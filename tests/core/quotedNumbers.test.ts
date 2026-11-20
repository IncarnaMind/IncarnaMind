/**
 * A number in a quote that an Analysis reads (#447): its scale, currency, sign and footnote marks,
 * as `calculate` read an input's before #3393 and the figure schedule still reads one. Each
 * script's `calculate` call is given to `run_analysis` as quoted numbers, a run for each figure.
 * Through the core's public interface, as the assistant uses it, with a scripted chat model and a
 * fake Analysis runtime.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  type ConversationAnswer,
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type SaveChatProviderInput,
} from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { createFakeTextRecognizer, type FakeScanScript } from "../../src/core/documents/scan/fake";
import { openDatabase } from "../../src/core/storage";
import { evaluateArithmetic } from "../../src/shared/formula";
import { translate } from "../../src/shared/i18n";
import { answerEnded, type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { answerRequests, judgesNothing, scriptedModel, scriptedModels } from "../helpers/models";
import { docxOf, xlsxOf, xlsxPackage } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { paragraph, table, wordFile } from "../helpers/word";

const INCOME = "营业收入 152,340.56 121,883.20";

/** A Chinese annual report's income statement, its amounts in 万元 stated only in its heading. */
const REPORT = {
  name: "某公司2025年年度报告.pdf",
  contents: buildPdf([{ chineseLines: ["合并利润表", "单位：万元", INCOME] }]),
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

interface GivenFigure {
  marker: number;
  formula: string;
  inputs: unknown[];
}

/**
 * A step's calls, with each `calculate` call given to an Analysis instead: a run for each figure,
 * titled by its step and marker, its inputs as given and its formula as the code.
 */
function asAnalyses(calls: readonly Call[], step: number): Call[] {
  return calls.flatMap((call) => {
    if (call.tool !== "calculate") return [call];
    const { figures } = call.input as { figures: GivenFigure[] };
    return figures.map((figure) => ({
      tool: "run_analysis",
      input: { title: `${step} [=${figure.marker}]`, inputs: figure.inputs, code: figure.formula },
    }));
  });
}

/** A runtime that runs no code: a run's figure is its formula over the numbers it was given. */
const evaluating = () =>
  createFakeAnalysisRuntime({
    answer: (job) => {
      const worked = evaluateArithmetic(
        job.code,
        job.inputs.flatMap((input) =>
          input.kind === "number" ? [{ name: input.name, value: input.value }] : [],
        ),
      );
      const value = worked.ok && typeof worked.value === "number" ? worked.value : null;
      return {
        output: {
          results:
            value === null
              ? []
              : [{ kind: "figure", name: "figure", label: "Figure", unit: null, value }],
        },
      };
    },
  });

/** `items` six at a time, as an Answer runs at most six Analyses. */
const inSixes = <T>(items: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / 6) }, (_, index) =>
    items.slice(index * 6, index * 6 + 6),
  );

/** The marker of the figure a run's title names. */
const markerOf = (title: string) => Number(/\[=(\d+)\]/.exec(title)?.[1]);

/** `text` without its figure markers, or a sentence of its own where nothing else is left. */
function withoutMarkers(text: string): string {
  const left = text.replace(/\[=\d+\]/g, "").trim();
  return left.replace(/\[\^\d+\]/g, "").trim() ? left : `The figures are worked out.${left}`;
}

/**
 * A model that searches for each query in turn, then makes each step's calls
 * (from the Passages its searches showed it), one step per request, then
 * writes `answer` with its figure markers left out, as a run's are its own.
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
      const index = call.index - plan.queries.length;
      const step = plan.steps[index];
      if (step) {
        return {
          calls: asAnalyses(step(searches.flatMap((each) => shownPassages(each.text))), index),
        };
      }
      return { text: withoutMarkers(plan.answer) };
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

/**
 * What the runs of each step's `calculate` call told the model, a string for each such call: each
 * input a run refused as "[=n] name: problem", each run that ran as "Recorded [=n]".
 */
function toldRuns(model: MockLanguageModelV4): string[] {
  const last = answerRequests(model).at(-1);
  if (!last) throw new Error("The model wasn't asked anything.");
  const titles = new Map<string, string>();
  const bySteps = new Map<string, string[]>();
  for (const message of last.prompt) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && part.toolName === "run_analysis") {
          const input: unknown =
            typeof part.input === "string" ? JSON.parse(part.input) : part.input;
          const title =
            typeof input === "object" && input !== null && "title" in input ? input.title : "";
          titles.set(part.toolCallId, String(title));
        }
      }
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "run_analysis") continue;
      if (part.output.type !== "text") continue;
      const title = titles.get(part.toolCallId) ?? "";
      const step = title.split(" ")[0] ?? "";
      const marker = markerOf(title);
      const said = part.output.value;
      const lines = said.startsWith("Nothing ran.")
        ? said
            .split("\n")
            .slice(1)
            .map((line) => `[=${marker}] ${line.replace(/^- /, "")}`)
        : [`Recorded [=${marker}]`];
      bySteps.set(step, [...(bySteps.get(step) ?? []), ...lines]);
    }
  }
  return [...bySteps.values()].map((lines) => lines.join("\n"));
}

/** Each figure a run worked out, by marker, the last run for it: its value and the numbers read. */
function figuresOf(answer: ConversationAnswer) {
  const byMarker = new Map(
    answer.analyses.map((analysis) => [
      markerOf(analysis.title),
      {
        marker: markerOf(analysis.title),
        value: analysis.output.results.find((each) => each.kind === "figure")?.value ?? null,
        inputs: analysis.inputs.flatMap((each) => (each.kind === "figure" ? [each.input] : [])),
      },
    ]),
  );
  return [...byMarker.values()].sort((a, b) => a.marker - b.marker);
}

/** Asks in the assistant for an Analysis and waits for the Answer; returns it, and its end. */
async function askAndRead(core: Core, text: string, conversationId?: string) {
  const asked = await core.askInConversation({ text, conversationId, analyse: true });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, finished: ended.payload, conversationId: asked.conversation.id };
}

