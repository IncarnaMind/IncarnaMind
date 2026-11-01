/**
 * Calculated figures (#438, ADR-0021): an Answer's model names each input's
 * number in a quote and a formula; IncarnaMind reads the numbers, checks the
 * quotes and does the arithmetic, and the Answer shows the result where the
 * model wrote its marker ("[=1]"). Through the core's public interface, as the
 * assistant uses it, with a scripted chat model (and, for structured output, a
 * stub of a small local model).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  type ConversationAnswer,
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type MarkedFigure,
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
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { askAndEnd, isAnswer, QWEN35, setUpLocalModel } from "../helpers/localModels";
import { answerIn, question, writeMind } from "../helpers/minds";
import { answerRequests, promptOf, scriptedModel, scriptedModels } from "../helpers/models";
import { docxOf, xlsxOf, xlsxPackage } from "../helpers/office";
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

const INCOME = "营业收入 152,340.56 121,883.20";

/** A Chinese annual report's income statement, its amounts in 万元 stated only in its heading. */
const REPORT = {
  name: "某公司2025年年度报告.pdf",
  contents: buildPdf([{ chineseLines: ["合并利润表", "单位：万元", INCOME] }]),
};

/** The report of #577: its amounts in 万元, stated only in its heading. */
const CHENGHU_INCOME = "营业收入 120,345.67 98,765.43";
const CHENGHU = {
  name: "澄湖科技2025年年度报告.pdf",
  contents: buildPdf([
    { chineseLines: ["合并利润表", "单位：万元　币种：人民币", CHENGHU_INCOME] },
  ]),
};

/** A completion statement (#978): a sale price and three deductions, each in brackets. */
const SALE_LINES = [
  "Sale price £385,000.00",
  "Less: estate agent's fee (£4,620.00)",
  "Less: legal fees (£1,500.00)",
  "Less: search and other costs (£804.00)",
];
const COMPLETION = {
  name: "Completion statement 14 Mill Lane.pdf",
  contents: buildPdf([{ lines: ["Completion statement: 14 Mill Lane", ...SALE_LINES] }]),
};

const SALE_LINES_ZH = [
  "成交价 3,850,000.00",
  "减：中介费 （46,200.00）",
  "减：律师费 （15,000.00）",
  "减：其他费用 （8,040.00）",
];
const COMPLETION_ZH = {
  name: "房产交易结算表.pdf",
  contents: buildPdf([{ chineseLines: ["房产交易结算表", ...SALE_LINES_ZH] }]),
};

