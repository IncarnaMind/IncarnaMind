import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  type ConversationAnswer,
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type MarkedFigure,
  type SaveChatProviderInput,
} from "../../src/core";
import { migrate, migrations, openDatabase } from "../../src/core/storage";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readCalculatedFigureAttributes } from "../../src/shared/calculatedFigures";
import { translate } from "../../src/shared/i18n";
import {
  answerEnded,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { askAndEnd, isAnswer, QWEN35, setUpLocalModel } from "../helpers/localModels";
import { answerIn, question, writeMind } from "../helpers/minds";
import {
  answerRequests,
  judgesNothing,
  promptOf,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { type OllamaChatReply, startOllamaServer } from "../helpers/ollama";
import { buildPdf } from "../helpers/pdf";

const REVENUE = "Revenue was $1,482.6 million in 2025, compared with $1,231.0 million in 2024.";
const MARGIN = "Gross margin 41.2% 38.9%";

const ACME = {
  name: "Acme Annual Report 2025.pdf",
  contents: buildPdf([
    { lines: ["Acme Annual Report 2025", REVENUE] },
    { lines: ["Gross margin 2025 2024", MARGIN] },
  ]),
};

/** A Tool call as a scripted model makes it. */
type Call = { tool: string; input: unknown };

/**
 * A model that searches for each query in turn, then makes each step's calls
 * (from the Passages its searches showed it), one step per request, then
 * writes `answer`.
 */
function calculatingModel(plan: {
  queries: string[];
  steps: ((passages: ShownPassage[]) => Call[])[];
  answer: string;
}): MockLanguageModelV4 {
  return scriptedModel(
    (call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length < plan.queries.length) {
        return {
          calls: [{ tool: "search_documents", input: { query: plan.queries[searches.length] } }],
        };
      }
      const step = plan.steps[call.index - plan.queries.length];
      if (step) return { calls: step(searches.flatMap((each) => shownPassages(each.text))) };
      return { text: plan.answer };
    },
    { generate: judgesNothing },
  );
}

/** The id of the Passage of a Document whose name starts with `name`. */
function passageOf(passages: readonly ShownPassage[], name: string): string {
  const found = passages.find((passage) => passage.document.startsWith(name));
  if (!found) throw new Error(`No Passage of ${name} was shown.`);
  return found.id;
}

/**
 * Whether a Citation's quote was found, apart from the judgement of its sentence that follows an
 * Answer in the assistant (#2311, tests/core/answerSupport.test.ts).
 */
const quoteCheck = (citation: { check: string }) =>
  citation.check === "not-found" ? "not-found" : "found";

/** What each call of `tool` told the model, oldest first, as the model's last request shows them. */
function told(model: MockLanguageModelV4, tool: string): string[] {
  const last = answerRequests(model).at(-1);
  if (!last) throw new Error("The model wasn't asked anything.");
  const texts: string[] = [];
  for (const message of last.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === tool && part.output.type === "text") {
        texts.push(part.output.value);
      }
    }
  }
  return texts;
}

/** Blocks' text as a reader sees it: a line per paragraph, a table's cells between bars. */
function shown(blocks: readonly NodeJSON[]): string {
  const inline = (node: NodeJSON): string =>
    node.type === "text"
      ? (node.text ?? "")
      : node.type === "calculatedFigure"
        ? (readCalculatedFigureAttributes(node.attrs)?.figure.shown ?? "")
        : node.type === "missingNumber"
          ? "‹mark›"
          : (node.content ?? []).map(inline).join("");
  return blocks
    .map((block) =>
      block.type === "table"
        ? (block.content ?? [])
            .map((row) => (row.content ?? []).map((cell) => inline(cell)).join(" | "))
            .join("\n")
        : inline(block),
    )
    .join("\n");
}

/** Asks in the assistant and waits for the Answer; returns it as the assistant reads it, and its end. */
async function askAndRead(core: Core, text: string, conversationId?: string) {
  const asked = await core.askInConversation({ text, conversationId });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, finished: ended.payload, conversationId: asked.conversation.id };
}

/**
 * A core whose chat model is Claude Haiku 5.5 (or `provider`), scripted: a model measured to
 * use calculate, so its Answers are offered it (ADR-0021). Its service is
 * allowed, and the files are added as Documents. Its Answers run the Tool
 * loop from the first call, as the scripts call it, whatever the
 * retrieve-first list says (#1633).
 */
async function setUpCalculating(
  model: MockLanguageModelV4,
  files: readonly { name: string; contents: string | Uint8Array }[],
  dataDir?: string,
  overrides: Partial<CoreAdapters> = {},
  provider: SaveChatProviderInput = {
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  },
) {
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
    createChatModel: scriptedModels(model).createChatModel,
    ...overrides,
    answerPaths: { retrievesFirst: () => false, ...overrides.answerPaths },
  });
  const saved = await core.saveChatProvider(provider);
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(
    core,
    await Promise.all(files.map((file) => writeSourceFile(sources, file.name, file.contents))),
  );
  return { core };
}