/**
 * A core whose chat model is Claude Haiku 5.5 (or `provider`), scripted, with an Analysis runtime
 * that works out each run's formula. Its service is allowed, and the files are added as
 * Documents. Its Answers run the Tool loop from the first call, as the scripts call it, whatever
 * the retrieve-first list says (#1633).
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
    analysisRuntime: evaluating(),
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

describe("An Analysis's quoted number", { timeout: 60_000 }, () => {
  test("an amount under the heading's 单位：万元 needs that line as unitQuote, never guessed, in a growth rate too", async () => {
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

    const [first, second] = toldRuns(model);
    // A ratio's scale cancelled inside calculate's formula; an Analysis's number stands alone.
    expect(first).toBe(
      [1, 2]
        .flatMap((marker) => [
          `[=${marker}] y2025: 152,340.56 has no unit, and p. 1 says "单位：万元"; give that line as unitQuote.`,
          `[=${marker}] y2024: 121,883.20 has no unit, and p. 1 says "单位：万元"; give that line as unitQuote.`,
        ])
        .join("\n"),
    );
    expect(second).toBe("Recorded [=2]");
    expect(figuresOf(answer)).toMatchObject([
      {
        marker: 2,
        value: 304_573_600,
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

    expect(figuresOf(answer)).toMatchObject([
      {
        value: expect.closeTo(0.00233, 9),
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
});

describe("A raised footnote digit after an amount (#2474)", { timeout: 60_000 }, () => {
  test("an Analysis reads 1,240.50, and neither a joined quote nor a joined number passes", async () => {
    const pdf = buildPdf([
      {
        lines: ["Grants paid 2025"],
        placed: [
          { text: "Hollin Pumps 1,240.50", x: 72, y: 700 },
          { text: "1", x: 173, y: 703, size: 7 },
        ],
      },
    ]);
    const figures = (passage: string) => [
      {
        marker: 1,
        label: "Grant paid",
        formula: "amount",
        inputs: [
          {
            name: "amount",
            label: "Grant",
            passage,
            location: "p. 1",
            quote: "Hollin Pumps 1,240.50¹",
            number: "1,240.50",
          },
        ],
      },
      {
        marker: 2,
        label: "Joined digits",
        formula: "joined",
        inputs: [
          {
            name: "joined",
            label: "Joined",
            passage,
            location: "p. 1",
            quote: "Hollin Pumps 1,240.501",
            number: "1,240.501",
          },
        ],
      },
      {
        marker: 3,
        label: "Joined number",
        formula: "named",
        inputs: [
          {
            name: "named",
            label: "Named",
            passage,
            location: "p. 1",
            quote: "Hollin Pumps 1,240.50¹",
            number: "1,240.501",
          },
        ],
      },
    ];
    const model = calculatingModel({
      queries: ["grants paid"],
      steps: [
        (passages): Call[] => [
          {
            tool: "calculate",
            input: { figures: figures(passageOf(passages, "Grants paid 2025")) },
          },
        ],
      ],
      answer: "Hollin Pumps was paid [=1].",
    });
    const { core } = await setUpCalculating(model, [
      { name: "Grants paid 2025.pdf", contents: pdf },
    ]);

    const { answer } = await askAndRead(core, "How much was Hollin Pumps paid?");

    expect(figuresOf(answer)).toMatchObject([
      {
        marker: 1,
        inputs: [
          {
            citation: { quote: "Hollin Pumps 1,240.50¹", check: "found", pageFrom: 1 },
            number: { chars: "1,240.50¹", value: 1240.5 },
          },
        ],
      },
    ]);
    expect(figuresOf(answer)).toHaveLength(1);
    const [message] = toldRuns(model);
    expect(message).toContain("Recorded [=1]");
    expect(message).toContain("[=2] joined: the quote isn't word for word");
    expect(message).toContain('[=3] named: the quote has no number "1,240.501"; it has 1,240.50¹.');
  });
});

describe("A circled footnote mark after an amount (#2646)", { timeout: 60_000 }, () => {
  test("an Analysis reads 1,240.50 from 1,240.50①, and a joined number doesn't pass", async () => {
    const figures = (passage: string) => [
      {
        marker: 1,
        label: "Grant paid",
        formula: "amount",
        inputs: [
          {
            name: "amount",
            label: "Grant",
            passage,
            quote: "Hollin Pumps 1,240.50①",
            number: "1,240.50",
          },
        ],
      },
      {
        marker: 2,
        label: "Joined digits",
        formula: "joined",
        inputs: [
          {
            name: "joined",
            label: "Joined",
            passage,
            quote: "Hollin Pumps 1,240.501",
            number: "1,240.501",
          },
        ],
      },
      {
        marker: 3,
        label: "Joined number",
        formula: "named",
        inputs: [
          {
            name: "named",
            label: "Named",
            passage,
            quote: "Hollin Pumps 1,240.50①",
            number: "1,240.501",
          },
        ],
      },
    ];
    const model = calculatingModel({
      queries: ["grants paid"],
      steps: [
        (passages): Call[] => [
          {
            tool: "calculate",
            input: { figures: figures(passageOf(passages, "Grants paid 2025")) },
          },
        ],
      ],
      answer: "Hollin Pumps was paid [=1].",
    });
    const { core } = await setUpCalculating(model, [
      { name: "Grants paid 2025.txt", contents: "Grants paid 2025\nHollin Pumps 1,240.50①" },
    ]);

    const { answer } = await askAndRead(core, "How much was Hollin Pumps paid?");

    expect(figuresOf(answer)).toMatchObject([
      {
        marker: 1,
        inputs: [
          {
            citation: { quote: "Hollin Pumps 1,240.50①", check: "found" },
            number: { chars: "1,240.50①", value: 1240.5 },
          },
        ],
      },
    ]);
    expect(figuresOf(answer)).toHaveLength(1);
    const [message] = toldRuns(model);
    expect(message).toContain("Recorded [=1]");
    expect(message).toContain("[=2] joined: the quote isn't word for word");
    expect(message).toContain('[=3] named: the quote has no number "1,240.501"; it has 1,240.50①.');
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

    expect(
      figuresOf(answer)[0]?.inputs.map((input) => [input.number.chars, input.number.value]),
    ).toEqual([
      ["£385,000.00", 385_000],
      ["(£4,620.00)", -4_620],
      ["(£1,500.00)", -1_500],
      ["(£804.00)", -804],
    ]);
    expect(figuresOf(answer)[0]?.value).toBe(378_076);
    expect(told(model, "search_documents")[0]).toContain(
      "An amount in brackets in these Passages is negative",
    );
  });

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

    expect(figuresOf(answer)[0]?.inputs.map((input) => input.number.value)).toEqual([
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

    const { answer } = await askAndRead(core, "What were the net sale proceeds of 14 Mill Lane?");

    expect(
      figuresOf(answer)[0]?.inputs.map((input) => [input.number.chars, input.number.value]),
    ).toEqual([
      ["£385,000.00", 385_000],
      ["(4,620.00)", -4_620],
      ["(1,500.00)", -1_500],
      ["(804.00)", -804],
    ]);
    expect(figuresOf(answer)[0]?.inputs.map((input) => input.unitStatement)).toMatchObject([
      null,
      unitOf("GBP", "£", "Sale price £385,000.00"),
      unitOf("GBP", "£", "Sale price £385,000.00"),
      unitOf("GBP", "£", "Sale price £385,000.00"),
    ]);
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

    expect(figuresOf(answer)[0]?.inputs.map((input) => input.number.value)).toEqual([
      3_850_000, -46_200, -15_000, -8_040,
    ]);
    expect(
      figuresOf(answer)[0]
        ?.inputs.slice(1)
        .map((input) => input.unitStatement),
    ).toMatchObject([
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

    expect(figuresOf(answer)[0]?.inputs.map((input) => input.number.value)).toEqual([
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

    const { answer } = await askAndRead(core, "What were the net sale proceeds of 14 Mill Lane?");

    expect(toldRuns(model)[0]).toContain(
      'the unitQuote "Sale price £385,000.00" gives GBP, but p. 1 names more than one currency (GBP, USD); quote the line that applies, from a Passage that names one.',
    );
    expect(figuresOf(answer)).toEqual([]);
    expect(translate("en", "answer.figures.uncalculated.one")).toBe(
      "1 figure couldn’t be calculated",
    );
    expect(translate("zh-CN", "answer.figures.uncalculated.one")).toBe("1 个数字未能计算");
  });

  // protects=#1001; fails_when=a line that writes a currency for a one-decimal amount under a scale is recorded, so a User sees £380.4 for an amount in thousands.
  test("amounts without two decimals are refused", async () => {
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

    const { answer } = await askAndRead(core, "What were the net sale proceeds of 14 Mill Lane?");

    expect(toldRuns(model)[0]).toContain(
      'are not full money amounts with two decimals ("385,000.00")',
    );
    expect(figuresOf(answer)).toEqual([]);
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

    const { answer } = await askAndRead(core, "What were the net sale proceeds of 14 Mill Lane?");

    expect(toldRuns(model)[0]).toContain('the Document states a scale ("£\'000")');
    expect(figuresOf(answer)).toEqual([]);
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

    const { answer } = await askAndRead(core, "What were the net sale proceeds of 14 Mill Lane?");

    const [toldOnce] = toldRuns(model);
    expect(toldOnce).toContain(
      "the unitQuote isn't word for word in P1; copy the line that states the unit exactly, from the Passage it is in.",
    );
    expect(toldOnce).toContain(
      'the unitQuote "Less: agent\'s fee (4,620.00)" states no unit or scale; give the line that does, such as "单位：万元" or "in millions".',
    );
    expect(figuresOf(answer)).toEqual([]);
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
  return scriptedModel(
    (call) => {
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
      if (step) {
        return {
          calls: asAnalyses(
            step(searches.flatMap((each) => shownPassages(each.text))),
            call.index - 1,
          ),
        };
      }
      return { text: withoutMarkers(forms.map((_, index) => `[=${index + 1}]`).join(" ")) };
    },
    { generate: judgesNothing },
  );
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
    told: toldRuns(model),
    recorded: figuresOf(answer).map((figure) => [figure.marker, figure.value]),
  };
}

// protects=#2365; fails_when=a figure from a Document whose scale is written as "'000", "000s", "(000 omitted)", "TEUR", "T€", "k€", "$K", "MEUR", "$MM", "USD MM", "金额（万）", "新台幣仟元" or "港幣百萬" is calculated unscaled, 1,000 to 1,000,000 times too small; no_claim=the Answer's wording, which the scripted model writes.
describe("A scale written in a form the reader didn't know is applied or refused, never left out (#2365)", {
  timeout: 120_000,
}, () => {
  // An Answer runs at most six Analyses, so the forms are worked out six at a time.
  const each = (["pdf", "word", "sheet"] as const).flatMap((format) =>
    [
      { language: "English", forms: ENGLISH_FORMS, chinese: false },
      { language: "Chinese", forms: CHINESE_FORMS, chinese: true },
    ].flatMap(({ language, forms, chinese }) =>
      inSixes(forms).map((part, index) => ({
        format,
        language: `${language} ${index + 1}`,
        forms: part,
        chinese,
      })),
    ),
  );

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

    const { answer } = await askAndRead(core, "What are the net proceeds?");

    expect(toldRuns(model)[0]).toContain("but the Document states a scale (");
    expect(figuresOf(answer)).toEqual([]);
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

    expect(toldRuns(model)[0]).toContain(
      `[=1] m: the unitQuote "${headLine}" states more than one unit or scale; give the line or column head that states the unit of 12.5 alone.`,
    );
    expect(figuresOf(answer)).toEqual([]);
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
    // A Word heading's section is a Unit of its own: a parent's line that says it holds for the
    // whole Document can be quoted from another Passage; the figure is still refused until it is.
    if (format === "word section before") {
      if (!chinese)
        expect(asked).toContain(
          "in another Passage of the same Document; give that line as unitQuote.",
        );
      expect(asked).toContain(
        "it can't be calculated without guessing whether that scale applies.",
      );
    }
    expect(recorded).toEqual([]);
  });
});

/** A Passage of `document` whose text writes `quote`, as a search showed it. */
function passageWriting(passages: readonly ShownPassage[], document: string, quote: string) {
  const found = passages.find(
    (each) => each.document.startsWith(document) && each.text.includes(quote),
  );
  if (!found) throw new Error(`No Passage of ${document} writes "${quote}".`);
  return found;
}

/** The scale figure both rows are worked out under, as the model gives it. */
const scaleFigure = (
  marker: number,
  numbers: { revenue: string; costs: string },
  unitQuote: string,
) => ({
  marker,
  label: `Difference ${marker}`,
  formula: "rev - cost",
  inputs: [
    { name: "rev", label: "Revenue", citation: 1, number: numbers.revenue, unitQuote },
    { name: "cost", label: "Costs", citation: 2, number: numbers.costs, unitQuote },
  ],
});

const SCANS = join(import.meta.dirname, "../fixtures/scans");
const scanPicture = (id: string) => readFileSync(join(SCANS, `${id}.jpg`));

/** A core whose scanned pages read `script`; the fake recognizer marks the script's unsure words (#535). */
async function setUpScanned(
  model: MockLanguageModelV4,
  files: readonly { name: string; contents: string | Uint8Array }[],
  script: FakeScanScript,
) {
  return setUpCalculating(model, files, undefined, {
    textRecognizer: createFakeTextRecognizer({ script }),
    textRecognitionModelSource: NO_MODEL_FILES,
  });
}

/** Runs `rev - cost` over two rows of a one-page PDF that states no page scale; returns the Answer and what the model was told. */
async function rowsWithoutScale(name: string, rows: [string, string]) {
  const numbers = rows.map((row) => row.slice(row.lastIndexOf(" ") + 1)) as [string, string];
  const model = calculatingModel({
    queries: ["rows revenue costs"],
    steps: [
      (passages) => {
        const passage = passageWriting(passages, name, rows[0]);
        const location = passage.location ?? "p. 1";
        return [
          {
            tool: "cite",
            input: {
              citations: [
                { marker: 1, passage: passage.id, location, quote: rows[0] },
                { marker: 2, passage: passage.id, location, quote: rows[1] },
              ],
            },
          },
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "Difference",
                  formula: "rev - cost",
                  inputs: [
                    { name: "rev", label: "Revenue", citation: 1, number: numbers[0] },
                    { name: "cost", label: "Costs", citation: 2, number: numbers[1] },
                  ],
                },
              ],
            },
          },
        ];
      },
    ],
    answer: "[=1][^1]",
  });
  const { core } = await setUpCalculating(model, [
    { name: `${name}.pdf`, contents: buildPdf([{ lines: [name, ...rows] }]) },
  ]);
  const { answer } = await askAndRead(core, "What is the difference?");
  core.close();
  return { answer, asked: toldRuns(model)[0] ?? "" };
}

/**
 * A Word file whose parent heading's section states a scale, with a sibling section that states
 * another and a filler section between them so neither is in the figures' Passage: the parent's
 * line is an ancestor heading's, the sibling's is not.
 */
function wordParentScale(chinese: boolean) {
  const parent = chinese ? "财务报表" : "Financial statements";
  const sibling = chinese ? "资产负债表" : "Balance sheet";
  const notes = chinese ? "附注" : "Notes";
  const child = chinese ? "利润表" : "Income statement";
  const scale = chinese ? "所有金额单位：千元" : "All amounts in £'000";
  const siblingScale = chinese ? "金额单位：千美元" : "Amounts in HK$'000";
  const [revenueLabel, revenue] = chinese ? ["收入", "1,200"] : ["Revenue", "1,234.5"];
  const [costsLabel, costs] = chinese ? ["成本", "300"] : ["Costs", "334.5"];
  return {
    title: chinese ? "母公司账目" : "Parent Holdings accounts",
    scale,
    siblingScale,
    revenue: `${revenueLabel} ${revenue}`,
    costs: `${costsLabel} ${costs}`,
    numbers: { revenue, costs },
    contents: docxOf([
      { text: parent, heading: 1 },
      { text: scale },
      ...fillerLines(chinese).map((text) => ({ text })),
      { text: sibling, heading: 2 },
      { text: siblingScale },
      ...fillerLines(chinese).map((text) => ({ text })),
      { text: notes, heading: 2 },
      ...fillerLines(chinese).map((text) => ({ text })),
      { text: child, heading: 2 },
      { text: `${revenueLabel} ${revenue}` },
      { text: `${costsLabel} ${costs}` },
    ]),
  };
}

/** A PDF whose earlier page states a whole-Document scale and a table's own scale, with a filler page between it and the figures. */
function pdfEarlierPage(chinese: boolean) {
  const whole = chinese ? "所有金额单位：千元" : "All amounts in £'000";
  const table = chinese ? "金额单位：千美元" : "Amounts in HK$'000";
  const [revenueLabel, revenue] = chinese ? ["收入", "1,200"] : ["Revenue", "1,234.5"];
  const [costsLabel, costs] = chinese ? ["成本", "300"] : ["Costs", "334.5"];
  const page = (lines: string[]) => (chinese ? { chineseLines: lines } : { lines });
  return {
    title: chinese ? "母公司账目" : "Parent Holdings accounts",
    scale: whole,
    siblingScale: table,
    revenue: `${revenueLabel} ${revenue}`,
    costs: `${costsLabel} ${costs}`,
    numbers: { revenue, costs },
    contents: buildPdf([
      page([
        chinese ? "母公司账目附注" : "Parent Holdings notes",
        whole,
        table,
        ...fillerLines(chinese),
      ]),
      page(fillerLines(chinese)),
      page([
        chinese ? "母公司账目" : "Parent Holdings accounts",
        `${revenueLabel} ${revenue}`,
        `${costsLabel} ${costs}`,
      ]),
    ]),
  };
}

