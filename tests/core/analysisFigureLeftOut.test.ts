/**
 * An Analysis figure with a percent unit, written into a Note through its marker (#2577). One
 * IncarnaMind worked out again to the same number is a figure with its own marker and shows as a
 * percent. Where one couldn't be (its rows hold a cell that isn't a number, or come to another
 * number), the sentence holds the mark "[number missing]" where its number would be, never the
 * marker's text: the change says which figure, Check this Note reads no number there, a later
 * Answer that rewrites the sentence keeps the mark, and the exports write its words.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { plainText } from "../../src/core/mindText";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { keptText } from "../../src/renderer/src/changeFacts";
import { type AnalysisValue, noAnalysisOutput } from "../../src/shared/analysis";
import { translate } from "../../src/shared/i18n";
import { askAssistant, changesIn } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { listedSentences } from "../helpers/claimSentences";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { part, textOf, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import { judgesNothing, type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

type Language = "en" | "zh-CN";

const WORDS = {
  en: {
    question: "What was Harbour's average monthly loan growth?",
    rewrite: "Tidy the growth sentence in that note.",
    again: "Try the growth figure again and put it in the note.",
    put: "Put the calculated growth, 8.0%, where the note says [number missing].",
    plain: "Write the growth into the note as a plain number.",
    second: (number: string) => `There were ${number} loans in February.`,
    swap: "Update the growth sentence and the February sentence.",
    quarter: (n: number, said: string) => `Q${n} growth ${said}.`,
    was: (marker: string) => `was ${marker}`,
    cameTo: (number: string) => `came to ${number}`,
    cells: ["Quarter", "Growth", "Q"],
    split: (marker: string): [string, string] => [
      `Branch loans grew by ${marker}.`,
      "Sales held steady all year across every branch in the region.",
    ],
    splitPart: "Branch loans grew by",
    joined: (marker: string) => `Q1 growth was ${marker}, and Q2 growth was ${marker}.`,
    salesWithNumber:
      "Sales held steady all year across every branch in the region, at 1,080 loans.",
    label: "Average monthly loan growth",
    title: "Growth",
    sentence: (marker: string) => `Harbour's average monthly loan growth was ${marker}.`,
    tidied: (marker: string) => `Harbour's mean monthly loan growth was ${marker}.`,
    before: (marker: string) => `Last year it was ${marker}.`,
    part: "Harbour's average monthly",
    mark: "[number missing]",
  },
  "zh-CN": {
    question: "港湾分馆的月均借阅增长率是多少？",
    rewrite: "整理一下那篇笔记里的增长率这句话。",
    again: "再算一次增长率，写进笔记。",
    put: "把算出的增长率 8.0% 写在笔记中[缺少数字]的位置。",
    plain: "把增长率直接写成数字放进笔记。",
    second: (number: string) => `二月借阅 ${number} 次。`,
    swap: "更新增长率那句和二月那句。",
    quarter: (n: number, said: string) => `${["一", "二", "三"][n - 1]}季度增长率${said}。`,
    was: (marker: string) => `为 ${marker}`,
    cameTo: (number: string) => `达到 ${number}`,
    cells: ["季度", "增长率", "第"],
    split: (marker: string): [string, string] => [
      `港湾分馆借阅量上升了 ${marker}。`,
      "全年各分馆的销量在整个地区都保持稳定。",
    ],
    splitPart: "港湾分馆借阅量",
    joined: (marker: string) => `一季度增长率为 ${marker}，二季度增长率为 ${marker}。`,
    salesWithNumber: "全年各分馆的销量在整个地区都保持稳定，共 1,080 次。",
    label: "月均借阅增长率",
    title: "增长",
    sentence: (marker: string) => `港湾分馆的月均借阅增长率为 ${marker}。`,
    tidied: (marker: string) => `港湾分馆每月平均借阅增长率为 ${marker}。`,
    before: (marker: string) => `去年为 ${marker}。`,
    part: "港湾分馆的月均",
    mark: "[缺少数字]",
  },
} as const;

const loans = (growth: (month: number) => string): Buffer =>
  Buffer.from(
    [
      "month,loans,growth",
      ...Array.from(
        { length: 12 },
        (_, at) => `2026-${String(at + 1).padStart(2, "0")},${1000 + at * 80},${growth(at)}`,
      ),
      "",
    ].join("\n"),
  );

/** A column of fractions, so the mean the Analysis gives, 0.08, is the one the cells come to. */
const FRACTIONS = loans(() => "0.08");
/** The first month has no month before it, so its growth is "n/a", which no mean counts. */
const FIRST_MONTH_BLANK = loans((month) => (month === 0 ? "n/a" : "0.08"));
/** Percent points, 8.0, under the fraction, 0.08, a "%" figure takes. */
const PERCENT_POINTS = loans(() => "8.0");