/** The `calculate` call that sums up an Answer's figures. */
const calculateCall = (answer: ConversationAnswer) =>
  answer.toolCalls.find((call) => call.tool === "calculate");

const GROWTH = (cited: { revenue: number; margin: number }) => [
  {
    marker: 1,
    label: "Revenue growth 2025 (%)",
    formula: "rev2025 / rev2024 - 1",
    shown: "20.4%",
    inputs: [
      { name: "rev2025", label: "Revenue 2025 ($)", citation: cited.revenue, value: 1_482_600_000 },
      { name: "rev2024", label: "Revenue 2024 ($)", citation: cited.revenue, value: 1_231_000_000 },
    ],
  },
  {
    marker: 2,
    label: "Change in gross margin (percentage points)",
    formula: "gm2025 - gm2024",
    shown: "2.3 percentage points",
    inputs: [
      { name: "gm2025", label: "Gross margin 2025", citation: cited.margin, value: 0.412 },
      { name: "gm2024", label: "Gross margin 2024", citation: cited.margin, value: 0.389 },
    ],
  },
];

/** Cites the revenue sentence as [^1] and the margin row as [^2], then calculates both figures in one call. */
const citeAndCalculate = (passages: ShownPassage[]): Call[] => {
  const passage = passageOf(passages, "Acme");
  return [
    {
      tool: "cite",
      input: {
        citations: [
          { marker: 1, passage, location: "p. 1", quote: REVENUE },
          { marker: 2, passage, location: "p. 2", quote: MARGIN },
        ],
      },
    },
    { tool: "calculate", input: { figures: GROWTH({ revenue: 1, margin: 2 }) } },
  ];
};