/** The rows whose head writes a bare "(M)" or "(m)", in each Document kind. */
function rowHeadDocument(
  format: "pdf" | "word" | "sheet",
  chinese: boolean,
  heads: [string, string],
) {
  const title = chinese ? "阿尔法账目" : "Alpha accounts";
  const scale = chinese ? "单位：千元" : "(in thousands)";
  const [revenueLabel, revenue] = chinese ? ["收入", "1,200"] : ["Revenue", "1,234.5"];
  const [costsLabel, costs] = chinese ? ["成本", "300"] : ["Costs", "334.5"];
  const rows = [`${revenueLabel}${heads[0]} ${revenue}`, `${costsLabel}${heads[1]} ${costs}`];
  return {
    title,
    revenue: rows[0] as string,
    costs: rows[1] as string,
    numbers: { revenue, costs },
    unitQuote: scale,
    contents:
      format === "pdf"
        ? buildPdf([
            chinese
              ? { chineseLines: [title, scale, ...rows] }
              : { lines: [title, scale, ...rows] },
          ])
        : format === "word"
          ? docxOf([
              { text: title, heading: 1 },
              { text: scale },
              ...rows.map((text) => ({ text })),
            ])
          : xlsxOf([
              {
                name: title,
                rows: [
                  [title],
                  [scale],
                  [`${revenueLabel}${heads[0]}`, Number(revenue.replace(",", ""))],
                  [`${costsLabel}${heads[1]}`, Number(costs.replace(",", ""))],
                ],
              },
            ]),
  };
}

// protects=#2365; fails_when=a Word file's scale line under a parent heading is refused even when the model quotes it as unitQuote, or a sibling section's scale line is applied to the figures under another child heading.
describe("A parent heading's scale line is quoted from another Passage, and a sibling's is refused (#2365)", {
  timeout: 120_000,
}, () => {
  test.each([
    { language: "English", chinese: false },
    { language: "Chinese", chinese: true },
  ])("$language", async ({ chinese }) => {
    const fixture = wordParentScale(chinese);
    const model = calculatingModel({
      queries: [chinese ? "利润表 收入 成本" : "Income statement revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, fixture.title, fixture.revenue);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: fixture.revenue },
                  { marker: 2, passage: passage.id, location, quote: fixture.costs },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  scaleFigure(1, fixture.numbers, fixture.scale),
                  scaleFigure(2, fixture.numbers, fixture.siblingScale),
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1] [=2][^1]",
    });
    const { core } = await setUpCalculating(model, [
      { name: `${fixture.title}.docx`, contents: fixture.contents },
    ]);

    const { answer } = await askAndRead(core, chinese ? "差额是多少？" : "What is the difference?");
    core.close();

    const asked = toldRuns(model)[0] ?? "";
    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
    expect(asked).toContain(`[=2] rev:`);
    expect(asked).toContain("is in a section that doesn't state");
    const input = figuresOf(answer)[0]?.inputs[0];
    const unit = input?.unitStatement;
    expect(unit?.citation.quote).toBe(fixture.scale);
    expect(unit?.citation.check).toBe("found");
    expect(unit?.citation.passageId).not.toBe(input?.citation.passageId);
    expect(unit?.scale).toBe(1000);
  });

  /** Runs `unitQuote` for two rows of a Word Document; returns the Answer and what the model was told. */
  async function wordQuoteUnder(
    name: string,
    contents: Buffer,
    rows: [string, string],
    unitQuote: string,
  ) {
    const [revenue, costs] = rows.map((row) => row.slice(row.lastIndexOf(" ") + 1)) as [
      string,
      string,
    ];
    const model = calculatingModel({
      queries: ["revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, name, rows[0]);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: { figures: [scaleFigure(1, { revenue, costs }, unitQuote)] },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [{ name: `${name}.docx`, contents }]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();
    return { answer, asked: toldRuns(model)[0] ?? "" };
  }

  test("a line in another occurrence of the same heading path is refused", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Notes", heading: 1 },
      { text: "Revenue", heading: 2 },
      { text: "All amounts in €'000" },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Notes", heading: 1 },
      { text: "Revenue", heading: 2 },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Notes accounts",
      contents,
      rows,
      "All amounts in €'000",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is in a section that doesn't state");
  });

  test("a table's caption inside the ancestor section is refused", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: "Amounts in HK$ millions" },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Notes", heading: 2 },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Income statement", heading: 2 },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Caption accounts",
      contents,
      rows,
      "Amounts in HK$ millions",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is in a section that doesn't state");
  });

  test("a short file's sibling section is refused inside one Passage", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Notes", heading: 1 },
      { text: "Revenue", heading: 2 },
      { text: "Amounts in €'000" },
      { text: "Notes", heading: 1 },
      { text: "Expenses", heading: 2 },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Short notes",
      contents,
      rows,
      "Amounts in €'000",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is in a section that doesn't state");
  });

  test("a short file's ancestor caption is refused inside one Passage", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: "Amounts in HK$ millions" },
      { text: "Income statement", heading: 2 },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Short captions",
      contents,
      rows,
      "Amounts in HK$ millions",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is in a section that doesn't state");
  });

  test("a nearer scale line in the figure's own section refutes a wider ancestor line", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: "All amounts in £'000" },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Income statement", heading: 2 },
      { text: "Amounts in £m" },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Nearer amounts",
      contents,
      rows,
      "All amounts in £'000",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test("a nearer scale line in a closer ancestor refutes a wider ancestor line", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: "All amounts in £'000" },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Income statement", heading: 2 },
      { text: "All amounts in £m" },
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Revenue", heading: 3 },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Two ancestors",
      contents,
      rows,
      "All amounts in £'000",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test("a shorter heading path that isn't an ancestor doesn't contain the figure", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Other matters", heading: 1 },
      { text: "All amounts in £'000" },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Financial statements", heading: 1 },
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Income statement", heading: 2 },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Other matters",
      contents,
      rows,
      "All amounts in £'000",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is in a section that doesn't state");
  });

  test("a later part of the same section is stated by its line", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: "All amounts in £'000" },
      ...fillerLines(false).map((text) => ({ text })),
      ...fillerLines(false).map((text) => ({ text })),
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordQuoteUnder(
      "Long section",
      contents,
      rows,
      "All amounts in £'000",
    );

    expect(asked).not.toContain("doesn't state");
    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
  });

  test("a spanning Word quote's sibling line is refused for a figure in the next section", {
    timeout: 60_000,
  }, async () => {
    const contents = docxOf([
      { text: "Notes", heading: 1 },
      { text: "Revenue", heading: 2 },
      { text: "Amounts in €'000" },
      { text: "Expenses", heading: 2 },
      { text: "Revenue 1,234.5" },
      { text: "Costs 334.5" },
    ]);
    const quote = "Amounts in €'000\nExpenses\nRevenue 1,234.5";
    const model = calculatingModel({
      queries: ["spanning word revenue"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Spanning notes", "Amounts in €'000");
          return [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage.id, quote }] } },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Revenue",
                    formula: "rev * 1",
                    inputs: [
                      {
                        name: "rev",
                        label: "Revenue",
                        citation: 1,
                        number: "1,234.5",
                        unitQuote: "Amounts in €'000",
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [{ name: "Spanning notes.docx", contents }]);

    const { answer } = await askAndRead(core, "What is the revenue?");
    core.close();

    expect(figuresOf(answer)).toEqual([]);
    expect(toldRuns(model)[0] ?? "").toContain("is in a section that doesn't state");
  });
});