/** Cites each line of a statement as a marker from 1, then makes `calls` over those markers. */
const citeStatement =
  (name: string, lines: readonly string[], calls: (cited: number[]) => Call[]) =>
  (passages: ShownPassage[]): Call[] => {
    const passage = passageOf(passages, name);
    // A PDF's Passage is shown with its pages, any other's with its location.
    const location = passages.find((each) => each.id === passage)?.location ?? "p. 1";
    const citations = lines.map((quote, index) => ({
      marker: index + 1,
      passage,
      location,
      quote,
    }));
    return [{ tool: "cite", input: { citations } }, ...calls(lines.map((_, index) => index + 1))];
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
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length < plan.queries.length) {
      return {
        calls: [{ tool: "search_documents", input: { query: plan.queries[searches.length] } }],
      };
    }
    const step = plan.steps[call.index - plan.queries.length];
    if (step) return { calls: step(searches.flatMap((each) => shownPassages(each.text))) };
    return { text: plan.answer };
  });
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
 * A core whose chat model is Claude Haiku 5.5, scripted: a model measured to
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
) {
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
    createChatModel: scriptedModels(model).createChatModel,
    ...overrides,
    answerPaths: { retrievesFirst: () => false, ...overrides.answerPaths },
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
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
    label: "Revenue growth 2025",
    formula: "rev2025 / rev2024 - 1",
    as: "percent",
    inputs: [
      {
        name: "rev2025",
        label: "Revenue 2025",
        citation: cited.revenue,
        number: "$1,482.6 million",
      },
      {
        name: "rev2024",
        label: "Revenue 2024",
        citation: cited.revenue,
        number: "$1,231.0 million",
      },
    ],
  },
  {
    marker: 2,
    label: "Change in gross margin",
    formula: "gm2025 - gm2024",
    inputs: [
      { name: "gm2025", label: "Gross margin 2025", citation: cited.margin, number: "41.2%" },
      { name: "gm2024", label: "Gross margin 2024", citation: cited.margin, number: "38.9%" },
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
    // The model is told what each came to, with the numbers it read, in one line each.
    expect(told(model, "calculate")).toEqual([
      [
        "Recorded [=1] = 20.4% (Revenue growth 2025: $1,482.6 million ÷ $1,231.0 million − 1).",
        "Recorded [=2] = 2.3 percentage points (Change in gross margin: 41.2% − 38.9%).",
        "Write each marker in its number's place, in the text or a table's cell, as in \"grew [=1] in 2025\": it shows the number with its unit, so write neither beside it.",
      ].join("\n"),
    ]);
    // A difference of two percents is in percentage points, never "2.3%".
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
        label: "Revenue growth 2025",
        formula: "rev2025 / rev2024 - 1",
        shown: "20.4%",
        unit: { kind: "ratio" },
        show: { language: "en", as: "percent", decimals: null, scale: null },
        engine: 1,
        written: null,
        inputs: [
          {
            name: "rev2025",
            label: "Revenue 2025",
            citation: { quote: REVENUE, check: "found", pageFrom: 1, pageTo: 1 },
            number: {
              chars: "$1,482.6 million",
              at: REVENUE.indexOf("$1,482.6"),
              value: 1_482_600_000,
              unit: { kind: "currency", code: "USD" },
              decimals: 1,
              reading: null,
            },
            cell: null,
            unitStatement: null,
          },
          { name: "rev2024", number: { chars: "$1,231.0 million", value: 1_231_000_000 } },
        ],
      },
      {
        marker: 2,
        shown: "2.3 percentage points",
        unit: { kind: "points" },
        inputs: [
          { citation: { quote: MARGIN, check: "found", pageFrom: 2 }, number: { chars: "41.2%" } },
          { number: { chars: "38.9%", value: 0.389 } },
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

  test("a Chinese 同比增长 cancels its 单位; an amount needs the heading's 单位：万元 as unitQuote, never guessed", async () => {
    const figure = (marker: number, formula: string, unitQuote?: string) => ({
      marker,
      label: marker === 1 ? "2025年营业收入同比增长" : "2025年营业收入增加额",
      formula,
      ...(marker === 1 && { as: "percent", decimals: 2 }),
      inputs: [
        { name: "y2025", label: "2025年营业收入", citation: 1, position: 1, unitQuote },
        { name: "y2024", label: "2024年营业收入", citation: 1, position: 2, unitQuote },
      ],
    });
    const model = calculatingModel({
      queries: ["营业收入"],
      steps: [
        (passages) => [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passageOf(passages, "某公司"),
                  location: "p. 1",
                  quote: INCOME,
                },
              ],
            },
          },
          {
            tool: "calculate",
            input: { figures: [figure(1, "y2025 / y2024 - 1"), figure(2, "y2025 - y2024")] },
          },
        ],
        () => [
          { tool: "calculate", input: { figures: [figure(2, "y2025 - y2024", "单位：万元")] } },
        ],
      ],
      answer: "2025年营业收入同比增长[=1]，比上年增加[=2][^1]。",
    });
    const { core } = await setUpCalculating(model, [REPORT]);

    const { answer } = await askAndRead(core, "公司2025年营业收入同比增长多少？比上年增加了多少？");

    const [first, second] = told(model, "calculate");
    expect(first).toBe(
      [
        "Recorded [=1] = 24.99% (2025年营业收入同比增长: 152,340.56 ÷ 121,883.20 − 1).",
        "Fix these with another calculate call:",
        '- [=2] y2025: 152,340.56 has no unit, and p. 1 says "单位：万元"; give that line as unitQuote.',
        '- [=2] y2024: 121,883.20 has no unit, and p. 1 says "单位：万元"; give that line as unitQuote.',
      ].join("\n"),
    );
    expect(second).toMatch(/^Recorded \[=2\] = 30,457\.36万元 \(2025年营业收入增加额: /);
    expect(shown(answerBlocks(answer))).toBe(
      "2025年营业收入同比增长24.99%，比上年增加30,457.36万元。",
    );
    expect(answer.figures).toMatchObject([
      { marker: 1, shown: "24.99%", inputs: [{ unitStatement: null }, { unitStatement: null }] },
      {
        marker: 2,
        shown: "30,457.36万元",
        unit: { kind: "currency", code: "CNY" },
        show: { language: "zh-CN" },
        inputs: [
          {
            number: { chars: "152,340.56", value: 1_523_405_600, scale: 10_000, scaleWord: "万" },
            unitStatement: {
              citation: { quote: "单位：万元", check: "found", pageFrom: 1 },
              scale: 10_000,
              scaleWord: "万",
              currency: "CNY",
            },
          },
          { number: { chars: "121,883.20", value: 1_218_832_000 } },
        ],
      },
    ]);
  });

  // protects=#577: a formula that divides an amount by 10000 to show 亿 is refused with a line that names scale, and scale shows it right; fails_when=the figure comes out 10,000 times too small, or the line doesn't say how to ask for the scale; no_claim=every way a power of ten can be written (tests/shared/formula.test.ts).
  test("a formula that turns 万元 into 亿元 itself is refused, and scale: 亿 shows the amount in 亿元 (#577)", async () => {
    const total = (formula: string, show: object = {}) => ({
      marker: 1,
      label: "2025年营业收入合计",
      formula,
      ...show,
      inputs: [
        {
          name: "rev25",
          label: "2025年营业收入",
          citation: 1,
          number: "120,345.67",
          unitQuote: "单位：万元　币种：人民币",
        },
      ],
    });
    const model = calculatingModel({
      queries: ["营业收入"],
      steps: [
        (passages) => [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passageOf(passages, "澄湖科技"),
                  location: "p. 1",
                  quote: CHENGHU_INCOME,
                },
              ],
            },
          },
          { tool: "calculate", input: { figures: [total("rev25 / 10000")] } },
        ],
        () => [
          {
            tool: "calculate",
            input: { figures: [total("rev25", { scale: "亿", decimals: 2 })] },
          },
        ],
      ],
      answer: "2025年营业收入合计为 [=1] 亿元[^1]。",
    });
    const { core } = await setUpCalculating(model, [CHENGHU]);

    const { answer } = await askAndRead(core, "2025年营业收入合计多少亿元？");

    expect(told(model, "calculate")).toEqual([
      [
        "Nothing was recorded.",
        "Fix these with another calculate call:",
        '- [=1]: rev25 / 10000 changes the scale itself, but inputs are already in base units (万 applied); to show it in 亿, give scale: "亿" and write rev25 in place of rev25 / 10000.',
      ].join("\n"),
      expect.stringMatching(/^Recorded \[=1\] = 12\.03亿元 \(2025年营业收入合计: 120,345\.67\)\./),
    ]);
    expect(shown(answerBlocks(answer))).toBe("2025年营业收入合计为 12.03亿元。");
    expect(answer.figures).toMatchObject([
      { marker: 1, value: 1_203_456_700, shown: "12.03亿元", written: null },
    ]);
  });

  // protects=the English analogues of #577 are refused both ways, naming the scale meant, while a power of ten that makes a rate per so many stands; fails_when="/ 1000" for billions or "* 1000" for millions is recorded, or "per 10,000 users" is refused; no_claim=Chinese, tested above.
  test("in English, millions made billions and billions made millions are refused; a rate per 10,000 users isn't", async () => {
    const ASSETS = "Total assets were $12.4 billion at the end of 2025.";
    const USERS = "Users at the end of 2025: 3,120,000";
    const facts = {
      name: "Acme Facts 2025.pdf",
      contents: buildPdf([{ lines: ["Acme Facts 2025", REVENUE, ASSETS, USERS] }]),
    };
    const figures = (first: object, second: object) => [
      {
        marker: 1,
        label: "Revenue 2025",
        inputs: [{ name: "rev", label: "Revenue 2025", citation: 1, number: "$1,482.6 million" }],
        ...first,
      },
      {
        marker: 2,
        label: "Total assets 2025",
        inputs: [
          { name: "assets", label: "Total assets 2025", citation: 2, number: "$12.4 billion" },
        ],
        ...second,
      },
    ];
    const perUsers = {
      marker: 3,
      label: "Revenue per 10,000 users 2025",
      formula: "rev / (users / 10000)",
      inputs: [
        { name: "rev", label: "Revenue 2025", citation: 1, number: "$1,482.6 million" },
        { name: "users", label: "Users 2025", citation: 3, number: "3,120,000" },
      ],
    };
    const model = calculatingModel({
      queries: ["revenue assets users"],
      steps: [
        (passages) => {
          const passage = passageOf(passages, "Acme Facts");
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage, location: "p. 1", quote: REVENUE },
                  { marker: 2, passage, location: "p. 1", quote: ASSETS },
                  { marker: 3, passage, location: "p. 1", quote: USERS },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  ...figures({ formula: "rev / 1000" }, { formula: "assets * 1000" }),
                  perUsers,
                ],
              },
            },
          ];
        },
        () => [
          {
            tool: "calculate",
            input: {
              figures: figures(
                { formula: "rev", scale: "billion", decimals: 2 },
                { formula: "assets", scale: "million" },
              ),
            },
          },
        ],
      ],
      answer:
        "Revenue was [=1] in 2025[^1], total assets [=2][^2], and revenue per 10,000 users [=3][^3].",
    });
    const { core } = await setUpCalculating(model, [facts]);

    const { answer } = await askAndRead(
      core,
      "What were Acme's revenue in billions and assets in millions?",
    );

    const [first, second] = told(model, "calculate");
    expect(first).toBe(
      [
        "Recorded [=3] = $4.8 million (Revenue per 10,000 users 2025: $1,482.6 million ÷ (3,120,000 ÷ 10000)).",
        "Fix these with another calculate call:",
        '- [=1]: rev / 1000 changes the scale itself, but inputs are already in base units (million applied); to show it in billion, give scale: "billion" and write rev in place of rev / 1000.',
        '- [=2]: assets * 1000 changes the scale itself, but inputs are already in base units (billion applied); to show it in million, give scale: "million" and write assets in place of assets * 1000.',
      ].join("\n"),
    );
    expect(second).toMatch(
      /^Recorded \[=1\] = \$1\.48 billion .*\nRecorded \[=2\] = \$12,400 million /,
    );
    expect(shown(answerBlocks(answer))).toBe(
      "Revenue was $1.48 billion in 2025, total assets $12,400 million, and revenue per 10,000 users $4.8 million.",
    );
  });

  // protects=#577's doubled word: a scale the model writes after its marker never shows beside the figure's own, and one that isn't the figure's is stored as what the Answer wrote; fails_when="万元 亿元" reads in the Answer, or the differing scale is lost; no_claim=how #439 shows it.
  test("a scale written after a marker isn't shown twice; one that isn't the figure's is kept as what the Answer wrote (#577)", async () => {
    const model = calculatingModel({
      queries: ["营业收入"],
      steps: [
        (passages) => [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passageOf(passages, "澄湖科技"),
                  location: "p. 1",
                  quote: CHENGHU_INCOME,
                },
              ],
            },
          },
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "2025年营业收入",
                  formula: "rev25",
                  inputs: [
                    {
                      name: "rev25",
                      label: "2025年营业收入",
                      citation: 1,
                      number: "120,345.67",
                      unitQuote: "单位：万元　币种：人民币",
                    },
                  ],
                },
              ],
            },
          },
        ],
      ],
      answer: "2025年营业收入合计为 [=1] 亿元[^1]，报告列示为 [=1]万元。",
    });
    const { core } = await setUpCalculating(model, [CHENGHU]);

    const { answer } = await askAndRead(core, "2025年营业收入合计多少亿元？");

    expect(shown(answerBlocks(answer))).toBe(
      "2025年营业收入合计为 120,345.67万元，报告列示为 120,345.67万元。",
    );
    expect(answer.figures).toMatchObject([{ marker: 1, shown: "120,345.67万元", written: "亿元" }]);
  });

  test("every input and formula it can't work out is told to the model in one line, and nothing is recorded for it", async () => {
    const NOTES = [
      "# Results",
      "",
      REVENUE,
      "",
      "Units sold were 4,812 in 2025 and 4,812 in 2024.",
      "",
      "Prices in Tokyo were ¥1,200 a unit.",
      "",
      "Growth of 2–3% is expected next year.",
      "",
      "Losses were 0 in 2024.",
      "",
      "Gross margin was 41.2% in 2025.",
      "",
      "Revenue in China was 8.1亿元.",
    ].join("\n");
    const quote = (passage: string, text: string) => ({
      passage,
      location: "§ Results",
      quote: text,
    });
    const model = calculatingModel({
      queries: ["revenue units prices growth losses margin", "stock"],
      steps: [
        (passages) => {
          const notes = passageOf(passages, "Notes");
          const stock = passageOf(passages, "Stock");
          const one = (name: string, text: string, number: string, more: object = {}) => ({
            name,
            label: name,
            ...quote(notes, text),
            number,
            ...more,
          });
          const figures = [
            {
              marker: 1,
              formula: "a",
              inputs: [
                {
                  name: "a",
                  label: "a",
                  passage: "P9",
                  quote: "Revenue was $9 million.",
                  number: "$9 million",
                },
              ],
            },
            {
              marker: 2,
              formula: "a",
              inputs: [{ name: "a", label: "a", citation: 4, number: "1" }],
            },
            {
              marker: 3,
              formula: "a",
              inputs: [one("a", "Revenue was $9 million in 2025.", "$9 million")],
            },
            { marker: 4, formula: "a", inputs: [one("a", REVENUE, "1.25亿")] },
            {
              marker: 5,
              formula: "a",
              inputs: [one("a", "Units sold were 4,812 in 2025 and 4,812 in 2024.", "4,812")],
            },
            {
              marker: 6,
              formula: "a",
              inputs: [
                { name: "a", label: "a", passage: stock, quote: "Stock 1,234", number: "1,234" },
              ],
            },
            {
              marker: 7,
              formula: "a",
              inputs: [one("a", "Prices in Tokyo were ¥1,200 a unit.", "¥1,200")],
            },
            {
              marker: 8,
              formula: "rev_us + rev_cn",
              inputs: [
                one("rev_us", REVENUE, "$1,482.6 million"),
                one("rev_cn", "Revenue in China was 8.1亿元.", "8.1亿元"),
              ],
            },
            {
              marker: 9,
              formula: "margin + rev",
              inputs: [
                one("margin", "Gross margin was 41.2% in 2025.", "41.2%"),
                one("rev", REVENUE, "$1,482.6 million"),
              ],
            },
            {
              marker: 10,
              formula: "share",
              inputs: [one("share", "Growth of 2–3% is expected next year.", "2–3%")],
            },
            {
              marker: 11,
              formula: "(a + b))",
              inputs: [
                one("a", REVENUE, "$1,482.6 million"),
                one("b", REVENUE, "$1,231.0 million"),
              ],
            },
            { marker: 12, formula: "rev2026 / a", inputs: [one("a", REVENUE, "$1,482.6 million")] },
            { marker: 13, formula: "VLOOKUP(a)", inputs: [one("a", REVENUE, "$1,482.6 million")] },
            {
              marker: 14,
              formula: "a / losses",
              inputs: [
                one("a", REVENUE, "$1,482.6 million"),
                one("losses", "Losses were 0 in 2024.", "0"),
              ],
            },
          ];
          return [{ tool: "calculate", input: { figures } }];
        },
        () => [
          {
            tool: "calculate",
            input: {
              figures: Array.from({ length: 21 }, (_, index) => ({
                marker: index + 1,
                formula: "a",
                inputs: [],
              })),
            },
          },
        ],
      ],
      answer: "The figures couldn't be worked out.",
    });
    const { core } = await setUpCalculating(model, [
      { name: "Notes.md", contents: NOTES },
      { name: "Stock.txt", contents: "Stock 1,234" },
    ]);

    const { answer } = await askAndRead(core, "What do the notes say about the numbers?");

    const [first, second] = told(model, "calculate");
    expect(first?.split("\n")).toEqual([
      "Nothing was recorded.",
      "Fix these with another calculate call:",
      `- [=1] a: there is no Passage "P9" in your search results; use a Passage's id, such as P1.`,
      "- [=2] a: [^4] isn't recorded; record it with cite first, or give passage, location and quote.",
      "- [=3] a: the quote isn't word for word at § Results in P1; copy it exactly, and check where it is.",
      '- [=4] a: the quote has no number "1.25亿"; it has $1,482.6 million, $1,231.0 million.',
      '- [=5] a: "4,812" is in the quote 2 times; give its position (1 or 2).',
      '- [=6] a: "1,234" can be read two ways in this Document; give reading: 1 for 1234, 2 for 1.234.',
      '- [=7] a: "¥1,200" could be CNY or JPY here; quote the line that names its currency as unitQuote.',
      "- [=8]: rev_us is USD and rev_cn is CNY; add an exchange rate as a cited input.",
      "- [=9]: can't add an amount in USD (rev) to a percent (margin).",
      '- [=10] share: "2–3%" is a range; give reading: 1 for 2%, 2 for 3%.',
      '- [=11]: formula: unexpected ")" at character 8.',
      "- [=12]: the formula uses rev2026, which isn't one of its inputs (a).",
      "- [=13]: VLOOKUP isn't available; use + - * / ^, SUM, AVERAGE, MIN, MAX, ABS, SIGN, ROUND, RRI, SQRT.",
      "- [=14]: losses is 0, so the formula divides by zero.",
    ]);
    expect(second).toBe(
      "Nothing was recorded. Fix these with another calculate call:\n- At most 20 figures in one call, and 30 inputs in one figure.",
    );
    expect(answer.figures).toEqual([]);
    expect(calculateCall(answer)).toBeUndefined();
  });

  test("a number the model wrote right before its marker is shown once when it is the figure, and kept and flagged when it isn't; markers in code stay, and one with no figure goes", async () => {
    const model = calculatingModel({
      queries: ["revenue gross margin"],
      steps: [citeAndCalculate],
      answer:
        "Revenue grew 20.4% [=1] in 2025, gross margin rose 2.3% [=2], costs fell [=9], and `[=1]` is how it is written.",
    });
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer, finished } = await askAndRead(core, "How did Acme do in 2025?");

    expect(shown(answerBlocks(answer))).toBe(
      "Revenue grew 20.4% in 2025, gross margin rose 2.3% 2.3 percentage points, costs fell, and [=1] is how it is written.",
    );
    expect(answer.figures).toMatchObject([
      { marker: 1, shown: "20.4%", written: null },
      { marker: 2, shown: "2.3 percentage points", written: "2.3%" },
    ]);
    expect(finished.uncalculated).toBe(1);
    expect(calculateCall(answer)).toMatchObject({ resultCount: 2, uncalculated: 1 });
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
              formula,
              as: "percent",
              inputs: [
                // Only a name is needed; what some models call the number as written, "value", reads the same.
                {
                  name: "a",
                  passage: passageOf(passages, "Acme"),
                  location: "p. 1",
                  quote: REVENUE,
                  value: "$1,482.6 million",
                },
                {
                  name: "b",
                  passage: passageOf(passages, "Acme"),
                  location: "p. 1",
                  quote: REVENUE,
                  number: "$1,231.0 million",
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
      /^Recorded \[=1\] = -17\.0% \(\$1,231\.0 million ÷ \$1,482\.6 million − 1\)\. It replaces the earlier \[=1\] = 20\.4%: give each figure a marker of its own\./,
    );
    expect(results[4]).toMatch(/^Recorded \[=1\]/);
    expect(results[5]).toBe(
      "You have called calculate enough for this Question: write the Answer now with the figures recorded, and say which numbers couldn't be calculated rather than working them out.",
    );
    expect(answer.figures).toMatchObject([
      {
        shown: "-17.0%",
        inputs: [{ name: "a", label: "a", number: { chars: "$1,482.6 million" } }, { name: "b" }],
      },
    ]);
  });

  test("a difference of percents asked for as a percent is shown in percentage points, and the model is told", async () => {
    const model = calculatingModel({
      queries: ["gross margin"],
      steps: [
        (passages) => {
          const [, margin] = GROWTH({ revenue: 1, margin: 1 });
          const passage = passageOf(passages, "Acme");
          return [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage, location: "p. 2", quote: MARGIN }] },
            },
            { tool: "calculate", input: { figures: [{ ...margin, as: "percent" }] } },
          ];
        },
      ],
      answer: "Gross margin rose [=2][^1].",
    });
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer } = await askAndRead(core, "How did Acme's gross margin change?");

    expect(told(model, "calculate")[0]?.split("\n")[0]).toBe(
      "Recorded [=2] = 2.3 percentage points (Change in gross margin: 41.2% − 38.9%). It is shown in its own unit: percentage points can't be shown as a percent; a difference of two percents is in percentage points.",
    );
    expect(answer.figures).toMatchObject([{ shown: "2.3 percentage points", show: { as: null } }]);
  });

  test("an Answer written beside calculate with no marker in it stands when the model writes no other", async () => {
    const model = scriptedModel((call) => {
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
    });
    const { core } = await setUpCalculating(model, [ACME]);

    const { answer } = await askAndRead(core, "How much did Acme's revenue grow?");

    expect(answer.text).toBe("Acme's revenue grew 20.4% in 2025.");
  });

  test("a workbook's input uses the number its cell stores, not the one it shows rounded", async () => {
    const styles = [
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>`,
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`,
      `<borders count="1"><border><left/><right/><top/><bottom/></border></borders>`,
      `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/></cellXfs>`,
    ].join("");
    const text = (ref: string, value: string) =>
      `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
    const share = (ref: string, value: number) => `<c r="${ref}" s="1"><v>${value}</v></c>`;
    const book = xlsxPackage({
      sheets: [
        {
          name: "Margins",
          xml: `<sheetData><row r="1">${text("A1", "Region")}${text("B1", "2025")}${text("C1", "2024")}</row><row r="2">${text("A2", "West")}${share("B2", 0.04213)}${share("C2", 0.0398)}</row></sheetData>`,
        },
      ],
      styles,
    });
    const model = calculatingModel({
      queries: ["West"],
      steps: [
        (passages) => {
          const passage = passageOf(passages, "Margins");
          const input = (name: string, number: string) => ({
            name,
            label: name,
            passage,
            location: "Margins, row 2",
            quote: "West\t4.2%\t4.0%",
            number,
          });
          return [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    formula: "m2025 - m2024",
                    decimals: 3,
                    inputs: [input("m2025", "4.2%"), input("m2024", "4.0%")],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "The West's margin rose [=1].",
    });
    const { core } = await setUpCalculating(model, [{ name: "Margins.xlsx", contents: book }]);

    const { answer } = await askAndRead(core, "How did the West's margin change?");

    expect(answer.figures).toMatchObject([
      {
        shown: "0.233 percentage points",
        inputs: [
          {
            number: { chars: "4.2%", value: 0.04213 },
            cell: { sheet: "Margins", ref: "B2", stored: 0.04213 },
          },
          { number: { chars: "4.0%", value: 0.0398 }, cell: { ref: "C2", stored: 0.0398 } },
        ],
      },
    ]);
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

describe("Amounts in brackets are negative (#978)", { timeout: 60_000 }, () => {
  const inputs = (cited: number[], numbers: string[]) =>
    ["price", "agent", "legal", "other"].map((name, index) => ({
      name,
      label: ["Sale price", "Agent's fee", "Legal fees", "Other costs"][index],
      citation: cited[index],
      number: numbers[index],
    }));
  const NUMBERS = ["£385,000.00", "(£4,620.00)", "(£1,500.00)", "(£804.00)"];
  const figure = (cited: number[], formula: string) => ({
    marker: 1,
    label: "Net sale proceeds",
    formula,
    inputs: inputs(cited, NUMBERS),
  });

  // protects=#978; fails_when=a deduction in brackets is read as positive, the net proceeds come out 391,924 or the working doesn't show each input's sign; no_claim=the wording of the Answer, which the scripted model writes.
  test("deductions in brackets are taken off: the net proceeds are 378,076, and each input is read as written", async () => {
    const model = calculatingModel({
      queries: ["sale price deductions"],
      steps: [
        citeStatement("Completion statement", SALE_LINES, (cited) => [
          {
            tool: "calculate",
            input: { figures: [figure(cited, "price + agent + legal + other")] },
          },
        ]),
      ],
      answer: "The net sale proceeds were [=1][^1].",
    });
    const { core } = await setUpCalculating(model, [COMPLETION]);

    const { answer } = await askAndRead(core, "What were the net sale proceeds of 14 Mill Lane?");

    expect(shown(answerBlocks(answer))).toBe("The net sale proceeds were £378,076.00.");
    expect(
      answer.figures[0]?.inputs.map((input) => [input.number.chars, input.number.value]),
    ).toEqual([
      ["£385,000.00", 385_000],
      ["(£4,620.00)", -4_620],
      ["(£1,500.00)", -1_500],
      ["(£804.00)", -804],
    ]);
    expect(told(model, "calculate")[0]).not.toContain("Check the sign");
    expect(told(model, "search_documents")[0]).toContain(
      "An amount in brackets in these Passages is negative",
    );
  });

  // protects=#978; fails_when=a formula that subtracts an amount in brackets is recorded without telling the model it adds it, or the model's fix is called a marker given twice; no_claim=that a model heeds the line, which a hand check with Claude Haiku 5.5 shows.
  test("a formula that subtracts them adds them: the model is told the sign it was read with, and its fix replaces the figure quietly", async () => {
    const model = calculatingModel({
      queries: ["sale price deductions"],
      steps: [
        citeStatement("Completion statement", SALE_LINES, (cited) => [
          {
            tool: "calculate",
            input: { figures: [figure(cited, "price - agent - legal - other")] },
          },
        ]),
        () => [
          {
            tool: "calculate",
            input: { figures: [figure([1, 2, 3, 4], "price + agent + legal + other")] },
          },
        ],
      ],
      answer: "The net sale proceeds were [=1][^1].",
    });
    const { core } = await setUpCalculating(model, [COMPLETION]);

    const { answer } = await askAndRead(core, "What were the net sale proceeds of 14 Mill Lane?");

    const [first, second] = told(model, "calculate");
    expect(first).toContain("Recorded [=1] = £391,924.00");
    expect(first).toContain(
      "Check the sign: agent is (£4,620.00), read as -4620; legal is (£1,500.00), read as -1500; other is (£804.00), read as -804, so subtracting them adds them.",
    );
    expect(second).toMatch(/^Recorded \[=1\] = £378,076\.00 /);
    expect(second).not.toContain("replaces");
    expect(shown(answerBlocks(answer))).toBe("The net sale proceeds were £378,076.00.");
  });

  // protects=#978; fails_when=a correct change between two losses, or from a loss to a profit, is told its sign is wrong; no_claim=the wording of the line a deduction gets.
  test.each([
    [
      "two losses",
      ["Loss for 2025 (£2,500.00)", "Loss for 2024 (£3,100.00)"],
      ["(£2,500.00)", "(£3,100.00)"],
      "£600.00",
    ],
    [
      "a profit and a loss",
      ["Profit for 2025 £800.00", "Loss for 2024 (£500.00)"],
      ["£800.00", "(£500.00)"],
      "£1,300.00",
    ],
  ])(
    "a difference between %s is recorded with no word about its sign",
    async (_name, lines, numbers, result) => {
      const input = (name: string, label: string, cited: number[], at: number) => ({
        name,
        label,
        citation: cited[at],
        number: numbers[at],
      });
      const model = calculatingModel({
        queries: ["profit loss"],
        steps: [
          citeStatement("Results", lines, (cited) => [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Change",
                    formula: "later - earlier",
                    inputs: [input("later", "2025", cited, 0), input("earlier", "2024", cited, 1)],
                  },
                ],
              },
            },
          ]),
        ],
        answer: "The change was [=1][^1].",
      });
      const results = {
        name: "Results.pdf",
        contents: buildPdf([{ lines: ["Results", ...lines] }]),
      };
      const { core } = await setUpCalculating(model, [results]);

      const { answer } = await askAndRead(core, "What was the change in the result?");

      expect(told(model, "calculate")[0]).toMatch(`Recorded [=1] = ${result} `);
      expect(told(model, "calculate")[0]).not.toContain("Check the sign");
      expect(shown(answerBlocks(answer))).toBe(`The change was ${result}.`);
    },
  );

  // protects=#978; fails_when=full-width brackets in a Chinese statement are read as positive; no_claim=English.
  test("in Chinese: （46,200.00） is minus 46,200, and the net proceeds are 3,780,760", async () => {
    const numbers = ["3,850,000.00", "（46,200.00）", "（15,000.00）", "（8,040.00）"];
    const model = calculatingModel({
      queries: ["成交价 中介费"],
      steps: [
        citeStatement("房产交易结算表", SALE_LINES_ZH, (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "净收入",
                  formula: "price + agent + legal + other",
                  inputs: inputs(cited, numbers),
                },
              ],
            },
          },
        ]),
      ],
      answer: "出售房产的净收入为[=1][^1]。",
    });
    const { core } = await setUpCalculating(model, [COMPLETION_ZH]);

    const { answer } = await askAndRead(core, "出售房产的净收入是多少？");

    expect(shown(answerBlocks(answer))).toBe("出售房产的净收入为3,780,760.00。");
    expect(answer.figures[0]?.inputs.map((input) => input.number.value)).toEqual([
      3_850_000, -46_200, -15_000, -8_040,
    ]);
  });
});

/** The statement of #1001: the currency is on the sale price, and the deductions below it are bare. */
const MIXED_LINES = [
  "Sale price £385,000.00",
  "Less: agent's fee (4,620.00)",
  "Less: legal fees (1,500.00)",
  "Less: search and other costs (804.00)",
];
const MIXED = {
  name: "Completion statement 14 Mill Lane.pdf",
  contents: buildPdf([{ lines: ["Completion statement: 14 Mill Lane", ...MIXED_LINES] }]),
};
const MIXED_ZH = {
  name: "房产交易结算表.pdf",
  contents: buildPdf([
    {
      chineseLines: [
        "房产交易结算表",
        "成交价 ¥3,850,000.00",
        "减：中介费 （46,200.00）",
        "减：律师费 （15,000.00）",
        "减：其他费用 （8,040.00）",
      ],
    },
  ]),
};

describe("A currency on a statement's first amount (#1001)", { timeout: 60_000 }, () => {
  const labels = ["Sale price", "Agent's fee", "Legal fees", "Other costs"];
  const inputs = (cited: number[], numbers: readonly string[], unitQuote: string) =>
    labels.map((label, index) => ({
      name: ["price", "agent", "legal", "other"][index],
      label,
      citation: cited[index],
      number: numbers[index],
      ...(index > 0 ? { unitQuote } : {}),
    }));
  const figure = (cited: number[], numbers: readonly string[], unitQuote: string) => ({
    marker: 1,
    label: "Net sale proceeds",
    formula: "price + agent + legal + other",
    inputs: inputs(cited, numbers, unitQuote),
  });
  const unitOf = (currency: string, chars: string, quote: string) => ({
    citation: { quote, check: "found" },
    scale: 1,
    scaleWord: null,
    currency,
    currencyChars: chars,
  });

  // protects=#1001; fails_when=a bare fee under "Sale price £385,000.00" has no currency, a second currency is guessed, or the input doesn't keep where its currency came from; no_claim=the wording of the Answer, which the scripted model writes.
  test("the sale price's £ is the bare fees' currency: £378,076.00, with each fee negative and its unit's line kept", async () => {
    const numbers = ["£385,000.00", "(4,620.00)", "(1,500.00)", "(804.00)"];
    const model = calculatingModel({
      queries: ["sale price deductions"],
      steps: [
        citeStatement("Completion statement", MIXED_LINES, (cited) => [
          {
            tool: "calculate",
            input: { figures: [figure(cited, numbers, "Sale price £385,000.00")] },
          },
        ]),
      ],
      answer: "The net sale proceeds were [=1][^1].",
    });
    const { core } = await setUpCalculating(model, [MIXED]);

    const { answer, finished } = await askAndRead(
      core,
      "What were the net sale proceeds of 14 Mill Lane?",
    );

    expect(shown(answerBlocks(answer))).toBe("The net sale proceeds were £378,076.00.");
    expect(
      answer.figures[0]?.inputs.map((input) => [input.number.chars, input.number.value]),
    ).toEqual([
      ["£385,000.00", 385_000],
      ["(4,620.00)", -4_620],
      ["(1,500.00)", -1_500],
      ["(804.00)", -804],
    ]);
    expect(answer.figures[0]?.inputs.map((input) => input.unitStatement)).toMatchObject([
      null,
      unitOf("GBP", "£", "Sale price £385,000.00"),
      unitOf("GBP", "£", "Sale price £385,000.00"),
      unitOf("GBP", "£", "Sale price £385,000.00"),
    ]);
    expect(finished.uncalculated).toBe(0);
  });

  test("in Chinese: ¥ on 成交价 is the bare fees' currency, and the net income is in 元", async () => {
    const numbers = ["¥3,850,000.00", "（46,200.00）", "（15,000.00）", "（8,040.00）"];
    const model = calculatingModel({
      queries: ["成交价 中介费"],
      steps: [
        citeStatement(
          "房产交易结算表",
          [
            "成交价 ¥3,850,000.00",
            "减：中介费 （46,200.00）",
            "减：律师费 （15,000.00）",
            "减：其他费用 （8,040.00）",
          ],
          (cited) => [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "净收入",
                    formula: "price + agent + legal + other",
                    inputs: inputs(cited, numbers, "成交价 ¥3,850,000.00"),
                  },
                ],
              },
            },
          ],
        ),
      ],
      answer: "出售房产的净收入为[=1][^1]。",
    });
    const { core } = await setUpCalculating(model, [MIXED_ZH]);

    const { answer } = await askAndRead(core, "出售房产的净收入是多少？");

    expect(shown(answerBlocks(answer))).toBe("出售房产的净收入为3,780,760.00元。");
    expect(answer.figures[0]?.inputs.map((input) => input.number.value)).toEqual([
      3_850_000, -46_200, -15_000, -8_040,
    ]);
    expect(answer.figures[0]?.inputs.slice(1).map((input) => input.unitStatement)).toMatchObject([
      unitOf("CNY", "¥", "成交价 ¥3,850,000.00"),
      unitOf("CNY", "¥", "成交价 ¥3,850,000.00"),
      unitOf("CNY", "¥", "成交价 ¥3,850,000.00"),
    ]);
  });

  // protects=#1001; fails_when=a statement in 万元 over a ¥ amount and bare fees reads the ¥ lines' currency without the scale, so the User sees 380.38元 instead of the amount in 万元.
  test("in Chinese, the scale's own line still applies it: the net income is in 万元", async () => {
    const lines = [
      "单位：万元",
      "成交价 ¥380.38",
      "减：中介费 （4.00）",
      "减：律师费 （1.50）",
      "减：其他费用 （0.80）",
    ];
    const statement = {
      name: "房产交易结算表.pdf",
      contents: buildPdf([{ chineseLines: ["房产交易结算表", ...lines] }]),
    };
    const numbers = ["¥380.38", "（4.00）", "（1.50）", "（0.80）"];
    const model = calculatingModel({
      queries: ["成交价 中介费"],
      steps: [
        citeStatement("房产交易结算表", lines.slice(1), (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "净收入",
                  formula: "price + agent + legal + other",
                  inputs: labels.map((label, index) => ({
                    name: ["price", "agent", "legal", "other"][index],
                    label,
                    citation: cited[index],
                    number: numbers[index],
                    unitQuote: "单位：万元",
                  })),
                },
              ],
            },
          },
        ]),
      ],
      answer: "出售房产的净收入为[=1][^1]。",
    });
    const { core } = await setUpCalculating(model, [statement]);

    const { answer } = await askAndRead(core, "出售房产的净收入是多少？");

    expect(shown(answerBlocks(answer))).toBe("出售房产的净收入为374.08万元。");
    expect(answer.figures[0]?.inputs.map((input) => input.number.value)).toEqual([
      3_803_800, -40_000, -15_000, -8_000,
    ]);
  });

  test("a Passage that names two currencies gives the bare fees neither, and the model is told why", async () => {
    const document = {
      name: "Completion statement 14 Mill Lane.pdf",
      contents: buildPdf([
        {
          lines: [
            "Completion statement: 14 Mill Lane",
            "Sale price £385,000.00",
            "Deposit $12,000.00",
            ...MIXED_LINES.slice(1),
          ],
        },
      ]),
    };
    const numbers = ["£385,000.00", "(4,620.00)", "(1,500.00)", "(804.00)"];
    const model = calculatingModel({
      queries: ["sale price deductions"],
      steps: [
        citeStatement("Completion statement", MIXED_LINES, (cited) => [
          {
            tool: "calculate",
            input: { figures: [figure(cited, numbers, "Sale price £385,000.00")] },
          },
        ]),
      ],
      answer: "The net sale proceeds were [=1][^1].",
    });
    const { core } = await setUpCalculating(model, [document]);

    const { answer, finished } = await askAndRead(
      core,
      "What were the net sale proceeds of 14 Mill Lane?",
    );

    expect(told(model, "calculate")[0]).toContain(
      'the unitQuote "Sale price £385,000.00" gives GBP, but p. 1 names more than one currency (GBP, USD); quote the line that applies, from a Passage that names one.',
    );
    expect(answer.figures).toEqual([]);
    expect(finished.uncalculated).toBe(1);
    expect(translate("en", "answer.figures.uncalculated.one")).toBe(
      "1 figure couldn’t be calculated",
    );
    expect(translate("zh-CN", "answer.figures.uncalculated.one")).toBe("1 个数字未能计算");
  });

  // protects=#1001; fails_when=a line that writes a currency for a one-decimal amount under a scale is recorded, so a User sees £380.4 for an amount in thousands.
  test("amounts without two decimals are refused, and the Answer reports the figure couldn't be calculated", async () => {
    const lines = ["All figures in thousands", "Sale price £380.4", "Less: agent's fee (4.0)"];
    const statement = {
      name: "Completion statement 14 Mill Lane.pdf",
      contents: buildPdf([{ lines: ["Completion statement: 14 Mill Lane", ...lines] }]),
    };
    const model = calculatingModel({
      queries: ["sale price deductions"],
      steps: [
        citeStatement("Completion statement", lines, (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "Net sale proceeds",
                  formula: "price + agent",
                  inputs: [
                    {
                      name: "price",
                      label: "Sale price",
                      citation: cited[1],
                      number: "£380.4",
                      unitQuote: "All figures in thousands",
                    },
                    {
                      name: "agent",
                      label: "Agent's fee",
                      citation: cited[2],
                      number: "(4.0)",
                      unitQuote: "Sale price £380.4",
                    },
                  ],
                },
              ],
            },
          },
        ]),
      ],
      answer: "The net sale proceeds were [=1][^1].",
    });
    const { core } = await setUpCalculating(model, [statement]);

    const { answer, finished } = await askAndRead(
      core,
      "What were the net sale proceeds of 14 Mill Lane?",
    );

    expect(told(model, "calculate")[0]).toContain(
      'are not full money amounts with two decimals ("385,000.00")',
    );
    expect(answer.figures).toEqual([]);
    expect(finished.uncalculated).toBe(1);
  });

  // protects=#1001; fails_when=a PDF whose pages say "(£'000)" in a running header reads a bare fee without the scale; the header is stripped before the page text is stored, so the marker is read before the strip.
  test("a currency next to a scale in a PDF's running header is caught before it is stripped", async () => {
    const pages = [
      {
        lines: [
          "(£'000)",
          "Completion statement: 14 Mill Lane",
          "Sale price £385,000.00",
          "Less: agent's fee (4,620.00)",
        ],
      },
      { lines: ["(£'000)", "Notes on the sale continue on this page."] },
      { lines: ["(£'000)", "The seller's file notes continue further."] },
      { lines: ["(£'000)", "The seller's file notes end here."] },
    ];
    const document = {
      name: "Completion statement 14 Mill Lane.pdf",
      contents: buildPdf(pages),
    };
    const model = calculatingModel({
      queries: ["sale price deductions"],
      steps: [
        citeStatement(
          "Completion statement",
          ["Sale price £385,000.00", "Less: agent's fee (4,620.00)"],
          (cited) => [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Net sale proceeds",
                    formula: "price + agent",
                    inputs: [
                      {
                        name: "price",
                        label: "Sale price",
                        citation: cited[0],
                        number: "£385,000.00",
                      },
                      {
                        name: "agent",
                        label: "Agent's fee",
                        citation: cited[1],
                        number: "(4,620.00)",
                        unitQuote: "Sale price £385,000.00",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        ),
      ],
      answer: "The net sale proceeds were [=1][^1].",
    });
    const { core } = await setUpCalculating(model, [document]);

    const { answer, finished } = await askAndRead(
      core,
      "What were the net sale proceeds of 14 Mill Lane?",
    );

    expect(told(model, "calculate")[0]).toContain('the Document states a scale ("£\'000")');
    expect(answer.figures).toEqual([]);
    expect(finished.uncalculated).toBe(1);
  });

  // protects=#1001; fails_when=a PDF read before this build (no scale marker) is trusted without being read again, or its running header's scale is lost by the re-read.
  test("a PDF read before this build is read again, and keeps its running header's scale", async () => {
    const dataDir = await createTempDataFolder();
    const pages = [
      {
        lines: [
          "(£'000)",
          "Completion statement: 14 Mill Lane",
          "Sale price £385,000.00",
          "Less: agent's fee (4,620.00)",
        ],
      },
      { lines: ["(£'000)", "Notes on the sale continue on this page."] },
      { lines: ["(£'000)", "The seller's file notes continue further."] },
      { lines: ["(£'000)", "The seller's file notes end here."] },
    ];
    const document = {
      name: "Completion statement 14 Mill Lane.pdf",
      contents: buildPdf(pages),
    };
    const model = calculatingModel({ queries: [], steps: [], answer: "Nothing." });
    const { core } = await setUpCalculating(model, [document], dataDir);
    const saved = (await core.listDocuments())[0];
    if (!saved) throw new Error("Missing Document.");
    core.close();

    // The pages as an older build left them: no marker, and the older pipeline's version.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run("UPDATE document_pages SET scale_marker = NULL WHERE document_id = ?", [saved.id]);
    db.run("UPDATE documents SET processing_version = 18 WHERE id = ?", [saved.id]);
    db.close();

    const again = startCore(dataDir);
    await waitForProcessing(again, [saved.id]);
    const markers = queryDatabase<{ scale_marker: string }>(
      dataDir,
      "SELECT DISTINCT scale_marker FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
      [saved.id],
    ).map((row) => row.scale_marker);
    expect(markers).toEqual(["£'000"]);
    again.close();
  });

  test("a unitQuote that isn't in the Passage, or writes no currency, is refused as today", async () => {
    const numbers = ["£385,000.00", "(4,620.00)", "(1,500.00)", "(804.00)"];
    const model = calculatingModel({
      queries: ["sale price deductions"],
      steps: [
        citeStatement("Completion statement", MIXED_LINES, (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                figure(cited, numbers, "Sale price £999,999.00"),
                { ...figure(cited, numbers, "Less: agent's fee (4,620.00)"), marker: 2 },
              ],
            },
          },
        ]),
      ],
      answer: "The net sale proceeds were [=1] and [=2][^1].",
    });
    const { core } = await setUpCalculating(model, [MIXED]);

    const { answer, finished } = await askAndRead(
      core,
      "What were the net sale proceeds of 14 Mill Lane?",
    );

    const [toldOnce] = told(model, "calculate");
    expect(toldOnce).toContain(
      "the unitQuote isn't word for word in P1; copy the line that states the unit exactly, from the same Passage.",
    );
    expect(toldOnce).toContain(
      'the unitQuote "Less: agent\'s fee (4,620.00)" states no unit or scale; give the line that does, such as "单位：万元" or "in millions".',
    );
    expect(answer.figures).toEqual([]);
    expect(finished.uncalculated).toBe(2);
  });
});

/** A scale a Document states in one of the forms #2365 found the reader missing, and what 1,200 − 300 under it is worth. */
interface ScaleForm {
  /** A word only this Document has, for its search. */
  code: string;
  line: string;
  value: number;
}

const ENGLISH_FORMS: readonly ScaleForm[] = [
  { code: "Alpha", line: "Amounts in £'000", value: 900_000 },
  { code: "Bravo", line: "All amounts in '000", value: 900_000 },
  { code: "Charlie", line: "Figures in 000s", value: 900_000 },
  { code: "Delta", line: "(000 omitted)", value: 900_000 },
  { code: "Echo", line: "Angaben in TEUR", value: 900_000 },
  { code: "Foxtrot", line: "Angaben in T€", value: 900_000 },
  { code: "Golf", line: "Amounts in k€", value: 900_000 },
  { code: "Hotel", line: "Amounts in $K", value: 900_000 },
  { code: "India", line: "Amounts in MEUR", value: 900_000_000 },
  { code: "Juliett", line: "(in $MM)", value: 900_000_000 },
  { code: "Lima", line: "USD MM", value: 900_000_000 },
];
const CHINESE_FORMS: readonly ScaleForm[] = [
  { code: "Mike", line: "金额（万）", value: 9_000_000 },
  { code: "November", line: "單位：新台幣仟元", value: 900_000 },
  { code: "Oscar", line: "單位：港幣百萬", value: 900_000_000 },
  { code: "Papa", line: "金額（萬）", value: 9_000_000 },
];

/**
 * Where a Document states its scale: on the figures' PDF page or Word section, only in its Word
 * header, in a sheet's cell, or apart from the figures, on the PDF page or under the Word heading
 * before theirs.
 */
type ScaleFormat =
  | "pdf"
  | "word"
  | "word header"
  | "sheet"
  | "pdf page before"
  | "word section before";

/** Enough text that the part stating the scale is a Passage of its own. */
const fillerLines = (chinese: boolean) =>
  Array.from({ length: 40 }, (_, index) =>
    chinese
      ? `董事会第${index + 1}次审阅了集团的经营情况、现金状况以及来年的展望。`
      : `The directors reviewed item ${index + 1} of the group's trading, cash and outlook in detail.`,
  );

/**
 * The rows a form's Document writes: its title, then revenue and costs, in its language. An English
 * "1,200" alone could group thousands or mark decimals, so its amounts have a decimal point.
 */
const scaleRows = (form: ScaleForm, chinese: boolean) =>
  chinese
    ? { title: `${form.code} 公司账目`, revenue: ["收入", "1,200"], costs: ["成本", "300"] }
    : {
        title: `${form.code} Holdings accounts`,
        revenue: ["Revenue", "1,234.5"],
        costs: ["Costs", "334.5"],
      };

/** A Document of `format` stating `form`'s scale: on its page, in its body, only in its header, or in a cell. */
function scaleDocument(form: ScaleForm, format: ScaleFormat, chinese: boolean) {
  const { title, revenue, costs } = scaleRows(form, chinese);
  const line = ([label, number]: string[]) => `${label} ${number}`;
  const cells = ([label = "", number = ""]: string[]) => [label, Number(number.replace(",", ""))];
  switch (format) {
    case "pdf":
      return {
        name: `${form.code} accounts.pdf`,
        contents: buildPdf([
          chinese
            ? { chineseLines: [title, form.line, line(revenue), line(costs)] }
            : { lines: [title, form.line, line(revenue), line(costs)] },
        ]),
      };
    case "word":
    case "word header":
      return {
        name: `${form.code} accounts.docx`,
        contents: docxOf(
          [
            { text: title, heading: 1 },
            ...(format === "word" ? [{ text: form.line }] : []),
            { text: line(revenue) },
            { text: line(costs) },
          ],
          format === "word header" ? { header: form.line } : {},
        ),
      };
    case "pdf page before": {
      const page = (lines: string[]) => (chinese ? { chineseLines: lines } : { lines });
      return {
        name: `${form.code} accounts.pdf`,
        contents: buildPdf([
          page([`${form.code} notes`, form.line, ...fillerLines(chinese)]),
          page([title, line(revenue), line(costs)]),
        ]),
      };
    }
    case "word section before":
      return {
        name: `${form.code} accounts.docx`,
        contents: docxOf([
          { text: `${form.code} notes`, heading: 1 },
          { text: form.line },
          ...fillerLines(chinese).map((text) => ({ text })),
          { text: title, heading: 2 },
          { text: line(revenue) },
          { text: line(costs) },
        ]),
      };
    case "sheet":
      return {
        name: `${form.code} accounts.xlsx`,
        contents: xlsxOf([
          {
            name: form.code,
            rows: [[title], [form.line], cells(revenue), cells(costs)],
          },
        ]),
      };
  }
}

/** Where a form's revenue and costs are quoted from, and their numbers as written. */
function scaleQuotes(form: ScaleForm, format: ScaleFormat, chinese: boolean) {
  const { revenue, costs } = scaleRows(form, chinese);
  const quote = ([label, number]: string[]) =>
    format === "sheet" ? `${label}\t${number?.replace(",", "")}` : `${label} ${number}`;
  const number = (written: string | undefined) =>
    format === "sheet" ? (written ?? "").replace(",", "") : (written ?? "");
  return {
    revenue: { quote: quote(revenue), number: number(revenue[1]) },
    costs: { quote: quote(costs), number: number(costs[1]) },
  };
}

/**
 * A model that searches for every form's Document at once, cites its revenue and costs, works
 * out revenue − costs for each with no unitQuote, then again, when `withUnitQuote`, with its
 * scale line as unitQuote.
 */
function scaleModel(
  forms: readonly ScaleForm[],
  format: ScaleFormat,
  chinese: boolean,
  withUnitQuote: boolean,
) {
  const figures = (unitQuote: boolean) =>
    forms.map((form, index) => {
      const { revenue, costs } = scaleQuotes(form, format, chinese);
      const scale = unitQuote ? { unitQuote: form.line } : {};
      return {
        marker: index + 1,
        label: `${form.code} margin`,
        formula: "rev - cost",
        inputs: [
          {
            name: "rev",
            label: "Revenue",
            citation: 2 * index + 1,
            number: revenue.number,
            ...scale,
          },
          { name: "cost", label: "Costs", citation: 2 * index + 2, number: costs.number, ...scale },
        ],
      };
    });
  const steps: ((passages: ShownPassage[]) => Call[])[] = [
    (passages) => {
      const citations = forms.flatMap((form, index) => {
        const { revenue, costs } = scaleQuotes(form, format, chinese);
        const passage = passages.find(
          (each) =>
            each.document.startsWith(`${form.code} accounts`) && each.text.includes(revenue.quote),
        );
        if (!passage) throw new Error(`No Passage of ${form.code} was shown.`);
        const location =
          passage.location ??
          (passage.pages?.includes("-")
            ? `pp. ${passage.pages.replace("-", "–")}`
            : `p. ${passage.pages}`);
        return [
          { marker: 2 * index + 1, passage: passage.id, location, quote: revenue.quote },
          { marker: 2 * index + 2, passage: passage.id, location, quote: costs.quote },
        ];
      });
      return [
        { tool: "cite", input: { citations } },
        { tool: "calculate", input: { figures: figures(false) } },
      ];
    },
    ...(withUnitQuote ? [() => [{ tool: "calculate", input: { figures: figures(true) } }]] : []),
  ];
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return {
        calls: forms.map((form) => ({
          tool: "search_documents",
          input: {
            query: `${form.code} ${chinese ? "公司账目 收入 成本" : "Holdings accounts revenue costs"}`,
          },
        })),
      };
    }
    const step = steps[call.index - 1];
    if (step) return { calls: step(searches.flatMap((each) => shownPassages(each.text))) };
    return { text: forms.map((_, index) => `[=${index + 1}]`).join(" ") };
  });
}