describe("The calculate Tool", { timeout: 60_000 }, () => {
  test("records two figures in one call; the Answer shows them where their markers are, in its text and in a table's cell", async () => {
    const model = calculatingModel({
      queries: ["revenue gross margin"],
      steps: [citeAndCalculate],
      answer: [
        "Revenue grew [=1] in 2025, to $1,482.6 million[^1]; gross margin rose [=2], to 41.2%[^2].",
        "",
        "| Measure | Change |",
        "|:--|--:|",
        "| Revenue | [=1] |",
        "| Gross margin | [=2] |",
      ].join("\n"),
    });
    const { core } = await setUpCalculating(model, [ACME]);
    const cards: string[] = [];
    core.on("answer.toolCallStarted", ({ call }) => cards.push(call.tool));

    const { answer, finished } = await askAndRead(
      core,
      "How much did Acme's revenue grow in 2025, and how did its gross margin change?",
    );

    // It is steered to the Tool, in few words: the instructions go with every Question.
    const system = promptOf(model)[0]?.text ?? "";
    const steer =
      system.split("\n\n").find((block) => block.startsWith("Never work out a number yourself")) ??
      "";
    expect(steer).toMatch(/call calculate/);
    expect(steer.length).toBeLessThan(1000);
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toContain("calculate");
    const tool = model.doStreamCalls[0]?.tools?.find((each) => each.name === "calculate");
    if (tool?.type !== "function") throw new Error("The calculate Tool is not a function tool.");
    expect(tool.description).toContain(
      "Revision worksheets need every item row and its revision, no bare values.",
    );
    // The model is told what each came to, with the numbers it used, in one line each.
    expect(told(model, "calculate")).toEqual([
      [
        "Recorded [=1] = 20.4% (Revenue growth 2025 (%): 1,482,600,000 ÷ 1,231,000,000 − 1 = 20.4% · 1,482.6 → 1,482,600,000, 1,231.0 → 1,231,000,000).",
        "Recorded [=2] = 2.3 percentage points (Change in gross margin (percentage points): 0.412 − 0.389 = 2.3 percentage points · 41.2 → 0.412, 38.9 → 0.389).",
        "Write each marker in its number's place, in the text or a table's cell, as in \"grew [=1] in 2025\": it shows as its shown text, so write neither the number nor its unit beside it.",
      ].join("\n"),
    ]);
    expect(shown(answerBlocks(answer))).toBe(
      [
        "Revenue grew 20.4% in 2025, to $1,482.6 million; gross margin rose 2.3 percentage points, to 41.2%.",
        "Measure | Change",
        "Revenue | 20.4%",
        "Gross margin | 2.3 percentage points",
      ].join("\n"),
    );
    expect(answer.figures).toMatchObject([
      {
        marker: 1,
        label: "Revenue growth 2025 (%)",
        formula: "rev2025 / rev2024 - 1",
        shown: "20.4%",
        written: null,
        inputs: [
          {
            name: "rev2025",
            label: "Revenue 2025 ($)",
            citation: { quote: REVENUE, check: "found", pageFrom: 1, pageTo: 1 },
            number: { chars: "1,482.6", at: REVENUE.indexOf("1,482.6"), value: 1_482_600_000 },
            cell: null,
            unitStatement: null,
          },
          { name: "rev2024", number: { chars: "1,231.0", value: 1_231_000_000 } },
        ],
      },
      {
        marker: 2,
        shown: "2.3 percentage points",
        inputs: [
          { citation: { quote: MARGIN, check: "found", pageFrom: 2 }, number: { chars: "41.2" } },
          { number: { chars: "38.9", value: 0.389 } },
        ],
      },
    ]);
    expect(answer.figures[0]?.value).toBeCloseTo(1482.6 / 1231 - 1, 12);
    expect(finished.figures).toEqual(answer.figures);
    expect(finished.uncalculated).toBe(0);
    // Its steps say how many it calculated, with no Tool-call card, as for cite.
    expect(calculateCall(answer)).toMatchObject({
      source: "documents",
      status: "done",
      resultCount: 2,
    });
    expect(cards).toEqual(["search_documents"]);
    expect(translate("en", "answer.figures.calculated", { count: 2 })).toBe("Calculated 2 figures");
    expect(translate("zh-CN", "answer.figures.calculated", { count: 2 })).toBe("计算了 2 个数字");
  });

  test.each([
    ["a record and a figure each given alone", (value: object) => value],
    [
      "lists written in JSON and encoded twice",
      (value: object) => JSON.stringify(JSON.stringify([value])),
    ],
  ])("cite and calculate take %s, with no step spent on sending them again", async (_how, wrap) => {
    const model = calculatingModel({
      queries: ["revenue"],
      steps: [
        (passages): Call[] => {
          const passage = passageOf(passages, "Acme");
          const [figure] = GROWTH({ revenue: 1, margin: 1 });
          const record = { marker: 1, passage, location: "p. 1", quote: REVENUE };
          return [
            { tool: "cite", input: { citations: wrap(record) } },
            { tool: "calculate", input: { figures: wrap(figure ?? {}) } },
          ];
        },
      ],
      answer: "Revenue grew [=1] in 2025, to $1,482.6 million[^1].",
    });
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer } = await askAndRead(core, "How much did Acme's revenue grow in 2025?");

    expect(answerRequests(model)).toHaveLength(3);
    expect(shown(answerBlocks(answer))).toBe("Revenue grew 20.4% in 2025, to $1,482.6 million.");
    expect(answer.figures).toMatchObject([
      { marker: 1, inputs: [{ citation: { check: "found" } }, { citation: { check: "found" } }] },
    ]);
  });

  test("an input of a marker reads the words the model quoted, not the whole sentence its Citation shows (#2739)", async () => {
    const quoted = "Revenue was $1,482.6 million in 2025";
    const model = calculatingModel({
      queries: ["revenue"],
      steps: [
        (passages) => [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passageOf(passages, "Acme"),
                  location: "p. 1",
                  quote: quoted,
                },
              ],
            },
          },
          { tool: "calculate", input: { figures: GROWTH({ revenue: 1, margin: 1 }).slice(0, 1) } },
        ],
      ],
      answer: "Revenue was $1,482.6 million in 2025[^1].",
    });
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer } = await askAndRead(core, "How much did revenue grow?");

    expect(told(model, "calculate")[0]?.split("\n")).toEqual([
      "Nothing was recorded.",
      "Fix these with another calculate call:",
      "- [=1] rev2024: 1,231,000,000 isn't in its quote, which has 1,482.6, 2025: give the number the quote writes, as a plain number, moved by a power of ten only where you mean another scale or unit",
    ]);
    expect(answer.citations.find((each) => each.marker === 1)?.quote).toBe(REVENUE);
    expect(answer.figures).toEqual([]);
  });

  test("a number the model wrote right before its marker is shown once when it is the figure, and kept and flagged when it isn't; markers in code stay, and one with no figure is the mark that says so (#2577)", async () => {
    const model = calculatingModel({
      queries: ["revenue gross margin"],
      steps: [citeAndCalculate],
      answer:
        "Revenue grew 20.4% [=1] in 2025, gross margin rose 2.3% [=2], costs fell [=9], and `[=1]` is how it is written.",
    });
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer, finished } = await askAndRead(core, "How did Acme do in 2025?");

    expect(shown(answerBlocks(answer))).toBe(
      "Revenue grew 20.4% in 2025, gross margin rose 2.3% 2.3 percentage points, costs fell ‹mark›, and [=1] is how it is written.",
    );
    expect(answer.figures).toMatchObject([
      { marker: 1, shown: "20.4%", written: null },
      { marker: 2, shown: "2.3 percentage points", written: "2.3%" },
    ]);
    expect(finished.uncalculated).toBe(1);
    // Its end names the marker, and no number was written before it (#2313).
    expect(calculateCall(answer)).toMatchObject({
      resultCount: 2,
      uncalculated: 1,
      uncalculatedFigures: [{ marker: 9, written: null }],
    });
    expect(translate("en", "answer.figures.uncalculated.one")).toBe(
      "1 figure couldn’t be calculated",
    );
  });

  test("a marker given again replaces its figure, and the model is told; past five calls in one Answer, calculate is refused so the model answers", async () => {
    const growth = (passages: ShownPassage[], formula: string): Call[] => [
      {
        tool: "calculate",
        input: {
          figures: [
            {
              marker: 1,
              label: "Revenue growth (%)",
              formula,
              shown: formula === "a / b - 1" ? "20.4%" : "-17.0%",
              inputs: [
                // A value written as text reads as the number it writes.
                {
                  name: "a",
                  passage: passageOf(passages, "Acme"),
                  location: "p. 1",
                  quote: REVENUE,
                  value: "1482.6",
                },
                {
                  name: "b",
                  passage: passageOf(passages, "Acme"),
                  location: "p. 1",
                  quote: REVENUE,
                  value: 1231,
                },
              ],
            },
          ],
        },
      },
    ];
    const model = calculatingModel({
      queries: ["revenue"],
      steps: [
        (passages) => growth(passages, "a / b - 1"),
        (passages) => growth(passages, "b / a - 1"),
        (passages) => growth(passages, "b / a - 1"),
        (passages) => growth(passages, "b / a - 1"),
        (passages) => growth(passages, "b / a - 1"),
        (passages) => growth(passages, "a / b - 1"),
      ],
      answer: "Revenue changed by [=1].",
    });
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer } = await askAndRead(core, "How did Acme's revenue change?");

    const results = told(model, "calculate");
    expect(results[1]).toMatch(
      /^Recorded \[=1\] = -17\.0% \(Revenue growth \(%\): 1,231 ÷ 1,482\.6 − 1 = -17\.0%\)\. It replaces the earlier \[=1\] = 20\.4%: give each figure a marker of its own\./,
    );
    expect(results[4]).toMatch(/^Recorded \[=1\]/);
    expect(results[5]).toBe(
      "You have called calculate enough for this Question: write the Answer now with the figures recorded, and say which numbers couldn't be calculated rather than working them out.",
    );
    expect(answer.figures).toMatchObject([
      {
        shown: "-17.0%",
        inputs: [{ name: "a", label: "a", number: { chars: "1,482.6" } }, { name: "b" }],
      },
    ]);
  });

  test("an Answer written beside calculate with no marker in it stands when the model writes no other", async () => {
    const model = scriptedModel(
      (call) => {
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search) return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
        if (call.index === 1) {
          const [growth] = GROWTH({ revenue: 1, margin: 1 });
          const passage = passageOf(shownPassages(search.text), "Acme");
          const inputs = growth?.inputs.map(({ citation: _, ...input }) => ({
            ...input,
            passage,
            location: "p. 1",
            quote: REVENUE,
          }));
          return {
            text: "Acme's revenue grew 20.4% in 2025.",
            calls: [{ tool: "calculate", input: { figures: [{ ...growth, inputs }] } }],
          };
        }
        return { text: "" };
      },
      { generate: judgesNothing },
    );
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer } = await askAndRead(core, "How much did Acme's revenue grow?");

    expect(answer.text).toBe("Acme's revenue grew 20.4% in 2025.");
  });

  test("Question context and search read a figure as its shown text", async () => {
    const model = calculatingModel({
      queries: ["revenue gross margin"],
      steps: [citeAndCalculate],
      answer: "Revenue grew [=1] in 2025[^1]; gross margin rose [=2][^2].",
    });
    const { core } = await setUpCalculating(model, [ACME]);
    const { conversationId } = await askAndRead(core, "How did Acme do in 2025?");

    const asked = model.doStreamCalls.length;
    await askAndRead(core, "Why?", conversationId);

    const earlier = promptOf(model, asked).filter(
      (message) => message.role === "assistant" && message.text,
    );
    expect(earlier.map((message) => message.text)).toEqual([
      "Revenue grew 20.4% in 2025[Acme Annual Report 2025, p. 1 · C1]; gross margin rose 2.3 percentage points[Acme Annual Report 2025, p. 2 · C2].",
    ]);
    const [match] = await core.searchConversations("percentage");
    expect(match?.conversation.id).toBe(conversationId);
    expect(match?.messages.map((message) => message.excerpt)).toEqual([
      expect.stringContaining("gross margin rose 2.3 percentage points"),
    ]);
  });
});