// protects=#2365; fails_when=a whole-Document scale line on an earlier page is refused when the model quotes it, or a table's own scale line on an earlier page is applied to another page's figures.
describe("An earlier page's whole-Document scale line states the scale when quoted, and another is refused (#2365)", {
  timeout: 120_000,
}, () => {
  test.each([
    { language: "English", chinese: false },
    { language: "Chinese", chinese: true },
  ])("$language", async ({ chinese }) => {
    const fixture = pdfEarlierPage(chinese);
    const model = calculatingModel({
      queries: [chinese ? "母公司账目 收入 成本" : "Parent Holdings revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, fixture.title, fixture.revenue);
          const location = passage.location ?? "p. 3";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: fixture.revenue },
                  { marker: 2, passage: passage.id, location, quote: fixture.costs },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  scaleFigure(1, fixture.numbers, fixture.scale),
                  scaleFigure(2, fixture.numbers, fixture.siblingScale),
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1] [=2][^1]",
    });
    const { core } = await setUpCalculating(model, [
      { name: `${fixture.title}.pdf`, contents: fixture.contents },
    ]);

    const { answer } = await askAndRead(core, chinese ? "差额是多少？" : "What is the difference?");
    core.close();

    const asked = toldRuns(model)[0] ?? "";
    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
    expect(asked).toContain(`[=2] rev:`);
    expect(asked).toContain("is on another page");
    const unit = figuresOf(answer)[0]?.inputs[0]?.unitStatement;
    expect(unit?.citation.quote).toBe(fixture.scale);
    expect(unit?.citation.pageFrom).toBe(1);
    expect(unit?.citation.check).toBe("found");
  });

  test("a whole-Document line on another page is offered to the model by its whole line", {
    timeout: 60_000,
  }, async () => {
    const rows = ["Hint revenue 1,234.5", "Hint costs 334.5"];
    const page = (lines: string[]) => ({ lines });
    const model = calculatingModel({
      queries: ["hint revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Hint accounts", rows[0] as string);
          const location = passage.location ?? "p. 3";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] as string },
                  { marker: 2, passage: passage.id, location, quote: rows[1] as string },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      { name: "rev", label: "Revenue", citation: 1, number: "1,234.5" },
                      { name: "cost", label: "Costs", citation: 2, number: "334.5" },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Hint accounts.pdf",
        contents: buildPdf([
          page(["Hint notes", "All amounts in £'000", ...fillerLines(false)]),
          page(fillerLines(false)),
          page(["Hint accounts", rows[0] as string, rows[1] as string]),
        ]),
      },
    ]);

    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();

    expect(figuresOf(answer)).toEqual([]);
    expect(toldRuns(model)[0] ?? "").toContain(
      'p. 1 states a scale ("All amounts in £\'000") in another Passage of the same Document; give that line as unitQuote.',
    );
  });

  /** A two-page PDF and the calculation over its second page's two rows, quoting `unitQuote`. */
  async function shortPdf(unitQuote: string) {
    const rows = ["Revenue 1,234.5", "Costs 334.5"];
    const model = calculatingModel({
      queries: ["short pdf revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Short accounts", rows[0] as string);
          const location = passage.location ?? "pp. 1–2";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] as string },
                  { marker: 2, passage: passage.id, location, quote: rows[1] as string },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      {
                        name: "rev",
                        label: "Revenue",
                        citation: 1,
                        number: "1,234.5",
                        unitQuote,
                      },
                      {
                        name: "cost",
                        label: "Costs",
                        citation: 2,
                        number: "334.5",
                        unitQuote,
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Short accounts.pdf",
        contents: buildPdf([
          { lines: [unitQuote, "Short notes"] },
          { lines: ["Short accounts", rows[0] as string, rows[1] as string] },
        ]),
      },
    ]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();
    return { answer, asked: toldRuns(model)[0] ?? "" };
  }

  test("a short PDF's table line on its first page is refused inside one Passage", {
    timeout: 60_000,
  }, async () => {
    const { answer, asked } = await shortPdf("Amounts in HK$ millions");

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is on another page");
  });

  test("a short PDF's whole-Document line on its first page still states the scale", {
    timeout: 60_000,
  }, async () => {
    const { answer } = await shortPdf("All amounts in £'000");

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
  });

  /** A PDF quoted across both pages, and a figure in the page named after the quote's start. */
  async function spanningPdf(name: string, first: string[], second: string[], quote: string) {
    const model = calculatingModel({
      queries: ["spanning pdf revenue"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, name, "Revenue 1,234.5");
          return [
            {
              tool: "cite",
              input: {
                citations: [{ marker: 1, passage: passage.id, location: "pp. 1–2", quote }],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Revenue",
                    formula: "rev * 1",
                    inputs: [
                      {
                        name: "rev",
                        label: "Revenue",
                        citation: 1,
                        number: "1,234.5",
                        unitQuote: "Amounts in HK$ millions",
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      { name: `${name}.pdf`, contents: buildPdf([{ lines: first }, { lines: second }]) },
    ]);
    const { answer } = await askAndRead(core, "What is the revenue?");
    core.close();
    return { answer, asked: toldRuns(model)[0] ?? "" };
  }

  test("a spanning quote's earlier page line is refused for a figure on the next page", {
    timeout: 60_000,
  }, async () => {
    const { answer, asked } = await spanningPdf(
      "Spanning accounts",
      ["Short notes", "Amounts in HK$ millions"],
      ["Short accounts", "Revenue 1,234.5"],
      "Short notes\nAmounts in HK$ millions\nShort accounts\nRevenue 1,234.5",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is on another page");
  });

  test("a spanning quote's line on the figure's own page states its scale", {
    timeout: 60_000,
  }, async () => {
    const { answer } = await spanningPdf(
      "Same page accounts",
      ["Short notes"],
      ["Amounts in HK$ millions", "Revenue 1,234.5"],
      "Short notes\nAmounts in HK$ millions\nRevenue 1,234.5",
    );

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 1_234_500_000],
    ]);
  });

  /** Runs the two rows of one PDF, under `quote` as unitQuote (or none), laid out in `pages`. */
  async function pdfUnitQuote(
    name: string,
    pages: string[][],
    rows: [string, string],
    quote: string | null,
    location: string,
  ) {
    const model = calculatingModel({
      queries: ["pdf revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, name, rows[0]);
          const scale = quote ? { unitQuote: quote } : {};
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      { name: "rev", label: "Revenue", citation: 1, number: "1,234.5", ...scale },
                      { name: "cost", label: "Costs", citation: 2, number: "334.5", ...scale },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      { name: `${name}.pdf`, contents: buildPdf(pages.map((lines) => ({ lines }))) },
    ]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();
    return { answer, asked: toldRuns(model)[0] ?? "" };
  }

  test("a nearer scale line on the figure's own page refutes a wider earlier-page line", {
    timeout: 60_000,
  }, async () => {
    const { answer, asked } = await pdfUnitQuote(
      "Nearer amounts",
      [
        ["Unless otherwise stated, all amounts are in £m", ...fillerLines(false)],
        fillerLines(false),
        ["Amounts in £'000", "Revenue 1,234.5", "Costs 334.5"],
      ],
      ["Revenue 1,234.5", "Costs 334.5"],
      "Unless otherwise stated, all amounts are in £m",
      "pp. 2–3",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test("a whole-Document line on a later page doesn't state an earlier page's scale", {
    timeout: 60_000,
  }, async () => {
    const { answer, asked } = await pdfUnitQuote(
      "Later amounts",
      [
        ["Revenue 1,234.5", "Costs 334.5"],
        ["All amounts in £'000", ...fillerLines(false)],
      ],
      ["Revenue 1,234.5", "Costs 334.5"],
      "All amounts in £'000",
      "pp. 1–2",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is after");
  });

  /** Cites two rows of a three-page scan and quotes `unitQuote` for them. */
  async function scannedQuoteUnder(
    name: string,
    script: FakeScanScript,
    rows: [string, string],
    unitQuote: string,
  ) {
    const model = calculatingModel({
      queries: ["revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, name, rows[0]);
          const location = passage.location ?? "p. 3";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      { name: "rev", label: "Revenue", citation: 1, number: "1,234.5", unitQuote },
                      { name: "cost", label: "Costs", citation: 2, number: "334.5", unitQuote },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpScanned(
      model,
      [
        {
          name: `${name}.pdf`,
          contents: buildPdf([
            { scan: scanPicture("en-clean") },
            { scan: scanPicture("en-clean") },
            { scan: scanPicture("en-clean") },
          ]),
        },
      ],
      script,
    );
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();
    return { answer, asked: toldRuns(model)[0] ?? "" };
  }

  test("an unsure whole-Document line another Passage holds takes the unsure-word refusal", {
    timeout: 120_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const { answer, asked } = await scannedQuoteUnder(
      "Unsure scale",
      {
        pages: {
          "1": {
            lines: ["All amounts in £'000", ...fillerLines(false)],
            unsure: ["£'000"],
          },
          "2": { lines: fillerLines(false) },
          "3": { lines: rows },
        },
      },
      rows,
      "All amounts in £'000",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("may include a word the scan misread");
  });

  test("an unsure line on the figure's own page isn't replaced by a clean earlier one", {
    timeout: 120_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const { answer, asked } = await scannedQuoteUnder(
      "Unsure own page",
      {
        pages: {
          "1": { lines: ["All amounts in £'000", "Notes continue"] },
          "2": { lines: fillerLines(false) },
          "3": { lines: ["Amounts in £'000", ...rows], unsure: ["£'000"] },
        },
      },
      rows,
      "Amounts in £'000",
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("may include a word the scan misread");
  });
});

// protects=#2365; fails_when=a nearer scale line in the figure's own Unit is ignored, a scale line below a figure is applied to it, a later repeated parent heading's line is applied to an earlier figure, or a parent heading's whole-Document line is refused.
describe("A scale line states the numbers under it, in its own Unit (#2365)", {
  timeout: 120_000,
}, () => {
  test.each(["pdf", "word", "sheet"] as const)(
    "a nearer line in the figure's own Unit refutes a wider one: %s",
    async (format) => {
      const title = "Same unit accounts";
      const wider = "All amounts in £'000";
      const nearer = "Amounts in £m";
      const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
      const quoteOf = (row: string) =>
        format === "sheet"
          ? `${row.slice(0, row.lastIndexOf(" ")).trim()}\t${row.slice(row.lastIndexOf(" ")).trim().replace(/,/g, "")}`
          : row;
      const number = (row: string) =>
        format === "sheet"
          ? row.slice(row.lastIndexOf(" ")).trim().replace(/,/g, "")
          : row.slice(row.lastIndexOf(" ")).trim();
      const model = calculatingModel({
        queries: ["same unit revenue costs"],
        steps: [
          (passages) => {
            const passage = passageWriting(passages, title, quoteOf(rows[0]));
            const location = passage.location ?? "p. 1";
            return [
              {
                tool: "cite",
                input: {
                  citations: [
                    { marker: 1, passage: passage.id, location, quote: quoteOf(rows[0]) },
                    { marker: 2, passage: passage.id, location, quote: quoteOf(rows[1]) },
                  ],
                },
              },
              {
                tool: "calculate",
                input: {
                  figures: [
                    {
                      marker: 1,
                      label: "Difference",
                      formula: "rev - cost",
                      inputs: [
                        {
                          name: "rev",
                          label: "Revenue",
                          citation: 1,
                          number: number(rows[0]),
                          unitQuote: wider,
                        },
                        {
                          name: "cost",
                          label: "Costs",
                          citation: 2,
                          number: number(rows[1]),
                          unitQuote: wider,
                        },
                      ],
                    },
                  ],
                },
              },
            ];
          },
        ],
        answer: "[=1][^1]",
      });
      const contents =
        format === "pdf"
          ? buildPdf([{ lines: [title, wider, nearer, ...rows] }])
          : format === "word"
            ? docxOf([
                { text: title, heading: 1 },
                { text: wider },
                { text: nearer },
                ...rows.map((text) => ({ text })),
              ])
            : xlsxOf([
                {
                  name: title,
                  rows: [[title], [wider], [nearer], ["Revenue", 1234.5], ["Costs", 334.5]],
                },
              ]);
      const extension = format === "pdf" ? "pdf" : format === "word" ? "docx" : "xlsx";
      const { core } = await setUpCalculating(model, [{ name: `${title}.${extension}`, contents }]);
      const { answer } = await askAndRead(core, "What is the difference?");
      core.close();

      expect(figuresOf(answer)).toEqual([]);
      expect(toldRuns(model)[0] ?? "").toContain("but a nearer line states a scale");
    },
  );

  test("a line below the figure is refused, and an earlier whole-Document line states it", {
    timeout: 60_000,
  }, async () => {
    const title = "Below amounts";
    const earlier = "All amounts in £'000";
    const below = "Amounts in £m";
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const model = calculatingModel({
      queries: ["below revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, title, rows[0]);
          const location = passage.location ?? "p. 2";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  scaleFigure(1, { revenue: "1,234.5", costs: "334.5" }, earlier),
                  scaleFigure(2, { revenue: "1,234.5", costs: "334.5" }, below),
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1] [=2][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: `${title}.pdf`,
        contents: buildPdf([
          { lines: ["Below notes", earlier, ...fillerLines(false)] },
          { lines: [title, ...rows, below] },
        ]),
      },
    ]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();

    const asked = toldRuns(model)[0] ?? "";
    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
    expect(asked).toContain("[=2]");
    expect(asked).toContain("is after");
  });

  /** Runs `rev - cost` over two rows of a Word file, quoting each line in `quotes` for its own figure. */
  async function wordUnder(
    name: string,
    contents: Buffer,
    rows: [string, string],
    quotes: readonly string[],
  ) {
    const [revenue, costs] = rows.map((row) => row.slice(row.lastIndexOf(" ") + 1)) as [
      string,
      string,
    ];
    const model = calculatingModel({
      queries: ["revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, name, rows[0]);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: quotes.map((unitQuote, index) =>
                  scaleFigure(index + 1, { revenue, costs }, unitQuote),
                ),
              },
            },
          ];
        },
      ],
      answer: `${quotes.map((_, index) => `[=${index + 1}]`).join(" ")}[^1]`,
    });
    const { core } = await setUpCalculating(model, [{ name: `${name}.docx`, contents }]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();
    return { answer, asked: toldRuns(model)[0] ?? "" };
  }

  test("a later repeated parent heading's line doesn't reach an earlier section", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const earlier = "All amounts in £m";
    const later = "All amounts in £'000";
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: earlier },
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Income statement", heading: 2 },
      { text: rows[0] },
      { text: rows[1] },
      { text: "Financial statements", heading: 1 },
      { text: later },
      ...fillerLines(false).map((text) => ({ text })),
    ]);

    const { answer, asked } = await wordUnder("Repeated parent", contents, rows, [earlier, later]);

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000_000],
    ]);
    expect(asked).toContain("is after");
  });

  test("an earlier parent line doesn't reach past a repeated heading to a later section", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const line = "All amounts in £'000";
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: line },
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Financial statements", heading: 1 },
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Income statement", heading: 2 },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer, asked } = await wordUnder("Repeated ancestor", contents, rows, [line]);

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is in a section that doesn't state");
  });

  test("a parent heading's line that excepts the notes states the scale", {
    timeout: 60_000,
  }, async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const line = "All amounts are in £m except where stated in the notes";
    const contents = docxOf([
      { text: "Financial statements", heading: 1 },
      { text: line },
      ...fillerLines(false).map((text) => ({ text })),
      { text: "Income statement", heading: 2 },
      { text: rows[0] },
      { text: rows[1] },
    ]);

    const { answer } = await wordUnder("Note scoped parent", contents, rows, [line]);

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000_000],
    ]);
  });
});