/** Runs `scaleModel` over every form's Document of `format`; returns what the model was told and the figures recorded, by marker. */
async function calculateUnderScales(
  forms: readonly ScaleForm[],
  format: ScaleFormat,
  chinese: boolean,
  withUnitQuote: boolean,
) {
  const model = scaleModel(forms, format, chinese, withUnitQuote);
  const { core } = await setUpCalculating(
    model,
    forms.map((form) => scaleDocument(form, format, chinese)),
  );
  const { answer } = await askAndRead(
    core,
    chinese ? "各公司的利润是多少？" : "What is each margin?",
  );
  core.close();
  return {
    told: told(model, "calculate"),
    recorded: answer.figures.map((figure) => [figure.marker, figure.value]),
  };
}

// protects=#2365; fails_when=a figure from a Document whose scale is written as "'000", "000s", "(000 omitted)", "TEUR", "T€", "k€", "$K", "MEUR", "$MM", "USD MM", "金额（万）", "新台幣仟元" or "港幣百萬" is calculated unscaled, 1,000 to 1,000,000 times too small; no_claim=the Answer's wording, which the scripted model writes.
describe("A scale written in a form the reader didn't know is applied or refused, never left out (#2365)", {
  timeout: 120_000,
}, () => {
  const each = [
    ...(["pdf", "word", "sheet"] as const).flatMap((format) => [
      { format, language: "English", forms: ENGLISH_FORMS, chinese: false },
      { format, language: "Chinese", forms: CHINESE_FORMS, chinese: true },
    ]),
  ];

  test.each(each)(
    "$format, $language: refused with no unitQuote, then worked out at the scale its line states",
    async ({ format, forms, chinese }) => {
      const {
        told: [asked, fixed],
        recorded,
      } = await calculateUnderScales(forms, format, chinese, true);

      const number = scaleQuotes(forms[0] as ScaleForm, format, chinese).revenue.number;
      for (const marker of forms.map((_, index) => index + 1)) {
        expect(asked).toContain(`[=${marker}] rev: ${number} has no unit, and `);
        expect(asked).not.toContain(`Recorded [=${marker}]`);
        expect(fixed).toContain(`Recorded [=${marker}]`);
      }
      expect(recorded).toEqual(forms.map((form, index) => [index + 1, form.value]));
    },
  );

  // protects=#2365; fails_when=a scale stated only in a Word file's header is never read, so its figures are calculated unscaled.
  test.each([
    { language: "English", forms: ENGLISH_FORMS, chinese: false },
    { language: "Chinese", forms: CHINESE_FORMS, chinese: true },
  ])(
    "a scale only in a Word file's header refuses the figure, as no Passage can quote it: $language",
    async ({ forms, chinese }) => {
      const {
        told: [asked],
        recorded,
      } = await calculateUnderScales(forms, "word header", chinese, false);

      for (const [index, form] of forms.entries()) {
        expect(asked).toContain(
          `[=${index + 1}] rev: ${chinese ? "1,200" : "1,234.5"} has no unit, and a running header or footer at § ${scaleRows(form, chinese).title} states a scale ("`,
        );
      }
      expect(asked).toContain("it can't be calculated without guessing its scale.");
      expect(recorded).toEqual([]);
    },
  );
});