const growth = (label: string): Extract<AnalysisValue, { kind: "figure" }> => ({
  kind: "figure",
  name: "growth",
  label,
  unit: "%",
  value: 0.08,
  of: { input: "loans", columns: ["growth"], rows: [[2, 13]], count: 12, how: "mean" },
});

/** The same figure given without naming its rows: it is recorded, and its marker is "[=1]". */
function recorded(label: string): Extract<AnalysisValue, { kind: "figure" }> {
  const { of: _rows, ...figure } = growth(label);
  return figure;
}

/** A figure the code gives without naming its rows: it is recorded, and its marker is "[=1]". */
const BRANCHES: Extract<AnalysisValue, { kind: "figure" }> = {
  kind: "figure",
  name: "branches",
  label: "Branches",
  unit: null,
  value: 12,
};

/** How the mark reads in `shown`, so a test can't take its words for text the model wrote. */
const MARK = "‹mark›";

/** A Block's text as the User sees it, the mark as `MARK`. */
function shown(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText || node.nodeName === "calculatedFigure") return plainText(node);
  if (node.nodeName === "missingNumber") return MARK;
  return node
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText || child instanceof Y.XmlElement ? shown(child) : "",
    )
    .join("");
}

/** The Answer's request that rewrites a Note: the second Question's, which names it. */
const rewrites = (call: ModelCall) =>
  call.prompt.includes(WORDS.en.rewrite) || call.prompt.includes(WORDS["zh-CN"].rewrite);

/** The Answer's request that works the figure out again: the try-again Question's. */
const triesAgain = (call: ModelCall) =>
  call.prompt.includes(WORDS.en.again) || call.prompt.includes(WORDS["zh-CN"].again);

/** The Answer's request that writes the number as plain digits: the plain Question's. */
const writesPlain = (call: ModelCall) =>
  call.prompt.includes(WORDS.en.plain) || call.prompt.includes(WORDS["zh-CN"].plain);

/** The Answer's request that rewrites the growth sentence and the one beside it. */
const swaps = (call: ModelCall) =>
  call.prompt.includes(WORDS.en.swap) || call.prompt.includes(WORDS["zh-CN"].swap);

/** The sentence of the Note the second Answer read, as it read it: its line that names the growth. */
const readSentence = (call: ModelCall, language: Language): string =>
  call.prompt
    .split("\n")
    .find((line) => line.includes(WORDS[language].part))
    ?.trim() ?? "";

