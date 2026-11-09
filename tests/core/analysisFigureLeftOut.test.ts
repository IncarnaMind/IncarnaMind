/**
 * An Analysis figure with a percent unit, written into a Note through its marker (#2577). One
 * IncarnaMind worked out again to the same number is a figure with its own marker and shows as a
 * percent. One it couldn't (its rows hold a cell that isn't a number, or come to another number)
 * has no marker, and a sentence that still writes one is never left without its number unsaid:
 * the marker stays where it was, and the change says which figure couldn't be written.
 */
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { plainText } from "../../src/core/mindText";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { keptText } from "../../src/renderer/src/changeFacts";
import { type AnalysisValue, noAnalysisOutput } from "../../src/shared/analysis";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";

type Language = "en" | "zh-CN";

const WORDS = {
  en: {
    question: "What was Harbour's average monthly loan growth?",
    label: "Average monthly loan growth",
    sentence: (marker: string) => `Harbour's average monthly loan growth was ${marker}.`,
    before: (marker: string) => `Last year it was ${marker}.`,
  },
  "zh-CN": {
    question: "港湾分馆的月均借阅增长率是多少？",
    label: "月均借阅增长率",
    sentence: (marker: string) => `港湾分馆的月均借阅增长率为 ${marker}。`,
    before: (marker: string) => `去年为 ${marker}。`,
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

async function written(language: Language, file: Buffer, content: string) {
  const words = WORDS[language];
  const model = scriptedModel((call) => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "loans growth" } }] };
    if (!call.results.some((result) => result.tool === "run_analysis")) {
      const found = shownPassages(search.text).find((each) => each.document.startsWith("Loans"));
      return {
        calls: [
          {
            tool: "run_analysis",
            input: {
              title: words.label,
              inputs: [{ name: "loans", passage: found?.id ?? "" }],
              code: "pass",
            },
          },
        ],
      };
    }
    if (!call.results.some((result) => result.tool === "create_mind"))
      return {
        calls: [
          {
            tool: "create_mind",
            streamInput: true,
            input: { title: language === "en" ? "Growth" : "增长", content },
          },
        ],
      };
    return { text: language === "en" ? "Written." : "已写入。" };
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: createFakeAnalysisRuntime({
      answer: () => ({
        output: { ...noAnalysisOutput(), results: [growth(words.label)] },
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
  const lines = client.blocks
    .toArray()
    .flatMap((block) => (block instanceof Y.XmlElement ? [plainText(block)] : []));
  core.close();
  const [row] = changedMinds(answer);
  return {
    sentence: lines.at(-1),
    change,
    line: row ? keptText((key, params) => translate(language, key, params), row) : null,
  };
}

describe.each(["en", "zh-CN"] as const)("%s", (language) => {
  const words = WORDS[language];

  test("a percent figure IncarnaMind worked out again is written as a percent, with nothing left out", async () => {
    const { sentence, change, line } = await written(language, FRACTIONS, words.sentence("[=1]"));
    expect(sentence).toBe(words.sentence("8.0%"));
    expect(change.figuresLeftOut).toBeUndefined();
    expect(line).toBeNull();
  });

  test.each([
    ["a cell that isn't a number", FIRST_MONTH_BLANK],
    ["cells that come to another number", PERCENT_POINTS],
  ])(
    "a percent figure whose rows hold %s has no marker, and the sentence keeps the marker's place",
    async (_, file) => {
      const { sentence, change, line } = await written(language, file, words.sentence("[=1]"));
      expect(sentence).toBe(words.sentence("[=1]"));
      expect(change.figuresLeftOut).toEqual({ count: 1, labels: [words.label] });
      expect(line).toBe(
        language === "en"
          ? `· 1 figure couldn’t be written, so its marker stays in the text: “${words.label}”`
          : `· 有 1 个数字未能写入，其标记仍留在文中：“${words.label}”`,
      );
    },
  );

  test("a number the sentence wrote right before a marker no figure holds stays, and the marker goes as before", async () => {
    const { sentence, change, line } = await written(
      language,
      FIRST_MONTH_BLANK,
      words.sentence("8% [=1]"),
    );
    expect(sentence).toBe(words.sentence("8%"));
    expect(change.figuresLeftOut).toBeUndefined();
    expect(line).toBeNull();
  });

  test("a marker no figure holds stays where it is, and is counted", async () => {
    const { sentence, change, line } = await written(
      language,
      FRACTIONS,
      `${words.sentence("[=1]")} ${words.before("[=2]")}`,
    );
    expect(sentence).toBe(`${words.sentence("8.0%")} ${words.before("[=2]")}`);
    expect(change.figuresLeftOut).toEqual({ count: 1, labels: [] });
    expect(line).toBe(
      language === "en"
        ? "· 1 figure couldn’t be written, so its marker stays in the text"
        : "· 有 1 个数字未能写入，其标记仍留在文中",
    );
  });
});