// protects=#2365; fails_when=a scale form that reads more than one way ("in MM": millions, millimetres or months) is guessed either way, or ordinary text ("order 000123", "1,000s of users", "(000) 123-4567", "一万人", "万一") is read as a scale and changes or refuses a figure from a Document that states none.
describe("A scale form that reads two ways is refused; text that states no scale changes nothing (#2365)", {
  timeout: 120_000,
}, () => {
  test("“(in MM)” refuses the figure with no unitQuote and with it; Documents with no scale give the plain difference", async () => {
    const unsure = { code: "Quebec", line: "Revenue (in MM)", value: 0 };
    const plain: ScaleForm[] = [
      { code: "Romeo", line: "Customer order 000123", value: 900 },
      { code: "Sierra", line: "Used by 1,000s of users", value: 900 },
      { code: "Tango", line: "Call (000) 123-4567", value: 900 },
      { code: "Uniform", line: "Thousands of people attended.", value: 900 },
    ];
    const {
      told: [asked, fixed],
      recorded,
    } = await calculateUnderScales([unsure, ...plain], "pdf", false, true);

    expect(asked).toContain(
      `[=1] rev: 1,234.5 has no unit, and p. 1 writes "in MM", which can be read as more than one scale or unit; it can't be calculated without guessing its scale.`,
    );
    expect(fixed).toContain(
      `[=1] rev: the unitQuote "Revenue (in MM)" writes "in MM", which can be read as more than one scale or unit; 1,234.5 can't be calculated without guessing its scale.`,
    );
    expect(recorded).toEqual([
      [2, 900],
      [3, 900],
      [4, 900],
      [5, 900],
    ]);
  });

  test("Chinese text with 万 in its words, not as a column's unit, leaves the difference as it is", async () => {
    const plain: ScaleForm[] = [
      { code: "Victor", line: "万一成本超支，另行通知", value: 900 },
      { code: "Whiskey", line: "员工一万人", value: 900 },
    ];
    const { recorded } = await calculateUnderScales(plain, "pdf", true, false);

    expect(recorded).toEqual([
      [1, 900],
      [2, 900],
    ]);
  });
});

// protects=#2365; fails_when=a two-decimal statement's currency is carried to bare fees under a scale written "000s", "(000 omitted)" or "金额（万）", so the User sees an amount a thousand or ten thousand times too small.
describe("A statement's first-amount currency isn't carried under a scale form the reader now knows (#2365)", {
  timeout: 60_000,
}, () => {
  test.each([
    { scale: "Figures in 000s", chinese: false },
    { scale: "(000 omitted)", chinese: false },
    { scale: "金额（万）", chinese: true },
    { scale: "Amounts (in MM)", chinese: false },
  ])("$scale", async ({ scale, chinese }) => {
    const lines = chinese
      ? ["成交价 ¥385.00", "减：中介费 （4.62）"]
      : ["Sale price £385.00", "Less: agent's fee (4.62)"];
    const document = {
      name: "Completion statement 14 Mill Lane.pdf",
      contents: buildPdf([
        chinese
          ? { chineseLines: ["房产交易结算表", scale, ...lines] }
          : { lines: ["Completion statement: 14 Mill Lane", scale, ...lines] },
      ]),
    };
    const numbers = chinese ? ["¥385.00", "（4.62）"] : ["£385.00", "(4.62)"];
    const model = calculatingModel({
      queries: [chinese ? "成交价 中介费" : "sale price deductions"],
      steps: [
        citeStatement("Completion statement", lines, (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "Net",
                  formula: "price + agent",
                  inputs: [
                    { name: "price", label: "Price", citation: cited[0], number: numbers[0] },
                    {
                      name: "agent",
                      label: "Fee",
                      citation: cited[1],
                      number: numbers[1],
                      unitQuote: lines[0],
                    },
                  ],
                },
              ],
            },
          },
        ]),
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [document]);

    const { answer, finished } = await askAndRead(core, "What are the net proceeds?");

    expect(told(model, "calculate")[0]).toContain("but the Document states a scale (");
    expect(answer.figures).toEqual([]);
    expect(finished.uncalculated).toBe(1);
  });
});

// protects=#2365; fails_when=a line that only looks like a scale (a share class, "M&A", "Series M", a wrapped "million", "000s of users") changes a figure, or one that reads two ways ("ending in 000", "Call (000)", "TUSD") is read either way instead of refused.
describe("Text that only looks like a scale changes nothing, and one that reads two ways is refused (#2365)", {
  timeout: 120_000,
}, () => {
  test.each([
    {
      language: "English",
      chinese: false,
      plain: [
        "Share class USD B Acc",
        "USD M&A advisory fees",
        "Series M USD notes",
        "Millions",
        "Thousands of 000s of users",
      ],
      refused: [
        "Accounts ending in 000",
        "Call (000)",
        "Holdings of TUSD stablecoin",
        "We hold Class USD B",
      ],
    },
    {
      language: "Chinese",
      chinese: true,
      plain: ["美元B类份额", "账户尾号000"],
      refused: ["客户热线（000）", "持有份额类别：USD B。"],
    },
  ])("$language", async ({ chinese, plain, refused }) => {
    const codes = [
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo",
      "Foxtrot",
      "Golf",
      "Hotel",
      "India",
    ];
    const forms = [...plain, ...refused].map((line, index) => ({
      code: codes[index] as string,
      line,
      value: 900,
    }));
    const {
      told: [asked],
      recorded,
    } = await calculateUnderScales(forms, "pdf", chinese, false);

    expect(recorded).toEqual(plain.map((_, index) => [index + 1, 900]));
    for (const marker of refused.map((_, index) => plain.length + index + 1)) {
      expect(asked).toContain(
        `[=${marker}] rev: ${chinese ? "1,200" : "1,234.5"} has no unit, and p. 1 writes "`,
      );
    }
  });
});