async function written(
  language: Language,
  file: Buffer,
  content: string,
  /** What the Answer asked `swap` writes as its own text's new content, over `part`, or the whole Note. */
  swap: { content: string; part?: string; removesOnly?: boolean } = { content: "" },
) {
  const words = WORDS[language];
  /** The sentences each Check sent to be sorted into claims, the latest last. */
  const listed: string[][] = [];
  /** What the model was told each edit_mind call came to, in order. */
  const told: string[] = [];
  const tidy = (said: string) =>
    language === "en" ? said.replace("average", "mean") : said.replace("的月均", "每月平均");
  const model = scriptedModel(
    (call) => {
      // Edit with AI's rewrite of the passage it was given.
      const passage = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1];
      // Asked to put the number in, it writes the number where the words were.
      if (passage !== undefined && call.prompt.includes(words.put))
        return { text: passage.replace(words.mark, "8.0%") };
      if (passage !== undefined) return { text: tidy(passage) };
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "loans growth" } }] };
      if (!call.results.some((result) => result.tool === "run_analysis")) {
        const found = shownPassages(search.text).find((each) => each.document.startsWith("Loans"));
        return {
          calls: [
            {
              tool: "run_analysis",
              input: {
                title: rewrites(call) ? BRANCHES.label : words.label,
                inputs: [{ name: "loans", passage: found?.id ?? "" }],
                code: rewrites(call)
                  ? "count"
                  : triesAgain(call) || writesPlain(call) || swaps(call)
                    ? "again"
                    : "pass",
              },
            },
          ],
        };
      }
      if (swaps(call)) {
        if (!call.results.some((result) => result.tool === "edit_mind"))
          return {
            calls: [
              {
                tool: "edit_mind",
                input: {
                  mind: words.title,
                  ...(swap.part !== undefined && { part: swap.part }),
                  content: swap.content,
                  times_as_long: 1,
                  removes_only: swap.removesOnly === true,
                },
              },
            ],
          };
        return { text: language === "en" ? "Done." : "已完成。" };
      }
      if (writesPlain(call)) {
        const edits = call.results.filter((result) => result.tool === "edit_mind");
        if (edits.length > 0 && told.length < edits.length)
          told.push(...edits.slice(told.length).map((result) => result.text));
        if (edits.length === 0)
          return {
            calls: [
              {
                tool: "edit_mind",
                input: {
                  mind: words.title,
                  part: words.part,
                  content: words.sentence("8.0%"),
                  times_as_long: 1,
                  removes_only: false,
                },
              },
            ],
          };
        return { text: language === "en" ? "Done." : "已完成。" };
      }
      if (triesAgain(call)) {
        const edits = call.results.filter((result) => result.tool === "edit_mind");
        // Its sentence again with the figure it calculated this time, then, once told that text
        // isn't its own to replace, the number by Edit with AI.
        if (edits.length === 0)
          return {
            calls: [
              {
                tool: "edit_mind",
                input: {
                  mind: words.title,
                  part: words.part,
                  content: words.sentence("[=1]"),
                  times_as_long: 1,
                  removes_only: false,
                },
              },
            ],
          };
        if (edits.length === 1 && edits[0]?.text.includes("give instruction instead"))
          return {
            calls: [
              {
                tool: "edit_mind",
                input: {
                  mind: words.title,
                  part: words.part,
                  instruction: words.put,
                  times_as_long: 1,
                  removes_only: false,
                },
              },
            ],
          };
        return { text: language === "en" ? "Done." : "已完成。" };
      }
      if (rewrites(call)) {
        const edits = call.results.filter((result) => result.tool === "edit_mind");
        // As a model may, it gives the sentence it read as new text first, and an instruction
        // once told that text isn't its own to replace.
        if (edits.length === 0)
          return {
            calls: [
              {
                tool: "edit_mind",
                input: {
                  mind: words.title,
                  part: words.part,
                  content: tidy(readSentence(call, language)),
                  times_as_long: 1,
                  removes_only: false,
                },
              },
            ],
          };
        if (edits.length === 1 && edits[0]?.text.includes("give instruction instead"))
          return {
            calls: [
              {
                tool: "edit_mind",
                input: {
                  mind: words.title,
                  part: words.part,
                  instruction: words.rewrite,
                  times_as_long: 1,
                  removes_only: false,
                },
              },
            ],
          };
        return { text: language === "en" ? "Tidied." : "已整理。" };
      }
      if (!call.results.some((result) => result.tool === "create_mind"))
        return {
          calls: [
            {
              tool: "create_mind",
              streamInput: true,
              input: { title: words.title, content },
            },
          ],
        };
      return { text: language === "en" ? "Written." : "已写入。" };
    },
    {
      generate: (call) => {
        if (call.question === "find-claims")
          listed.push(listedSentences(call.prompt).map((each) => each.text));
        return judgesNothing(call);
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: createFakeAnalysisRuntime({
      answer: (job) => ({
        output: {
          ...noAnalysisOutput(),
          results: [
            job.code === "count"
              ? BRANCHES
              : job.code === "again"
                ? recorded(words.label)
                : growth(words.label),
          ],
        },
      }),
    }),
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  if (language === "zh-CN") await core.updateSettings({ user: { language } });
  await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), "Loans.csv", file),
  ]);
  const answer = await askAssistant(core, {
    text: words.question,
    mindId: (await core.createMind({ title: "Questions" })).id,
    analyse: true,
  });
  const change = answer.toolCalls.findLast((call) => call.tool === "create_mind")?.mindChange;
  if (!change) throw new Error("The Answer made no Note.");
  const client = await connectToMind(core, change.mindId);
  await client.settled();
  await resolveChanges(client, "accept");
  const lines = () =>
    client.blocks
      .toArray()
      .flatMap((block) => (block instanceof Y.XmlElement ? [shown(block)] : []));
  const [row] = changedMinds(answer);
  return {
    core,
    conversationId: answer.conversationId,
    mindId: change.mindId,
    told,
    listed,
    lines,
    sentence: lines().at(-1),
    change,
    line: row ? keptText((key, params) => translate(language, key, params), row) : null,
  };
}