describe("Calculated figures with conversations (ADR-0017)", { timeout: 60_000 }, () => {
  test("are kept with each Answer, and read back the same after a restart; Answers from before keep none", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 67),
    );
    const at = "2026-10-01T00:00:00.000Z";
    db.run(
      "INSERT INTO conversations (id, auto_title, created_at, updated_at) VALUES ('before', 'Tides', ?, ?)",
      [at, at],
    );
    db.run(
      `INSERT INTO conversation_messages (id, conversation_id, position, kind, text, status, created_at, updated_at)
       VALUES ('old-answer', 'before', 1, 'answer', 'Twice a day.', 'done', ?, ?)`,
      [at, at],
    );
    db.close();

    const model = calculatingModel({
      queries: ["revenue gross margin"],
      steps: [citeAndCalculate],
      answer: "Revenue grew [=1][^1]; gross margin rose [=2][^2].",
    });
    const { core } = await setUpCalculating(model, [ACME], dataDir);

    const old = (await core.getConversation("before")).messages[0];
    expect(old).toMatchObject({ kind: "answer", figures: [] });

    const { answer, conversationId } = await askAndRead(core, "How did Acme do in 2025?");
    expect(answer.figures.map((figure) => figure.shown)).toEqual([
      "20.4%",
      "2.3 percentage points",
    ]);
    core.close();

    const again = startCore(dataDir);
    const reopened = (await again.getConversation(conversationId)).messages.find(
      (message) => message.id === answer.id,
    );
    expect(reopened).toMatchObject({ kind: "answer", figures: answer.figures as MarkedFigure[] });
    expect(shown(answerBlocks({ ...(reopened as ConversationAnswer), status: "done" }))).toBe(
      "Revenue grew 20.4%; gross margin rose 2.3 percentage points.",
    );
    again.close();
  });
});