// protects=#2365; fails_when=a number under one column of a table's head row takes another column's unit or scale when the whole row is given as unitQuote: a 12.5% margin recorded as £25.0 thousand, or EPS £1.25 as £1,250.
test.each([
  {
    language: "English, a percent",
    head: ["Segment", "Revenue (£000)", "Margin (%)"],
    row: ["Clothing", 4620, 12.5],
  },
  {
    language: "Chinese, a percent",
    head: ["分部", "收入（万元）", "毛利率（%）"],
    row: ["服装", 4620, 12.5],
  },
  {
    language: "English, one currency at two scales",
    head: ["Segment", "Revenue (£000)", "EPS (£)"],
    row: ["Clothing", 4620, 12.5],
  },
  {
    language: "English, a currency column beside a count's",
    head: ["Segment", "Revenue ($000)", "Shares (000s)"],
    row: ["Group", 4620, 12.5],
  },
  {
    language: "Chinese, one currency at two scales",
    head: ["分部", "收入（万元）", "每股收益（元）"],
    row: ["服装", 4620, 12.5],
  },
])(
  "a head row that states a unit for each column doesn't give one of them to a number: $language",
  {
    timeout: 60_000,
  },
  async ({ head, row }) => {
    const headLine = head.join("\t");
    const rowLine = row.join("\t");
    const model = calculatingModel({
      queries: ["Segments margin 分部"],
      steps: [
        (passages) => [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passageOf(passages, "Segments"),
                  location: "Segments, rows 1–2",
                  quote: rowLine,
                },
              ],
            },
          },
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "Double the margin",
                  formula: "m * 2",
                  inputs: [
                    {
                      name: "m",
                      label: "Margin",
                      citation: 1,
                      number: "12.5",
                      unitQuote: headLine,
                    },
                  ],
                },
              ],
            },
          },
        ],
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      { name: "Segments.xlsx", contents: xlsxOf([{ name: "Segments", rows: [head, row] }]) },
    ]);

    const { answer } = await askAndRead(core, "What is twice the margin?");

    expect(told(model, "calculate")[0]).toContain(
      `[=1] m: the unitQuote "${headLine}" states more than one unit or scale; give the line or column head that states the unit of 12.5 alone.`,
    );
    expect(answer.figures).toEqual([]);
  },
);

// protects=#2365; fails_when=a number under a Word heading whose parent section states the scale, or on a PDF page after the one that does, is calculated plain, 1,000 to 1,000,000 times too small.
describe("A scale stated in another part of the Document refuses a bare number, never leaves it out (#2365)", {
  timeout: 120_000,
}, () => {
  test.each([
    ...(["pdf page before", "word section before"] as const).flatMap((format) => [
      { format, language: "English", forms: ENGLISH_FORMS.slice(0, 4), chinese: false },
      { format, language: "Chinese", forms: CHINESE_FORMS.slice(0, 2), chinese: true },
    ]),
  ])("$format, $language", async ({ format, forms, chinese }) => {
    const {
      told: [asked],
      recorded,
    } = await calculateUnderScales(forms, format, chinese, false);

    for (const marker of forms.map((_, index) => index + 1)) {
      expect(asked).toContain(
        `[=${marker}] rev: ${chinese ? "1,200" : "1,234.5"} has no unit, and `,
      );
    }
    // A Word heading's section is a Unit of its own; a short PDF page shares a Passage with the one
    // before it, whose scale line the Passage's Units then hold.
    if (format === "word section before")
      expect(asked).toContain(
        "it can't be calculated without guessing whether that scale applies.",
      );
    expect(recorded).toEqual([]);
  });
});

// protects=#2365; fails_when=a Word header in a form that reads two ways ("(in MM)") leaves no scale marker, so the figure under it is calculated plain.
test("a Word header that writes a scale two ways refuses the figure", {
  timeout: 60_000,
}, async () => {
  const form = { code: "Quebec", line: "Revenue (in MM)", value: 0 };
  const {
    told: [asked],
    recorded,
  } = await calculateUnderScales([form], "word header", false, false);

  expect(asked).toContain(
    `[=1] rev: 1,234.5 has no unit, and a running header or footer at § Quebec Holdings accounts states a scale ("in MM")`,
  );
  expect(recorded).toEqual([]);
});

// protects=#2365; fails_when=a PDF read before this build keeps no scale for a running header in a form the reader didn't know ("(000 omitted)"), so its pages' bare figures are read plain.
test("a PDF read before this build is read again and keeps a running header's “(000 omitted)”", {
  timeout: 60_000,
}, async () => {
  const dataDir = await createTempDataFolder();
  const pages = [
    "Revenue 1,234.5",
    "Notes continue here.",
    "More notes here.",
    "The notes end.",
  ].map((line) => ({ lines: ["Holdings Ltd (000 omitted)", line] }));
  const model = calculatingModel({ queries: [], steps: [], answer: "Nothing." });
  const { core } = await setUpCalculating(
    model,
    [{ name: "Holdings accounts.pdf", contents: buildPdf(pages) }],
    dataDir,
  );
  const saved = (await core.listDocuments())[0];
  if (!saved) throw new Error("Missing Document.");
  core.close();

  const db = openDatabase(join(dataDir, DATABASE_FILE));
  db.run("UPDATE document_pages SET scale_marker = '' WHERE document_id = ?", [saved.id]);
  db.run("UPDATE documents SET processing_version = 19 WHERE id = ?", [saved.id]);
  db.close();

  const again = startCore(dataDir);
  expect((await again.listDocuments())[0]).toMatchObject({ id: saved.id, status: "queued" });
  await waitForProcessing(again, [saved.id]);
  expect(
    queryDatabase<{ scale_marker: string }>(
      dataDir,
      "SELECT DISTINCT scale_marker FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
      [saved.id],
    ).map((row) => row.scale_marker),
  ).toEqual(["(000 omitted)"]);
  again.close();
});

// protects=#2365; fails_when=a per-share figure, or a share count, under "(in millions, except per share data)" or "（除每股数据外）" is scaled with the amounts, so earnings per share come out a million times too large.
test.each([
  {
    language: "English",
    lines: [
      "Results (in millions, except share and per share data)",
      "Revenue 1,482.6",
      "Diluted earnings per share 2.15",
      "Weighted average shares outstanding 412.5",
    ],
    question: "What are twice the revenue, EPS and shares?",
    chinese: false,
  },
  {
    language: "Chinese",
    lines: [
      "单位：百万元（除股数及每股数据外）",
      "营业收入 1,482.6",
      "基本每股收益 2.15",
      "发行在外普通股加权平均股份 412.5",
    ],
    question: "营业收入、每股收益和股数的两倍各是多少？",
    chinese: true,
  },
])(
  "a scale that leaves out per-share data and share counts applies to the amounts alone: $language",
  {
    timeout: 60_000,
  },
  async ({ lines, question, chinese }) => {
    const [head = "", ...rows] = lines;
    const document = {
      name: "Results 2025.pdf",
      contents: buildPdf([chinese ? { chineseLines: lines } : { lines }]),
    };
    const twice = (marker: number, citation: number, number: string, unitQuote?: string) => ({
      marker,
      label: `Twice ${number}`,
      formula: "x * 2",
      inputs: [{ name: "x", label: number, citation, number, ...(unitQuote && { unitQuote }) }],
    });
    const model = calculatingModel({
      queries: [chinese ? "营业收入 每股收益" : "revenue earnings per share"],
      steps: [
        citeStatement("Results 2025", rows, (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                twice(1, cited[0] as number, "1,482.6", head),
                twice(2, cited[1] as number, "2.15"),
                twice(3, cited[1] as number, "2.15", head),
                twice(4, cited[2] as number, "412.5", head),
              ],
            },
          },
        ]),
      ],
      answer: "[=1] [=2] [=3] [=4][^1]",
    });
    const { core } = await setUpCalculating(model, [document]);

    const { answer } = await askAndRead(core, question);

    expect(answer.figures.map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 2_965_200_000],
      [2, 4.3],
      [3, 4.3],
      [4, 825],
    ]);
  },
);

// protects=#2365; fails_when=the amounts on a joined line after "单位：千元，每股收益除外" or "(in thousands, except per share data)" are taken for per-share figures, because the statement's own words are read as their row's label, and come out a thousand times too small.
test.each([
  {
    language: "Chinese PDF, its rows joined",
    document: {
      name: "Pelican 利润表.pdf",
      contents: buildPdf([
        {
          chineseLines: [
            "Pelican 利润表",
            "单位：千元，每股收益除外",
            "营业收入 1,234.5",
            "营业成本 334.5",
            "基本每股收益 0.52",
          ],
        },
      ]),
    },
    head: "单位：千元，每股收益除外",
    quotes: ["营业收入 1,234.5", "营业成本 334.5", "基本每股收益 0.52"],
  },
  {
    language: "Chinese Word file, its rows apart",
    document: {
      name: "Pelican 利润表.docx",
      contents: docxOf(
        [
          "Pelican 利润表",
          "单位：千元，每股收益除外",
          "营业收入 1,234.5",
          "营业成本 334.5",
          "基本每股收益 0.52",
        ].map((text) => ({ text })),
      ),
    },
    head: "单位：千元，每股收益除外",
    quotes: ["营业收入 1,234.5", "营业成本 334.5", "基本每股收益 0.52"],
  },
  {
    language: "English PDF, all on one line",
    document: {
      name: "Pelican results.pdf",
      contents: buildPdf([
        {
          lines: [
            "Pelican Inc (in thousands, except per share data) Revenue 1,234.5 Costs 334.5 Diluted EPS 0.52",
          ],
        },
      ]),
    },
    head: "(in thousands, except per share data)",
    quotes: ["Revenue 1,234.5", "Costs 334.5", "Diluted EPS 0.52"],
  },
])(
  "the amounts beside a per-share exception are scaled; the per-share row isn't: $language",
  {
    timeout: 60_000,
  },
  async ({ document, head, quotes }) => {
    const [revenue = "", costs = "", eps = ""] = quotes;
    const number = (quote: string) => quote.split(" ").at(-1) ?? "";
    const model = calculatingModel({
      queries: ["Pelican 营业收入 revenue"],
      steps: [
        (passages) => {
          const passage = passageOf(passages, "Pelican");
          const location = passages.find((each) => each.id === passage)?.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: quotes.map((quote, index) => ({
                  marker: index + 1,
                  passage,
                  location,
                  quote,
                })),
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Margin",
                    formula: "rev - cost",
                    inputs: [
                      {
                        name: "rev",
                        label: "Revenue",
                        citation: 1,
                        number: number(revenue),
                        unitQuote: head,
                      },
                      {
                        name: "cost",
                        label: "Costs",
                        citation: 2,
                        number: number(costs),
                        unitQuote: head,
                      },
                    ],
                  },
                  {
                    marker: 2,
                    label: "Twice the revenue",
                    formula: "rev * 2",
                    inputs: [
                      { name: "rev", label: "Revenue", citation: 1, number: number(revenue) },
                    ],
                  },
                  {
                    marker: 3,
                    label: "Twice the EPS",
                    formula: "eps * 2",
                    inputs: [
                      {
                        name: "eps",
                        label: "EPS",
                        citation: 3,
                        number: number(eps),
                        unitQuote: head,
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1] [=2] [=3][^1]",
    });
    const { core } = await setUpCalculating(model, [document]);

    const { answer } = await askAndRead(core, "What is the margin?");

    expect(told(model, "calculate")[0]).toContain(`[=2] rev: ${number(revenue)} has no unit, and `);
    expect(answer.figures.map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
      [3, 1.04],
    ]);
  },
);

// protects=#2365; fails_when=a fund's share class in a sheet's row ("USD B") is read as the row's unit, so a NAV of 12.34 is recorded as $24.68 billion.
test("a share class in a sheet's row is no unit for its NAV, which is refused rather than scaled", {
  timeout: 60_000,
}, async () => {
  const row = ["USD B", "LU0123456789", 12.34];
  const model = calculatingModel({
    queries: ["Funds NAV"],
    steps: [
      (passages) => [
        {
          tool: "cite",
          input: {
            citations: [
              {
                marker: 1,
                passage: passageOf(passages, "Funds"),
                location: "Funds, rows 1–2",
                quote: row.join("\t"),
              },
            ],
          },
        },
        {
          tool: "calculate",
          input: {
            figures: [
              {
                marker: 1,
                label: "Twice the NAV",
                formula: "nav * 2",
                inputs: [{ name: "nav", label: "NAV", citation: 1, number: "12.34" }],
              },
            ],
          },
        },
      ],
    ],
    answer: "[=1][^1]",
  });
  const { core } = await setUpCalculating(model, [
    {
      name: "Funds.xlsx",
      contents: xlsxOf([{ name: "Funds", rows: [["Share class", "ISIN", "NAV"], row] }]),
    },
  ]);

  const { answer } = await askAndRead(core, "What is twice the NAV?");

  expect(told(model, "calculate")[0]).toContain(
    `[=1] nav: 12.34 has no unit, and Funds, row 2 writes "USD B", which can be read as more than one scale or unit`,
  );
  expect(answer.figures).toEqual([]);
});

// protects=#2365; fails_when=a per-share row under "In millions of dollars, except where noted" is scaled with the amounts when the model quotes that line, so EPS $1.25 comes out $1.25 million.
test.each([
  {
    language: "English",
    lines: [
      "Pelican In millions of dollars, except where noted",
      "Revenue 1,234.5",
      "Earnings per share 1.25",
    ],
    chinese: false,
  },
  {
    language: "Chinese",
    lines: ["Pelican 单位：百万元（除另有说明外）", "营业收入 1,234.5", "每股收益 1.25"],
    chinese: true,
  },
])(
  "a per-share row under “except where noted” is refused, the amounts scaled: $language",
  {
    timeout: 60_000,
  },
  async ({ lines, chinese }) => {
    const [title = "", revenue = "", eps = ""] = lines;
    const head = title.replace("Pelican ", "");
    const number = (quote: string) => quote.split(" ").at(-1) ?? "";
    const twice = (marker: number, citation: number, quote: string, unitQuote?: string) => ({
      marker,
      label: `Twice ${quote}`,
      formula: "x * 2",
      inputs: [
        {
          name: "x",
          label: quote,
          citation,
          number: number(quote),
          ...(unitQuote && { unitQuote }),
        },
      ],
    });
    const model = calculatingModel({
      queries: ["Pelican revenue 营业收入"],
      steps: [
        citeStatement("Pelican", [revenue, eps], (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                twice(1, cited[0] as number, revenue, head),
                twice(2, cited[1] as number, eps),
                twice(3, cited[1] as number, eps, head),
              ],
            },
          },
        ]),
      ],
      answer: "[=1] [=2] [=3][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Pelican results.pdf",
        contents: buildPdf([chinese ? { chineseLines: lines } : { lines }]),
      },
    ]);

    const { answer } = await askAndRead(core, "What are the figures doubled?");

    const [asked] = told(model, "calculate");
    expect(asked).toContain(
      `[=2] x: 1.25 is on a per-share row, and "${head.replace(/（.*$|, except.*$/, "")}`,
    );
    expect(asked).toContain(
      `[=3] x: 1.25 is on a per-share row, and the unitQuote "${head}" scales its Document's amounts except where it notes otherwise; it can't be calculated without guessing its scale.`,
    );
    expect(answer.figures.map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 2_469_000_000],
    ]);
  },
);

