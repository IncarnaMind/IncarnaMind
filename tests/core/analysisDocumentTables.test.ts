/**
 * Tables in PDF, Word and PowerPoint Documents as an Analysis's Inputs (#448): the index keeps
 * each table's rows and columns with its Units, an Analysis reads them as it reads a sheet's
 * range, and a figure() over them is worked out again from the app's own cells, each cited where
 * the Document has it. A table over pages is one table; a merged cell keeps its columns; a
 * footnote mark isn't a digit; a scan's numbers are never worked out again; a cell the app can't
 * find again stays text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { CURRENT_SINCE } from "../../src/core/documents/processing";
import { createFakeTextRecognizer, type FakeScanScript } from "../../src/core/documents/scan/fake";
import { openDatabase } from "../../src/core/storage";
import type {
  AnalysisCell,
  AnalysisFigureRows,
  AnalysisInput,
  AnalysisJob,
  AnalysisValue,
  FigureHow,
} from "../../src/shared/analysis";
import { answerEnded, type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { answerRequests, scriptedModel, scriptedModels } from "../helpers/models";
import { buildPdf, type PdfPage } from "../helpers/pdf";
import { para, pptxOf, sp, txBody, xfrm } from "../helpers/pptx";
import { escapeXml, paragraph, table, wordFile } from "../helpers/word";

type TableInput = Extract<AnalysisInput, { kind: "table" }>;

const isNumber = (cell: AnalysisCell): cell is number =>
  typeof cell === "number" && Number.isFinite(cell);

/** Consecutive row numbers as runs, as the helper names a figure's rows. */
function runsOf(rows: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const row of rows) {
    const last = runs.at(-1);
    if (last && last[1] === row - 1) last[1] = row;
    else runs.push([row, row]);
  }
  return runs;
}

/** What the helper's figure(name, df[column], how) gives for the rows `keep` keeps. */
function figureOf(
  input: TableInput,
  column: string,
  how: FigureHow,
  keep: (row: readonly AnalysisCell[]) => boolean = () => true,
): AnalysisValue {
  const at = input.columns.indexOf(column);
  if (at < 0) throw new Error(`${input.name} has no column ${column}: ${input.columns.join(", ")}`);
  const kept = input.rows.flatMap((row, index) =>
    keep(row) ? [{ cells: row, number: input.rowNumbers?.[index] ?? 0 }] : [],
  );
  const values = kept.map((row) => row.cells[at] ?? null).filter(isNumber);
  const value = how === "count" ? values.length : values.reduce((sum, each) => sum + each, 0);
  const of: AnalysisFigureRows = {
    input: input.name,
    columns: [column],
    rows: runsOf(kept.map((row) => row.number)),
    count: kept.length,
    how,
  };
  return { kind: "figure", name: `${how}_${at}`, label: column, unit: null, value, of };
}

type Call = { tool: string; input: unknown };

function analysingModel(query: string, runs: ((passages: ShownPassage[]) => Call)[]) {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) return { calls: [{ tool: "search_documents", input: { query } }] };
    const ran = call.results.filter((result) => result.tool === "run_analysis").length;
    const next = runs[ran];
    if (next) return { calls: [next(searches.flatMap((each) => shownPassages(each.text)))] };
    return { text: "Done [=1]." };
  });
}

const passageOf = (passages: readonly ShownPassage[], name: string, text?: string) => {
  const found = passages.find(
    (passage) => passage.document.startsWith(name) && (!text || passage.text.includes(text)),
  );
  if (!found) throw new Error(`No Passage of ${name} was shown.`);
  return found.id;
};

const run =
  (document: string, inputs: Record<string, unknown>[], shows?: string) =>
  (passages: ShownPassage[]): Call => ({
    tool: "run_analysis",
    input: {
      title: "Totals",
      inputs: inputs.map((input) => ({ ...input, passage: passageOf(passages, document, shows) })),
      code: "figure(...)",
    },
  });

/** Every Analysis report the model read, in order. */
function reports(model: MockLanguageModelV4): string[] {
  const texts: string[] = [];
  for (const message of answerRequests(model).at(-1)?.prompt ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === "run_analysis") {
        if (part.output.type === "text") texts.push(part.output.value);
      }
    }
  }
  return texts;
}

