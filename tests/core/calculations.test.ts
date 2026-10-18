/**
 * Calculated figures (#438, ADR-0021): an Answer's model names each input's
 * number in a quote and a formula; IncarnaMind reads the numbers, checks the
 * quotes and does the arithmetic, and the Answer shows the result where the
 * model wrote its marker ("[=1]"). Through the core's public interface, as the
 * assistant uses it, with a scripted chat model (and, for structured output, a
 * stub of a small local model).
 */
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  type ConversationAnswer,
  type Core,
  DATABASE_FILE,
  type MarkedFigure,
} from "../../src/core";
import { migrate, migrations, openDatabase } from "../../src/core/storage";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
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
import { lastAnswerCall, promptOf, scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxPackage } from "../helpers/office";
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
    const citations = lines.map((quote, index) => ({
      marker: index + 1,
      passage,
      location: "p. 1",
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

/** What each call of `tool` told the model, oldest first, as the model's last request shows them. */
function told(model: MockLanguageModelV4, tool: string): string[] {
  const last = model.doStreamCalls.at(-1);
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
    node.type === "text" ? (node.text ?? "") : (node.content ?? []).map(inline).join("");
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
 * allowed, and the files are added as Documents.
 */
async function setUpCalculating(
  model: MockLanguageModelV4,
  files: readonly { name: string; contents: string | Uint8Array }[],
  dataDir?: string,
) {
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
    createChatModel: scriptedModels(model).createChatModel,
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
    expect(steer.length).toBeLessThan(900);
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toContain("calculate");
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

    expect(model.doStreamCalls).toHaveLength(3);
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
      "- [=13]: VLOOKUP isn't available; use + - * / ^, SUM, AVERAGE, MIN, MAX, ABS, ROUND, RRI, SQRT.",
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
      "1 figure couldn't be calculated",
    );
  });

  test("a marker given again replaces its figure, and the model is told; past three calls in one Answer, calculate is refused so the model answers", async () => {
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
    expect(results[3]).toBe(
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

    await askAndRead(core, "Why?", conversationId);

    const earlier = promptOf(model, lastAnswerCall(model)).filter(
      (message) => message.role === "assistant" && message.text,
    );
    expect(earlier.map((message) => message.text)).toEqual([
      "Revenue grew 20.4% in 2025[Acme Annual Report 2025, p. 1]; gross margin rose 2.3 percentage points[Acme Annual Report 2025, p. 2].",
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
    expect(JSON.stringify(request)).not.toMatch(/calculations|calculate/);
    expect(ended.payload).toMatchObject({ figures: [], uncalculated: 0, figureRetry: null });
    expect(answerIn(client, answerId).textContent).toBe("Revenue grew 20.4% .");
  });
});