/**
 * Every kind of row a scale line must not scale, under each form of the line (#2365): an amount
 * is scaled; a per-share figure is left plain only where the line excepts it; a percent, ratio,
 * multiple, basis points, count, year or identifier is refused. Each row is doubled with the line
 * as its unitQuote. `null` is a refusal.
 */
const ROW_KINDS_EN: readonly [string, string][] = [
  ["Revenue 1,234.5", "1,234.5"],
  ["Diluted EPS ($) 1.25", "1.25"],
  ["Gross margin (%) 27.4", "27.4"],
  ["Current ratio 1.8", "1.8"],
  ["Net debt to EBITDA (x) 2.5", "2.5"],
  ["Interest spread (bps) 125", "125"],
  ["Employees 4250", "4250"],
  ["Stores 312", "312"],
  ["Customer ID 5512", "5512"],
  ["Year founded 1998", "1998"],
  ["Weighted average shares 412.5", "412.5"],
  ["Dividend per share 0.35", "0.35"],
  ["Payment date 15", "15"],
  ["ISIN 4471", "4471"],
  ["Phone 5550123", "5550123"],
  ["Revenue per unit 12.34", "12.34"],
  ["Average revenue per user 12.34", "12.34"],
  ["Cash cost per tonne 85.2", "85.2"],
];
const ROW_KINDS_ZH: readonly [string, string][] = [
  ["营业收入 1,234.5", "1,234.5"],
  ["基本每股收益（元） 0.52", "0.52"],
  ["毛利率（%） 27.4", "27.4"],
  ["流动比率 1.8", "1.8"],
  ["净负债/EBITDA（倍） 2.5", "2.5"],
  ["利差（基点） 125", "125"],
  ["员工人数 4250", "4250"],
  ["门店数量 312", "312"],
  ["客户编号 5512", "5512"],
  ["成立年份 1998", "1998"],
  ["发行在外普通股加权平均股份 412.5", "412.5"],
  ["每股股利（元） 0.35", "0.35"],
  ["付款日期 15", "15"],
  ["证券代码 4471", "4471"],
  ["联系电话 5550123", "5550123"],
  ["每单位收入 12.34", "12.34"],
  ["人均收入 12.34", "12.34"],
  ["每吨现金成本 85.2", "85.2"],
];

/**
 * What each row of the tables above doubles to under a line that scales 1,234.5 to `revenue`: only
 * the amount is scaled, and the per-share rows are left plain where the line excepts them.
 */
const doubledRows = (revenue: number, perShare: [number, number] | null) => [
  revenue,
  perShare?.[0] ?? null,
  ...Array<null>(9).fill(null),
  perShare?.[1] ?? null,
  ...Array<null>(6).fill(null),
];

// protects=#2365; fails_when=a row that isn't an amount (earnings per share, a percent, a ratio, a multiple, basis points, a count, an identifier) is scaled by its Document's scale line when the model quotes it, under any form of that line, in English or Chinese.
test.each([
  { head: "(in thousands)", chinese: false, doubled: doubledRows(2_469_000, null) },
  { head: "(in billions)", chinese: false, doubled: doubledRows(2_469_000_000_000, null) },
  {
    head: "(in millions, except per share data)",
    chinese: false,
    doubled: doubledRows(2_469_000_000, [2.5, 0.7]),
  },
  { head: "Amounts in £'000", chinese: false, doubled: doubledRows(2_469_000, null) },
  {
    head: "All figures in £'000 unless otherwise stated",
    chinese: false,
    doubled: doubledRows(2_469_000, null),
  },
  {
    head: "In millions of dollars, except where noted",
    chinese: false,
    doubled: doubledRows(2_469_000_000, null),
  },
  { head: "(000 omitted)", chinese: false, doubled: doubledRows(2_469_000, null) },
  { head: "单位：千元", chinese: true, doubled: doubledRows(2_469_000, null) },
  { head: "单位：万元", chinese: true, doubled: doubledRows(24_690_000, null) },
  { head: "单位：亿元", chinese: true, doubled: doubledRows(246_900_000_000, null) },
  {
    head: "单位：千元，每股收益除外",
    chinese: true,
    doubled: doubledRows(2_469_000, [1.04, 0.7]),
  },
  { head: "金额（万）", chinese: true, doubled: doubledRows(24_690_000, null) },
  {
    head: "单位：百万元（除另有说明外）",
    chinese: true,
    doubled: doubledRows(2_469_000_000, null),
  },
])(
  "each kind of row under “$head” is scaled only when it is an amount",
  {
    timeout: 60_000,
  },
  async ({ head, chinese, doubled }) => {
    const rows = chinese ? ROW_KINDS_ZH : ROW_KINDS_EN;
    const lines = ["Pelican accounts", head, ...rows.map(([line]) => line)];
    const model = calculatingModel({
      queries: ["Pelican accounts"],
      steps: [
        citeStatement(
          "Pelican",
          rows.map(([line]) => line),
          (cited) => [
            {
              tool: "calculate",
              input: {
                figures: rows.map(([line, number], index) => ({
                  marker: index + 1,
                  label: line,
                  formula: "x * 2",
                  inputs: [
                    { name: "x", label: line, citation: cited[index], number, unitQuote: head },
                  ],
                })),
              },
            },
          ],
        ),
      ],
      answer: rows.map((_, index) => `[=${index + 1}]`).join(" "),
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Pelican accounts.docx",
        contents: docxOf(lines.map((text) => ({ text }))),
      },
    ]);

    const { answer } = await askAndRead(
      core,
      chinese ? "各项的两倍是多少？" : "What is each doubled?",
    );

    const byMarker = new Map(answer.figures.map((figure) => [figure.marker, figure.value]));
    expect(rows.map((_, index) => byMarker.get(index + 1) ?? null)).toEqual(doubled);
  },
);

/** Twice each of `quotes`, from a Word file of `lines` under `head`, with `head` as unitQuote; `null` where refused. */
async function doubledUnder(
  head: string,
  lines: readonly string[],
  quotes: readonly string[],
  format: "word" | "text" = "word",
) {
  const model = calculatingModel({
    queries: ["Pelican statement"],
    steps: [
      citeStatement("Pelican", quotes, (cited) => [
        {
          tool: "calculate",
          input: {
            figures: quotes.map((quote, index) => ({
              marker: index + 1,
              label: quote,
              formula: "x * 2",
              inputs: [
                {
                  name: "x",
                  label: quote,
                  citation: cited[index],
                  number: quote.split(" ").at(-1),
                  unitQuote: head,
                },
              ],
            })),
          },
        },
      ]),
    ],
    answer: quotes.map((_, index) => `[=${index + 1}]`).join(" "),
  });
  const all = ["Pelican statement", head, ...lines];
  const { core } = await setUpCalculating(model, [
    format === "word"
      ? { name: "Pelican statement.docx", contents: docxOf(all.map((text) => ({ text }))) }
      : { name: "Pelican statement.txt", contents: all.join("\n") },
  ]);
  const { answer } = await askAndRead(core, "What is each doubled?");
  const byMarker = new Map(answer.figures.map((figure) => [figure.marker, figure.value]));
  return quotes.map((_, index) => byMarker.get(index + 1) ?? null);
}

const TEN_YEAR_EPS = [
  "1.25",
  "1.20",
  "1.15",
  "1.10",
  "1.05",
  "1.00",
  "0.95",
  "0.90",
  "0.85",
  "0.80",
];
const THIRTEEN_YEAR_EPS = [...TEN_YEAR_EPS, "0.75", "0.70", "0.65"];

/**
 * Where a number's row label is (#2365): on its line, on the line above, above a column of like
 * numbers (a record read one cell per line), or nowhere the page shows. Each figure is doubled
 * with the scale line as its unitQuote; `null` is a refusal, the default when the row is unknown.
 */
// protects=#2365; fails_when=a number whose row the page doesn't show (past a long column, under a sentence, a blank line, a number written otherwise or the scale line itself) is scaled as an amount, or a per-share figure, a percent or a per-unit figure in a column is scaled with the amounts.
test.each([
  {
    layout: "labels on their own lines, and a per annum amount",
    head: "(in thousands, except per share data)",
    lines: ["Revenue 1,234.5", "Diluted EPS 1.25", "Rent payable per annum 334.5"],
    quotes: ["1,234.5", "1.25", "334.5"],
    doubled: [2_469_000, 2.5, 669_000],
  },
  {
    layout: "a second year's column under the first, in English",
    head: "(in thousands, except per share data)",
    lines: [
      "Revenue",
      "1,234.5",
      "1,100.5",
      "Diluted earnings per share",
      "1.25",
      "1.10",
      "Gross margin (%)",
      "27.4",
      "26.1",
    ],
    quotes: ["1,100.5", "1.10", "26.1"],
    doubled: [2_201_000, 2.2, null],
  },
  {
    layout: "a second year's column under the first, in Chinese",
    head: "单位：千元，每股收益除外",
    lines: [
      "营业收入",
      "1,234.5",
      "1,100.5",
      "稀释每股收益",
      "0.52",
      "0.48",
      "毛利率（%）",
      "27.4",
      "26.1",
    ],
    quotes: ["1,100.5", "0.48", "26.1"],
    doubled: [2_201_000, 0.96, null],
  },
  {
    layout: "a ten-year record of EPS, its 9th and 10th years",
    head: "(in thousands, except per share data)",
    lines: ["Diluted earnings per share", ...TEN_YEAR_EPS],
    quotes: ["0.85", "0.80"],
    doubled: [1.7, 1.6],
  },
  {
    layout: "a thirteen-year record: the 12th year is read, the 13th is past the lines looked in",
    head: "(in thousands, except per share data)",
    lines: ["Diluted earnings per share", ...THIRTEEN_YEAR_EPS],
    quotes: ["0.70", "0.65"],
    doubled: [1.4, null],
  },
  {
    layout: "a ten-year record of a percent",
    head: "(in thousands)",
    lines: [
      "Operating margin (%)",
      "20.0",
      "19.9",
      "19.8",
      "19.7",
      "19.6",
      "19.5",
      "19.4",
      "19.3",
      "19.2",
      "19.1",
    ],
    quotes: ["19.1"],
    doubled: [null],
  },
  {
    layout: "a sentence above a lone number",
    head: "(in thousands, except per share data)",
    lines: ["Earnings per share are shown in note 9.", "1,234.5"],
    quotes: ["1,234.5"],
    doubled: [null],
  },
  {
    layout: "a total written otherwise under per-share rows",
    head: "(in thousands, except per share data)",
    lines: ["Earnings per share", "1.25", "1.10", "1,234.5"],
    quotes: ["1,234.5"],
    doubled: [null],
  },
  {
    layout: "a row head that states its own scale, above its number",
    head: "Net debt (£m)",
    lines: ["528.9"],
    quotes: ["528.9"],
    doubled: [1_057_800_000],
  },
  {
    layout: "a row head in 亿元 that states its own scale, above its number",
    head: "净负债（亿元）",
    lines: ["5.2"],
    quotes: ["5.2"],
    doubled: [1_040_000_000],
  },
  {
    layout: "a row head in £m under a scale line in thousands, above its number",
    head: "(in thousands)",
    lines: ["Net debt (£m)", "528.9"],
    quotes: ["528.9"],
    doubled: [null],
  },
  {
    layout: "a row head in £m under a scale line in thousands, on its number's line",
    head: "(in thousands)",
    lines: ["Net debt (£m) 528.9"],
    quotes: ["528.9"],
    doubled: [null],
  },
  {
    layout: "a row head in 亿元 under 单位：万元, above its number",
    head: "单位：万元",
    lines: ["净负债（亿元）", "5.2"],
    quotes: ["5.2"],
    doubled: [null],
  },
  {
    layout: "a row head in 亿元 under 单位：万元, on its number's line",
    head: "单位：万元",
    lines: ["净负债（亿元） 5.2"],
    quotes: ["5.2"],
    doubled: [null],
  },
  {
    layout: "a row head with words after its scale, quoted as the scale line",
    head: "Revenue (£000) - UK",
    lines: ["1,234.5"],
    quotes: ["1,234.5"],
    doubled: [2_469_000],
  },
  {
    layout: "a row head with words after its scale, under another scale line, above its number",
    head: "(in millions)",
    lines: ["Revenue (£000) - UK", "1,234.5"],
    quotes: ["1,234.5"],
    doubled: [null],
  },
  {
    layout: "a row head with words after its scale, under another scale line, on its number's line",
    head: "(in millions)",
    lines: ["Revenue (£000) - UK 1,234.5"],
    quotes: ["1,234.5"],
    doubled: [null],
  },
  {
    layout: "收入（百万元）合计 under 单位：万元, above its number",
    head: "单位：万元",
    lines: ["收入（百万元）合计", "1,234.5"],
    quotes: ["1,234.5"],
    doubled: [null],
  },
  {
    layout: "收入（百万元）合计 under 单位：万元, on its number's line",
    head: "单位：万元",
    lines: ["收入（百万元）合计 1,234.5"],
    quotes: ["1,234.5"],
    doubled: [null],
  },
  {
    layout: "a row head in £'000 under another scale line, its zeros kept with it",
    head: "(in millions)",
    lines: ["Net debt (£'000) 528.9"],
    quotes: ["528.9"],
    doubled: [null],
  },
  {
    layout: "a lone number right under the scale line",
    head: "(in thousands)",
    lines: ["1,234.5"],
    quotes: ["1,234.5"],
    doubled: [null],
  },
])(
  "a row's label decides its scale: $layout",
  { timeout: 60_000 },
  async ({ head, lines, quotes, doubled }) => {
    expect(await doubledUnder(head, lines, quotes)).toEqual(doubled);
  },
);

// protects=#2365; fails_when=a number after a blank line takes the label of the block above it.
test("a blank line ends the lines a lone number's label is looked for in", {
  timeout: 60_000,
}, async () => {
  const head = "(in thousands, except per share data)";
  const lines = ["Diluted earnings per share", "", "1.25"];
  expect(await doubledUnder(head, lines, ["1.25"], "text")).toEqual([null]);
  expect(
    await doubledUnder(head, ["Diluted earnings per share", "1.25"], ["1.25"], "text"),
  ).toEqual([2.5]);
});

// protects=#2365; fails_when="unless otherwise stated" isn't read as the line's exception, so a per-share row under it is refused for being per-share rather than for the line's own words.
test("a per-share row under “unless otherwise stated” is refused for the line's exception", {
  timeout: 60_000,
}, async () => {
  const head = "All figures in £'000 unless otherwise stated";
  const model = calculatingModel({
    queries: ["Pelican statement"],
    steps: [
      citeStatement("Pelican", ["Diluted EPS 1.25"], (cited) => [
        {
          tool: "calculate",
          input: {
            figures: [
              {
                marker: 1,
                label: "Twice the EPS",
                formula: "x * 2",
                inputs: [
                  { name: "x", label: "EPS", citation: cited[0], number: "1.25", unitQuote: head },
                ],
              },
            ],
          },
        },
      ]),
    ],
    answer: "[=1][^1]",
  });
  const { core } = await setUpCalculating(model, [
    {
      name: "Pelican statement.docx",
      contents: docxOf(["Pelican statement", head, "Diluted EPS 1.25"].map((text) => ({ text }))),
    },
  ]);

  await askAndRead(core, "What is twice the EPS?");

  expect(told(model, "calculate")[0]).toContain(
    `[=1] x: 1.25 is on a per-share row, and the unitQuote "${head}" scales its Document's amounts except where it notes otherwise`,
  );
});