describe("Structured output, for a model offered calculate", { timeout: 60_000 }, () => {
  test("its figures come in its JSON and are worked out the same way; one in error is dropped, the mark stands in its place, and the Answer says so", async () => {
    const growth = GROWTH({ revenue: 1, margin: 2 });
    const badMargin = {
      ...growth[1],
      inputs: [
        { name: "gm2025", label: "Gross margin 2025", citation: 2, value: 0.421 },
        { name: "gm2024", label: "Gross margin 2024", citation: 2, value: 0.389 },
      ],
    };
    // Its provider refuses Tools, so the Answer steps down to structured output.
    const model = scriptedModel(
      (call) =>
        call.tools.length > 0
          ? { error: { status: 400, message: "This model does not support tools" } }
          : {
              text: JSON.stringify({
                answer: "Revenue grew [=1][^1], and gross margin rose [=2][^2].",
                citations: [
                  { marker: 1, passage: "P1", location: "p. 1", quote: REVENUE },
                  { marker: 2, passage: "P1", location: "p. 2", quote: MARGIN },
                ],
                calculations: [growth[0], badMargin],
              }),
            },
      { generate: judgesNothing },
    );
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer, finished } = await askAndRead(
      core,
      "How did Acme's revenue and margin change in 2025?",
    );

    expect(finished.citationSupport).toBe("structured-output");
    expect(promptOf(model, 1)[0]?.text).toContain("- calculations: one for each number");
    expect(finished.figures).toMatchObject([{ marker: 1, shown: "20.4%" }]);
    expect(finished.uncalculated).toBe(1);
    // A cloud model gets no second request, as for quotes.
    expect(finished.figureRetry).toBeNull();
    expect(shown(answerBlocks(answer))).toBe("Revenue grew 20.4%, and gross margin rose ‹mark›.");
    expect(calculateCall(answer)).toMatchObject({ resultCount: 1, uncalculated: 1 });
    expect(translate("zh-CN", "answer.figures.uncalculated.one")).toBe("1 个数字未能计算");
  });
});

describe("DeepSeek's own models are offered calculate (#441)", { timeout: 60_000 }, () => {
  const DEEPSEEK: SaveChatProviderInput = {
    kind: "deepseek",
    apiKey: "sk-test",
    modelId: "deepseek-flash",
  };

  test("in English: the Tool and its steer are offered, and its figures are recorded and checked as Claude's are", async () => {
    const model = calculatingModel({
      queries: ["revenue gross margin"],
      steps: [citeAndCalculate],
      answer: "Revenue grew [=1] in 2025[^1]; gross margin rose [=2][^2].",
    });
    const { core } = await setUpCalculating(model, [ACME], undefined, {}, DEEPSEEK);

    const { answer } = await askAndRead(
      core,
      "How much did Acme's revenue grow in 2025, and its gross margin?",
    );

    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toContain("calculate");
    expect(promptOf(model)[0]?.text).toMatch(/Never work out a number yourself/);
    expect(shown(answerBlocks(answer))).toBe(
      "Revenue grew 20.4% in 2025; gross margin rose 2.3 percentage points.",
    );
    expect(
      answer.figures.map((figure) => figure.inputs.map((input) => input.citation.check)),
    ).toEqual([
      ["found", "found"],
      ["found", "found"],
    ]);
  });
});