async function exported(core: Core, mindId: string, format: "markdown" | "docx"): Promise<string> {
  const file = await core.exportMind(mindId, { format });
  return format === "docx"
    ? textOf(part(unzip(file.data), "word/document.xml"))
    : new TextDecoder().decode(file.data);
}

describe.each(["en", "zh-CN"] as const)("%s", (language) => {
  const words = WORDS[language];

  test("a percent figure IncarnaMind worked out again is written as a percent, with nothing left out", async () => {
    const { core, sentence, change, line } = await written(
      language,
      FRACTIONS,
      words.sentence("[=1]"),
    );
    core.close();
    expect(sentence).toBe(words.sentence("8.0%"));
    expect(change.figuresLeftOut).toBeUndefined();
    expect(line).toBeNull();
  });

  test.each([
    ["a cell that isn't a number", FIRST_MONTH_BLANK],
    ["cells that come to another number", PERCENT_POINTS],
  ])(
    "a percent figure whose rows hold %s has no figure, and the sentence holds the mark where its number would be",
    async (_, file) => {
      const { core, sentence, change, line } = await written(
        language,
        file,
        words.sentence("[=1]"),
      );
      core.close();
      expect(sentence).toBe(words.sentence(MARK));
      expect(change.figuresLeftOut).toEqual({ count: 1, labels: [words.label] });
      expect(line).toBe(
        language === "en"
          ? `· 1 figure couldn’t be calculated, so the text says [number missing]: “${words.label}”`
          : `· 有 1 个数字未能计算，文中标为[缺少数字]：“${words.label}”`,
      );
    },
  );

  test("a number the sentence wrote right before a marker no figure holds stays, the marker goes, and nothing is counted", async () => {
    const { core, sentence, change, line } = await written(
      language,
      FIRST_MONTH_BLANK,
      words.sentence("8% [=1]"),
    );
    core.close();
    expect(sentence).toBe(words.sentence("8%"));
    expect(change.figuresLeftOut).toBeUndefined();
    expect(line).toBeNull();
  });

  test("a marker no figure holds becomes the mark, and is counted", async () => {
    const { core, sentence, change, line } = await written(
      language,
      FRACTIONS,
      `${words.sentence("[=1]")} ${words.before("[=2]")}`,
    );
    core.close();
    expect(sentence).toBe(`${words.sentence("8.0%")} ${words.before(MARK)}`);
    expect(change.figuresLeftOut).toEqual({ count: 1, labels: [] });
    expect(line).toBe(
      language === "en"
        ? "· 1 figure couldn’t be calculated, so the text says [number missing]"
        : "· 有 1 个数字未能计算，文中标为[缺少数字]",
    );
  });

  test("Check this Note reads no number where the mark is", async () => {
    const { core, mindId, listed } = await written(
      language,
      FIRST_MONTH_BLANK,
      words.sentence("[=1]"),
    );
    await core.checkMind({ requestId: randomUUID(), mindId, mode: "all" });
    core.close();
    const read = listed.at(-1)?.find((each) => each.includes(words.part));
    expect(read).toBeDefined();
    expect(read).not.toMatch(/\d/);
  });

  /**
   * Asks the Answer in the Note's conversation, accepts what it wrote, and reads the Note's last line,
   * its paragraphs and its figures; `undo`: applies the Answer's changes as the window does, reads
   * them, and takes them back with Undo.
   */
  async function askedAgain(
    language: Language,
    question: string,
    {
      content = WORDS[language].sentence("[=1]"),
      swap = { content: "" },
      undo = false,
    }: {
      content?: string;
      swap?: { content: string; part?: string; removesOnly?: boolean };
      undo?: boolean;
    } = {},
  ) {
    const { core, mindId, conversationId, told } = await written(
      language,
      FIRST_MONTH_BLANK,
      content,
      swap,
    );
    const answer = await askAssistant(core, {
      conversationId,
      text: question,
      mindId,
      analyse: true,
    });
    const client = await connectToMind(core, mindId);
    await client.settled();
    const paragraphs = () => {
      const found: string[] = [];
      const visit = (node: Y.XmlElement) => {
        if (node.nodeName === "paragraph") found.push(shown(node));
        else for (const child of node.toArray()) if (child instanceof Y.XmlElement) visit(child);
      };
      for (const block of client.blocks.toArray()) if (block instanceof Y.XmlElement) visit(block);
      return found;
    };
    let undone: string[] | null = null;
    let applied: string[] | null = null;
    if (undo) {
      const requests = changesIn(answer).map((change) => change.request);
      const application = await core.applyAskedChanges({ answerId: answer.id, mindId, requests });
      await client.settled();
      applied = paragraphs();
      if (application) await core.undoAskedChanges(application.undoId);
      await client.settled();
      undone = paragraphs();
    } else await resolveChanges(client, "accept");
    await client.settled();
    const edits = answer.toolCalls.filter((call) => call.tool === "edit_mind");
    const last = client.blocks.toArray().at(-1);
    let figures = 0;
    const count = (node: Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "calculatedFigure") figures++;
        count(child);
      }
    };
    if (last instanceof Y.XmlElement) count(last);
    const now = paragraphs();
    core.close();
    return {
      edits,
      line: last instanceof Y.XmlElement ? shown(last) : null,
      figures,
      told,
      paragraphs: now,
      applied,
      undone,
    };
  }

  test("an Answer that records its own figure 1 and rewrites its own sentence keeps the mark a mark", async () => {
    const { edits, line } = await askedAgain(language, words.rewrite);
    expect(edits.map((call) => call.status)).toEqual(["done"]);
    expect(line).toBe(words.tidied(MARK));
  });

  test("a later Answer that calculates the figure puts it where the mark was", async () => {
    const { edits, line, figures } = await askedAgain(language, words.again);
    expect(edits.map((call) => call.status)).toEqual(["done"]);
    expect(line).toBe(words.sentence("8.0%"));
    expect(figures).toBe(1);
  });

  test("an Answer whose new text has a plain number where the mark is is refused, and the mark stays", async () => {
    const { edits, line, figures, told } = await askedAgain(language, words.plain);
    expect(edits.map((call) => call.status)).toEqual(["failed"]);
    expect(edits[0]?.mindProblem?.kind).toBe("missing-number");
    expect(told).toEqual([
      language === "en"
        ? 'Error: This change was not made: it takes out "[number missing]" and puts no calculated figure in its place. "[number missing]" stands for a number that could not be calculated. Either call calculate and write its marker where "[number missing]" is, or keep "[number missing]" exactly as written. Never write the number yourself.'
        : "Error: 这处改动没有做：它去掉了“[缺少数字]”，却没有在原处放入计算得出的数字。“[缺少数字]”表示一个未能算出的数字。请调用 calculate 并把它的标记写在“[缺少数字]”所在的位置，或者原样保留“[缺少数字]”。不要自己写出这个数字。",
    ]);
    expect(line).toBe(words.sentence(MARK));
    expect(figures).toBe(0);
  });

  describe("a paragraph with the mark and a second number", () => {
    const content = `${words.sentence("[=1]")} ${words.second("1,080")}`;

    test("a change that calculates the second number and types digits where the mark was is refused, and the mark stays", async () => {
      const { edits, line, figures } = await askedAgain(language, words.swap, {
        content,
        swap: { content: `${words.sentence("8.0%")} ${words.second("[=1]")}`, part: words.part },
      });
      expect(edits.map((call) => call.status)).toEqual(["failed"]);
      expect(edits[0]?.mindProblem?.kind).toBe("missing-number");
      expect(line).toBe(`${words.sentence(MARK)} ${words.second("1,080")}`);
      expect(figures).toBe(0);
    });

    test("a change with the calculated figure where the mark was lands", async () => {
      const { edits, line, figures } = await askedAgain(language, words.swap, {
        content,
        swap: { content: `${words.sentence("[=1]")} ${words.second("1,080")}`, part: words.part },
      });
      expect(edits.map((call) => call.status)).toEqual(["done"]);
      expect(line).toBe(`${words.sentence("8.0%")} ${words.second("1,080")}`);
      expect(figures).toBe(1);
    });

    test("a change that moves the mark's sentence within its paragraph and keeps the mark lands", async () => {
      const { edits, line } = await askedAgain(language, words.swap, {
        content,
        swap: {
          content: `${words.second("1,080")} ${words.sentence(words.mark)}`,
          part: words.part,
        },
      });
      expect(edits.map((call) => call.status)).toEqual(["done"]);
      expect(line).toBe(`${words.second("1,080")} ${words.sentence(MARK)}`);
    });
  });

  describe("no paragraph of a change answers for another", () => {
    const list = (said: (n: number) => string) =>
      [1, 2, 3].map((n) => `- ${words.quarter(n, said(n))}`).join("\n");

    test("a list of three like items, digits typed in one where the mark was: refused, and every mark stays", async () => {
      const { edits, paragraphs } = await askedAgain(language, words.swap, {
        content: list((n) => words.was(`[=${n}]`)),
        swap: {
          content: list((n) => (n === 2 ? words.cameTo("8.0%") : words.was(words.mark))),
        },
      });
      expect(edits.map((call) => call.status)).toEqual(["failed"]);
      expect(edits[0]?.mindProblem?.kind).toBe("missing-number");
      expect(paragraphs.slice(-3)).toEqual([1, 2, 3].map((n) => words.quarter(n, words.was(MARK))));
    });

    test("a table with the mark alone in two cells, digits typed in one: refused", async () => {
      const [quarter, growth, row] = words.cells;
      const table = (second: string) =>
        [
          `| ${quarter} | ${growth} |`,
          "| --- | --- |",
          `| ${row}1 | [=1] |`,
          `| ${row}2 | ${second} |`,
        ].join("\n");
      const { edits, paragraphs } = await askedAgain(language, words.swap, {
        content: table("[=2]"),
        swap: { content: table("8.0%").replace("[=1]", words.mark) },
      });
      expect(edits.map((call) => call.status)).toEqual(["failed"]);
      expect(edits[0]?.mindProblem?.kind).toBe("missing-number");
      expect(paragraphs.filter((each) => each === MARK)).toHaveLength(2);
    });

    test("a paragraph split in two that keeps its mark lands", async () => {
      const [first, second] = words.split("[=1]");
      const { edits, paragraphs } = await askedAgain(language, words.swap, {
        content: `${first} ${second}`,
        swap: { content: words.split(words.mark).join("\n\n"), part: words.splitPart },
      });
      expect(edits.map((call) => call.status)).toEqual(["done"]);
      expect(paragraphs.slice(-2)).toEqual(words.split(MARK));
    });

    test("two like items joined into one that keeps both marks lands", async () => {
      const { edits, paragraphs } = await askedAgain(language, words.swap, {
        content: [1, 2].map((n) => `- ${words.quarter(n, words.was(`[=${n}]`))}`).join("\n"),
        swap: { content: `- ${words.joined(words.mark)}` },
      });
      expect(edits.map((call) => call.status)).toEqual(["done"]);
      expect(paragraphs.at(-1)).toBe(words.joined(MARK));
    });
  });

  describe("taking the mark's sentence out", () => {
    const [growthSentence, sales] = words.split("[=1]");
    const content = `${growthSentence} ${sales}`;
    const part = words.splitPart;

    test("asked only to take text out, a change that only takes the sentence out lands with its mark, and Undo brings both back", async () => {
      const { edits, applied, undone } = await askedAgain(language, words.swap, {
        content,
        swap: { content: sales, part, removesOnly: true },
        undo: true,
      });
      expect(edits.map((call) => call.status)).toEqual(["done"]);
      expect(applied?.at(-1)).toBe(sales);
      expect(undone?.at(-1)).toBe(`${words.split(MARK)[0]} ${sales}`);
    });

    test("asked only to take text out, a change that also writes a number is refused", async () => {
      const { edits, line } = await askedAgain(language, words.swap, {
        content,
        swap: { content: words.salesWithNumber, part, removesOnly: true },
      });
      expect(edits.map((call) => call.status)).toEqual(["failed"]);
      expect(edits[0]?.mindProblem?.kind).toBe("missing-number");
      expect(line).toBe(`${words.split(MARK)[0]} ${sales}`);
    });

    test("not asked only to take text out, a change that drops the mark's sentence is refused", async () => {
      const { edits, line } = await askedAgain(language, words.swap, {
        content,
        swap: { content: sales, part },
      });
      expect(edits.map((call) => call.status)).toEqual(["failed"]);
      expect(edits[0]?.mindProblem?.kind).toBe("missing-number");
      expect(line).toBe(`${words.split(MARK)[0]} ${sales}`);
    });
  });

  test("the Markdown and Word exports write the mark's words in the interface language", async () => {
    const { core, mindId } = await written(language, FIRST_MONTH_BLANK, words.sentence("[=1]"));
    const markdown = await exported(core, mindId, "markdown");
    const word = await exported(core, mindId, "docx");
    core.close();
    expect(markdown).toContain(words.sentence(words.mark.replace("[", "\\[").replace("]", "\\]")));
    expect(word).toContain(words.sentence(words.mark));
    expect(markdown).not.toContain("[=1]");
    expect(word).not.toContain("[=1]");
  });
});