/** Ordinary rows of UK/IFRS, US GAAP and Chinese (CAS) statements: amounts a scale line covers. */
const AMOUNT_ROWS_EN = [
  "Revenue",
  "Cost of sales",
  "Gross profit",
  "Distribution costs",
  "Administrative expenses",
  "Other operating income",
  "Operating profit",
  "Finance income",
  "Finance costs",
  "Profit before tax",
  "Income tax expense",
  "Profit for the year",
  "Total comprehensive income for the year",
  "Staff costs",
  "Depreciation and amortisation",
  "Trade and other receivables",
  "Amounts due from customers",
  "Cash and cash equivalents",
  "Inventories",
  "Property, plant and equipment",
  "Trade and other payables",
  "Borrowings",
  "Share capital",
  "Retained earnings",
  "Net revenues",
  "Cost of units sold",
  "Selling, general and administrative",
  "Research and development",
  "Net income",
  "Interest income",
  "Dividends paid",
  "Revenue from stores",
  "Accounts receivable",
  "Accrued liabilities",
  "Long-term debt",
  "Total stockholders' equity",
  "Goodwill",
  "Deferred revenue",
  "Operating lease liabilities",
  "Capital expenditure",
];
const AMOUNT_ROWS_ZH = [
  "营业收入",
  "营业成本",
  "税金及附加",
  "销售费用",
  "管理费用",
  "研发费用",
  "财务费用",
  "其中：利息费用",
  "利息收入",
  "其他收益",
  "投资收益",
  "公允价值变动收益",
  "信用减值损失",
  "资产减值损失",
  "营业利润",
  "营业外收入",
  "营业外支出",
  "利润总额",
  "所得税费用",
  "净利润",
  "归属于母公司股东的净利润",
  "货币资金",
  "应收账款",
  "存货",
  "固定资产",
  "无形资产",
  "商誉",
  "短期借款",
  "应付账款",
  "应付职工薪酬",
  "应交税费",
  "长期借款",
  "实收资本（或股本）",
  "资本公积",
  "盈余公积",
  "未分配利润",
  "汇率变动对现金的影响",
  "员工薪酬",
  "经营活动产生的现金流量净额",
  "购建固定资产支付的现金",
];

// protects=#2365; fails_when=an ordinary amount row ("Profit for the year", "Staff costs", "Cost of units sold", 员工薪酬, 汇率变动的影响) is taken for a year, a count or a rate and refused, so a scaled statement can't be calculated.
test.each([
  { part: "English, 1–20", head: "(in thousands)", rows: AMOUNT_ROWS_EN.slice(0, 20) },
  { part: "English, 21–40", head: "(in thousands)", rows: AMOUNT_ROWS_EN.slice(20) },
  { part: "Chinese, 1–20", head: "单位：千元", rows: AMOUNT_ROWS_ZH.slice(0, 20) },
  { part: "Chinese, 21–40", head: "单位：千元", rows: AMOUNT_ROWS_ZH.slice(20) },
])(
  "every ordinary amount row is scaled by its line: $part",
  {
    timeout: 60_000,
  },
  async ({ head, rows }) => {
    const lines = rows.map((row) => `${row} 1,234.5`);
    const doubled = await doubledUnder(head, lines, lines);
    expect(rows.map((row, index) => [row, doubled[index]])).toEqual(
      rows.map((row) => [row, 2_469_000]),
    );
  },
);

// protects=#2365; fails_when=a per-share row labelled with its own currency ("Diluted EPS ($)", "基本每股收益（元）"), or with its label on the line above its number, is scaled with the amounts, so EPS comes out a thousand times too large.
test.each([
  {
    language: "English PDF, the label's own ($)",
    document: buildPdf([
      {
        lines: [
          "Pelican results",
          "(in thousands, except per share data)",
          "Revenue 1,234.5",
          "Diluted EPS ($) 1.25",
        ],
      },
    ]),
    name: "Pelican results.pdf",
    head: "(in thousands, except per share data)",
    quote: "Diluted EPS ($) 1.25",
    number: "1.25",
    doubled: 2.5,
  },
  {
    language: "Chinese PDF, the label's own （元）, rows joined",
    document: buildPdf([
      {
        chineseLines: [
          "Pelican 利润表",
          "单位：千元，每股收益除外",
          "营业收入 1,234.5",
          "基本每股收益（元） 0.52",
        ],
      },
    ]),
    name: "Pelican 利润表.pdf",
    head: "单位：千元，每股收益除外",
    quote: "基本每股收益（元） 0.52",
    number: "0.52",
    doubled: 1.04,
  },
  {
    language: "Chinese Word file, the label on the line above",
    document: docxOf(
      [
        "Pelican 利润表",
        "单位：千元，每股收益除外",
        "营业收入 1,234.5",
        "基本每股收益",
        "0.52",
      ].map((text) => ({ text })),
    ),
    name: "Pelican 利润表.docx",
    head: "单位：千元，每股收益除外",
    quote: "0.52",
    number: "0.52",
    doubled: 1.04,
  },
])(
  "a per-share row is left out of the scale however its label is written: $language",
  {
    timeout: 60_000,
  },
  async ({ document, name, head, quote, number, doubled }) => {
    const model = calculatingModel({
      queries: ["Pelican 利润表 results"],
      steps: [
        citeStatement("Pelican", [quote], (cited) => [
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "Twice the EPS",
                  formula: "eps * 2",
                  inputs: [
                    { name: "eps", label: "EPS", citation: cited[0], number, unitQuote: head },
                  ],
                },
              ],
            },
          },
        ]),
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [{ name, contents: document }]);

    const { answer } = await askAndRead(core, "What is twice the EPS?");

    expect(answer.figures.map((figure) => figure.value)).toEqual([doubled]);
  },
);