describe("A model not measured to use calculate answers as before", { timeout: 60_000 }, () => {
  test("in the Tool loop: no calculate Tool, no steer, and its Answer is as it was", async () => {
    const model = citingModel({
      query: "revenue",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, location: "p. 1", quote: REVENUE },
      ],
      answer: "Revenue grew about 20% [^1].",
    });
    // A model in Ollama: the catalog says nothing of its calculating.
    const { core } = await setUpWithDocuments(model, [ACME]);

    const { answer, finished } = await askAndRead(core, "How much did Acme's revenue grow?");

    for (const call of model.doStreamCalls) {
      expect(call.tools?.map((tool) => tool.name)).not.toContain("calculate");
    }
    const system = promptOf(model)[0]?.text ?? "";
    expect(system).not.toMatch(/calculate|\[=1\]/);
    expect(answer.text).toBe("Revenue grew about 20% [^1].");
    expect(answer.figures).toEqual([]);
    expect(answer.toolCalls.map((call) => call.tool)).toEqual(["search_documents"]);
    expect(finished).toMatchObject({ figures: [], uncalculated: 0, figureRetry: null });
  });

  test("a small local model in structured output: no calculations asked for, and any it gives are left alone", async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35],
      reply: (body): OllamaChatReply =>
        isAnswer(body)
          ? {
              content: JSON.stringify({
                answer: "Revenue grew 20.4% [^1].",
                citations: [{ marker: 1, passage: "P1", location: "p. 1", quote: REVENUE }],
                calculations: [GROWTH({ revenue: 1, margin: 1 })[0]],
              }),
            }
          : { content: JSON.stringify({ tags: [] }) },
    });
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35.name, {
      documents: [ACME],
    });
    const asked = question("How much did Acme's revenue grow?");
    writeMind(client, [asked]);
    const { answerId, ended } = await askAndEnd(core, client, mind.id, asked.attrs.id);
    if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);

    const request = ollama.chats.find((chat) => isAnswer(chat.body))?.body ?? {};
    expect(JSON.stringify(request)).not.toMatch(/\bcalculations\b|\bcalculate\b|\[=1\]/);
    expect(JSON.stringify(request)).toContain("IncarnaMind has no calculation Tool for this model");
    expect(ended.payload).toMatchObject({ figures: [], uncalculated: 0, figureRetry: null });
    expect(answerIn(client, answerId).textContent).toBe("Revenue grew 20.4% .");
  });
});

const marginChange = (citation: number, values = [0.412, 0.389]) => [
  {
    marker: 1,
    label: "Change in gross margin (percentage points)",
    formula: "gm2025 - gm2024",
    shown: `${(((values[0] ?? 0) - (values[1] ?? 0)) * 100).toFixed(1)} percentage points`,
    inputs: [
      { name: "gm2025", label: "Gross margin 2025", citation, value: values[0] },
      { name: "gm2024", label: "Gross margin 2024", citation, value: values[1] },
    ],
  },
];

/**
 * A model that searches, then makes each of `steps` in turn, one request each, from the Passage
 * its search showed it; asked again after the last, it writes nothing more.
 */
function steppingModel(steps: ((passage: string) => { text?: string; calls: Call[] })[]) {
  let made = 0;
  return scriptedModel(
    (call) => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) {
        return { calls: [{ tool: "search_documents", input: { query: "Acme revenue margin" } }] };
      }
      const step = steps[made++];
      return step ? step(passageOf(shownPassages(searched.text), "Acme")) : { text: "" };
    },
    { generate: judgesNothing },
  );
}

/** A `cite` call with one record, for `marker`'s quote on `location`. */
const citeOne = (passage: string, marker: number, location: string, quote: string): Call => ({
  tool: "cite",
  input: { citations: [{ marker, passage, location, quote }] },
});