interface Asked {
  files: { name: string; contents: Uint8Array | string }[];
  question: string;
  query: string;
  runs: ((passages: ShownPassage[]) => Call)[];
  helper: (job: AnalysisJob) => FakeAnswer;
  scans?: FakeScanScript;
  /** Changes the stored Units before the Question, as an older read could have left them. */
  stored?: (dataDir: string) => void;
}

async function ask(asked: Asked) {
  const model = analysingModel(asked.query, asked.runs);
  const runtime = createFakeAnalysisRuntime({ answer: asked.helper });
  const dataDir = await createTempDataFolder();
  const options = {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: runtime,
    ...(asked.scans && {
      textRecognizer: createFakeTextRecognizer({ script: asked.scans }),
      textRecognitionModelSource: NO_MODEL_FILES,
    }),
  };
  let core = startCore(dataDir, options);
  const provide = async () => {
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  };
  await provide();
  const sources = await createTempDataFolder();
  await addAndProcess(
    core,
    await Promise.all(
      asked.files.map((file) => writeSourceFile(sources, file.name, file.contents)),
    ),
  );
  if (asked.stored) {
    await core.close();
    asked.stored(dataDir);
    core = startCore(dataDir, options);
    await provide();
  }
  const question = await core.askInConversation({ text: asked.question });
  if (!question.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(question)}`);
  const ended = await answerEnded(core, question.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(question.conversation.id);
  const answer = content.messages.find((message) => message.id === question.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  const inputs = runtime.jobs.flatMap((job) =>
    job.inputs.flatMap((input) => (input.kind === "table" ? [input] : [])),
  );
  return { analyses: answer.analyses, inputs, reports: reports(model) };
}

const column = (input: TableInput | undefined, heading: string) => {
  const at = input?.columns.indexOf(heading) ?? -1;
  return input?.rows.map((row) => row[at] ?? null) ?? [];
};

const checkOf = (analysis: { recalculations?: { result: string; check: unknown }[] } | undefined) =>
  analysis?.recalculations?.map((each) => each.check) ?? [];

/* A register of payments over three pages: headings repeated on each, a carried-forward line at
 * the foot of the first two and a brought-forward line at the head of the next, footnote marks
 * after some amounts and suppliers, and the total printed at the end. */
const PAYMENTS = [
  ["2025-04-02", "Hollin Pumps", "1,240.50¹"],
  ["2025-04-03", "Garth Fencing*", "3,980.00"],
  ["2025-04-07", "Mere Lane Haulage", "615.25"],
  ["2025-04-09", "Hollin Pumps", "2,075.75²"],
  ["2025-04-14", "Tarn Electrical", "9,410.00"],
  ["2025-04-16", "Garth Fencing", "4,402.10"],
  ["2025-04-22", "Brack Survey Co", "1,118.40¹"],
  ["2025-04-25", "Mere Lane Haulage", "780.00"],
  ["2025-05-01", "Tarn Electrical", "6,333.33"],
  ["2025-05-06", "Hollin Pumps", "2,250.00"],
  ["2025-05-12", "Brack Survey Co", "3,019.95"],
  ["2025-05-19", "Garth Fencing", "1,650.60²"],
  ["2025-05-27", "Tarn Electrical", "5,125.00"],
] as const;
const PAID = [124_050, 398_000, 61_525, 207_575, 941_000, 440_210, 111_840, 78_000, 633_333];
const PAID_TOO = [225_000, 301_995, 165_060, 512_500];
const pounds = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function registerPdf(): Uint8Array {
  const footer = (page: number) => ({
    text: `Northfield Water - grants register - page ${page}`,
    x: 72,
    y: 40,
  });
  const at = [72, 160, 380] as const;
  const row = (cells: readonly string[], y: number) =>
    cells.flatMap((text, index) => (text ? [{ text, x: at[index] ?? 72, y }] : []));
  const parts = [PAYMENTS.slice(0, 5), PAYMENTS.slice(5, 10), PAYMENTS.slice(10)];
  let carried = 0;
  let paid = 0;
  const register = parts.map((rows, index): PdfPage => {
    const placed = [...row(["Date", "Supplier", "Amount (GBP)"], 700)];
    let y = 684;
    if (index > 0) {
      placed.push(...row(["", "Brought forward", pounds(carried)], y));
      y -= 16;
    }
    for (const payment of rows) {
      placed.push(...row(payment, y));
      carried += [...PAID, ...PAID_TOO][paid++] ?? 0;
      y -= 16;
    }
    const last = index === parts.length - 1;
    placed.push(...row(["", last ? "Total paid" : "Carried forward", pounds(carried)], y - 4));
    return {
      lines: [`Grants register, April and May 2025${index > 0 ? " (continued)" : ""}`],
      placed: [...placed, footer(index + 2)],
    };
  });
  return buildPdf([
    { lines: ["Northfield Water", "", "Grants register: April and May 2025"] },
    ...register,
  ]);
}

const PNL = [
  ["Revenue", "412.6", "455.0", "498.3", "540.9", "601.2"],
  ["Cost of sales", "(240.1)", "(261.7)", "(282.0)", "(301.4)", "(330.8)"],
  ["Gross profit", "172.5", "193.3", "216.3", "239.5", "270.4"],
  ["Operating costs", "(98.4)", "(104.2)", "(111.9)", "(118.0)", "(126.5)"],
  ["Operating profit", "74.1", "89.1", "104.4", "121.5", "143.9"],
] as const;

function incomeStatementPdf(): Uint8Array {
  const at = [72, 250, 310, 370, 430, 490] as const;
  const top = 640;
  const rows = [["", "2021", "2022", "2023", "2024", "2025"], ...PNL];
  return buildPdf([
    {
      lines: ["Five-year income statement", "", "Years ended 31 March (GBP millions)"],
      placed: rows.flatMap((cells, index) =>
        cells.flatMap((text, column) =>
          text ? [{ text, x: at[column] ?? 72, y: top - index * 16 }] : [],
        ),
      ),
    },
  ]);
}

const merged = (properties: string, text = "") =>
  `<w:tcPr>${properties}</w:tcPr>${text ? paragraph(text) : ""}`;

/** A budget table as Word merges it: a workstream down its items, a heading over two columns, a label over two. */
function budgetDocx(
  words: { title: string; workstream: string; item: string; cost: string; staff: string },
  lines: readonly (readonly [string, string, string, string])[],
  total: readonly [string, string, string],
): Uint8Array {
  const restart = (text: string) => merged('<w:vMerge w:val="restart"/>', text);
  const continued = () => merged("<w:vMerge/>");
  const rows = [
    [restart(words.workstream), restart(words.item), merged('<w:gridSpan w:val="2"/>', words.cost)],
    [continued(), continued(), words.staff, words.staff === "Staff" ? "Suppliers" : "外部"],
    ...lines.map((line, index) => [
      lines[index - 1]?.[0] === line[0] ? continued() : restart(line[0]),
      line[1],
      line[2],
      line[3],
    ]),
    [merged('<w:gridSpan w:val="2"/>', total[0]), total[1], total[2]],
  ];
  return wordFile({
    body: [paragraph(words.title, { style: "Title" }), table(rows, 4)].join(""),
  });
}

function deck(title: string, rows: readonly (readonly string[])[]): Uint8Array {
  const cell = (text: string) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  const grid = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1100000"/><a:ext cx="8000000" cy="3600000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${'<a:gridCol w="2000000"/>'.repeat(rows[0]?.length ?? 1)}</a:tblGrid>${rows
    .map((row) => `<a:tr h="360000">${row.map(cell).join("")}</a:tr>`)
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const heading = (text: string) =>
    sp({
      id: 2,
      name: "Title",
      ph: `<p:ph type="title"/>`,
      spPr: xfrm(457200, 200000, 8000000, 800000),
      body: txBody(para(escapeXml(text))),
    });
  return pptxOf({
    slides: [{ shapes: heading("Board pack") }, { shapes: heading(title) + grid }],
  });
}

const SCANS = join(import.meta.dirname, "../fixtures/scans");
/** What the real recognizer read of the table scan: Table 3, and 表 5 with "1,286" unsure. */
const scanScript = (): FakeScanScript => {
  const read = JSON.parse(readFileSync(join(SCANS, "read.json"), "utf8")) as FakeScanScript;
  return { pages: { 1: read.pages.table ?? {} } };
};

describe("a PDF table over three pages, headed again on each (#448)", { timeout: 60_000 }, () => {
  test.each([
    ["en", "Add up the grants paid in the register and check the total it prints."],
    ["zh", "把登记表中的拨款加起来，并与表末印出的合计核对。"],
  ])(
    "is one table whose payments add up to the printed total, cited page by page (%s)",
    async (_, question) => {
      const { analyses, inputs, reports } = await ask({
        files: [{ name: "Grants register 2025.pdf", contents: registerPdf() }],
        question,
        query: "grants register payments",
        runs: [run("Grants register", [{ name: "register" }])],
        helper: (job) => {
          const [input] = job.inputs;
          if (input?.kind !== "table") throw new Error("No table.");
          const dated = (row: readonly AnalysisCell[]) =>
            typeof row[0] === "string" && row[0] !== "";
          return { output: { results: [figureOf(input, "Amount (GBP)", "sum", dated)] } };
        },
      });
      const [input] = inputs;
      expect(input?.columns).toEqual(["Date", "Supplier", "Amount (GBP)"]);
      // 13 payments, 2 lines carried forward, 2 brought forward and the total: one table of 18 rows.
      expect(input?.rowNumbers).toEqual(Array.from({ length: 18 }, (_, at) => at + 2));
      expect(column(input, "Amount (GBP)").slice(0, 3)).toEqual([1240.5, 3980, 615.25]);
      expect(column(input, "Supplier")[1]).toBe("Garth Fencing*");
      const [analysis] = analyses;
      expect(checkOf(analysis)).toEqual([{ kind: "same", value: 42_000.88 }]);
      expect(analysis?.markers.figures).toHaveLength(1);
      const [range] = analysis?.inputs ?? [];
      if (range?.kind !== "range") throw new Error("No range was read.");
      expect(range.citation).toMatchObject({
        pageFrom: 2,
        pageTo: 4,
        location: { kind: "page", from: 2, to: 4 },
        quote: "2025-04-02 Hollin Pumps 1,240.50¹",
      });
      expect(range.table?.rows.map((row) => row.unit)).toEqual([
        ...Array(6).fill(2),
        ...Array(7).fill(3),
        ...Array(5).fill(4),
      ]);
      expect(range.table?.rows[7]).toEqual({
        row: 9,
        unit: 3,
        quote: "2025-04-16 Garth Fencing 4,402.10",
      });
      expect(range.table?.marks).toBe(4);
      expect(reports[0]).toContain(
        "- register: Grants register 2025, table 1 (pp. 2–4), A1:C19: 18 rows × 3 columns",
      );
      expect(reports[0]).toContain("4 cells have a footnote mark after its number");
    },
  );
});

describe("a five-year income statement in a PDF (#448)", { timeout: 60_000 }, () => {
  test.each([
    ["en", "What were gross margins over the five years?"],
    ["zh", "这五年的毛利率分别是多少？"],
  ])("reads its years as columns and its brackets as negatives (%s)", async (_, question) => {
    const { analyses, inputs } = await ask({
      files: [{ name: "Five-year statement.pdf", contents: incomeStatementPdf() }],
      question,
      query: "income statement revenue gross profit",
      runs: [run("Five-year statement", [{ name: "pnl" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        const costs = (row: readonly AnalysisCell[]) => String(row[0]).endsWith("costs");
        return { output: { results: [figureOf(input, "2025", "sum", costs)] } };
      },
    });
    const [input] = inputs;
    expect(input?.columns).toEqual(["A", "2021", "2022", "2023", "2024", "2025"]);
    expect(column(input, "A")).toEqual(PNL.map((row) => row[0]));
    expect(column(input, "2025")).toEqual([601.2, -330.8, 270.4, -126.5, 143.9]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: -126.5 }]);
    const [range] = analyses[0]?.inputs ?? [];
    expect(range?.kind === "range" && range.citation).toMatchObject({
      pageFrom: 1,
      pageTo: 1,
      quote: "Revenue 412.6 455.0 498.3 540.9 601.2",
    });
  });
});

describe("a Word table with merged cells (#448)", { timeout: 60_000 }, () => {
  test.each([
    [
      "en",
      "Does the suppliers column add up to the budget's total?",
      {
        title: "Clinic fit-out budget",
        workstream: "Workstream",
        item: "Item",
        cost: "Cost (GBP)",
        staff: "Staff",
      },
      [
        ["Design", "Surveys", "1,200", "8,400"],
        ["Design", "Drawings", "2,350", "11,900"],
        ["Works", "Joinery", "900", "23,750"],
        ["Works", "Wiring", "1,100", "17,300"],
      ],
      ["Contingency", "500", "6,000"],
      ["Workstream", "Item", "Cost (GBP) Staff", "Cost (GBP) Suppliers"],
      "Cost (GBP) Suppliers",
      67_350,
    ],
    [
      "zh",
      "外部费用一列合计是否与预算总额一致？",
      {
        title: "诊所装修预算（单位：元）",
        workstream: "工作",
        item: "项目",
        cost: "费用（元）",
        staff: "内部",
      },
      [
        ["设计", "勘测", "１，２００", "8,400"],
        ["设计", "图纸", "2,350", "11,900"],
        ["施工", "木工", "900", "23,750"],
      ],
      ["不可预见费", "500", "6,000"],
      ["工作", "项目", "费用（元）内部", "费用（元）外部"],
      "费用（元）外部",
      50_050,
    ],
  ] as const)(
    "keeps each amount under its own heading and works the column out again (%s)",
    async (_, question, words, lines, total, headings, summed, expected) => {
      const { analyses, inputs, reports } = await ask({
        files: [{ name: "Budget.docx", contents: budgetDocx(words, lines, total) }],
        question,
        query: lines[0]?.[1] ?? "",
        runs: [run("Budget", [{ name: "budget" }])],
        helper: (job) => {
          const [input] = job.inputs;
          if (input?.kind !== "table") throw new Error("No table.");
          return { output: { results: [figureOf(input, summed, "sum")] } };
        },
      });
      const [input] = inputs;
      expect(input?.columns).toEqual(headings);
      expect(input?.rows.at(-1)).toEqual([total[0], null, 500, 6000]);
      expect(input?.rows[1]?.[0]).toBeNull();
      expect(input?.rows[0]?.[2]).toBe(1200);
      expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: expected }]);
      const [range] = analyses[0]?.inputs ?? [];
      expect(range?.kind === "range" && range.citation.location?.kind).toBe("section");
      expect(reports[0]).toContain("- budget: Budget, table 1 (section 1), A1:D");
    },
  );
});

describe("a deck's table (#448)", { timeout: 60_000 }, () => {
  test.each([
    [
      "en",
      "How many orders did the regions take?",
      ["Region", "Orders"],
      ["Northgate", "2,318"],
      ["Riverside", "1,675"],
    ],
    ["zh", "各地区一共多少订单？", ["地区", "订单"], ["华东", "2,318"], ["华南", "1,675"]],
  ] as const)(
    "is read from its slide, each row cited there (%s)",
    async (_, question, headings, a, b) => {
      const { analyses, inputs } = await ask({
        files: [
          { name: "Board pack.pptx", contents: deck("Results", [headings, a, b, [a[0], "40"]]) },
        ],
        question,
        query: a[0],
        runs: [run("Board pack", [{ name: "orders" }])],
        helper: (job) => {
          const [input] = job.inputs;
          if (input?.kind !== "table") throw new Error("No table.");
          return { output: { results: [figureOf(input, headings[1], "sum")] } };
        },
      });
      expect(inputs[0]?.columns).toEqual([...headings]);
      expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 4033 }]);
      const [range] = analyses[0]?.inputs ?? [];
      expect(range?.kind === "range" && range.citation).toMatchObject({
        pageFrom: 2,
        pageTo: 2,
        location: { kind: "slide", from: 2, to: 2 },
        quote: `${a[0]}\t${a[1]}`,
      });
    },
  );
});

describe("a scanned page's tables (#448)", { timeout: 60_000 }, () => {
  test.each([
    ["en", "Add up the product lines in Table 3 and check them against its total."],
    ["zh", "把表 5 各地区上半年收入加起来，并与合计核对。"],
  ])(
    "are read as recognized, and no figure of them is worked out again (%s)",
    async (_, question) => {
      const { analyses, inputs, reports } = await ask({
        files: [
          {
            name: "Scanned revenue tables.pdf",
            contents: buildPdf([{ scan: readFileSync(join(SCANS, "table.jpg")) }]),
          },
        ],
        question,
        query: "revenue product line",
        scans: scanScript(),
        runs: [
          (passages) => ({
            tool: "run_analysis",
            input: {
              title: "Tables",
              inputs: [{ name: "t", passage: passageOf(passages, "Scanned") }],
              code: "x",
            },
          }),
          run("Scanned", [
            { name: "lines", table: 1 },
            { name: "regions", table: 2 },
          ]),
        ],
        helper: (job) => {
          const [lines, regions] = job.inputs;
          if (lines?.kind !== "table" || regions?.kind !== "table") throw new Error("No tables.");
          return {
            output: {
              results: [figureOf(lines, "2025", "sum"), figureOf(regions, "上半年", "sum")],
            },
          };
        },
      });
      expect(reports[0]).toContain("this Passage shows more than one table");
      expect(reports[0]).toContain('table 1 (p. 1): "Product line | 2024 | 2025 | Change", 5 rows');
      const [lines, regions] = inputs;
      expect(lines?.readFromScan).toBe(true);
      expect(column(lines, "2025")).toEqual([5330, 1985, 4412, 1301, 13028]);
      // The recognizer was unsure of "1,286": it stays text, and no figure over it is checked.
      expect(column(regions, "上半年")).toEqual(["1,286", 974, 512, 2772]);
      const checks = checkOf(analyses[0]);
      expect(checks).toHaveLength(2);
      for (const check of checks) {
        expect(check).toMatchObject({
          kind: "unchecked",
          reason: expect.stringContaining("read from a scan"),
        });
      }
      expect(analyses[0]?.markers.figures).toEqual([]);
      expect(reports[1]).toContain("Its numbers were read from a scan by text recognition");
      const [range] = analyses[0]?.inputs ?? [];
      expect(range?.kind === "range" && range.table?.scan).toBe(true);
    },
  );
});

describe("a cell the app can't find again where the Document has it (#448)", {
  timeout: 60_000,
}, () => {
  test("stays text, so a figure over it isn't worked out again", async () => {
    const { analyses, inputs } = await ask({
      files: [{ name: "Five-year statement.pdf", contents: incomeStatementPdf() }],
      question: "Total the 2025 column.",
      query: "income statement revenue gross profit",
      runs: [run("Five-year statement", [{ name: "pnl" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        return { output: { results: [figureOf(input, "2025", "sum")] } };
      },
      stored: (dataDir) => {
        const db = openDatabase(join(dataDir, DATABASE_FILE));
        try {
          // The stored text no longer holds "601.2" where the table has it.
          db.run("UPDATE document_pages SET text = replace(text, '601.2', '601,2')");
        } finally {
          db.close();
        }
      },
    });
    expect(column(inputs[0], "2025")[0]).toBe("601.2");
    expect(checkOf(analyses[0])).toEqual([
      { kind: "unchecked", reason: expect.stringContaining("isn't a number") },
    ]);
    expect(analyses[0]?.markers.figures).toEqual([]);
  });
});

describe("a Document with no table of figures (#448)", { timeout: 60_000 }, () => {
  test("is refused in plain words, and nothing runs", async () => {
    const { inputs, reports } = await ask({
      files: [
        {
          name: "Letter.pdf",
          contents: buildPdf([{ lines: ["Dear Ms Hale,", "", "Revenue rose in the spring."] }]),
        },
        { name: "Five-year statement.pdf", contents: incomeStatementPdf() },
      ],
      question: "Total the letter's figures.",
      query: "revenue spring letter",
      runs: [run("Letter", [{ name: "letter" }])],
      helper: () => ({}),
    });
    expect(inputs).toEqual([]);
    expect(reports[0]).toContain(
      "letter: Letter has no table of figures with rows and columns the app could read; quote its numbers with calculate instead",
    );
  });
});

describe("a Word table long enough to run over two sections (#448)", { timeout: 60_000 }, () => {
  test("is still one table, its rows numbered on", async () => {
    const rows = Array.from({ length: 260 }, (_, at) => [
      `Account ${String(at + 1).padStart(3, "0")} held at the northern depot`,
      `${(at + 1) * 10}`,
    ]);
    const { analyses, inputs } = await ask({
      files: [
        {
          name: "Ledger.docx",
          contents: wordFile({
            body: [
              paragraph("Depot ledger", { style: "Title" }),
              table([["Account", "Balance"], ...rows]),
            ].join(""),
          }),
        },
      ],
      question: "Total the balances.",
      query: "Account 001 depot",
      runs: [run("Ledger", [{ name: "ledger" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        return { output: { results: [figureOf(input, "Balance", "sum")] } };
      },
    });
    expect(inputs[0]?.rowNumbers).toHaveLength(260);
    expect(inputs[0]?.rowNumbers?.at(-1)).toBe(261);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 339_300 }]);
    const [range] = analyses[0]?.inputs ?? [];
    if (range?.kind !== "range") throw new Error("No range was read.");
    expect(new Set(range.table?.rows.map((row) => row.unit))).toEqual(new Set([1, 2]));
  });
});

describe("a raised mark after a sheet's number (#448)", { timeout: 60_000 }, () => {
  test("isn't read as a digit of it", async () => {
    const { analyses, inputs } = await ask({
      files: [
        { name: "grants.csv", contents: 'Item,Amount\nPumps,1240.50\nFencing,"3,980.00²"\n' },
      ],
      question: "Total the amounts.",
      query: "Pumps Fencing",
      runs: [run("grants", [{ name: "grants" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        return { output: { results: [figureOf(input, "Amount", "sum")] } };
      },
    });
    expect(column(inputs[0], "Amount")).toEqual([1240.5, "3,980.00²"]);
    expect(checkOf(analyses[0])).toEqual([
      { kind: "unchecked", reason: expect.stringContaining("isn't a number") },
    ]);
  });
});

describe("Documents read before their tables were kept (#448)", { timeout: 60_000 }, () => {
  test.each([
    ["Five-year statement.pdf", "pdf" as const, () => incomeStatementPdf()],
    [
      "Budget.docx",
      "docx" as const,
      () =>
        budgetDocx(
          {
            title: "Budget",
            workstream: "Workstream",
            item: "Item",
            cost: "Cost (GBP)",
            staff: "Staff",
          },
          [
            ["Design", "Surveys", "1,200", "8,400"],
            ["Works", "Joinery", "900", "23,750"],
          ],
          ["Contingency", "500", "6,000"],
        ),
    ],
    [
      "Board pack.pptx",
      "pptx" as const,
      () =>
        deck("Results", [
          ["Region", "Orders"],
          ["North", "12"],
          ["South", "30"],
        ]),
    ],
  ])("are read again at startup, so %s gains its table", async (name, kind, contents) => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const sources = await createTempDataFolder();
    const [document] = await addAndProcess(first, [
      await writeSourceFile(sources, name, contents()),
    ]);
    await first.close();
    const tablesStored = () =>
      queryDatabase<{ label: string | null }>(
        dataDir,
        "SELECT label FROM document_pages WHERE document_id = ? AND label LIKE '%\"tables\":[%'",
        [document?.id ?? ""],
      ).length;
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = ?", [BigInt(CURRENT_SINCE[kind] - 1)]);
      db.run("UPDATE document_pages SET label = NULL");
    } finally {
      db.close();
    }
    expect(tablesStored()).toBe(0);
    const again = startCore(dataDir);
    const [read] = await waitForProcessing(again, [document?.id ?? ""]);
    expect(read?.status).toBe("ready");
    expect(tablesStored()).toBe(1);
    await again.close();
  });
});