// protects=#2365; fails_when=a nearer line stating another scale or currency is ignored, a page or section between states another scale, a row head's bracket scale is left plain, a scan-misread scale word is left plain, or a column head's scale is applied to another column.
describe("A nearer line, page, section, row head or column head decides the scale, or the figure is refused (#2365)", {
  timeout: 120_000,
}, () => {
  /** Runs `rev - cost` over `rows`, quoting `quotes[i]` (or nothing) for figure i+1. */
  async function figuresUnder(
    name: string,
    file: { name: string; contents: Uint8Array },
    rows: [string, string],
    quotes: readonly (string | null)[],
    options: { scanned?: FakeScanScript; query?: string } = {},
  ) {
    const numbers = rows.map((row) => row.slice(row.lastIndexOf(" ") + 1)) as [string, string];
    const input = (at: 0 | 1, unitQuote: string | null) => ({
      name: at === 0 ? "rev" : "cost",
      label: at === 0 ? "Revenue" : "Costs",
      citation: at + 1,
      number: numbers[at] as string,
      ...(unitQuote !== null && { unitQuote }),
    });
    const model = calculatingModel({
      queries: [options.query ?? "revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, name, rows[0]);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: quotes.map((unitQuote, index) => ({
                  marker: index + 1,
                  label: `Difference ${index + 1}`,
                  formula: "rev - cost",
                  inputs: [input(0, unitQuote), input(1, unitQuote)],
                })),
              },
            },
          ];
        },
      ],
      answer: `${quotes.map((_, index) => `[=${index + 1}]`).join(" ")}[^1]`,
    });
    const { core } = options.scanned
      ? await setUpScanned(model, [file], options.scanned)
      : await setUpCalculating(model, [file]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();
    return { answer, asked: toldRuns(model)[0] ?? "" };
  }

  const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];

  test.each([
    ["a same-page line (in £)", "Directors' fees (in £)", "(in £)"],
    ["a same-page bracket (£)", "Directors' fees (£)", "(£)"],
    ["a bracket with more words", "Directors' fees (in £ and pence)", "(in £ and pence)"],
    ["a bracket listing a code", "Directors' fees (in £, GBP)", "(in £, GBP)"],
    ["a bracket pointing at a note", "Directors' fees (in £, see note 3)", "(in £, see note 3)"],
  ])("%s states a currency with no scale", async (_label, nearer, statement) => {
    const wider = "All amounts in £'000";
    const { answer, asked } = await figuresUnder(
      "Own unit accounts",
      {
        name: "Own unit accounts.pdf",
        contents: buildPdf([{ lines: ["Own unit accounts", wider, nearer, ...rows] }]),
      },
      rows,
      [wider, wider],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
    expect(asked).toContain(statement);
  });

  test("a nearer line on the figure's page states a currency with no scale", async () => {
    const wider = "All amounts in £'000";
    const nearer = "Directors' fees (in £)";
    const { answer, asked } = await figuresUnder(
      "Earlier amounts",
      {
        name: "Earlier amounts.pdf",
        contents: buildPdf([
          { lines: ["Earlier notes", wider, ...fillerLines(false)] },
          { lines: ["Earlier accounts", nearer, ...rows] },
        ]),
      },
      rows,
      [wider, wider],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
    expect(asked).toContain("(in £)");
  });

  test("a nearer line in the figure's child word section states a currency with no scale", async () => {
    const wider = "All amounts in £'000";
    const nearer = "Directors' fees (in £)";
    const { answer, asked } = await figuresUnder(
      "Own unit word",
      {
        name: "Own unit word.docx",
        contents: docxOf([
          { text: "Financial statements", heading: 1 },
          { text: wider },
          ...fillerLines(false).map((text) => ({ text })),
          { text: "Income statement", heading: 2 },
          { text: nearer },
          ...rows.map((text) => ({ text })),
        ]),
      },
      rows,
      [wider, wider],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
    expect(asked).toContain("(in £)");
  });

  test("a nearer line in dollars refutes a line in $ thousands", async () => {
    const wider = "All amounts in $ thousands";
    const nearer = "Directors' fees (in dollars)";
    const { answer, asked } = await figuresUnder(
      "Dollar amounts",
      {
        name: "Dollar amounts.pdf",
        contents: buildPdf([{ lines: ["Dollar amounts", wider, nearer, ...rows] }]),
      },
      rows,
      [wider, wider],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
    expect(asked).toContain("(in dollars)");
  });

  test("in Chinese, a nearer line in 元 refutes a line in 千元", async () => {
    const wider = "所有金额单位：千元";
    const nearer = "单位：元";
    const zhRows: [string, string] = ["收入 1,200", "成本 300"];
    const { answer, asked } = await figuresUnder(
      "母公司账目",
      {
        name: "母公司账目.pdf",
        contents: buildPdf([{ chineseLines: ["母公司账目", wider, nearer, ...zhRows] }]),
      },
      zhRows,
      [wider, wider],
      { query: "母公司账目 收入 成本" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
    expect(asked).toContain(nearer);
  });

  test("a page between the quoted page and the figure states another scale", async () => {
    const wider = "All amounts in £'000";
    const between = "Segment results (in millions)";
    const file = {
      name: "Between amounts.pdf",
      contents: buildPdf([
        { lines: ["Between notes", wider, ...fillerLines(false)] },
        { lines: [between, ...fillerLines(false)] },
        { lines: ["Between accounts", ...rows] },
      ]),
    };
    const quoted = await figuresUnder("Between amounts", file, rows, [wider, wider]);

    expect(figuresOf(quoted.answer)).toEqual([]);
    expect(quoted.asked).toContain("but a nearer line states a scale");
    expect(quoted.asked).toContain("in millions");
  });

  test("with no unitQuote, a scale on a page between isn't offered as one the rule refuses", async () => {
    const between = "Segment results (in millions)";
    const file = {
      name: "Between hint accounts.pdf",
      contents: buildPdf([
        { lines: ["Between hint notes", "All amounts in £'000", ...fillerLines(false)] },
        { lines: [between, ...fillerLines(false)] },
        { lines: ["Between hint accounts", ...rows] },
      ]),
    };
    const { answer, asked } = await figuresUnder("Between hint accounts", file, rows, [null]);

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).not.toContain("give that line as unitQuote");
    expect(asked).toContain("without guessing");
  });

  test("a scale line later in the quoted line's own word section refutes it", async () => {
    const wider = "All amounts in £'000";
    const later = "The segment amounts that follow are in £m";
    const { answer, asked } = await figuresUnder(
      "Section scan",
      {
        name: "Section scan.docx",
        contents: docxOf([
          { text: "Financial statements", heading: 1 },
          { text: wider },
          { text: later },
          ...fillerLines(false).map((text) => ({ text })),
          ...rows.map((text) => ({ text })),
        ]),
      },
      rows,
      [wider, wider],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test("a scale line later in the parent section refutes it for a child section's figure", async () => {
    const wider = "All amounts in £'000";
    const later = "The segment amounts that follow are in £m";
    const { answer, asked } = await figuresUnder(
      "Section child",
      {
        name: "Section child.docx",
        contents: docxOf([
          { text: "Financial statements", heading: 1 },
          { text: wider },
          { text: later },
          ...fillerLines(false).map((text) => ({ text })),
          { text: "Income statement", heading: 2 },
          ...rows.map((text) => ({ text })),
        ]),
      },
      rows,
      [wider, wider],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test.each(["K", "k", "thousands"])(
    "a row head's bracket scale (%s) is the row's own",
    async (scale) => {
      const kRows: [string, string] = [`Revenue (${scale}) 1,234.5`, `Costs (${scale}) 334.5`];
      const { answer, asked } = await figuresUnder(
        "Bracket amounts",
        {
          name: "Bracket amounts.pdf",
          contents: buildPdf([{ lines: ["Bracket amounts", ...kRows] }]),
        },
        kRows,
        [null],
      );

      expect(figuresOf(answer)).toEqual([]);
      expect(asked).toMatch(/row whose head|give that line as unitQuote/);
    },
  );

  test("a page in thousands agrees with a row head's (K)", async () => {
    const page = "in thousands";
    const kRows: [string, string] = ["Revenue (K) 1,234.5", "Costs (K) 334.5"];
    const { answer } = await figuresUnder(
      "Agreeing amounts",
      {
        name: "Agreeing amounts.pdf",
        contents: buildPdf([{ lines: ["Agreeing amounts", page, ...kRows] }]),
      },
      kRows,
      [page],
    );

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
  });

  test.each(["th0usands", "thousand5"])(
    "a scan-misread scale word (%s) is an unsettled candidate",
    async (misread) => {
      const script = {
        pages: {
          "1": { lines: fillerLines(false) },
          "2": { lines: fillerLines(false) },
          "3": {
            lines: ["Misread accounts", `All amounts in ${misread}`, ...rows],
            unsure: [misread],
          },
        },
      };
      const { answer, asked } = await figuresUnder(
        "Misread accounts",
        {
          name: "Misread accounts.pdf",
          contents: buildPdf([
            { scan: scanPicture("en-clean") },
            { scan: scanPicture("en-clean") },
            { scan: scanPicture("en-clean") },
          ]),
        },
        rows,
        [null],
        { scanned: script },
      );

      expect(figuresOf(answer)).toEqual([]);
      expect(asked).toContain(misread);
      expect(asked).toContain("without guessing");
    },
  );

  test("a column head whose scale ends the line isn't applied to another column", async () => {
    const head = "项目 本期 上期（万元）";
    const row = "收入 1200 1100";
    const model = calculatingModel({
      queries: ["母公司账目 收入"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "母公司账目", row);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, location, quote: row }] },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "本期收入",
                    formula: "x * 1",
                    inputs: [
                      {
                        name: "x",
                        label: "本期收入",
                        citation: 1,
                        number: "1200",
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
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "母公司账目.pdf",
        contents: buildPdf([{ chineseLines: ["母公司账目", head, row] }]),
      },
    ]);
    const { answer } = await askAndRead(core, "本期收入是多少？");
    core.close();

    expect(figuresOf(answer)).toEqual([]);
    expect(toldRuns(model)[0] ?? "").toContain(
      "one column of a row whose head states the scale of another",
    );
  });

  test("a tab-separated column head states one column's scale, not another's", async () => {
    const head = "项目\t本期（万元）\t上期";
    const row = "收入\t1200\t1100";
    const model = calculatingModel({
      queries: ["母公司账目 收入"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "母公司账目", row);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, location, quote: row }] },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "本期",
                    formula: "x * 1",
                    inputs: [
                      { name: "x", label: "本期", citation: 1, number: "1200", unitQuote: head },
                    ],
                  },
                  {
                    marker: 2,
                    label: "上期",
                    formula: "y * 1",
                    inputs: [
                      { name: "y", label: "上期", citation: 1, number: "1100", unitQuote: head },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1] [=2][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "母公司账目.xlsx",
        contents: xlsxOf([
          {
            name: "母公司账目",
            rows: [
              ["项目", "本期（万元）", "上期"],
              ["收入", 1200, 1100],
            ],
          },
        ]),
      },
    ]);
    const { answer } = await askAndRead(core, "本期和上期的收入是多少？");
    core.close();

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 12_000_000],
    ]);
  });

  test("a line below the figure isn't offered as its unitQuote", async () => {
    const rows: [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
    const model = calculatingModel({
      queries: ["revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Below hint", rows[0]);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      { name: "rev", label: "Revenue", citation: 1, number: "1,234.5" },
                      { name: "cost", label: "Costs", citation: 2, number: "334.5" },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Below hint.docx",
        contents: docxOf([
          { text: "Financial statements", heading: 1 },
          { text: rows[0] },
          { text: rows[1] },
          { text: "All amounts in millions" },
        ]),
      },
    ]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();

    const asked = toldRuns(model)[0] ?? "";
    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("is below it");
    expect(asked).not.toContain("give that line as unitQuote");
  });

  test("a line above and a line below: only the line above is offered as the unitQuote", async () => {
    const above = "All amounts in millions";
    const below = "All amounts in thousands";
    const model = calculatingModel({
      queries: ["revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Above and below", "Revenue 1,234.5");
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: "Revenue 1,234.5" },
                  { marker: 2, passage: passage.id, location, quote: "Costs 334.5" },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      { name: "rev", label: "Revenue", citation: 1, number: "1,234.5" },
                      { name: "cost", label: "Costs", citation: 2, number: "334.5" },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Above and below.docx",
        contents: docxOf([
          { text: "Financial statements", heading: 1 },
          { text: above },
          { text: "Revenue 1,234.5" },
          { text: "Costs 334.5" },
          { text: below },
        ]),
      },
    ]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();

    const asked = toldRuns(model)[0] ?? "";
    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain('"in millions"');
    expect(asked).toContain("give that line as unitQuote");
    expect(asked).not.toContain("in thousands");
  });

  test("a nearer line with the same scale in another currency refuses", async () => {
    const wider = "All amounts in £ thousands";
    const nearer = "(in $ thousands)";
    const { answer, asked } = await figuresUnder(
      "Currency amounts",
      {
        name: "Currency amounts.pdf",
        contents: buildPdf([{ lines: ["Currency amounts", wider, nearer, ...rows] }]),
      },
      rows,
      [wider, wider],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
    expect(asked).toContain("$ thousands");
  });

  test("a column head's scale for 本期 isn't applied to 上期", async () => {
    const head = "项目 本期（万元） 上期";
    const zhRows: [string, string] = ["收入 1,200 1,100", "成本 300 280"];
    const { answer, asked } = await figuresUnder(
      "母公司账目",
      {
        name: "母公司账目.pdf",
        contents: buildPdf([
          {
            chineseLines: ["母公司账目", "单位：元", head, ...zhRows],
          },
        ]),
      },
      zhRows,
      [head],
      { query: "母公司账目 收入 成本" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("one column of a row whose head states the scale of another");
  });

  test.each([
    ["(in £, thousands)", 900_000, "GBP"],
    ["(in £, '000)", 900_000, "GBP"],
    ["(in US$, millions)", 900_000_000, "USD"],
    ["(in euros, millions)", 900_000_000, "EUR"],
    ["(in dollars, in thousands)", 900_000, "USD"],
  ])(
    "a bracket's currency and the scale later in its tail are both read (%s)",
    async (statement, value, currency) => {
      const { answer } = await figuresUnder(
        "Tail amounts",
        {
          name: "Tail amounts.pdf",
          contents: buildPdf([{ lines: ["Tail amounts", statement, ...rows] }]),
        },
        rows,
        [statement, statement],
      );

      expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
        [1, value],
        [2, value],
      ]);
      expect(figuresOf(answer)[0]?.inputs[0]?.unitStatement?.currency).toBe(currency);
    },
  );

  test.each(["(in $US thousands)", "(in £ and $ thousands)"])(
    "a bracket's tail the reader can't settle refuses the figures (%s)",
    async (statement) => {
      const { answer, asked } = await figuresUnder(
        "Tail amounts",
        {
          name: "Tail amounts.pdf",
          contents: buildPdf([{ lines: ["Tail amounts", statement, ...rows] }]),
        },
        rows,
        [statement, statement],
      );

      expect(figuresOf(answer)).toEqual([]);
      expect(asked).toMatch(/states no unit or scale|can be read as more than one scale/);
    },
  );

  test("a row's bracket that isn't wholly a scale is no scale, so (m/s) is no millions", async () => {
    const speedRows: [string, string] = ["Speed (m/s) 12.5", "Wind (m/s) 3.5"];
    const { answer, asked } = await figuresUnder(
      "Wind speeds",
      {
        name: "Wind speeds.pdf",
        contents: buildPdf([{ lines: ["Wind speeds", ...speedRows] }]),
      },
      speedRows,
      ["(m/s)"],
      { query: "wind speeds speed wind" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("states no unit or scale");
  });

  test("a row's whole bracket quoted as the unitQuote is still its scale", async () => {
    const kRows: [string, string] = ["Revenue (K) 1,234.5", "Costs (K) 334.5"];
    const { answer } = await figuresUnder(
      "Whole bracket",
      {
        name: "Whole bracket.pdf",
        contents: buildPdf([{ lines: ["Whole bracket", ...kRows] }]),
      },
      kRows,
      ["(K)"],
    );

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
  });

  test.each([
    [
      "£'000 over rows (£)",
      "All amounts in £'000",
      ["Directors' fees (£) 1,234.5", "Committee fees (£) 334.5"],
    ],
    [
      "£'000 over rows (in £)",
      "All amounts in £'000",
      ["Directors' fees (in £) 1,234.5", "Committee fees (in £) 334.5"],
    ],
  ] as const)(
    "a row head's own plain currency refuses a wider line: %s",
    async (_name, wider, feeRows) => {
      const { answer, asked } = await figuresUnder(
        "Fee rows",
        {
          name: "Fee rows.pdf",
          contents: buildPdf([{ lines: ["Fee rows", wider, ...feeRows] }]),
        },
        feeRows as unknown as [string, string],
        [wider, wider],
        { query: `fee rows directors fees committee fees ${wider}` },
      );

      expect(figuresOf(answer)).toEqual([]);
      expect(asked).toContain("row whose head states its own currency");
      expect(asked).not.toContain("quote the row's head as unitQuote");
    },
  );

  test("in Chinese, a row head's （元） refuses the wider 单位：万元", async () => {
    const wider = "单位：万元";
    const zhRows: [string, string] = ["收入（元） 1,200", "成本（元） 300"];
    const { answer, asked } = await figuresUnder(
      "单价账目",
      {
        name: "单价账目.pdf",
        contents: buildPdf([{ chineseLines: ["单价账目", wider, ...zhRows] }]),
      },
      zhRows,
      [wider, wider],
      { query: "单价账目 收入 成本" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("row whose head states its own currency");
    expect(asked).not.toContain("quote the row's head as unitQuote");
  });

  test("a quoted scale in another currency than the figure's refuses instead of dropping it", async () => {
    const statement = "Amounts in £m";
    const dollarRows: [string, string] = ["Revenue $1,234.5", "Costs $334.5"];
    const { answer, asked } = await figuresUnder(
      "Dollar rows",
      {
        name: "Dollar rows.pdf",
        contents: buildPdf([{ lines: ["Dollar rows", statement, ...dollarRows] }]),
      },
      dollarRows,
      [statement, statement],
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain(`the unitQuote "${statement}" states GBP, but $1,234.5 is in USD`);
  });

  test("a nearer bracket stating a scale the reader doesn't read whole refuses the wider line", async () => {
    const wider = "All amounts in £m";
    const { answer, asked } = await figuresUnder(
      "Fee note",
      {
        name: "Fee note.pdf",
        contents: buildPdf([{ lines: ["Fee note", wider, "Fees (in £, thousands)", ...rows] }]),
      },
      rows,
      [wider],
      { query: "fee note revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test("a nearer bracket on a later page stating an unread scale refuses a whole-Document line", async () => {
    const wider = "All amounts in £m unless otherwise stated";
    const { answer, asked } = await figuresUnder(
      "Across fees",
      {
        name: "Across fees.pdf",
        contents: buildPdf([
          { lines: ["Across fees notes", wider, ...fillerLines(false)] },
          { lines: fillerLines(false) },
          { lines: ["Across fees accounts", "Directors' fees (in £, thousands)", ...rows] },
        ]),
      },
      rows,
      [wider],
      { query: "across fees revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test("a nearer bracket with '000 the reader doesn't read whole refuses the wider line", async () => {
    const wider = "All amounts in £m";
    const { answer } = await figuresUnder(
      "Remuneration note",
      {
        name: "Remuneration note.pdf",
        contents: buildPdf([
          { lines: ["Remuneration note", wider, "Remuneration (in £, '000)", ...rows] },
        ]),
      },
      rows,
      [wider],
      { query: "remuneration note revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
  });

  test("a nearer multiplier bracket refuses the wider line", async () => {
    const wider = "All amounts in €m";
    const { answer } = await figuresUnder(
      "Subsidiary note",
      {
        name: "Subsidiary note.pdf",
        contents: buildPdf([
          { lines: ["Subsidiary note", wider, "Subsidiary results (× €1,000)", ...rows] },
        ]),
      },
      rows,
      [wider],
      { query: "subsidiary note revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
  });

  test("a row head's plain currency combines with the wider line's scale", async () => {
    const dollarRows: [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const { answer } = await figuresUnder(
      "Dollar caption",
      {
        name: "Dollar caption.pdf",
        contents: buildPdf([{ lines: ["Dollar caption", "(in thousands)", ...dollarRows] }]),
      },
      dollarRows,
      ["(in thousands)"],
      { query: "dollar caption revenue costs" },
    );

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
    expect(figuresOf(answer)[0]?.inputs[0]?.unitStatement?.currency).toBe("USD");
  });

  test.each([
    ["a bracket naming the same currency", "Fees (in £, GBP thousands)"],
    ["a line naming sterling", "Remuneration is shown in sterling, in thousands"],
    ["an amount that is not a scale", "Board fees (cap of 150,000 pounds per director)"],
  ])("a nearer form that agrees is no scale of its own: %s", async (_label, nearer) => {
    const wider = "All amounts in £'000";
    const { answer } = await figuresUnder(
      "Agreeing forms",
      {
        name: "Agreeing forms.pdf",
        contents: buildPdf([{ lines: ["Agreeing forms", wider, nearer, ...rows] }]),
      },
      rows,
      [wider],
      { query: "agreeing forms revenue costs" },
    );

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
  });

  test("a line with two scales refuses before it combines with a row head", async () => {
    const dollarRows: [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const twoScales = "Revenue in US$ millions; costs in US$ thousands";
    const { answer, asked } = await figuresUnder(
      "Two scales",
      {
        name: "Two scales.pdf",
        contents: buildPdf([{ lines: ["Two scales", twoScales, ...dollarRows] }]),
      },
      dollarRows,
      [twoScales],
      { query: "two scales revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("states more than one scale");
  });

  test("a row head with a currency and its own scale still refuses another line's scale", async () => {
    const amountRows: [string, string] = [
      "Revenue (US$) (thousands) 1,234.5",
      "Costs (US$) (thousands) 334.5",
    ];
    const { answer, asked } = await figuresUnder(
      "Own scale rows",
      {
        name: "Own scale rows.pdf",
        contents: buildPdf([{ lines: ["Own scale rows", "(in millions)", ...amountRows] }]),
      },
      amountRows,
      ["(in millions)"],
      { query: "own scale rows revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("row whose head states its own scale");
  });

  test("a sheet's currency-only column head combines with the wider scale", async () => {
    const model = calculatingModel({
      queries: ["fees sheet revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Fees sheet", "Revenue\t1234.5");
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: "Revenue\t1234.5" },
                  { marker: 2, passage: passage.id, location, quote: "Costs\t334.5" },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      {
                        name: "rev",
                        label: "Revenue",
                        citation: 1,
                        number: "1234.5",
                        unitQuote: "(in thousands)",
                      },
                      {
                        name: "cost",
                        label: "Costs",
                        citation: 2,
                        number: "334.5",
                        unitQuote: "(in thousands)",
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Fees sheet.xlsx",
        contents: xlsxOf([
          {
            name: "Fees",
            rows: [
              ["(in thousands)"],
              ["Item", "Amount (US$)"],
              ["Revenue", 1234.5],
              ["Costs", 334.5],
            ],
          },
        ]),
      },
    ]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000],
    ]);
  });

  test.each([
    ["a nearer currency line", "(in thousands)", "Directors' remuneration (in £)"],
    ["a quoted currency line", "Group summary (in £)", "Segment detail (in thousands)"],
  ])(
    "a plain currency and a plain scale on different lines refuse: %s",
    async (_label, wider, nearer) => {
      const { answer } = await figuresUnder(
        "Plain pairs",
        {
          name: "Plain pairs.pdf",
          contents: buildPdf([{ lines: ["Plain pairs", wider, nearer, ...rows] }]),
        },
        rows,
        [wider],
        { query: "plain pairs revenue costs" },
      );

      expect(figuresOf(answer)).toEqual([]);
    },
  );

  test.each([
    [
      "a scale word about options",
      "All amounts in £'000",
      "Share awards (in £, options in thousands)",
    ],
    [
      "a scale word about headcount",
      "All amounts in $'000",
      "Staff costs (in US$, headcount in thousands)",
    ],
    ["a lowercase multiplier", "All amounts in millions", "Subsidiary results (in €, x 1,000)"],
    ["a European multiplier", "All amounts in €m", "German subsidiary (in €, × 1.000)"],
    [
      "two scale words",
      "All amounts in £'000",
      "Fees are shown in sterling, in thousands; totals are in millions",
    ],
    [
      "a × form carrying a scale word",
      "All amounts in €'000",
      "Subsidiary (in €, × 1,000, thousands)",
    ],
    [
      "a scale word after another word",
      "All amounts in £'000",
      "Tariffs (in £, per thousand units)",
    ],
    [
      "an unreadable multiplier beside a plain currency line",
      "(in €)",
      "German subsidiary (in €, × 1.000)",
    ],
  ])("an unread form whose scale can't be read refuses: %s", async (_label, wider, nearer) => {
    const { answer } = await figuresUnder(
      "Unread forms",
      {
        name: "Unread forms.pdf",
        contents: buildPdf([{ lines: ["Unread forms", wider, nearer, ...rows] }]),
      },
      rows,
      [wider],
      { query: "unread forms revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
  });

  test("a two-scale line's hint names each scale it states", async () => {
    const dollarRows: [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const twoScales = "Shares in millions; amounts in thousands";
    const model = calculatingModel({
      queries: ["two scale hint revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Two scale hint", dollarRows[0]);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: dollarRows[0] },
                  { marker: 2, passage: passage.id, location, quote: dollarRows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      { name: "rev", label: "Revenue", citation: 1, number: "1,234.5" },
                      { name: "cost", label: "Costs", citation: 2, number: "334.5" },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Two scale hint.pdf",
        contents: buildPdf([{ lines: ["Two scale hint", twoScales, ...dollarRows] }]),
      },
    ]);
    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();

    const asked = toldRuns(model)[0] ?? "";
    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain('"in millions"');
    expect(asked).toContain('"in thousands"');
    expect(asked).not.toContain('"in millions", "in millions"');
  });

  test("a nearer line with another scale is refused (not only its bracket)", async () => {
    const wider = "All amounts in £'000";
    const nearer = "Directors' fees are shown in sterling, in millions";
    const { answer, asked } = await figuresUnder(
      "Sterling line",
      {
        name: "Sterling line.pdf",
        contents: buildPdf([{ lines: ["Sterling line", wider, nearer, ...rows] }]),
      },
      rows,
      [wider],
      { query: "sterling line revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("but a nearer line states a scale");
  });

  test("a row bracket that is a scale doesn't scale a row that isn't an amount", async () => {
    const marginRows: [string, string] = ["Gross margin (k) 12.5", "Net margin (k) 3.5"];
    const { answer, asked } = await figuresUnder(
      "Margins",
      {
        name: "Margins.pdf",
        contents: buildPdf([{ lines: ["Margins", ...marginRows] }]),
      },
      marginRows,
      ["(k)"],
      { query: "margins gross net margin" },
    );

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain('is on a percent row ("Gross margin (k)")');
  });

  test.each([
    "All amounts in this remuneration report are in £'000",
    "Unless otherwise stated, all amounts in this Directors' Remuneration Report are in £'000",
    "All amounts in this segment are in £'000",
    "All amounts in the Group's remuneration report are in £'000",
    "All amounts on this page are in £'000",
    "All amounts below are in £'000",
  ])("a scope naming a part refuses its p. 1 line for a p. 3 figure: %s", async (wider) => {
    const { answer } = await figuresUnder(
      "Scope accounts",
      {
        name: "Scope accounts.pdf",
        contents: buildPdf([
          { lines: ["Scope notes", wider, ...fillerLines(false)] },
          { lines: fillerLines(false) },
          { lines: ["Scope accounts", ...rows] },
        ]),
      },
      rows,
      [wider, wider],
      { query: "scope accounts revenue costs" },
    );

    expect(figuresOf(answer)).toEqual([]);
  });

  test("in Chinese, 分部 in the scope refuses its p. 1 line for a p. 3 figure", async () => {
    const wider = "所有分部信息金额单位：百万元";
    const zhRows: [string, string] = ["收入 1,200", "成本 300"];
    const { answer } = await figuresUnder(
      "分部账目",
      {
        name: "分部账目.pdf",
        contents: buildPdf([
          { chineseLines: ["分部账目附注", wider, ...fillerLines(true)] },
          { chineseLines: fillerLines(true) },
          { chineseLines: ["分部账目", ...zhRows] },
        ]),
      },
      zhRows,
      [wider, wider],
      { query: "分部账目 收入 成本" },
    );

    expect(figuresOf(answer)).toEqual([]);
  });
});

// protects=#2365; fails_when=a row head's bare "(M)" or "(m)" takes the page's scale, so a floor area in metres or a million-scaled amount is multiplied by 1,000.
describe("A row head's bare (M) or (m) is a scale of its own, never the page's (#2365)", {
  timeout: 120_000,
}, () => {
  test.each([
    {
      format: "pdf",
      language: "English",
      chinese: false,
      heads: [" (M)", " (m)"] as [string, string],
    },
    {
      format: "pdf",
      language: "Chinese",
      chinese: true,
      heads: ["（M）", "（m）"] as [string, string],
    },
    {
      format: "word",
      language: "English",
      chinese: false,
      heads: [" (M)", " (m)"] as [string, string],
    },
    {
      format: "sheet",
      language: "English",
      chinese: false,
      heads: [" (M)", " (m)"] as [string, string],
    },
  ])("$format, $language", async ({ format, chinese, heads }) => {
    const fixture = rowHeadDocument(format as "pdf" | "word" | "sheet", chinese, heads);
    const quoteOf = (written: string) =>
      format === "sheet"
        ? `${written.slice(0, written.lastIndexOf(" ")).trim()}\t${written.slice(written.lastIndexOf(" ")).trim().replace(/,/g, "")}`
        : written;
    const number = (written: string) => {
      const text = written.slice(written.lastIndexOf(" ")).trim();
      return format === "sheet" ? text.replace(/,/g, "") : text;
    };
    const model = calculatingModel({
      queries: [chinese ? "收入 成本" : "revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, fixture.title, quoteOf(fixture.revenue));
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: quoteOf(fixture.revenue) },
                  { marker: 2, passage: passage.id, location, quote: quoteOf(fixture.costs) },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      {
                        name: "rev",
                        label: "Revenue",
                        citation: 1,
                        number: number(fixture.revenue),
                        unitQuote: fixture.unitQuote,
                      },
                      {
                        name: "cost",
                        label: "Costs",
                        citation: 2,
                        number: number(fixture.costs),
                        unitQuote: fixture.unitQuote,
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const extension = format === "pdf" ? "pdf" : format === "word" ? "docx" : "xlsx";
    const { core } = await setUpCalculating(model, [
      { name: `${fixture.title}.${extension}`, contents: fixture.contents },
    ]);

    const { answer } = await askAndRead(core, chinese ? "差额是多少？" : "What is the difference?");
    core.close();

    expect(figuresOf(answer)).toEqual([]);
    expect(toldRuns(model)[0] ?? "").toContain("row whose head writes");
  });

  test("a capital (M) under a page that states millions is the row's own scale and stands", {
    timeout: 60_000,
  }, async () => {
    const rows = ["Revenue (M) 1,234.5", "Costs (M) 334.5"];
    const model = calculatingModel({
      queries: ["revenue costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, "Alpha accounts", rows[0] as string);
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: rows[0] },
                  { marker: 2, passage: passage.id, location, quote: rows[1] },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      {
                        name: "rev",
                        label: "Revenue",
                        citation: 1,
                        number: "1,234.5",
                        unitQuote: "(in millions)",
                      },
                      {
                        name: "cost",
                        label: "Costs",
                        citation: 2,
                        number: "334.5",
                        unitQuote: "(in millions)",
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Alpha accounts.pdf",
        contents: buildPdf([{ lines: ["Alpha accounts", "(in millions)", ...rows] }]),
      },
    ]);

    const { answer } = await askAndRead(core, "What is the difference?");
    core.close();

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
      [1, 900_000_000],
    ]);
  });

  test("a bare (M) with no page scale is refused", {
    timeout: 60_000,
  }, async () => {
    const { answer, asked } = await rowsWithoutScale("Bare millions", [
      "Revenue (M) 1,234.5",
      "Costs (M) 334.5",
    ]);

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("row whose head writes");
  });
});

// protects=#2365; fails_when=a row head's unit of measure inside a longer bracket ("(millions of m2)", "（百万平方米）") is no measure row, so the page's money scale multiplies a square-metre figure by 1,000.
describe("A unit of measure inside a longer bracket is still a measure row (#2365)", {
  timeout: 120_000,
}, () => {
  test.each([
    {
      format: "pdf",
      language: "English",
      chinese: false,
      heads: [" (millions of m2)", " (millions of m2)"] as [string, string],
    },
    {
      format: "pdf",
      language: "Chinese",
      chinese: true,
      heads: ["（百万平方米）", "（百万平方米）"] as [string, string],
    },
    {
      format: "word",
      language: "English",
      chinese: false,
      heads: [" (millions of m2)", " (millions of m2)"] as [string, string],
    },
    {
      format: "sheet",
      language: "English",
      chinese: false,
      heads: [" (millions of m2)", " (millions of m2)"] as [string, string],
    },
  ])("$format, $language", async ({ format, chinese, heads }) => {
    const fixture = rowHeadDocument(format as "pdf" | "word" | "sheet", chinese, heads);
    const quoteOf = (written: string) =>
      format === "sheet"
        ? `${written.slice(0, written.lastIndexOf(" ")).trim()}\t${written.slice(written.lastIndexOf(" ")).trim().replace(/,/g, "")}`
        : written;
    const number = (written: string) => {
      const text = written.slice(written.lastIndexOf(" ")).trim();
      return format === "sheet" ? text.replace(/,/g, "") : text;
    };
    const model = calculatingModel({
      queries: [chinese ? "销售额 成本" : "sales costs"],
      steps: [
        (passages) => {
          const passage = passageWriting(passages, fixture.title, quoteOf(fixture.revenue));
          const location = passage.location ?? "p. 1";
          return [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, location, quote: quoteOf(fixture.revenue) },
                  { marker: 2, passage: passage.id, location, quote: quoteOf(fixture.costs) },
                ],
              },
            },
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Difference",
                    formula: "rev - cost",
                    inputs: [
                      {
                        name: "rev",
                        label: "Sales",
                        citation: 1,
                        number: number(fixture.revenue),
                        unitQuote: fixture.unitQuote,
                      },
                      {
                        name: "cost",
                        label: "Costs",
                        citation: 2,
                        number: number(fixture.costs),
                        unitQuote: fixture.unitQuote,
                      },
                    ],
                  },
                ],
              },
            },
          ];
        },
      ],
      answer: "[=1][^1]",
    });
    const extension = format === "pdf" ? "pdf" : format === "word" ? "docx" : "xlsx";
    const { core } = await setUpCalculating(model, [
      { name: `${fixture.title}.${extension}`, contents: fixture.contents },
    ]);

    const { answer } = await askAndRead(core, chinese ? "差额是多少？" : "What is the difference?");
    core.close();

    expect(figuresOf(answer)).toEqual([]);
    expect(toldRuns(model)[0] ?? "").toContain("unit of measure");
  });

  test("a measure's own millions with no page scale is refused", {
    timeout: 60_000,
  }, async () => {
    const { answer, asked } = await rowsWithoutScale("Sales area", [
      "Sales (millions of m2) 1,234.5",
      "Costs (millions of m2) 334.5",
    ]);

    expect(figuresOf(answer)).toEqual([]);
    expect(asked).toContain("row whose head writes");
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

// protects=#2365; fails_when=a Document of a kind not read again (here plain text) keeps the empty marker an earlier build stored, and a scale it writes two ways ("in MM") is then missed, so a statement's currency is carried to bare fees unscaled.
test("a stored empty marker still finds a scale the page writes two ways", {
  timeout: 60_000,
}, async () => {
  const dataDir = await createTempDataFolder();
  const lines = ["Sale price £385.00", "Less: agent's fee (4.62)"];
  const document = {
    name: "Completion statement 14 Mill Lane.txt",
    contents: ["Completion statement: 14 Mill Lane", "Amounts (in MM)", ...lines].join("\n"),
  };
  const first = await setUpCalculating(
    calculatingModel({ queries: [], steps: [], answer: "Nothing." }),
    [document],
    dataDir,
  );
  first.core.close();
  // As a build before this one stored it: the page's marker read without the forms that read two ways.
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  db.run("UPDATE document_pages SET scale_marker = ''");
  db.close();

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
                label: "Net",
                formula: "price + agent",
                inputs: [
                  { name: "price", label: "Price", citation: cited[0], number: "£385.00" },
                  {
                    name: "agent",
                    label: "Fee",
                    citation: cited[1],
                    number: "(4.62)",
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
  const { core } = await setUpCalculating(model, [], dataDir);

  const { answer } = await askAndRead(core, "What are the net proceeds?");

  expect(toldRuns(model)[0]).toContain('but the Document states a scale ("in MM")');
  expect(figuresOf(answer)).toEqual([]);
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

    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
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

    expect(toldRuns(model)[0]).toContain(`[=2] rev: ${number(revenue)} has no unit, and `);
    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
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

  expect(toldRuns(model)[0]).toContain(
    `[=1] nav: 12.34 has no unit, and Funds, row 2 writes "USD B", which can be read as more than one scale or unit`,
  );
  expect(figuresOf(answer)).toEqual([]);
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

    const [asked] = toldRuns(model);
    expect(asked).toContain(
      `[=2] x: 1.25 is on a per-share row, and "${head.replace(/（.*$|, except.*$/, "")}`,
    );
    expect(asked).toContain(
      `[=3] x: 1.25 is on a per-share row, and the unitQuote "${head}" scales its Document's amounts except where it notes otherwise; it can't be calculated without guessing its scale.`,
    );
    expect(figuresOf(answer).map((figure) => [figure.marker, figure.value])).toEqual([
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

    const byMarker = new Map(figuresOf(answer).map((figure) => [figure.marker, figure.value]));
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
  const byMarker = new Map(figuresOf(answer).map((figure) => [figure.marker, figure.value]));
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
    layout: "a row head in (bn) under a scale line in millions, above its number",
    head: "(in millions)",
    lines: ["Loans (bn)", "12.3"],
    quotes: ["12.3"],
    doubled: [null],
  },
  {
    layout: "a row head in (bn) under a scale line in millions, on its number's line",
    head: "(in millions)",
    lines: ["Loans (bn) 12.3"],
    quotes: ["12.3"],
    doubled: [null],
  },
  {
    layout: "a row head in (bn) quoted as the scale line",
    head: "Loans (bn)",
    lines: ["12.3"],
    quotes: ["12.3"],
    doubled: [24_600_000_000],
  },
  {
    layout: "a row head in 亿 under 单位：万元, on its number's line",
    head: "单位：万元",
    lines: ["营业收入（亿） 12.3"],
    quotes: ["12.3"],
    doubled: [null],
  },
  {
    layout: "row heads in units of measure under a scale line",
    head: "(in thousands)",
    lines: ["Capacity (MW) 1,234.5", "Sales area (m2) 334.5", "Output (tonnes) 412.5"],
    quotes: ["1,234.5", "334.5", "412.5"],
    doubled: [null, null, null],
  },
  {
    layout: "row heads in Chinese units of measure under 单位：千元",
    head: "单位：千元",
    lines: ["装机容量（兆瓦） 1,234.5", "销售面积（平方米） 334.5", "产量（吨） 412.5"],
    quotes: ["1,234.5", "334.5", "412.5"],
    doubled: [null, null, null],
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

// protects=#448; fails_when=a Word table row under a cell merged down from the row above loses its label, so a per-share figure is scaled with the amounts; no_claim=none.
test("a Word table row whose first cell is merged down keeps its label", {
  timeout: 60_000,
}, async () => {
  const head = "(in thousands, except per share data)";
  const quote = "Diluted EPS\tNote 12\t1.25";
  const continued = "<w:tcPr><w:vMerge/></w:tcPr>";
  const restart = (text: string) =>
    `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
  const model = calculatingModel({
    queries: ["Pelican statement"],
    steps: [
      citeStatement("Pelican statement", [quote], (cited) => [
        {
          tool: "calculate",
          input: {
            figures: [
              {
                marker: 1,
                label: quote,
                formula: "x * 2",
                inputs: [
                  {
                    name: "x",
                    label: quote,
                    citation: cited[0],
                    number: "1.25",
                    unitQuote: head,
                  },
                ],
              },
            ],
          },
        },
      ]),
    ],
    answer: "[=1]",
  });
  const { core } = await setUpCalculating(model, [
    {
      name: "Pelican statement.docx",
      contents: wordFile({
        body: [
          paragraph("Pelican statement", { style: "Title" }),
          paragraph(head),
          table([
            ["Workstream", "Item", "Note", "Amount"],
            [restart("Design"), "Revenue", "", "1,234.5"],
            [continued, "Diluted EPS", "Note 12", "1.25"],
          ]),
        ].join(""),
      }),
    },
  ]);
  const { answer } = await askAndRead(core, "What is the diluted EPS doubled?");
  expect(figuresOf(answer).map((figure) => figure.value)).toEqual([2.5]);
});

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

  expect(toldRuns(model)[0]).toContain(
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
test.each(
  [
    { language: "English", head: "(in thousands)", rows: AMOUNT_ROWS_EN },
    { language: "Chinese", head: "单位：千元", rows: AMOUNT_ROWS_ZH },
  ].flatMap(({ language, head, rows }) =>
    // In halves first, as a half's rows share no quote ("净利润 1,234.5" is in a later row's line).
    [rows.slice(0, 20), rows.slice(20)].flatMap((half, at) =>
      inSixes(half).map((part, index) => {
        const from = at * 20 + index * 6 + 1;
        return { part: `${language}, ${from}–${from + part.length - 1}`, head, rows: part };
      }),
    ),
  ),
)(
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

    expect(figuresOf(answer).map((figure) => figure.value)).toEqual([doubled]);
  },
);

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

  test("cells that show £ million as '+23,770m' are read in millions, not as 23,770", async () => {
    const own = await calculated(MILLIONS, { formula: "autumn + spring" }, NET, "The net is [=1].");
    expect(figuresOf(own)).toMatchObject([
      {
        value: 14_475_000_000,
        inputs: [
          { number: { chars: "+23,770m", value: 23_770_000_000 }, cell: { stored: 23770 } },
          { number: { chars: "-9,295m", value: -9_295_000_000 }, cell: { stored: -9295 } },
        ],
      },
    ]);
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
    expect(figuresOf(answer)).toMatchObject([{ value: 14_475_000_000 }]);
    expect(figuresOf(answer)[0]?.inputs[0]?.number.value).toBe(23_770_000_000);
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
      expect(figuresOf(answer)[0]?.value).toBe(case_.value);
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
      expect(figuresOf(answer)[0]?.value).toBe(case_.value);
    },
  );

  test("万元 written after a cell's number is read in yuan, in Chinese", async () => {
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
    expect(figuresOf(answer)[0]?.value).toBe(304_573_600);
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
      value: 14_475_000_000,
    },
    {
      heading: "Revenue ($bn)",
      format: "0.0",
      stored: [1.2, 0.3] as [number, number],
      numbers: ["1.2", "0.3"],
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
      expect(figuresOf(answer)[0]?.value).toBe(table.value);
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
      expect(figuresOf(answer)).toMatchObject([
        {
          value: table.value,
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

  test("the English half of a bilingual unit line, '100million USD', states the scale", async () => {
    const model = reserves(
      [{ unitQuote: "100million USD", as: "number" }],
      "9月末比1月末增加了[=1]。",
    );
    const { core } = await setUpCalculating(model, [RESERVES]);

    const { answer } = await askAndRead(core, "9月末外汇储备与1月末相比变化了多少？");

    expect(figuresOf(answer)).toMatchObject([{ value: 1_173_000_000 }]);
  });
});

describe("A number takes the unit its row gives it in a cell of its own (#1798)", {
  timeout: 60_000,
}, () => {
  const ROW = "净负债\t2026年三季度实际\t31000\t万元\t实际，非预测";

  // protects=31000 quoted alone from a row whose next cell says 万元 is never read as 31,000 元: the model is asked for the row as unitQuote, and the row gives 3.1亿元; fails_when=the figure comes out 0.00031亿 or the row is refused as stating no unit; no_claim=a unit stated on another row, which still needs its own line.
  test("31000 beside a 万元 cell asks for its row, and the row gives 31,000万元", async () => {
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
    const [asked, recorded] = toldRuns(model);
    expect(asked).toContain(`31000 has no unit, and 2026年三季度, row 6 says "${ROW}"`);
    expect(recorded).toContain("Recorded [=1]");
    expect(figuresOf(answer)).toMatchObject([
      {
        value: 310_000_000,
        inputs: [
          { number: { chars: "31000", value: 310_000_000 }, unitStatement: { scale: 10_000 } },
        ],
      },
    ]);
  });
  // protects=a units cell that begins with its own number ("1000 t") is not read as a unit alone: the 540 of its row stays the plain 540 it is on main, not 5,400,000 t; fails_when=the cell is read by putting a 1 before it, which gives the row a multiplier the cell doesn't write (#2997); no_claim=that a plain 540 is the best reading of such a row
  test("a units cell that begins with a number is no multiplier", async () => {
    const model = calculatingModel({
      queries: ["bolts output"],
      steps: [
        (passages) => [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passageOf(passages, "Output"),
                  quote: "| Bolts | 1000 t | 540 |",
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
                  label: "Bolts output",
                  formula: "out",
                  inputs: [{ name: "out", label: "Bolts", citation: 1, number: "540" }],
                },
              ],
            },
          },
        ],
      ],
      answer: "Bolts output was [=1][^1].",
    });
    const { core } = await setUpCalculating(model, [
      {
        name: "Output.md",
        contents: "| Item | Unit | Output |\n|---|---|---|\n| Bolts | 1000 t | 540 |\n",
      },
    ]);
    const { answer } = await askAndRead(core, "What was the bolts output?");

    expect(figuresOf(answer).map((figure) => figure.value)).toEqual([540]);
  });
});