describe("A fix asked for in one step is still owed in the next (#489)", {
  timeout: 60_000,
}, () => {
  // Written then cited, the Run ends once every marker has its record; citing first, a step that
  // wrote no marker is asked again, as before.
  const paths = [
    ["writes then cites", true, 4],
    ["cites first", false, 5],
  ] as const;

  test.each(paths)(
    "%s: a quote cite refused, then a step that only calculates: the Run goes on until the quote is fixed",
    async (_, writes, requests) => {
      const model = steppingModel([
        (passage) => ({
          text: "Revenue was $1,482.6 million in 2025[^1]; gross margin rose [=1][^2].",
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  {
                    marker: 1,
                    passage,
                    location: "p. 1",
                    quote: "Revenue was $9 million in 2025.",
                  },
                  { marker: 2, passage, location: "p. 2", quote: MARGIN },
                ],
              },
            },
          ],
        }),
        () => ({ calls: [{ tool: "calculate", input: { figures: marginChange(2) } }] }),
        (passage) => ({ calls: [citeOne(passage, 1, "p. 1", REVENUE)] }),
      ]);
      const { core } = await setUpCalculating(model, [ACME], undefined, {
        answerPaths: { writesThenCites: () => writes },
      });

      const { answer } = await askAndRead(core, "How did Acme do in 2025?");

      expect(answerRequests(model)).toHaveLength(requests);
      expect(answer.citations.map((citation) => citation.check)).toEqual(["found", "found"]);
      expect(answer.figures.map((figure) => figure.shown)).toEqual(["2.3 percentage points"]);
    },
  );

  test.each(paths)(
    "%s: a figure calculate refused, then a step that only cites: the Run goes on until the figure is fixed",
    async (_, writes, requests) => {
      const cited = (passage: string) => citeOne(passage, 1, "p. 2", MARGIN);
      const model = steppingModel([
        (passage) => ({
          text: "Gross margin rose [=1][^1].",
          calls: [
            cited(passage),
            { tool: "calculate", input: { figures: marginChange(1, [0.45, 0.389]) } },
          ],
        }),
        (passage) => ({ calls: [cited(passage)] }),
        () => ({ calls: [{ tool: "calculate", input: { figures: marginChange(1) } }] }),
      ]);
      const { core } = await setUpCalculating(model, [ACME], undefined, {
        answerPaths: { writesThenCites: () => writes },
      });

      const { answer } = await askAndRead(core, "How did Acme's margin change in 2025?");

      expect(answerRequests(model)).toHaveLength(requests);
      expect(answer.figures.map((figure) => figure.shown)).toEqual(["2.3 percentage points"]);
    },
  );

  test.each(paths)(
    "%s: two quotes refused, then fixed one cite at a time: the Run goes on until both are",
    async (_, writes, requests) => {
      const model = steppingModel([
        (passage) => ({
          text: "Revenue was $1,482.6 million in 2025[^1]. Gross margin was 41.2%[^2].",
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  {
                    marker: 1,
                    passage,
                    location: "p. 1",
                    quote: "Revenue was $9 million in 2025.",
                  },
                  { marker: 2, passage, location: "p. 2", quote: "Gross margin 99.9%" },
                ],
              },
            },
          ],
        }),
        (passage) => ({ calls: [citeOne(passage, 1, "p. 1", REVENUE)] }),
        (passage) => ({ calls: [citeOne(passage, 2, "p. 2", MARGIN)] }),
      ]);
      const { core } = await setUpCalculating(model, [ACME], undefined, {
        answerPaths: { writesThenCites: () => writes },
      });

      const { answer } = await askAndRead(core, "How did Acme do in 2025?");

      expect(answerRequests(model)).toHaveLength(requests);
      expect(answer.citations.map(quoteCheck)).toEqual(["found", "found"]);
    },
  );

  /** Writes the revenue sentence marked [^1] and the margin sentence unmarked, citing both: [^2] as `margin` says. */
  const writesOneMarker = (margin: { passage?: string; quote: string }) => (passage: string) => ({
    text: "Revenue was $1,482.6 million in 2025[^1]. Gross margin was 41.2% in 2025.",
    calls: [
      {
        tool: "cite",
        input: {
          citations: [
            { marker: 1, passage, location: "p. 1", quote: REVENUE },
            {
              marker: 2,
              passage: margin.passage ?? passage,
              location: "p. 2",
              quote: margin.quote,
            },
          ],
        },
      },
    ],
  });

  test.each([
    ["writes then cites", true],
    ["cites first", false],
  ])(
    "%s: a record whose marker isn't written, good: the Run ends with it and its marker is placed",
    async (_, writes) => {
      const model = steppingModel([writesOneMarker({ quote: MARGIN })]);
      const { core } = await setUpCalculating(model, [ACME], undefined, {
        answerPaths: { writesThenCites: () => writes },
      });

      const { answer } = await askAndRead(core, "How did Acme do in 2025?");

      expect(answerRequests(model)).toHaveLength(2);
      expect(answer.text).toContain("[^2]");
      expect(answer.citations.map(quoteCheck)).toEqual(["found", "found"]);
    },
  );

  test.each([
    ["writes then cites", "a quote the Passage doesn't hold", true, 3],
    ["cites first", "a quote the Passage doesn't hold", false, 4],
    ["writes then cites", "a Passage it wasn't shown", true, 3],
    ["cites first", "a Passage it wasn't shown", false, 4],
  ])(
    "%s: a record whose marker isn't written, refused for %s, then fixed: the Run goes on until it is, and its marker is placed",
    async (_, refused, writes, requests) => {
      const margin =
        refused === "a Passage it wasn't shown"
          ? { passage: "P999", quote: MARGIN }
          : { quote: "Gross margin 99.9%" };
      const model = steppingModel([
        writesOneMarker(margin),
        (passage) => ({ calls: [citeOne(passage, 2, "p. 2", MARGIN)] }),
      ]);
      const { core } = await setUpCalculating(model, [ACME], undefined, {
        answerPaths: { writesThenCites: () => writes },
      });

      const { answer } = await askAndRead(core, "How did Acme do in 2025?");

      expect(answerRequests(model)).toHaveLength(requests);
      expect(answer.text).toContain("[^2]");
      expect(answer.citations.map(quoteCheck)).toEqual(["found", "found"]);
    },
  );

  test.each([
    ["writes then cites", true],
    ["cites first", false],
  ])(
    "%s: a record whose marker isn't written, refused and never fixed: its marker is placed, not found",
    async (_, writes) => {
      const model = steppingModel([writesOneMarker({ quote: "Gross margin 99.9%" })]);
      const { core } = await setUpCalculating(model, [ACME], undefined, {
        answerPaths: { writesThenCites: () => writes },
      });

      const { answer } = await askAndRead(core, "How did Acme do in 2025?");

      expect(answerRequests(model)).toHaveLength(3);
      expect(answer.text).toContain("[^2]");
      expect(answer.citations.map(quoteCheck)).toEqual(["found", "not-found"]);
    },
  );

  test.each([
    ["writes then cites", true],
    ["cites first", false],
  ])(
    "%s: a fix still owed when the Run stops at its step limit: the record's marker is placed, not found",
    async (_, writes) => {
      const refused = writesOneMarker({ quote: "Gross margin 99.9%" });
      const model = scriptedModel(
        (call) => {
          const searched = call.results.find((result) => result.tool === "search_documents");
          if (!searched) {
            return {
              calls: [{ tool: "search_documents", input: { query: "Acme revenue margin" } }],
            };
          }
          const passage = passageOf(shownPassages(searched.text), "Acme");
          return call.results.some((result) => result.tool === "cite")
            ? { calls: [citeOne(passage, 2, "p. 2", "Gross margin 99.9%")] }
            : refused(passage);
        },
        { generate: judgesNothing },
      );
      const { core } = await setUpCalculating(model, [ACME], undefined, {
        answerPaths: { writesThenCites: () => writes },
      });

      const { answer } = await askAndRead(core, "How did Acme do in 2025?");

      expect(answerRequests(model).length).toBeGreaterThan(3);
      expect(answer.text).toContain("[^2]");
      expect(answer.citations.map(quoteCheck)).toEqual(["found", "not-found"]);
    },
  );

  test("writes then cites: a written marker with no record: the Run goes on until it has one", async () => {
    const model = steppingModel([
      (passage) => ({
        text: "Revenue was $1,482.6 million in 2025[^1]. Gross margin was 41.2%[^2].",
        calls: [citeOne(passage, 1, "p. 1", REVENUE)],
      }),
      (passage) => ({ calls: [citeOne(passage, 2, "p. 2", MARGIN)] }),
    ]);
    const { core } = await setUpCalculating(model, [ACME], undefined, {
      answerPaths: { writesThenCites: () => true },
    });

    const { answer } = await askAndRead(core, "How did Acme do in 2025?");

    expect(answerRequests(model)).toHaveLength(3);
    expect(answer.citations.map(quoteCheck)).toEqual(["found", "found"]);
  });

  test("cites first: what the model writes after its fix is the rest of the Answer", async () => {
    const model = steppingModel([
      (passage) => ({
        text: "Revenue was $1,482.6 million in 2025[^1].",
        calls: [citeOne(passage, 1, "p. 1", "Revenue was $9 million in 2025.")],
      }),
      (passage) => ({ calls: [citeOne(passage, 1, "p. 1", REVENUE)] }),
      () => ({ text: "Acme grew in every quarter.", calls: [] }),
    ]);
    const { core } = await setUpCalculating(model, [ACME], undefined, {
      answerPaths: { writesThenCites: () => false },
    });

    const { answer } = await askAndRead(core, "How did Acme do in 2025?");

    expect(answerRequests(model)).toHaveLength(4);
    expect(answer.text).toBe(
      "Revenue was $1,482.6 million in 2025[^1].\n\nAcme grew in every quarter.",
    );
    expect(answer.citations.map(quoteCheck)).toEqual(["found"]);
  });
});