// protects=#2365; fails_when=a Word file read before this build keeps no header scale until it is added again, or re-reading it holds up the start or changes its Passages.
test("a Word file read before this build is read again in the background, keeps its Passages, and gains its header's scale", {
  timeout: 60_000,
}, async () => {
  const dataDir = await createTempDataFolder();
  const model = calculatingModel({ queries: [], steps: [], answer: "Nothing." });
  const { core } = await setUpCalculating(
    model,
    [scaleDocument(ENGLISH_FORMS[0] as ScaleForm, "word header", false)],
    dataDir,
  );
  const saved = (await core.listDocuments())[0];
  if (!saved) throw new Error("Missing Document.");
  core.close();
  const passages = () =>
    queryDatabase<{ id: string; text: string }>(
      dataDir,
      "SELECT id, text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY seq",
      [saved.id],
    );
  const before = passages();

  // As the build before left it: the header never read, and the older pipeline's version.
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  db.run("UPDATE document_pages SET scale_marker = '' WHERE document_id = ?", [saved.id]);
  db.run("UPDATE documents SET processing_version = 19 WHERE id = ?", [saved.id]);
  db.close();

  const again = startCore(dataDir);
  // The start doesn't wait for it: the Word file is only queued.
  expect((await again.listDocuments())[0]).toMatchObject({ id: saved.id, status: "queued" });
  await waitForProcessing(again, [saved.id]);
  expect(
    queryDatabase<{ scale_marker: string }>(
      dataDir,
      "SELECT DISTINCT scale_marker FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
      [saved.id],
    ).map((row) => row.scale_marker),
  ).toEqual(["£'000"]);
  expect(passages()).toEqual(before);
  again.close();
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
  test("its figures come in its JSON and are worked out the same way; one in error is dropped, and the Answer says so", async () => {
    const growth = GROWTH({ revenue: 1, margin: 2 });
    const badMargin = {
      ...growth[1],
      inputs: [
        { name: "gm2025", label: "Gross margin 2025", citation: 2, number: "42.1%" },
        { name: "gm2024", label: "Gross margin 2024", citation: 2, number: "38.9%" },
      ],
    };
    // Its provider refuses Tools, so the Answer steps down to structured output.
    const model = scriptedModel((call) =>
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
    expect(shown(answerBlocks(answer))).toBe("Revenue grew 20.4%, and gross margin rose.");
    expect(calculateCall(answer)).toMatchObject({ resultCount: 1, uncalculated: 1 });
    expect(translate("zh-CN", "answer.figures.uncalculated.one")).toBe("1 个数字未能计算");
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

/**
 * A workbook with one table: a heading row, then a row for each amount in column B, a cell with the
 * number format given and the number it stores, as a Budget table's cells are: "+23,770m" shows
 * where 23770 is stored.
 */
function amountsBook(table: {
  heading: string;
  format: string;
  rows: { label: string; stored: number; format?: string }[];
  /** Words in the table's own language, which settle how its numbers are written. */
  notes?: string;
}): Buffer {
  const formats = [table.format, ...table.rows.flatMap((row) => (row.format ? [row.format] : []))];
  const escaped = (code: string) => code.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const styles = [
    `<numFmts count="${formats.length}">${formats
      .map((code, at) => `<numFmt numFmtId="${164 + at}" formatCode="${escaped(code)}"/>`)
      .join("")}</numFmts>`,
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`,
    `<borders count="1"><border><left/><right/><top/><bottom/></border></borders>`,
    `<cellXfs count="${formats.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>${formats
      .map(
        (_, at) =>
          `<xf numFmtId="${164 + at}" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`,
      )
      .join("")}</cellXfs>`,
  ].join("");
  const text = (ref: string, value: string) =>
    `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const rows = table.rows
    .map((row, at) => {
      const style = row.format ? formats.indexOf(row.format) + 1 : 1;
      return `<row r="${at + 2}">${text(`A${at + 2}`, row.label)}<c r="B${at + 2}" s="${style}"><v>${row.stored}</v></c></row>`;
    })
    .join("");
  return xlsxPackage({
    sheets: [
      {
        name: "Table",
        xml: `<sheetData><row r="1">${text("A1", table.heading)}${text("B1", "2025-26")}</row>${rows}${table.notes ? `<row r="${table.rows.length + 2}">${text(`A${table.rows.length + 2}`, table.notes)}</row>` : ""}</sheetData>`,
      },
    ],
    styles,
  });
}

describe("A Calculated figure keeps the scale its inputs are worked in (#1442)", {
  timeout: 60_000,
}, () => {
  /** Asks for `formula` over the table's two rows; the Answer writes `answer` where the marker is. */
  async function calculated(
    book: Buffer,
    figure: { formula: string; unitQuote?: string; scale?: string; as?: string; decimals?: number },
    inputs: { name: string; row: number; number: string; line: string }[],
    answer: string,
    asked = "What is the net?",
  ) {
    const model = calculatingModel({
      queries: ["table"],
      steps: [
        (passages) => {
          const passage = passageOf(passages, "Table");
          return [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Net",
                    formula: figure.formula,
                    ...(figure.as && { as: figure.as }),
                    ...(figure.scale && { scale: figure.scale }),
                    ...(figure.decimals !== undefined && { decimals: figure.decimals }),
                    inputs: inputs.map((input) => ({
                      name: input.name,
                      label: input.name,
                      passage,
                      location: `Table, row ${input.row}`,
                      quote: input.line,
                      number: input.number,
                      ...(figure.unitQuote && { unitQuote: figure.unitQuote }),
                    })),
                  },
                ],
              },
            },
          ];
        },
      ],
      answer,
    });
    const { core } = await setUpCalculating(model, [{ name: "Table.xlsx", contents: book }]);
    return (await askAndRead(core, asked)).answer;
  }

  const MILLIONS = amountsBook({
    heading: "£ million",
    format: '+#,##0"m";-#,##0"m"',
    rows: [
      { label: "Employer NICs", stored: 23770 },
      { label: "Employee NICs", stored: -9295 },
    ],
  });
  const NET = [
    { name: "autumn", row: 2, number: "+23,770m", line: "Employer NICs\t+23,770m" },
    { name: "spring", row: 3, number: "-9,295m", line: "Employee NICs\t-9,295m" },
  ];

  test("cells that show £ million as '+23,770m' give a net shown in millions, not '0 million' or '14 thousand'", async () => {
    const own = await calculated(MILLIONS, { formula: "autumn + spring" }, NET, "The net is [=1].");
    expect(own.figures).toMatchObject([
      {
        value: 14_475_000_000,
        shown: "14,475m",
        inputs: [
          { number: { chars: "+23,770m", value: 23_770_000_000 }, cell: { stored: 23770 } },
          { number: { chars: "-9,295m", value: -9_295_000_000 }, cell: { stored: -9295 } },
        ],
      },
    ]);

    // As Claude Sonnet 5.5 did, asking for the scale by name; and as GPT-6.1 Sol did, in a number.
    const named = await calculated(
      MILLIONS,
      { formula: "autumn + spring", scale: "million" },
      NET,
      "The net is [=1].",
    );
    expect(named.figures[0]?.shown).toBe("14,475 million");
    const plain = await calculated(
      MILLIONS,
      { formula: "autumn + spring", as: "number", decimals: 0 },
      NET,
      "The net is [=1].",
    );
    expect(plain.figures[0]?.shown).toBe("14,475m");
  });

  test("the same when the workbook's words settle how its numbers are written", async () => {
    const book = amountsBook({
      heading: "Table 5.1: the costs and yields of the measures, in pounds million",
      format: '+#,##0"m";-#,##0"m"',
      rows: [
        { label: "Employer National Insurance contributions: increase the rate", stored: 23770 },
        { label: "Employee National Insurance contributions: cut the main rate", stored: -9295 },
      ],
      notes:
        "The costs of the measures are those the Office for Budget Responsibility certified, and they are shown in pounds million for each year of the forecast.",
    });
    const answer = await calculated(
      book,
      { formula: "autumn + spring" },
      [
        {
          name: "autumn",
          row: 2,
          number: "+23,770m",
          line: "Employer National Insurance contributions: increase the rate\t+23,770m",
        },
        {
          name: "spring",
          row: 3,
          number: "-9,295m",
          line: "Employee National Insurance contributions: cut the main rate\t-9,295m",
        },
      ],
      "The net is [=1].",
    );
    expect(answer.figures).toMatchObject([{ value: 14_475_000_000, shown: "14,475m" }]);
    expect(answer.figures[0]?.inputs[0]?.number.value).toBe(23_770_000_000);
  });

  test.each([
    { larger: 2, smaller: 500, shown: "£2.5bn", value: 2_500_000_000 },
    { larger: 1.2, smaller: 350, shown: "£1.55bn", value: 1_550_000_000 },
    { larger: 2, smaller: 512, shown: "£2,512m", value: 2_512_000_000 },
    { larger: 1.2, smaller: 383, shown: "£1,583m", value: 1_583_000_000 },
    { larger: 1.2, smaller: 300, shown: "£1.5bn", value: 1_500_000_000 },
    { larger: 1.2, smaller: 800, shown: "£2.0bn", value: 2_000_000_000 },
  ])(
    "£$larger bn and £$smaller m together, from cells that store the numbers before 'bn' and 'm': the larger scale with one decimal more than its input has when that loses no digits, else the smaller (#1482)",
    async (case_) => {
      const largerCell = `£${case_.larger}bn`;
      const book = amountsBook({
        heading: "Revenue",
        format: Number.isInteger(case_.larger) ? '"£"0"bn"' : '"£"0.0"bn"',
        rows: [
          { label: "Product", stored: case_.larger },
          { label: "Services", stored: case_.smaller, format: '"£"0"m"' },
        ],
      });
      const answer = await calculated(
        book,
        { formula: "product + services" },
        [
          { name: "product", row: 2, number: largerCell, line: `Product\t${largerCell}` },
          {
            name: "services",
            row: 3,
            number: `£${case_.smaller}m`,
            line: `Services\t£${case_.smaller}m`,
          },
        ],
        "Revenue came to [=1].",
      );
      expect(answer.figures[0]?.value).toBe(case_.value);
      expect(answer.figures[0]?.shown).toBe(case_.shown);
    },
  );

  test.each([
    { larger: 2, smaller: 5000, shown: "2.5亿元", value: 250_000_000 },
    { larger: 1.2, smaller: 3500, shown: "1.55亿元", value: 155_000_000 },
    { larger: 2, smaller: 5120, shown: "25,120万元", value: 251_200_000 },
    { larger: 1.2, smaller: 3830, shown: "15,830万元", value: 158_300_000 },
    { larger: 1.2, smaller: 3000, shown: "1.5亿元", value: 150_000_000 },
  ])(
    "$larger亿元 and $smaller万元 together, in Chinese: 亿 with one decimal more than its input has when that loses no digits, else 万 (#1482)",
    async (case_) => {
      const larger = `${case_.larger.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(case_.larger) ? 0 : 1 })}亿元`;
      const smaller = `${case_.smaller.toLocaleString("en-US")}万元`;
      const book = amountsBook({
        heading: "合并利润表",
        format: Number.isInteger(case_.larger) ? '0"亿元"' : '0.0"亿元"',
        rows: [
          { label: "产品收入", stored: case_.larger },
          { label: "服务收入", stored: case_.smaller, format: '#,##0"万元"' },
        ],
        notes: "本公司收入同比增长，主要来自新增客户的收入，以上数字均以亿元或万元列示。",
      });
      const answer = await calculated(
        book,
        { formula: "product + services" },
        [
          { name: "product", row: 2, number: larger, line: `产品收入\t${larger}` },
          { name: "services", row: 3, number: smaller, line: `服务收入\t${smaller}` },
        ],
        "收入合计为[=1]。",
        "收入合计是多少？",
      );
      expect(answer.figures[0]?.value).toBe(case_.value);
      expect(answer.figures[0]?.shown).toBe(case_.shown);
    },
  );

  test("万元 written after a cell's number is worked in yuan and shown in 万元, in Chinese", async () => {
    const book = amountsBook({
      heading: "合并利润表",
      format: '#,##0.00"万元"',
      rows: [
        { label: "营业收入 2025年", stored: 152340.56 },
        { label: "营业收入 2024年", stored: 121883.2 },
      ],
      notes: "本公司营业收入同比增长，主要来自新增客户的收入，以上数字均以万元列示。",
    });
    const answer = await calculated(
      book,
      { formula: "y2025 - y2024" },
      [
        {
          name: "y2025",
          row: 2,
          number: "152,340.56万元",
          line: "营业收入 2025年\t152,340.56万元",
        },
        {
          name: "y2024",
          row: 3,
          number: "121,883.20万元",
          line: "营业收入 2024年\t121,883.20万元",
        },
      ],
      "营业收入增加了[=1]。",
      "营业收入增加了多少？",
    );
    expect(answer.figures[0]?.value).toBe(304_573_600);
    expect(answer.figures[0]?.shown).toBe("30,457.36万元");
  });

  /** Cells that show plain numbers under a heading that states the unit: "(£m)", "($bn)", "单位：万元". */
  const headed = (heading: string, stored: [number, number], format = "#,##0") =>
    amountsBook({
      heading,
      format,
      rows: [
        { label: "Revenue", stored: stored[0] },
        { label: "Costs", stored: stored[1] },
      ],
    });

  test.each([
    {
      heading: "Table 5.1 (£m)",
      format: "#,##0",
      stored: [23770, 9295] as [number, number],
      numbers: ["23,770", "9,295"],
      shown: "£14,475m",
      value: 14_475_000_000,
    },
    {
      heading: "Revenue ($bn)",
      format: "0.0",
      stored: [1.2, 0.3] as [number, number],
      numbers: ["1.2", "0.3"],
      shown: "$900 million",
      value: 900_000_000,
    },
  ])(
    "plain cells under the heading '$heading' are worked in its unit, and the result keeps it",
    async (table) => {
      const answer = await calculated(
        headed(table.heading, table.stored, table.format),
        { formula: "revenue - costs", unitQuote: table.heading },
        [
          {
            name: "revenue",
            row: 2,
            number: table.numbers[0] as string,
            line: `Revenue\t${table.numbers[0]}`,
          },
          {
            name: "costs",
            row: 3,
            number: table.numbers[1] as string,
            line: `Costs\t${table.numbers[1]}`,
          },
        ],
        "The net is [=1].",
      );
      expect(answer.figures[0]?.value).toBe(table.value);
      expect(answer.figures[0]?.shown).toBe(table.shown);
    },
  );

  describe("A bracketed negative finds its cell (#1451)", { timeout: 60_000 }, () => {
    // protects=a negative a workbook writes in brackets, with or without a currency and a scale, or one a number format scales itself, is credited to its own cell, which stores its sign; fails_when=a figure's input has no cell, or a scaled cell's stored number isn't worked in at the scale it shows; no_claim=how a card shows the cell.
    test.each([
      {
        name: "brackets from a number format",
        format: "#,##0;(#,##0)",
        cells: [-1234, -500],
        stored: [-1234, -500],
        shown: ["(1,234)", "(500)"],
        value: -1734,
        figure: "-1,734",
      },
      {
        name: "brackets with a currency and a scale written in the format",
        format: '"£"#,##0.0"m";("£"#,##0.0"m")',
        cells: [-23.7, -1.3],
        stored: [-23.7, -1.3],
        shown: ["(£23.7m)", "(£1.3m)"],
        value: -25_000_000,
        figure: "-£25.0m",
      },
      {
        name: "brackets and a scale the format applies itself",
        format: '"£"#,##0.0,,"m";("£"#,##0.0,,"m")',
        cells: [-23_700_000, -1_300_000],
        stored: [-23_700_000, -1_300_000],
        shown: ["(£23.7m)", "(£1.3m)"],
        value: -25_000_000,
        figure: "-£25.0m",
      },
      {
        name: "a positive beside a negative: a cell whose text is its number stores nothing more",
        format: "#,##0;(#,##0)",
        cells: [-1234, 500],
        stored: [-1234, null],
        shown: ["(1,234)", "500"],
        value: -734,
        figure: "-734",
      },
    ])("$name", async (table) => {
      const book = amountsBook({
        heading: "Table",
        format: table.format,
        rows: [
          { label: "A", stored: table.cells[0] as number },
          { label: "B", stored: table.cells[1] as number },
        ],
      });
      const answer = await calculated(
        book,
        { formula: "a + b" },
        [
          { name: "a", row: 2, number: table.shown[0] as string, line: `A\t${table.shown[0]}` },
          { name: "b", row: 3, number: table.shown[1] as string, line: `B\t${table.shown[1]}` },
        ],
        "Together [=1].",
      );
      expect(answer.figures).toMatchObject([
        {
          value: table.value,
          shown: table.figure,
          inputs: [
            { cell: { sheet: "Table", ref: "B2", stored: table.stored[0] } },
            { cell: { sheet: "Table", ref: "B3", stored: table.stored[1] } },
          ],
        },
      ]);
    });
  });
});

/** The reserves table of SAFE's workbook: each month's figures as text, under a Chinese and an English unit line. */
function reservesBook(): Buffer {
  const text = (ref: string, value: string) =>
    `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const row = (at: number, cells: string[]) =>
    `<row r="${at}">${cells.map((value, column) => (value ? text(`${"ABCD"[column]}${at}`, value) : "")).join("")}</row>`;
  return xlsxPackage({
    sheets: [
      {
        name: "Sheet1",
        xml: `<sheetData>${[
          row(1, ["官方储备资产"]),
          row(2, ["Official reserve assets"]),
          row(4, ["项目 Item", "2026.01", "", "2026.09"]),
          row(5, ["", "亿美元", "亿SDR", "亿美元"]),
          row(6, ["", "100million USD", "100million SDR", "100million USD"]),
          row(8, ["1. 外汇储备", "33990.78 ", "24597.67 ", "34002.51 "]),
        ].join("")}</sheetData>`,
      },
    ],
  });
}

describe("A ratio among a figure's inputs leaves it shown as its amounts are written (#1784)", {
  timeout: 60_000,
}, () => {
  const REPORTS = {
    en: {
      name: "Northwind Annual Report.pdf",
      lines: [
        "EBITDA was £44 million in 2025, and net debt to EBITDA is 3.5:1.",
        "Revenue was £352 million at a margin of 12.5%.",
        "Cash at the year end was £12,400 thousand.",
        "Product revenue was $1.2 billion and services $350 million.",
      ],
      asked: "What does it come to?",
      answer: "It comes to [=1].",
    },
    "zh-CN": {
      name: "北风年度报告.pdf",
      lines: [
        "息税折旧摊销前利润为1.2亿元，净负债与其之比为3.5:1。",
        "营业收入2.4亿元，利润率为25.0%。",
        "期末现金为12,400万元，服务收入为3,500万元。",
      ],
      asked: "合计是多少？",
      answer: "合计为[=1]。",
    },
  };

  test.each([
    ["en", "ebitda * ratio", ["£44 million", "3.5"], null, "£154 million"],
    ["en", "ebitda * ratio", ["£44 million", "3.5"], "million", "£154 million"],
    ["en", "revenue * margin * ratio", ["£352 million", "12.5%", "3.5"], null, "£154 million"],
    ["en", "cash * ratio", ["£12,400 thousand", "3.5"], null, "£43,400 thousand"],
    [
      "en",
      "(product + services) * ratio",
      ["$1.2 billion", "$350 million", "3.5"],
      null,
      "$5,425 million",
    ],
    [
      "en",
      "(product + services) * ratio",
      ["$1.2 billion", "$350 million", "3.5"],
      "billion",
      "$5.425 billion",
    ],
    ["zh-CN", "ebitda * ratio", ["1.2亿元", "3.5"], null, "4.2亿元"],
    ["zh-CN", "ebitda * ratio", ["1.2亿元", "3.5"], "亿", "4.2亿元"],
    ["zh-CN", "revenue * margin * ratio", ["2.4亿元", "25.0%", "3.5"], null, "2.1亿元"],
    ["zh-CN", "cash * ratio", ["12,400万元", "3.5"], null, "43,400万元"],
    ["zh-CN", "(ebitda + services) * ratio", ["1.2亿元", "3,500万元", "3.5"], null, "54,250万元"],
  ] as const)("%s: %s over %j in %s shows %s", async (language, formula, numbers, scale, shown) => {
    const report = REPORTS[language];
    const names = formula.match(/[a-z]+/g) ?? [];
    const model = calculatingModel({
      queries: [language === "en" ? "EBITDA" : "息税折旧摊销前利润"],
      steps: [
        (passages) => {
          const passage = passageOf(passages, report.name.slice(0, 2));
          const inputs = numbers.map((number, at) => ({
            name: names[at],
            label: names[at],
            passage,
            location: "p. 1",
            quote: report.lines.find((line) => line.includes(number)),
            number,
          }));
          const figure = { marker: 1, label: "Figure", formula, inputs, ...(scale && { scale }) };
          return [{ tool: "calculate", input: { figures: [figure] } }];
        },
      ],
      answer: report.answer,
    });
    const contents = buildPdf([
      language === "en" ? { lines: report.lines } : { chineseLines: report.lines },
    ]);
    const { core } = await setUpCalculating(model, [{ name: report.name, contents }]);
    expect((await askAndRead(core, report.asked)).answer.figures[0]?.shown).toBe(shown);
  });
});

describe("The difference of two cited cells is calculated, not given up on (#1444)", {
  timeout: 60_000,
}, () => {
  const RESERVES = { name: "官方储备资产（2026年）.xlsx", contents: reservesBook() };

  /** What a model did against this table: a calculate call per step, each as given. */
  function reserves(steps: Record<string, unknown>[], answer: string) {
    return calculatingModel({
      queries: ["外汇储备"],
      steps: steps.map((figure) => (passages: ShownPassage[]): Call[] => {
        const passage = passageOf(passages, "官方储备资产");
        const input = (name: string, number: string, label: string) => ({
          name,
          label,
          passage,
          location: "Sheet1, row 8",
          quote: number,
          number,
          ...(figure.unitQuote ? { unitQuote: figure.unitQuote } : {}),
        });
        const { unitQuote: _, ...rest } = figure;
        return [
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "Change in foreign currency reserves",
                  formula: "sep - jan",
                  ...rest,
                  inputs: [
                    input("sep", "34002.51", "2026.09"),
                    input("jan", "33990.78", "2026.01"),
                  ],
                },
              ],
            },
          },
        ];
      }),
      answer,
    });
  }

  test("the English half of a bilingual unit line, '100million USD', states the scale; a Chinese Answer shows 11.73亿美元", async () => {
    const model = reserves(
      [{ unitQuote: "100million USD", as: "number" }],
      "9月末比1月末增加了[=1]。",
    );
    const { core } = await setUpCalculating(model, [RESERVES]);

    const { answer } = await askAndRead(core, "9月末外汇储备与1月末相比变化了多少？");

    expect(answer.figures).toMatchObject([{ value: 1_173_000_000, shown: "11.73亿美元" }]);
    expect(calculateCall(answer)).toMatchObject({ resultCount: 1 });
  });

  test("a figure refused for its scale says so, not for a way of showing it it has already dropped; five calls are allowed", async () => {
    const model = reserves(
      [
        { unitQuote: "100million USD", as: "number", scale: "亿" },
        { unitQuote: "100million USD", as: "number", scale: "billion", decimals: 2 },
      ],
      "The reserves rose by [=1].",
    );
    const { core } = await setUpCalculating(model, [RESERVES]);

    const { answer } = await askAndRead(
      core,
      "How much did the reserves change from January to September?",
    );

    const [first] = told(model, "calculate");
    expect(first).toContain("scale must be one of");
    expect(first).not.toContain("can't be shown as a number");
    expect(answer.figures).toMatchObject([{ value: 1_173_000_000, shown: "$1.17 billion" }]);
  });
});

describe("A number takes the unit its row gives it in a cell of its own (#1798)", {
  timeout: 60_000,
}, () => {
  const ROW = "净负债\t2026年三季度实际\t31000\t万元\t实际，非预测";

  // protects=31000 quoted alone from a row whose next cell says 万元 is never read as 31,000 元: the model is asked for the row as unitQuote, and the row gives 3.1亿元; fails_when=the figure comes out 0.00031亿 or the row is refused as stating no unit; no_claim=a unit stated on another row, which still needs its own line.
  test("31000 beside a 万元 cell asks for its row, and the row gives 3.1000亿元", async () => {
    const figure = (unitQuote?: string) => ({
      marker: 1,
      label: "净负债（亿元）",
      formula: "nd",
      scale: "亿",
      inputs: [{ name: "nd", label: "净负债", citation: 1, number: "31000", unitQuote }],
    });
    const model = calculatingModel({
      queries: ["净负债"],
      steps: [
        (passages) => [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passageOf(passages, "雪松控股"),
                  location: "2026年三季度, row 6",
                  quote: "31000",
                },
              ],
            },
          },
          { tool: "calculate", input: { figures: [figure()] } },
        ],
        () => [{ tool: "calculate", input: { figures: [figure(ROW)] } }],
      ],
      answer: "净负债为[=1][^1]。",
    });
    const name = "雪松控股2026年三季度终稿.xlsx";
    const { core } = await setUpCalculating(model, [
      {
        name,
        contents: await readFile(join(import.meta.dirname, "../fixtures/comparisons", name)),
      },
    ]);
    const { answer } = await askAndRead(core, "2026年三季度的净负债是多少亿元？");
    const [asked, recorded] = told(model, "calculate");
    expect(asked).toContain(`31000 has no unit, and 2026年三季度, row 6 says "${ROW}"`);
    expect(recorded).toContain("Recorded [=1] = 3.1000亿元");
    expect(answer.figures).toMatchObject([
      {
        value: 310_000_000,
        inputs: [
          { number: { chars: "31000", value: 310_000_000 }, unitStatement: { scale: 10_000 } },
        ],
      },
    ]);
  });
});

/** The margin's change from the row the Answer cites as `citation`, read with `numbers`. */
const marginChange = (citation: number, numbers = ["41.2%", "38.9%"]) => [
  {
    marker: 1,
    label: "Change in gross margin",
    formula: "gm2025 - gm2024",
    inputs: [
      { name: "gm2025", label: "Gross margin 2025", citation, number: numbers[0] },
      { name: "gm2024", label: "Gross margin 2024", citation, number: numbers[1] },
    ],
  },
];

/**
 * A model that searches, then makes each of `steps` in turn, one request each, from the Passage
 * its search showed it; asked again after the last, it writes nothing more.
 */
function steppingModel(steps: ((passage: string) => { text?: string; calls: Call[] })[]) {
  let made = 0;
  return scriptedModel((call) => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) {
      return { calls: [{ tool: "search_documents", input: { query: "Acme revenue margin" } }] };
    }
    const step = steps[made++];
    return step ? step(passageOf(shownPassages(searched.text), "Acme")) : { text: "" };
  });
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
            { tool: "calculate", input: { figures: marginChange(1, ["45.0%", "38.9%"]) } },
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
      const model = scriptedModel((call) => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "Acme revenue margin" } }] };
        }
        const passage = passageOf(shownPassages(searched.text), "Acme");
        return call.results.some((result) => result.tool === "cite")
          ? { calls: [citeOne(passage, 2, "p. 2", "Gross margin 99.9%")] }
          : refused(passage);
      });
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
