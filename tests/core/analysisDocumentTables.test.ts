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
import { readRange } from "../../src/core/analysis/ranges";
import { createFakeTextRecognizer, type FakeScanScript } from "../../src/core/documents/scan/fake";
import { cellTable } from "../../src/core/documents/tableCells";
import { pageTables, textLayerRows } from "../../src/core/documents/tables";
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
import { escapeXml, paragraph, STYLES, table, wordFile } from "../helpers/word";

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
  const cell = (text: string) => {
    const [plain = "", mark] = text.split("^");
    const run = (value: string, raised: boolean) =>
      `<a:r><a:rPr lang="en-GB"${raised ? ' baseline="30000"' : ""}/><a:t>${escapeXml(value)}</a:t></a:r>`;
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(plain, false)}${mark ? run(mark, true) : ""}</a:p></a:txBody><a:tcPr/></a:tc>`;
  };
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

/** A deck with a heading merged over two columns the way PowerPoint writes it. */
function mergedDeck(): Uint8Array {
  const cell = (text: string, attrs = "") =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  const grid = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1100000"/><a:ext cx="8000000" cy="3600000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${'<a:gridCol w="2000000"/>'.repeat(3)}</a:tblGrid>${[
    `<a:tr h="360000">${cell("Region")}${cell("Cost (GBP)", ' gridSpan="2"')}${cell("", ' hMerge="1"')}</a:tr>`,
    `<a:tr h="360000">${cell("North")}${cell("1,200")}${cell("1,100")}</a:tr>`,
    `<a:tr h="360000">${cell("South")}${cell("800")}${cell("760")}</a:tr>`,
  ].join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const heading = (text: string) =>
    sp({
      id: 2,
      name: "Title",
      ph: `<p:ph type="title"/>`,
      spPr: xfrm(457200, 200000, 8000000, 800000),
      body: txBody(para(escapeXml(text))),
    });
  return pptxOf({
    slides: [{ shapes: heading("Board pack") }, { shapes: heading("Results") + grid }],
  });
}

/** A deck with a label merged down its rows the way PowerPoint writes it. */
function mergedDownDeck(): Uint8Array {
  const cell = (text: string, attrs = "") =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  const grid = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1100000"/><a:ext cx="8000000" cy="3600000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>${[
    `<a:tr h="360000">${cell("Workstream")}${cell("Cost")}</a:tr>`,
    `<a:tr h="360000">${cell("Design", ' rowSpan="4"')}${cell("")}</a:tr>`,
    `<a:tr h="360000">${cell("", ' vMerge="1"')}${cell("Surveys")}</a:tr>`,
    `<a:tr h="360000">${cell("", ' vMerge="1"')}${cell("3,550")}</a:tr>`,
    `<a:tr h="360000">${cell("", ' vMerge="1"')}${cell("1,200")}</a:tr>`,
  ].join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const heading = (text: string) =>
    sp({
      id: 2,
      name: "Title",
      ph: `<p:ph type="title"/>`,
      spPr: xfrm(457200, 200000, 8000000, 800000),
      body: txBody(para(escapeXml(text))),
    });
  return pptxOf({
    slides: [{ shapes: heading("Board pack") }, { shapes: heading("Design costs") + grid }],
  });
}

interface RawCell {
  text: string;
  attrs?: string;
}

/** A deck whose table's cells are given as text and DrawingML attributes, as a merge is written. */
function rawDeck(title: string, rows: readonly (readonly RawCell[])[]): Uint8Array {
  const cell = ({ text, attrs = "" }: RawCell) =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
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
      expect(reports[0]).toContain("4 cells have a footnote mark after their numbers");
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
      3_550,
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
      3_550,
    ],
  ] as const)(
    "keeps each amount under its own heading and works the column out again (%s)",
    async (_, question, words, lines, total, headings, summed, expected, oneWorkstream) => {
      const { analyses, inputs, reports } = await ask({
        files: [{ name: "Budget.docx", contents: budgetDocx(words, lines, total) }],
        question,
        query: lines[0]?.[1] ?? "",
        runs: [run("Budget", [{ name: "budget" }])],
        helper: (job) => {
          const [input] = job.inputs;
          if (input?.kind !== "table") throw new Error("No table.");
          return {
            output: {
              results: [
                figureOf(input, summed, "sum"),
                figureOf(input, headings[2] ?? "", "sum", (row) => row[0] === lines[0]?.[0]),
              ],
            },
          };
        },
      });
      const [input] = inputs;
      expect(input?.columns).toEqual(headings);
      expect(input?.rows.at(-1)).toEqual([total[0], null, 500, 6000]);
      // A label merged down the rows repeats in each row under it.
      expect(input?.rows[0]?.[0]).toBe(lines[0]?.[0]);
      expect(input?.rows[1]?.[0]).toBe(lines[0]?.[0]);
      expect(input?.rows[0]?.[2]).toBe(1200);
      expect(checkOf(analyses[0])).toEqual([
        { kind: "same", value: expected },
        { kind: "same", value: oneWorkstream },
      ]);
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

  test("a footnote mark the deck sets raised after a number isn't a digit of it", async () => {
    const { analyses, inputs, reports } = await ask({
      files: [
        {
          name: "Board pack.pptx",
          contents: deck("Results", [
            ["Region", "Orders"],
            ["Northgate", "2,318^1"],
            ["Riverside", "1,675"],
          ]),
        },
      ],
      question: "How many orders did the regions take?",
      query: "Northgate",
      runs: [run("Board pack", [{ name: "orders" }])],
      helper: sumOf("Orders"),
    });
    expect(column(inputs[0], "Orders")).toEqual([2318, 1675]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 3993 }]);
    expect(reports[0]).toContain("1 cell has a footnote mark after its number");
  });

  test("a merged heading keeps its columns", async () => {
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents: mergedDeck() }],
      question: "Total the costs.",
      query: "Cost North South",
      runs: [run("Board pack", [{ name: "costs" }])],
      helper: () => ({}),
    });
    expect(inputs[0]?.columns).toEqual(["Region", "Cost (GBP)", "Cost (GBP) (2)"]);
    expect(inputs[0]?.rows).toEqual([
      ["North", 1200, 1100],
      ["South", 800, 760],
    ]);
  });

  test("a merged-down label repeats on every row it continues", async () => {
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents: mergedDownDeck() }],
      question: "What does Design cost?",
      query: "Design costs",
      runs: [run("Board pack", [{ name: "costs" }])],
      helper: sumOf("Cost"),
    });
    expect(inputs[0]?.columns).toEqual(["Workstream", "Cost"]);
    expect(inputs[0]?.rows.map((row) => row[0])).toEqual(["Design", "Design", "Design", "Design"]);
  });

  test("a merge in the first row of a table with no headings repeats", async () => {
    const contents = rawDeck("Design costs", [
      [{ text: "Design", attrs: ' rowSpan="2"' }, { text: "Research" }, { text: "1,000" }],
      [{ text: "", attrs: ' vMerge="1"' }, { text: "Prototype" }, { text: "1,200" }],
    ]);
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents }],
      question: "What did Design cost?",
      query: "Design Research Prototype",
      runs: [run("Board pack", [{ name: "design" }])],
      helper: () => ({}),
    });
    expect(inputs[0]?.rows).toEqual([
      ["Design", "Research", 1000],
      ["Design", "Prototype", 1200],
    ]);
  });

  test("a figure merged down the rows counts once", async () => {
    const contents = rawDeck("Costs", [
      [{ text: "Workstream" }, { text: "Item" }, { text: "Amount" }],
      [{ text: "1,000", attrs: ' rowSpan="2"' }, { text: "Research" }, { text: "100" }],
      [{ text: "", attrs: ' vMerge="1"' }, { text: "Prototype" }, { text: "200" }],
    ]);
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents }],
      question: "Total the amounts.",
      query: "Research Prototype",
      runs: [run("Board pack", [{ name: "costs" }])],
      helper: sumOf("Amount"),
    });
    expect(inputs[0]?.rows).toEqual([
      [1000, "Research", 100],
      [null, "Prototype", 200],
    ]);
  });

  test("a merge written as true is a merge", async () => {
    const contents = rawDeck("Costs", [
      [
        { text: "Region" },
        { text: "Cost (GBP)", attrs: ' gridSpan="2"' },
        { text: "", attrs: ' hMerge="true"' },
      ],
      [{ text: "North" }, { text: "1,200" }, { text: "1,100" }],
      [{ text: "South" }, { text: "800" }, { text: "760" }],
    ]);
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents }],
      question: "Total the costs.",
      query: "Cost North South",
      runs: [run("Board pack", [{ name: "costs" }])],
      helper: () => ({}),
    });
    expect(inputs[0]?.columns).toEqual(["Region", "Cost (GBP)", "Cost (GBP) (2)"]);
    expect(inputs[0]?.rows).toEqual([
      ["North", 1200, 1100],
      ["South", 800, 760],
    ]);
  });

  test("a labelled row with a blank under a heading is the body's", async () => {
    const contents = rawDeck("Design costs", [
      [{ text: "" }, { text: "Item" }, { text: "Cost" }],
      [{ text: "Design", attrs: ' rowSpan="4"' }, { text: "Research" }, { text: "" }],
      [{ text: "", attrs: ' vMerge="1"' }, { text: "Workshop" }, { text: "" }],
      [{ text: "", attrs: ' vMerge="1"' }, { text: "Prototype" }, { text: "1,200" }],
      [{ text: "", attrs: ' vMerge="1"' }, { text: "Testing" }, { text: "2,350" }],
    ]);
    const { analyses, inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents }],
      question: "What did Design cost?",
      query: "Design costs",
      runs: [run("Board pack", [{ name: "design" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        return {
          output: { results: [figureOf(input, "Cost", "sum", (row) => row[0] === "Design")] },
        };
      },
    });
    expect(inputs[0]?.rows.map((row) => row[0])).toEqual(["Design", "Design", "Design", "Design"]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 3550 }]);
  });

  test("a merge started in a heading row doesn't repeat into the next heading row", async () => {
    const contents = rawDeck("Revenue", [
      [{ text: "" }, { text: "Revenue" }, { text: "Revenue" }],
      [{ text: "Revenue", attrs: ' rowSpan="2"' }, { text: "2024" }, { text: "2025" }],
      [{ text: "", attrs: ' vMerge="1"' }, { text: "H1" }, { text: "H2" }],
      [{ text: "North" }, { text: "1,200" }, { text: "1,100" }],
      [{ text: "South" }, { text: "800" }, { text: "760" }],
    ]);
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents }],
      question: "Total the 2024 column.",
      query: "North South",
      runs: [run("Board pack", [{ name: "revenue" }])],
      helper: sumOf("Revenue 2024 H1"),
    });
    expect(inputs[0]?.columns).toEqual(["Revenue", "Revenue 2024 H1", "Revenue 2025 H2"]);
    expect(inputs[0]?.rows).toEqual([
      ["North", 1200, 1100],
      ["South", 800, 760],
    ]);
  });

  test("a label merged down written as true repeats", async () => {
    const contents = rawDeck("Design costs", [
      [{ text: "Workstream" }, { text: "Cost" }],
      [{ text: "Design", attrs: ' rowSpan="2"' }, { text: "Surveys" }],
      [{ text: "", attrs: ' vMerge="true"' }, { text: "3,550" }],
      [{ text: "", attrs: ' vMerge="true"' }, { text: "1,200" }],
    ]);
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents }],
      question: "What does Design cost?",
      query: "Design costs",
      runs: [run("Board pack", [{ name: "costs" }])],
      helper: sumOf("Cost"),
    });
    expect(inputs[0]?.rows.map((row) => row[0])).toEqual(["Design", "Design", "Design"]);
  });
});

describe("the heading shapes since round three, each with its own sum (#448)", () => {
  const restart = (text: string) =>
    `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
  const continued = () => "<w:tcPr><w:vMerge/></w:tcPr><w:p/>";
  const span = (text: string, columns = 2) =>
    `<w:tcPr><w:gridSpan w:val="${columns}"/></w:tcPr>${paragraph(text)}`;
  const word = (name: string, rows: readonly (readonly string[])[]) => () => ({
    name,
    contents: wordFile({ body: table(rows) }),
  });
  const pdf = (at: readonly number[], rows: readonly (readonly string[])[]) => () => ({
    name: "Table.pdf",
    contents: buildPdf([
      {
        lines: ["Table"],
        placed: rows.flatMap((cells, index) =>
          cells.flatMap((text, column) =>
            text ? [{ text, x: at[column] ?? 72, y: 600 - index * 16 }] : [],
          ),
        ),
      },
    ]),
  });
  const lastColumn = (columns: readonly string[]) => columns.at(-1) ?? "";
  const yearColumn = (columns: readonly string[]) => {
    const named = columns.find((column) => column.includes("2023"));
    if (!named) throw new Error(`No 2023 column: ${columns.join(", ")}`);
    return named;
  };
  const cases = [
    {
      name: "a year under a units heading (round 3)",
      query: "Plant",
      file: word("Plants.docx", [
        ["", "2024", "2023"],
        ["Plant A", "2045", "1987"],
        ["Plant B", "1,200", "900"],
        ["Plant C", "800", "600"],
      ]),
      pick: (columns: readonly string[]) => columns[1] ?? "",
      expected: 4045,
    },
    {
      name: "a units row below the headings (round 3)",
      query: "Pumps",
      file: word("Revenue.docx", [
        ["Product", "2024", "2025"],
        ["", "(GBP m)", "(GBP m)"],
        ["Pumps", "1,200", "1,350"],
        ["Fences", "900", "1,050"],
      ]),
      pick: (columns: readonly string[]) => columns[2] ?? "",
      expected: 2400,
    },
    {
      name: "a body row under a merged heading (round 3)",
      query: "Alpha",
      file: word("Sales.docx", [[span("Sales")], ["Alpha", "1,200"], ["Beta", "900"]]),
      pick: (columns: readonly string[]) => columns[1] ?? "",
      expected: 2100,
    },
    {
      name: "a label merged down the rows (round 3)",
      query: "Design",
      file: word("Costs.docx", [
        ["Workstream", "Cost"],
        [restart("Design"), ""],
        [continued(), ""],
        [continued(), "3,550"],
        [continued(), "1,200"],
      ]),
      pick: (columns: readonly string[]) => columns[1] ?? "",
      expected: 4750,
    },
    {
      name: "a label under a blank corner with no figures yet (round 4)",
      query: "Design",
      file: word("Design.docx", [
        ["", "Item", "Cost"],
        [restart("Design"), "Research", ""],
        [continued(), "Workshop", ""],
        [continued(), "Prototype", "1,200"],
        [continued(), "Testing", "2,350"],
      ]),
      pick: (columns: readonly string[]) => columns[2] ?? "",
      keep: (row: readonly AnalysisCell[]) => row[0] === "Design",
      expected: 3550,
    },
    {
      name: "a value beside a label under a blank heading (round 4)",
      query: "Opening stock",
      file: word("Stock.docx", [
        ["Item", "Description", "Units"],
        ["", "Opening stock", "2045"],
        ["Purchases", "Bought", "2,000"],
        ["Closing", "Stock", "1,800"],
      ]),
      pick: (columns: readonly string[]) => columns[2] ?? "",
      expected: 5845,
    },
    {
      name: "a merged-down heading beside a labelled second heading row (round 5)",
      query: "Alpha",
      file: word("Total.docx", [
        ["", restart("Total"), span("Revenue", 2)],
        ["Region", continued(), "2024", "2023"],
        ["Alpha", "A", "1,500", "1,200"],
        ["Beta", "B", "900", "660"],
      ]),
      pick: lastColumn,
      expected: 1860,
    },
    {
      name: "years and a word over a figure column (round 5)",
      query: "Alpha",
      file: word("Change.docx", [
        ["", span("Revenue (EUR k)", 3)],
        ["", "2024", "2023", "Change"],
        ["Alpha", "1,500", "1,200", "9%"],
        ["Beta", "900", "660", "5%"],
      ]),
      pick: yearColumn,
      expected: 1860,
    },
    {
      name: "one blank under an unmerged heading (round 5)",
      query: "Alpha",
      file: word("Margin.docx", [
        ["", span("Revenue", 2), "Margin"],
        ["Region", "2024", "2023", ""],
        ["Alpha", "1,500", "1,200", "12%"],
        ["Beta", "900", "660", "9%"],
      ]),
      pick: yearColumn,
      expected: 1860,
    },
    {
      name: "a deck's years and a word over a figure column (round 5)",
      query: "Alpha",
      file: () => ({
        name: "Board pack.pptx",
        contents: rawDeck("Cash", [
          [
            { text: "" },
            { text: "Revenue (EUR k)", attrs: ' gridSpan="3"' },
            { text: "", attrs: ' hMerge="1"' },
            { text: "", attrs: ' hMerge="1"' },
          ],
          [{ text: "" }, { text: "2024" }, { text: "2023" }, { text: "Change" }],
          [{ text: "Alpha" }, { text: "1,500" }, { text: "1,200" }, { text: "9%" }],
          [{ text: "Beta" }, { text: "900" }, { text: "660" }, { text: "5%" }],
        ]),
      }),
      pick: yearColumn,
      expected: 1860,
    },
    {
      name: "a page's years and a word over a figure column (round 5)",
      query: "Alpha",
      file: pdf(
        [72, 250, 350, 450],
        [
          ["Item", "Revenue", "Revenue", "Revenue"],
          ["", "2024", "2023", "Change"],
          ["Alpha", "1,500", "1,200", "9%"],
          ["Beta", "900", "1,310", "5%"],
        ],
      ),
      pick: yearColumn,
      expected: 2510,
    },
    {
      name: "a deck's merged-down heading beside a labelled second heading row (round 5)",
      query: "Alpha",
      file: () => ({
        name: "Board pack.pptx",
        contents: rawDeck("Cash", [
          [
            { text: "" },
            { text: "Total", attrs: ' rowSpan="2"' },
            { text: "Revenue", attrs: ' gridSpan="2"' },
            { text: "", attrs: ' hMerge="1"' },
          ],
          [
            { text: "Region" },
            { text: "", attrs: ' vMerge="1"' },
            { text: "2024" },
            { text: "2023" },
          ],
          [{ text: "Alpha" }, { text: "A" }, { text: "1,500" }, { text: "1,200" }],
          [{ text: "Beta" }, { text: "B" }, { text: "900" }, { text: "660" }],
        ]),
      }),
      pick: lastColumn,
      expected: 1860,
    },
    {
      name: "a unit word beside a figure in an empty-label row",
      query: "Pumps",
      file: word("Units.docx", [
        ["Item", "Description", "Units"],
        ["", "(GBP m)", "2045"],
        ["Pumps", "Bought", "1,200"],
        ["Fences", "Stock", "900"],
      ]),
      pick: (columns: readonly string[]) => columns[2] ?? "",
      expected: 2100,
    },
    {
      name: "a short unit beside a figure in an empty-label row",
      query: "Pumps",
      file: word("Units.docx", [
        ["Item", "Description", "Units"],
        ["", "t", "2045"],
        ["Pumps", "Bought", "1,200"],
        ["Fences", "Stock", "900"],
      ]),
      pick: (columns: readonly string[]) => columns[2] ?? "",
      expected: 2100,
    },
    {
      name: "a currency symbol beside a figure in an empty-label row",
      query: "Pumps",
      file: word("Units.docx", [
        ["Item", "Description", "Units"],
        ["", "£/kg", "2045"],
        ["Pumps", "Bought", "1,200"],
        ["Fences", "Stock", "900"],
      ]),
      pick: (columns: readonly string[]) => columns[2] ?? "",
      expected: 2100,
    },
  ];
  test.each(cases)("$name sums $expected", async ({ file, query, pick, keep, expected }) => {
    const document = file();
    const { analyses } = await ask({
      files: [document],
      question: "Total the column.",
      query,
      runs: [run(document.name.replace(/\.[^.]+$/, ""), [{ name: "table" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        const column = pick(input.columns);
        return { output: { results: [figureOf(input, column, "sum", keep)] } };
      },
    });
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: expected }]);
  });
});

describe("a merge that starts in a second heading row (#448)", () => {
  test("doesn't repeat into the body in Word", async () => {
    const restart = (text: string) =>
      `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
    const continued = () => "<w:tcPr><w:vMerge/></w:tcPr><w:p/>";
    const span = (text: string) => `<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${paragraph(text)}`;
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(4)}</w:tblGrid>${[
      `<w:tr>${tc("")}${span("Revenue")}<w:tc>${paragraph("Margin")}</w:tc></w:tr>`,
      `<w:tr>${tc("Region")}<w:tc>${restart("Design")}</w:tc>${tc("2024")}<w:tc/></w:tr>`,
      `<w:tr>${tc("Alpha")}<w:tc>${continued()}</w:tc>${tc("1,500")}${tc("12%")}</w:tr>`,
      `<w:tr>${tc("Beta")}<w:tc>${continued()}</w:tc>${tc("900")}${tc("9%")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { inputs } = await ask({
      files: [{ name: "Revenue.docx", contents: wordFile({ body: grid }) }],
      question: "Total the 2024 column.",
      query: "Alpha Beta",
      runs: [run("Revenue", [{ name: "revenue" }])],
      helper: sumOf("2024"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Alpha", null, 1500, 0.12]);
  });

  test("doesn't repeat into the body in a deck", async () => {
    const contents = rawDeck("Revenue", [
      [
        { text: "" },
        { text: "Revenue", attrs: ' gridSpan="2"' },
        { text: "", attrs: ' hMerge="1"' },
        { text: "Margin" },
      ],
      [
        { text: "Region" },
        { text: "Design", attrs: ' rowSpan="2"' },
        { text: "2024" },
        { text: "" },
      ],
      [{ text: "Alpha" }, { text: "", attrs: ' vMerge="1"' }, { text: "1,500" }, { text: "12%" }],
      [{ text: "Beta" }, { text: "", attrs: ' vMerge="1"' }, { text: "900" }, { text: "9%" }],
    ]);
    const { inputs } = await ask({
      files: [{ name: "Board pack.pptx", contents }],
      question: "Total the 2024 column.",
      query: "Alpha Beta",
      runs: [run("Board pack", [{ name: "revenue" }])],
      helper: sumOf("2024"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Alpha", null, 1500, 0.12]);
  });
});

describe("the heading matrix (#448)", () => {
  const span = (text: string, columns = 2) =>
    `<w:tcPr><w:gridSpan w:val="${columns}"/></w:tcPr>${paragraph(text)}`;
  const cases: { name: string; rows: (readonly string[])[] }[] = [];
  for (const headings of [2, 3])
    for (const corner of ["blank", "labelled"])
      for (const spanned of [false, true])
        for (const kind of ["years", "placeholder"])
          for (const body of ["labelled", "blank"])
            cases.push({
              name: `${headings} heading rows, ${corner} corner, ${spanned ? "a span" : "no span"}, ${kind}, ${body} body`,
              rows: [
                corner === "blank"
                  ? [
                      "",
                      ...(spanned ? [span("Revenue"), "Margin"] : ["Revenue", "Revenue", "Margin"]),
                    ]
                  : [
                      "Item",
                      ...(spanned ? [span("Revenue"), "Margin"] : ["Revenue", "Revenue", "Margin"]),
                    ],
                kind === "years" ? ["", "2024", "2023", "Change"] : ["", "2024", "2023", "n/a"],
                ...(headings === 3 ? [["", "t", "t", "%"]] : []),
                [body === "labelled" ? "Alpha" : "", "1,500", "1,200", "12%"],
                ["Beta", "900", "660", "9%"],
              ],
            });
  test.each(cases)("$name sums 1860", async ({ rows }) => {
    const { analyses } = await ask({
      files: [{ name: "Matrix.docx", contents: wordFile({ body: table(rows) }) }],
      question: "Total the 2023 column.",
      query: "Alpha Beta",
      runs: [run("Matrix", [{ name: "matrix" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        const column = input.columns.find((name) => name.includes("2023"));
        if (!column) throw new Error(`No 2023 column: ${input.columns.join(", ")}`);
        return { output: { results: [figureOf(input, column, "sum")] } };
      },
    });
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 1860 }]);
  });
});

describe("the heading matrix in decks and pages (#448)", () => {
  type Cell = { text: string; attrs?: string };
  const deckRows = (
    headings: number,
    corner: string,
    spanned: boolean,
    kind: string,
    body: string,
  ) => {
    const first: Cell[] = corner === "blank" ? [{ text: "" }] : [{ text: "Item" }];
    if (spanned) {
      first.push({ text: "Revenue", attrs: ' gridSpan="2"' }, { text: "", attrs: ' hMerge="1"' });
    } else {
      first.push({ text: "Revenue" }, { text: "Revenue" });
    }
    first.push({ text: "Margin" });
    return [
      first,
      [
        { text: "" },
        { text: "2024" },
        { text: "2023" },
        { text: kind === "years" ? "Change" : "n/a" },
      ],
      ...(headings === 3
        ? [[{ text: "" }, { text: "t" }, { text: "t" }, { text: "%" }] as Cell[]]
        : []),
      [
        { text: body === "labelled" ? "Alpha" : "" },
        { text: "1,500" },
        { text: "1,200" },
        { text: "12%" },
      ],
      [{ text: "Beta" }, { text: "900" }, { text: "660" }, { text: "9%" }],
    ];
  };
  type Built = { name: string; contents: Uint8Array };
  const cases: { name: string; file: () => Built }[] = [];
  for (const headings of [2, 3])
    for (const corner of ["blank", "labelled"])
      for (const spanned of [false, true])
        for (const kind of ["years", "placeholder"])
          for (const body of ["labelled", "blank"]) {
            const suffix = `${headings} heading rows, ${corner} corner, ${spanned ? "a span" : "no span"}, ${kind}, ${body} body`;
            const deck = deckRows(headings, corner, spanned, kind, body);
            cases.push({
              name: `deck: ${suffix}`,
              file: () => ({ name: "Matrix.pptx", contents: rawDeck("Matrix", deck) }),
            });
          }
  test.each(cases)("$name sums 1860", async ({ file }) => {
    const document = file();
    const { analyses } = await ask({
      files: [document],
      question: "Total the 2023 column.",
      query: "Alpha Beta",
      runs: [run("Matrix", [{ name: "matrix" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        const column = input.columns.find((each) => each.includes("2023"));
        if (!column) throw new Error(`No 2023 column: ${input.columns.join(", ")}`);
        return { output: { results: [figureOf(input, column, "sum")] } };
      },
    });
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 1860 }]);
  });
});

describe("the page heading matrix (#448)", () => {
  type Cell = { text: string; x: number; y: number; width?: number };
  const cases: { name: string; body: string; placed: Cell[] }[] = [];
  for (const headings of [2, 3])
    for (const corner of ["blank", "labelled"])
      for (const spanned of [false, true])
        for (const kind of ["years", "placeholder"])
          for (const body of ["labelled", "blank"]) {
            const at = [72, 250, 350, 450];
            const placed: Cell[] = [];
            const add = (text: string, column: number, row: number, width = 40) => {
              if (text !== "") placed.push({ text, x: at[column] ?? 72, y: 600 - row * 16, width });
            };
            if (corner === "labelled") add("Item", 0, 0);
            if (spanned) add("Revenue", 1, 0, 160);
            else {
              add("Revenue", 1, 0);
              add("Revenue", 2, 0);
            }
            add("Margin", 3, 0);
            add("2024", 1, 1);
            add("2023", 2, 1);
            add(kind === "years" ? "Change" : "n/a", 3, 1, 24);
            const first = headings === 3 ? 3 : 2;
            if (headings === 3) {
              add("t", 1, 2);
              add("t", 2, 2);
              add("%", 3, 2);
            }
            add(body === "labelled" ? "Alpha" : "", 0, first);
            add("1,500", 1, first);
            add("1,200", 2, first);
            add("12%", 3, first);
            add("Beta", 0, first + 1);
            add("900", 1, first + 1);
            add("660", 2, first + 1);
            add("9%", 3, first + 1);
            cases.push({
              name: `${headings} heading rows, ${corner} corner, ${spanned ? "a span" : "no span"}, ${kind}, ${body} body`,
              body,
              placed,
            });
          }
  test.each(cases)("$name", ({ body, placed }) => {
    const items = placed.map((each) => ({
      str: each.text,
      transform: [10, 0, 0, 10, each.x, each.y],
      width: each.width ?? 40,
      height: 10,
    }));
    const tables = pageTables(textLayerRows(items)).tables;
    if (body === "blank") {
      expect(tables).toEqual([]);
      return;
    }
    expect(tables[0]?.rows.map((row) => row[2])).toEqual(["1,200", "660"]);
  });
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

describe("the same table given twice (#448)", { timeout: 60_000 }, () => {
  test("is refused before it runs, so its rows aren't counted twice", async () => {
    const { inputs, reports } = await ask({
      files: [{ name: "Five-year statement.pdf", contents: incomeStatementPdf() }],
      question: "Total the 2025 column.",
      query: "income statement revenue gross profit",
      runs: [
        (passages) => ({
          tool: "run_analysis",
          input: {
            title: "Twice",
            inputs: [
              { name: "first", passage: passageOf(passages, "Five-year statement") },
              { name: "second", passage: passageOf(passages, "Five-year statement") },
            ],
            code: "figure(...)",
          },
        }),
      ],
      helper: () => {
        throw new Error("The run should have been refused before it ran.");
      },
    });
    expect(inputs).toEqual([]);
    expect(reports[0]).toContain('"first" and "second" read the same rows');
    expect(reports[0]).toContain("Every Passage of table 1 reads the whole table: give it once");
  });

  test("two different tables of one Document are both read", async () => {
    const { inputs } = await ask({
      files: [{ name: "Regions.pdf", contents: twoTablesPdf() }],
      question: "Total both tables.",
      query: "revenue by region",
      runs: [
        (passages) => ({
          tool: "run_analysis",
          input: {
            title: "Two",
            inputs: [
              { name: "first", passage: passageOf(passages, "Regions"), table: 1 },
              { name: "second", passage: passageOf(passages, "Regions"), table: 2 },
            ],
            code: "x",
          },
        }),
      ],
      helper: () => ({}),
    });
    expect(inputs).toHaveLength(2);
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
    ["Five-year statement.pdf", () => incomeStatementPdf()],
    [
      "Budget.docx",
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
      () =>
        deck("Results", [
          ["Region", "Orders"],
          ["North", "12"],
          ["South", "30"],
        ]),
    ],
  ])("are read again at startup, so %s gains its table", async (name, contents) => {
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
        "SELECT label FROM document_pages WHERE document_id = ? AND deleted_at IS NULL AND label LIKE '%\"tables\":[%'",
        [document?.id ?? ""],
      ).length;
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = 22");
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

/** A PDF with enough text to be built into more than one Passage. */
function longLedgerPdf(): Uint8Array {
  return buildPdf(
    Array.from({ length: 3 }, (_, page) => ({
      lines: Array.from({ length: 30 }, (_, at) =>
        [
          `Entry ${page * 30 + at + 1}: the northern depot recorded freight charges of`,
          `1,2${String(10 + at)} pounds for the period, against the budget set at the`,
          "start of the year for the routes it runs.",
        ].join(" "),
      ),
    })),
  );
}

describe("a PDF read before its tables were kept (#448)", { timeout: 60_000 }, () => {
  test("keeps the Passages it had, their windows an older build chose", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const sources = await createTempDataFolder();
    const [document] = await addAndProcess(first, [
      await writeSourceFile(sources, "Depot ledger.pdf", longLedgerPdf()),
    ]);
    const id = document?.id ?? "";
    await first.close();
    const pages = queryDatabase<{ text: string }>(
      dataDir,
      "SELECT text FROM document_pages WHERE document_id = ? AND deleted_at IS NULL ORDER BY page",
      [id],
    );
    const whole = pages
      .map(({ text }) => text.trim())
      .filter((text) => text !== "")
      .join("\n\n");
    // As a build before this one left it: one wider window over the same text.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const at = new Date().toISOString();
      db.run(
        "UPDATE passages SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND position > 0",
        [at, at, id],
      );
      db.run("UPDATE passages SET text = ? WHERE document_id = ? AND position = 0", [whole, id]);
      db.run("UPDATE documents SET processing_version = 22 WHERE id = ?", [id]);
    } finally {
      db.close();
    }
    const again = startCore(dataDir);
    const [read] = await waitForProcessing(again, [id]);
    expect(read?.status).toBe("ready");
    expect(
      queryDatabase<{ text: string }>(
        dataDir,
        "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
        [id],
      ).map((row) => row.text),
    ).toEqual([whole]);
    await again.close();
  });
});

const sumOf =
  (column: string) =>
  (job: AnalysisJob): FakeAnswer => {
    const [input] = job.inputs;
    if (input?.kind !== "table") throw new Error("No table.");
    return { output: { results: [figureOf(input, column, "sum")] } };
  };

describe("a table named as null (#448)", { timeout: 60_000 }, () => {
  test("is the Passage's only table, as when the field is left out", async () => {
    const { inputs } = await ask({
      files: [{ name: "Five-year statement.pdf", contents: incomeStatementPdf() }],
      question: "Total the 2025 column.",
      query: "income statement revenue gross profit",
      runs: [run("Five-year statement", [{ name: "pnl", table: null }])],
      helper: sumOf("2025"),
    });
    expect(inputs[0]?.columns).toEqual(["A", "2021", "2022", "2023", "2024", "2025"]);
  });
});

describe("a Word table's own layout (#448)", { timeout: 60_000 }, () => {
  test("a footnote mark Word sets raised after a number isn't a digit of it", async () => {
    const raised = (text: string) =>
      `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${text}</w:t></w:r>`;
    const cell = (amount: string, mark: string) =>
      `<w:p><w:r><w:t>${amount}</w:t></w:r>${raised(mark)}</w:p>`;
    const { analyses, inputs, reports } = await ask({
      files: [
        {
          name: "Grants.docx",
          contents: wordFile({
            body: table([
              ["Supplier", "Amount"],
              ["Hollin Pumps", cell("1,240.50", "1")],
              ["Garth Fencing", "3,980.00"],
              ["Tarn Electrical", cell("615.25", "2")],
            ]),
          }),
        },
      ],
      question: "Total the amounts.",
      query: "Hollin Pumps Garth Fencing",
      runs: [run("Grants", [{ name: "grants" }])],
      helper: sumOf("Amount"),
    });
    expect(column(inputs[0], "Amount")).toEqual([1240.5, 3980, 615.25]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 5835.75 }]);
    expect(reports[0]).toContain("2 cells have a footnote mark after their numbers");
  });

  test("a row that starts further along the grid keeps its cells under their headings", async () => {
    const before = (columns: number, cells: string) =>
      `<w:tr><w:trPr><w:gridBefore w:val="${columns}"/></w:trPr>${cells}</w:tr>`;
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(3)}</w:tblGrid>${[
      `<w:tr>${tc("Workstream")}${tc("Item")}${tc("Cost")}</w:tr>`,
      `<w:tr>${tc("Design")}${tc("Surveys")}${tc("3,550")}</w:tr>`,
      before(1, `${tc("Joinery")}${tc("900")}`),
    ].join("")}</w:tbl>`;
    const { analyses, inputs } = await ask({
      files: [{ name: "Costs.docx", contents: wordFile({ body: grid }) }],
      question: "Total the costs.",
      query: "Surveys Joinery",
      runs: [run("Costs", [{ name: "costs" }])],
      helper: sumOf("Cost"),
    });
    expect(inputs[0]?.rows).toEqual([
      ["Design", "Surveys", 3550],
      [null, "Joinery", 900],
    ]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 4450 }]);
  });

  test("a heading over two columns in the only heading row names both", async () => {
    const span = (text: string) => `<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${paragraph(text)}`;
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(3)}</w:tblGrid>${[
      `<w:tr><w:tc>${paragraph("Region")}</w:tc><w:tc>${span("Cost (GBP)")}</w:tc></w:tr>`,
      `<w:tr>${tc("North")}${tc("1,200")}${tc("1,100")}</w:tr>`,
      `<w:tr>${tc("South")}${tc("800")}${tc("760")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { inputs, reports } = await ask({
      files: [{ name: "Costs.docx", contents: wordFile({ body: grid }) }],
      question: "Which columns hold the costs?",
      query: "Cost North South",
      runs: [run("Costs", [{ name: "costs" }])],
      helper: () => ({}),
    });
    expect(inputs[0]?.columns).toEqual(["Region", "Cost (GBP)", "Cost (GBP) (2)"]);
    expect(inputs[0]?.rows).toEqual([
      ["North", 1200, 1100],
      ["South", 800, 760],
    ]);
    expect(reports[0]).toContain("table 1 (section 1), A1:C3: 2 rows × 3 columns");
  });

  test("a footnote mark after a full-width number is left out of it", async () => {
    const { analyses, inputs, reports } = await ask({
      files: [
        {
          name: "Amounts.docx",
          contents: wordFile({
            body: table([
              ["供应商", "金额"],
              ["水泵", "１，２００*"],
              ["围栏", "１，２００¹"],
            ]),
          }),
        },
      ],
      question: "把金额加起来。",
      query: "水泵 围栏",
      runs: [run("Amounts", [{ name: "amounts" }])],
      helper: sumOf("金额"),
    });
    expect(column(inputs[0], "金额")).toEqual([1200, 1200]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 2400 }]);
    expect(reports[0]).toContain("2 cells have a footnote mark after their numbers");
  });

  test("a row with gridAfter keeps a tab for its empty grid columns", async () => {
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(3)}</w:tblGrid>${[
      `<w:tr>${tc("Item")}${tc("Cost")}${tc("Notes")}</w:tr>`,
      `<w:tr><w:trPr><w:gridAfter w:val="1"/></w:trPr>${tc("Widget")}${tc("1,200")}</w:tr>`,
      `<w:tr>${tc("Gadget")}${tc("900")}${tc("seen")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const sources = await createTempDataFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Costs.docx", wordFile({ body: grid })),
    ]);
    await core.close();
    const texts = queryDatabase<{ text: string }>(
      dataDir,
      "SELECT text FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
      [document?.id ?? ""],
    ).map((page) => page.text);
    expect(texts.some((text) => text.split("\n").includes("Widget\t1,200\t"))).toBe(true);
  });
});

/** Two pages, each a table headed the same under a caption that differs only by its numbers. */
function twoTablesPdf(): Uint8Array {
  const page = (
    caption: string,
    rows: readonly (readonly [string, string, string])[],
  ): PdfPage => ({
    lines: [caption],
    placed: [["Region", "2025", "2024"], ...rows].flatMap((cells, index) =>
      cells.map((text, column) => ({ text, x: [72, 300, 380][column] ?? 72, y: 700 - index * 16 })),
    ),
  });
  return buildPdf([
    page("Table 4. Revenue by region, 2024 (GBP thousands)", [
      ["North", "1,200", "1,100"],
      ["South", "800", "760"],
      ["West", "640", "600"],
    ]),
    page("Table 5. Revenue by region, 2025 (GBP thousands)", [
      ["North", "420", "400"],
      ["South", "310", "300"],
      ["West", "250", "240"],
    ]),
  ]);
}

describe("tables on pages that follow each other (#448)", { timeout: 60_000 }, () => {
  test("two captioned tables headed the same stay two tables", async () => {
    const { analyses, inputs } = await ask({
      files: [{ name: "Regions.pdf", contents: twoTablesPdf() }],
      question: "Total the second table's 2025 column.",
      query: "revenue by region",
      runs: [run("Regions", [{ name: "costs", table: 2 }])],
      helper: sumOf("2025"),
    });
    expect(column(inputs[0], "2025")).toEqual([420, 310, 250]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 980 }]);
    const [range] = analyses[0]?.inputs ?? [];
    expect(range?.kind === "range" && range.citation.pageFrom).toBe(2);
  });

  test("a table whose first column is years is still a table", async () => {
    const years = buildPdf([
      {
        lines: ["Ten-year record"],
        placed: [
          ["Year", "Revenue", "Profit"],
          ["2021", "1,200", "300"],
          ["2022", "1,350", "320"],
          ["2023", "1,410", "345"],
        ].flatMap((cells, index) =>
          cells.map((text, column) => ({
            text,
            x: [72, 220, 320][column] ?? 72,
            y: 700 - index * 16,
          })),
        ),
      },
    ]);
    const { analyses, inputs } = await ask({
      files: [{ name: "Record.pdf", contents: years }],
      question: "Total the profit.",
      query: "ten-year record revenue profit",
      runs: [run("Record", [{ name: "record" }])],
      helper: sumOf("Profit"),
    });
    expect(inputs[0]?.columns).toEqual(["Year", "Revenue", "Profit"]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 965 }]);
  });
});

describe("a scan whose recognized text is the PDF's own text layer (#448)", {
  timeout: 60_000,
}, () => {
  test("gives no figure worked out again, as a scan read here doesn't", async () => {
    const searchable = buildPdf([
      {
        scan: readFileSync(join(SCANS, "table.jpg")),
        invisibleText: true,
        lines: ["Table 3. Revenue by product line (USD thousands), as recognized by the scanner"],
        placed: [
          ["Product line", "2024", "2025"],
          ["Freight software", "4,812", "5,330"],
          ["Warehouse sensors", "2,147", "1,985"],
          ["Fleet analytics", "3,906", "4,412"],
          ["Support contracts", "1,268", "1,301"],
        ].flatMap((cells, index) =>
          cells.map((text, column) => ({
            text,
            x: [72, 300, 380][column] ?? 72,
            y: 700 - index * 16,
          })),
        ),
      },
    ]);
    const { analyses, inputs, reports } = await ask({
      files: [{ name: "Searchable scan.pdf", contents: searchable }],
      question: "Add up the 2025 column.",
      query: "revenue by product line",
      runs: [run("Searchable scan", [{ name: "lines" }])],
      helper: sumOf("2025"),
    });
    expect(inputs[0]?.readFromScan).toBe(true);
    expect(column(inputs[0], "2025")).toEqual([5330, 1985, 4412, 1301]);
    expect(checkOf(analyses[0])).toEqual([
      { kind: "unchecked", reason: expect.stringContaining("read from a scan") },
    ]);
    expect(reports[0]).toContain("Its numbers were read from a scan by text recognition");
  });
});

describe("a kept scanned page whose new read finds no table (#448)", {
  timeout: 60_000,
}, () => {
  test("drops the table the earlier read kept", async () => {
    const dataDir = await createTempDataFolder();
    const options = {
      textRecognitionModelSource: NO_MODEL_FILES,
      textRecognizer: createFakeTextRecognizer({ script: scanScript() }),
    };
    const core = startCore(dataDir, options);
    const sources = await createTempDataFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Scanned revenue tables.pdf",
        buildPdf([{ scan: readFileSync(join(SCANS, "table.jpg")) }]),
      ),
    ]);
    const id = document?.id ?? "";
    const tablesStored = () =>
      queryDatabase<{ label: string | null }>(
        dataDir,
        "SELECT label FROM document_pages WHERE document_id = ? AND deleted_at IS NULL AND label LIKE '%\"tables\":[%'",
        [id],
      ).length;
    expect(tablesStored()).toBe(1);
    const checked = await core.recheckCitation({
      mindId: null,
      documentId: id,
      pageFrom: 1,
      pageTo: 1,
      quote: "Table 3. Revenue by product line (USD thousands)",
    });
    expect(checked).toMatchObject({ check: "found" });
    await core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = 22 WHERE id = ?", [id]);
      db.run("UPDATE document_pages SET text = ? WHERE document_id = ?", [
        "Scanned revenue tables",
        id,
      ]);
    } finally {
      db.close();
    }
    const again = startCore(dataDir, {
      textRecognitionModelSource: NO_MODEL_FILES,
      textRecognizer: createFakeTextRecognizer({
        script: { pages: { 1: { fail: "The kept scan must not be read again." } } },
      }),
    });
    const [read] = await waitForProcessing(again, [id]);
    expect(read?.status).toBe("ready");
    expect(tablesStored()).toBe(0);
    await again.close();
  });
});

describe("the review's table cases (#448)", { timeout: 60_000 }, () => {
  test("an unheaded column isn't named by the heading on its left", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Costs.docx",
          contents: wordFile({
            body: table([
              ["Item", "2024", ""],
              ["Pumps", "1,200", "5%"],
              ["Fences", "900", "7%"],
            ]),
          }),
        },
      ],
      question: "What are the amounts?",
      query: "Pumps Fences",
      runs: [run("Costs", [{ name: "costs" }])],
      helper: () => ({}),
    });
    expect(inputs[0]?.columns).toEqual(["Item", "2024", "C"]);
  });

  test("a heading row of dotted dates names the columns", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Dated.docx",
          contents: wordFile({
            body: table([
              ["Date", "31.12.2024", "2024.12.31"],
              ["Pumps", "1,200", "900"],
              ["Fences", "800", "700"],
            ]),
          }),
        },
      ],
      question: "Total the dated columns.",
      query: "Pumps dated",
      runs: [run("Dated", [{ name: "dated" }])],
      helper: () => ({}),
    });
    expect(inputs[0]?.columns).toEqual(["Date", "31.12.2024", "2024.12.31"]);
  });

  test("a first body row that isn't a figure stays a row", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Products.docx",
          contents: wordFile({
            body: table([
              ["Product", "2024"],
              ["Alpha", "—"],
              ["Beta", "1,200"],
              ["Gamma", "900"],
            ]),
          }),
        },
      ],
      question: "Total the 2024 column.",
      query: "Alpha Beta Gamma",
      runs: [run("Products", [{ name: "products" }])],
      helper: sumOf("2024"),
    });
    expect(inputs[0]?.rows).toEqual([
      ["Alpha", "—"],
      ["Beta", 1200],
      ["Gamma", 900],
    ]);
  });

  test("a first body row of a PDF table stays a row", async () => {
    const at = [72, 300] as const;
    const placed = [
      ["Product", "2024"],
      ["Alpha", "—"],
      ["Beta", "1,200"],
      ["Gamma", "900"],
    ].flatMap((cells, index) =>
      cells.map((text, column) => ({ text, x: at[column] ?? 72, y: 700 - index * 16 })),
    );
    const { inputs } = await ask({
      files: [{ name: "Products.pdf", contents: buildPdf([{ lines: ["Products"], placed }]) }],
      question: "Total the 2024 column.",
      query: "Products Alpha Beta Gamma",
      runs: [run("Products", [{ name: "products" }])],
      helper: sumOf("2024"),
    });
    expect(inputs[0]?.rows).toEqual([
      ["Alpha", "—"],
      ["Beta", 1200],
      ["Gamma", 900],
    ]);
  });

  test("a PDF's raised footnote digit doesn't join the number", () => {
    const rows = textLayerRows([
      { str: "1,240.50", transform: [10, 0, 0, 10, 300, 684], width: 44, height: 10 },
      { str: "1", transform: [7, 0, 0, 7, 344, 687], width: 3, height: 7 },
    ]);
    expect(rows[0]?.fragments[0]?.text).toBe("1,240.50¹");
  });

  test("a PDF's raised footnote digit at the row's own size doesn't join the number", () => {
    const rows = textLayerRows([
      { str: "1,240.50", transform: [10, 0, 0, 10, 300, 684], width: 44, height: 10 },
      { str: "1", transform: [10, 0, 0, 10, 344, 687], width: 4, height: 10 },
    ]);
    expect(rows[0]?.fragments[0]?.text).toBe("1,240.50¹");
  });

  test("a Word superscript set by a style or a position doesn't join the number", async () => {
    const style = (id: string, rPr: string) =>
      `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr>${rPr}</w:rPr></w:style>`;
    const based = (id: string, parent: string) =>
      `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="${parent}"/></w:style>`;
    const styles = [
      STYLES,
      style("Sup", '<w:vertAlign w:val="superscript"/>'),
      style("High", '<w:position w:val="6"/>'),
      based("Sup2", "Sup"),
    ].join("");
    const cell = (amount: string, mark: string) =>
      `<w:r><w:t>${amount}</w:t></w:r><w:r><w:rPr><w:rStyle w:val="${mark}"/></w:rPr><w:t>1</w:t></w:r>`;
    const { analyses, inputs } = await ask({
      files: [
        {
          name: "Grants.docx",
          contents: wordFile({
            styles,
            body: table([
              ["Supplier", "Amount"],
              ["Hollin Pumps", cell("1,240.50", "Sup")],
              ["Tarn Electrical", cell("615.25", "High")],
              ["Mere Lane Haulage", cell("2,075.75", "Sup2")],
            ]),
          }),
        },
      ],
      question: "Total the amounts.",
      query: "Hollin Pumps Tarn Electrical Mere Lane",
      runs: [run("Grants", [{ name: "grants" }])],
      helper: sumOf("Amount"),
    });
    expect(column(inputs[0], "Amount")).toEqual([1240.5, 615.25, 2075.75]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 3931.5 }]);
  });

  test("a run's own raise or lowering doesn't join the number", async () => {
    const mark = (amount: string, position: number) =>
      `<w:r><w:t>${amount}</w:t></w:r><w:r><w:rPr><w:position w:val="${position}"/></w:rPr><w:t>1</w:t></w:r>`;
    const { inputs } = await ask({
      files: [
        {
          name: "Grants.docx",
          contents: wordFile({
            body: table([
              ["Supplier", "Amount"],
              ["Hollin Pumps", mark("1,240.50", 6)],
              ["Garth Fencing", "3,980.00"],
              ["Tarn Electrical", mark("615.25", -6)],
            ]),
          }),
        },
      ],
      question: "Total the amounts.",
      query: "Hollin Pumps Garth Fencing Tarn Electrical",
      runs: [run("Grants", [{ name: "grants" }])],
      helper: sumOf("Amount"),
    });
    expect(column(inputs[0], "Amount")).toEqual([1240.5, 3980, "615.25₁"]);
  });

  test("a units row above the headings doesn't hide the first body row", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Revenue.docx",
          contents: wordFile({
            body: table([
              ["", "(GBP m)", "(GBP m)"],
              ["Product", "2024", "2025"],
              ["Pumps", "1,200", "1,350"],
              ["Fences", "900", "1,050"],
            ]),
          }),
        },
      ],
      question: "Total the 2025 column.",
      query: "Pumps Fences",
      runs: [run("Revenue", [{ name: "revenue" }])],
      helper: sumOf("2025"),
    });
    expect(inputs[0]?.columns[0]).toBe("Product");
    expect(inputs[0]?.columns.slice(1)).toEqual(["(GBP m) 2024", "(GBP m) 2025"]);
    expect(inputs[0]?.rows).toEqual([
      ["Pumps", 1200, 1350],
      ["Fences", 900, 1050],
    ]);
  });

  test("a units row below the headings still heads the columns", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Revenue.docx",
          contents: wordFile({
            body: table([
              ["Product", "2024", "2025"],
              ["", "(GBP m)", "(GBP m)"],
              ["Pumps", "1,200", "1,350"],
              ["Fences", "900", "1,050"],
            ]),
          }),
        },
      ],
      question: "Total the 2025 column.",
      query: "Pumps Fences",
      runs: [run("Revenue", [{ name: "revenue" }])],
      helper: sumOf("2025 (GBP m)"),
    });
    expect(inputs[0]?.columns).toEqual(["Product", "2024 (GBP m)", "2025 (GBP m)"]);
    expect(inputs[0]?.rows).toEqual([
      ["Pumps", 1200, 1350],
      ["Fences", 900, 1050],
    ]);
  });

  test("a first body row under a year heading keeps its label", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Output.docx",
          contents: wordFile({
            body: table([
              ["", "2024", "2023"],
              ["Plant A", "2045", "1987"],
              ["Plant B", "1,200", "900"],
              ["Plant C", "800", "600"],
            ]),
          }),
        },
      ],
      question: "Total the 2024 column.",
      query: "Plant",
      runs: [run("Output", [{ name: "output" }])],
      helper: sumOf("2024"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Plant A", 2045, 1987]);
    expect(inputs[0]?.rows).toHaveLength(3);
  });

  test("a Word first body row under a labelled heading keeps its label", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Output.docx",
          contents: wordFile({
            body: table([
              ["Plant", "2024", "2023"],
              ["", "t", "t"],
              ["Alpha", "2045", "1987"],
              ["Beta", "1,200", "900"],
              ["Gamma", "800", "600"],
            ]),
          }),
        },
      ],
      question: "Total the 2024 column.",
      query: "Alpha Beta Gamma",
      runs: [run("Output", [{ name: "output" }])],
      helper: sumOf("2024 t"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Alpha", 2045, 1987]);
  });

  test("a labelled row with a blank under a heading is the body's", async () => {
    const restart = (text: string) =>
      `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
    const continued = () => "<w:tcPr><w:vMerge/></w:tcPr><w:p/>";
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(3)}</w:tblGrid>${[
      `<w:tr>${tc("")}${tc("Item")}${tc("Cost")}</w:tr>`,
      `<w:tr><w:tc>${restart("Design")}</w:tc>${tc("Research")}<w:tc/></w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("Workshop")}<w:tc/></w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("Prototype")}${tc("1,200")}</w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("Testing")}${tc("2,350")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { analyses, inputs } = await ask({
      files: [{ name: "Design.docx", contents: wordFile({ body: grid }) }],
      question: "What did Design cost?",
      query: "Design costs",
      runs: [run("Design", [{ name: "design" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        return {
          output: { results: [figureOf(input, "Cost", "sum", (row) => row[0] === "Design")] },
        };
      },
    });
    expect(inputs[0]?.rows).toEqual([
      ["Design", "Research", null],
      ["Design", "Workshop", null],
      ["Design", "Prototype", 1200],
      ["Design", "Testing", 2350],
    ]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 3550 }]);
  });

  test("a first body row that says a value beside a label is not a heading", async () => {
    const { analyses, inputs } = await ask({
      files: [
        {
          name: "Stock.docx",
          contents: wordFile({
            body: table([
              ["Item", "Description", "Units"],
              ["", "Opening stock", "2045"],
              ["Purchases", "Bought", "2,000"],
              ["Closing", "Stock", "1,800"],
            ]),
          }),
        },
      ],
      question: "Total the units.",
      query: "stock purchases closing",
      runs: [run("Stock", [{ name: "stock" }])],
      helper: sumOf("Units"),
    });
    expect(inputs[0]?.rows[0]).toEqual([null, "Opening stock", 2045]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 5845 }]);
  });

  test("a placeholder in a body column doesn't make it a text column", async () => {
    const { analyses } = await ask({
      files: [
        {
          name: "Output.docx",
          contents: wordFile({
            body: table([
              ["Item", "2024", "2023"],
              ["", "n/a", "2045"],
              ["Alpha", "n/a", "1,200"],
              ["Beta", "n/a", "660"],
            ]),
          }),
        },
      ],
      question: "Total the 2023 column.",
      query: "Alpha Beta",
      runs: [run("Output", [{ name: "output" }])],
      helper: (job) => {
        const [input] = job.inputs;
        if (input?.kind !== "table") throw new Error("No table.");
        const column = input.columns.find((name) => name.includes("2023"));
        if (!column) throw new Error(`No 2023 column: ${input.columns.join(", ")}`);
        return { output: { results: [figureOf(input, column, "sum")] } };
      },
    });
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 1860 }]);
  });

  test("a first body row with placeholders under a units row stays a row", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Output.docx",
          contents: wordFile({
            body: table([
              ["", "(GBP m)", "(GBP m)"],
              ["Alpha", "—", "—"],
              ["Beta", "1,200", "1,000"],
              ["Gamma", "900", "700"],
            ]),
          }),
        },
      ],
      question: "Total the second column.",
      query: "Alpha Beta Gamma",
      runs: [run("Output", [{ name: "output" }])],
      helper: sumOf("(GBP m)"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Alpha", "—", "—"]);
  });

  test("a PDF first body row under a labelled heading keeps its label", async () => {
    const at = [72, 250, 310];
    const rows = [
      ["Plant", "2024", "2023"],
      ["", "t", "t"],
      ["Alpha", "2045", "1987"],
      ["Beta", "1,200", "900"],
      ["Gamma", "800", "600"],
    ];
    const contents = buildPdf([
      {
        lines: ["Output"],
        placed: rows.flatMap((cells, index) =>
          cells.flatMap((text, column) =>
            text ? [{ text, x: at[column] ?? 72, y: 600 - index * 16 }] : [],
          ),
        ),
      },
    ]);
    const { inputs } = await ask({
      files: [{ name: "Output.pdf", contents }],
      question: "Total the 2024 column.",
      query: "Alpha Beta Gamma",
      runs: [run("Output", [{ name: "output" }])],
      helper: sumOf("2024 t"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Alpha", 2045, 1987]);
    expect(inputs[0]?.rows).toHaveLength(3);
  });

  test("a PDF first body row with placeholders under a units row stays a row", async () => {
    const at = [72, 250, 310];
    const rows = [
      ["", "t", "t"],
      ["Alpha", "—", "—"],
      ["Beta", "1,200", "900"],
      ["Gamma", "800", "600"],
    ];
    const contents = buildPdf([
      {
        lines: ["Output"],
        placed: rows.flatMap((cells, index) =>
          cells.flatMap((text, column) =>
            text ? [{ text, x: at[column] ?? 72, y: 600 - index * 16 }] : [],
          ),
        ),
      },
    ]);
    const { inputs } = await ask({
      files: [{ name: "Output.pdf", contents }],
      question: "Total the second column.",
      query: "Alpha Beta Gamma",
      runs: [run("Output", [{ name: "output" }])],
      helper: sumOf("t"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Alpha", "—", "—"]);
  });

  test("a PDF first body row under a year heading keeps its label", async () => {
    const at = [72, 250, 310];
    const rows = [
      ["", "2024", "2023"],
      ["Alpha", "2045", "1987"],
      ["Beta", "1,200", "900"],
      ["Gamma", "800", "600"],
    ];
    const contents = buildPdf([
      {
        lines: ["Output"],
        placed: rows.flatMap((cells, index) =>
          cells.flatMap((text, column) =>
            text ? [{ text, x: at[column] ?? 72, y: 600 - index * 16 }] : [],
          ),
        ),
      },
    ]);
    const { inputs } = await ask({
      files: [{ name: "Output.pdf", contents }],
      question: "Total the 2024 column.",
      query: "Alpha Beta Gamma",
      runs: [run("Output", [{ name: "output" }])],
      helper: sumOf("2024"),
    });
    expect(inputs[0]?.rows[0]).toEqual(["Alpha", 2045, 1987]);
  });

  test("a PDF row that says a value beside a label is not a heading", () => {
    const at = [72, 250, 310];
    const rows = [
      ["Item", "Description", "Units"],
      ["", "Opening stock", "2045"],
      ["Purchases", "Bought", "2,000"],
      ["Closing", "Stock", "1,800"],
    ];
    const items = rows.flatMap((cells, index) =>
      cells.flatMap((text, column) =>
        text
          ? [
              {
                str: text,
                transform: [10, 0, 0, 10, at[column] ?? 72, 600 - index * 16],
                width: 40,
                height: 10,
              },
            ]
          : [],
      ),
    );
    const [table] = pageTables(textLayerRows(items)).tables;
    expect(table?.headings).toEqual(["Item", "Description", "Units"]);
    expect(table?.rows.map((row) => row[2])).toEqual(["2045", "2,000", "1,800"]);
  });

  test("a PDF labelled row with a blank under a heading is the body's", () => {
    const at = [72, 250, 310];
    const rows = [
      ["", "Description", "Cost"],
      ["Design", "Draft"],
      ["Surveys", "Paid", "1,200"],
      ["Drawings", "Paid", "900"],
    ];
    const items = rows.flatMap((cells, index) =>
      cells.flatMap((text, column) =>
        text
          ? [
              {
                str: text,
                transform: [10, 0, 0, 10, at[column] ?? 72, 600 - index * 16],
                width: 40,
                height: 10,
              },
            ]
          : [],
      ),
    );
    const [table] = pageTables(textLayerRows(items)).tables;
    expect(table?.headings[0]).toBe("");
    expect(table?.rows.map((row) => row[0])).toEqual(["Design", "Surveys", "Drawings"]);
  });

  test("a page's labelled row with a blank under an unmerged heading keeps the years", () => {
    const items = [
      { str: "Revenue", transform: [10, 0, 0, 10, 250, 600], width: 160, height: 10 },
      { str: "Margin", transform: [10, 0, 0, 10, 450, 600], width: 40, height: 10 },
      { str: "Region", transform: [10, 0, 0, 10, 72, 584], width: 40, height: 10 },
      { str: "2024", transform: [10, 0, 0, 10, 250, 584], width: 24, height: 10 },
      { str: "2023", transform: [10, 0, 0, 10, 350, 584], width: 24, height: 10 },
      { str: "Alpha", transform: [10, 0, 0, 10, 72, 568], width: 30, height: 10 },
      { str: "1,500", transform: [10, 0, 0, 10, 250, 568], width: 26, height: 10 },
      { str: "1,200", transform: [10, 0, 0, 10, 350, 568], width: 26, height: 10 },
      { str: "12%", transform: [10, 0, 0, 10, 450, 568], width: 18, height: 10 },
      { str: "Beta", transform: [10, 0, 0, 10, 72, 552], width: 26, height: 10 },
      { str: "900", transform: [10, 0, 0, 10, 250, 552], width: 18, height: 10 },
      { str: "660", transform: [10, 0, 0, 10, 350, 552], width: 18, height: 10 },
      { str: "9%", transform: [10, 0, 0, 10, 450, 552], width: 16, height: 10 },
    ];
    const [table] = pageTables(textLayerRows(items)).tables;
    expect(table?.headings.join(" ")).toContain("2023");
    expect(table?.rows.map((row) => row[2])).toEqual(["1,200", "660"]);
  });

  test("a PDF units row below the headings still heads the columns", async () => {
    const at = [72, 250, 310];
    const rows = [
      ["Product", "2024", "2025"],
      ["", "(GBP m)", "(GBP m)"],
      ["Pumps", "1,200", "1,350"],
      ["Fences", "900", "1,050"],
    ];
    const contents = buildPdf([
      {
        lines: ["Revenue"],
        placed: rows.flatMap((cells, index) =>
          cells.flatMap((text, column) =>
            text ? [{ text, x: at[column] ?? 72, y: 600 - index * 16 }] : [],
          ),
        ),
      },
    ]);
    const { inputs } = await ask({
      files: [{ name: "Revenue.pdf", contents }],
      question: "Total the 2025 column.",
      query: "Pumps Fences",
      runs: [run("Revenue", [{ name: "revenue" }])],
      helper: sumOf("2025 (GBP m)"),
    });
    expect(inputs[0]?.columns).toEqual(["Product", "2024 (GBP m)", "2025 (GBP m)"]);
    expect(inputs[0]?.rows).toEqual([
      ["Pumps", 1200, 1350],
      ["Fences", 900, 1050],
    ]);
  });

  test("a body row under a merged heading keeps its own label", async () => {
    const span = (text: string) => `<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${paragraph(text)}`;
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(2)}</w:tblGrid>${[
      `<w:tr><w:tc>${span("Sales")}</w:tc></w:tr>`,
      `<w:tr>${tc("Alpha")}${tc("1,200")}</w:tr>`,
      `<w:tr>${tc("Beta")}${tc("900")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { inputs } = await ask({
      files: [{ name: "Sales.docx", contents: wordFile({ body: grid }) }],
      question: "Total the sales.",
      query: "Alpha Beta",
      runs: [run("Sales", [{ name: "sales" }])],
      helper: sumOf("Sales"),
    });
    expect(inputs[0]?.rows).toEqual([
      ["Alpha", 1200],
      ["Beta", 900],
    ]);
  });

  test("a merged label repeats under a row with no figure", async () => {
    const restart = (text: string) =>
      `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
    const continued = () => "<w:tcPr><w:vMerge/></w:tcPr><w:p/>";
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(2)}</w:tblGrid>${[
      `<w:tr>${tc("Workstream")}${tc("Cost")}</w:tr>`,
      `<w:tr><w:tc>${restart("Design")}</w:tc><w:tc/></w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("Surveys")}</w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("3,550")}</w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("1,200")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { inputs } = await ask({
      files: [{ name: "Design.docx", contents: wordFile({ body: grid }) }],
      question: "Total Design's costs.",
      query: "Design costs",
      runs: [run("Design", [{ name: "design" }])],
      helper: sumOf("Cost"),
    });
    expect(inputs[0]?.rows.at(-1)?.[0]).toBe("Design");
    expect(inputs[0]?.rows.at(-1)?.[1]).toBe(1200);
    expect(inputs[0]?.rows.map((row) => row[0])).toEqual(["Design", "Design", "Design", "Design"]);
  });

  test("a figure merged down the rows counts once", async () => {
    const restart = (text: string) =>
      `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
    const continued = () => "<w:tcPr><w:vMerge/></w:tcPr><w:p/>";
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(3)}</w:tblGrid>${[
      `<w:tr>${tc("Workstream")}${tc("Item")}${tc("Amount")}</w:tr>`,
      `<w:tr><w:tc>${restart("1,200")}</w:tc>${tc("Surveys")}${tc("3,550")}</w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("Joinery")}${tc("900")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { analyses, inputs } = await ask({
      files: [{ name: "Costs.docx", contents: wordFile({ body: grid }) }],
      question: "Total the costs.",
      query: "Surveys Joinery",
      runs: [run("Costs", [{ name: "costs" }])],
      helper: sumOf("Amount"),
    });
    expect(inputs[0]?.rows).toEqual([
      [1200, "Surveys", 3550],
      [null, "Joinery", 900],
    ]);
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 4450 }]);
  });

  test("a column of English three-decimal numbers isn't read as German thousands", async () => {
    const { inputs } = await ask({
      files: [
        {
          name: "Rates.docx",
          contents: wordFile({
            body: table([
              ["Item", "Rate"],
              ["A", "0.123"],
              ["B", "0.456"],
              ["C", "0.789"],
            ]),
          }),
        },
      ],
      question: "Add up the rates.",
      query: "rates",
      runs: [run("Rates", [{ name: "rates" }])],
      helper: sumOf("Rate"),
    });
    expect(column(inputs[0], "Rate")).toEqual([0.123, 0.456, 0.789]);
  });

  test("a merge in the first row of a table with no headings repeats", async () => {
    const restart = (text: string) =>
      `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
    const continued = () => "<w:tcPr><w:vMerge/></w:tcPr><w:p/>";
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(3)}</w:tblGrid>${[
      `<w:tr><w:tc>${restart("Design")}</w:tc>${tc("Research")}${tc("1,000")}</w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("Prototype")}${tc("1,200")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { inputs } = await ask({
      files: [{ name: "Design.docx", contents: wordFile({ body: grid }) }],
      question: "What did Design cost?",
      query: "Design Research Prototype",
      runs: [run("Design", [{ name: "design" }])],
      helper: () => ({}),
    });
    expect(inputs[0]?.columns).toEqual(["A", "B", "C"]);
    expect(inputs[0]?.rows).toEqual([
      ["Design", "Research", 1000],
      ["Design", "Prototype", 1200],
    ]);
  });

  test("a merge started in a heading row doesn't repeat into the next heading row", async () => {
    const restart = (text: string) =>
      `<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph(text)}`;
    const continued = () => "<w:tcPr><w:vMerge/></w:tcPr><w:p/>";
    const tc = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const grid = `<w:tbl><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(3)}</w:tblGrid>${[
      `<w:tr>${tc("")}${tc("Revenue")}${tc("Revenue")}</w:tr>`,
      `<w:tr><w:tc>${restart("Revenue")}</w:tc>${tc("2024")}${tc("2025")}</w:tr>`,
      `<w:tr><w:tc>${continued()}</w:tc>${tc("H1")}${tc("H2")}</w:tr>`,
      `<w:tr>${tc("North")}${tc("1,200")}${tc("1,100")}</w:tr>`,
      `<w:tr>${tc("South")}${tc("800")}${tc("760")}</w:tr>`,
    ].join("")}</w:tbl>`;
    const { inputs } = await ask({
      files: [{ name: "Revenue.docx", contents: wordFile({ body: grid }) }],
      question: "Total the 2024 column.",
      query: "North South",
      runs: [run("Revenue", [{ name: "revenue" }])],
      helper: sumOf("Revenue 2024 H1"),
    });
    expect(inputs[0]?.columns).toEqual(["Revenue", "Revenue 2024 H1", "Revenue 2025 H2"]);
    expect(inputs[0]?.rows).toEqual([
      ["North", 1200, 1100],
      ["South", 800, 760],
    ]);
  });

  test("a German d.ddd column stays text rather than a thousand times too small", async () => {
    const { analyses, inputs } = await ask({
      files: [
        {
          name: "Beträge.docx",
          contents: wordFile({
            body: table([
              ["Posten", "Betrag"],
              ["A", "1.234"],
              ["B", "850"],
              ["C", "12.345"],
            ]),
          }),
        },
      ],
      question: "Summiere die Beträge.",
      query: "A B C",
      runs: [run("Beträge", [{ name: "betraege" }])],
      helper: sumOf("Betrag"),
    });
    expect(column(inputs[0], "Betrag")).toEqual(["1.234", 850, "12.345"]);
    expect(checkOf(analyses[0])).toEqual([
      { kind: "unchecked", reason: expect.stringContaining("holds text, not numbers") },
    ]);
  });

  test("a born-digital page over a picture keeps its figures checked", async () => {
    const at = [72, 300] as const;
    const tableRows = [
      ["Product", "Amount"],
      ["Pumps", "1,200"],
      ["Fences", "900"],
    ];
    const placed = [
      ...Array.from({ length: 2 }, (_, index) => ({
        text: "Revenue by product line for the period, in thousands of US dollars, prepared for the board and reviewed.",
        x: 72,
        y: 740 - index * 16,
      })),
      ...tableRows.flatMap((cells, index) =>
        cells.map((text, column) => ({ text, x: at[column] ?? 72, y: 700 - index * 16 })),
      ),
    ];
    const { analyses, inputs } = await ask({
      files: [
        {
          name: "Designed report.pdf",
          contents: buildPdf([
            { scan: readFileSync(join(SCANS, "table.jpg")), lines: ["Designed report"], placed },
          ]),
        },
      ],
      question: "Total the amounts.",
      query: "Pumps Fences",
      runs: [run("Designed report", [{ name: "amounts" }])],
      helper: sumOf("Amount"),
    });
    expect(inputs[0]?.readFromScan).toBeUndefined();
    expect(checkOf(analyses[0])).toEqual([{ kind: "same", value: 2100 }]);
  });
});

describe("a scanned page whose read fails (#448)", { timeout: 60_000 }, () => {
  test("keeps no table from its text layer", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      textRecognitionModelSource: NO_MODEL_FILES,
      textRecognizer: createFakeTextRecognizer({
        script: { pages: { 1: { fail: "The recognizer couldn't read the page." } } },
      }),
    });
    const at = [72, 300] as const;
    const placed = [
      ["Item", "Amount"],
      ["Pumps", "1,200"],
      ["Fences", "900"],
    ].flatMap((cells, index) =>
      cells.map((text, column) => ({ text, x: at[column] ?? 72, y: 700 - index * 16 })),
    );
    const sources = await createTempDataFolder();
    const [control, document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Readable table.pdf", buildPdf([{ placed }])),
      await writeSourceFile(
        sources,
        "Unread scan.pdf",
        buildPdf([{ scan: readFileSync(join(SCANS, "table.jpg")), placed }]),
      ),
    ]);
    await core.close();
    const labelsOf = (id: string) =>
      queryDatabase<{ label: string | null }>(
        dataDir,
        "SELECT label FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
        [id],
      ).map((page) => page.label ?? "");
    // The same text layer's table is found on a page that has no scan, so the scan's own read is
    // what removes it.
    expect(labelsOf(control?.id ?? "").some((label) => label.includes('"tables":['))).toBe(true);
    const labels = labelsOf(document?.id ?? "");
    expect(labels.some((label) => label.includes('"unread":true'))).toBe(true);
    expect(labels.some((label) => label.includes('"tables":['))).toBe(false);
  });
});

describe("a table with more rows than an Analysis reads (#448)", { timeout: 60_000 }, () => {
  test("is cut at the Analysis's limit, not thrown on", () => {
    const rows = [
      ["Item", "Amount"],
      ...Array.from({ length: 200_000 }, (_, at) => [`Item ${at}`, String(at)]),
    ];
    expect(cellTable(rows)?.rows).toHaveLength(200_000);
    const cells = new Map(rows.map((row, index) => [index + 1, row]));
    const read = readRange(cells, { firstRow: 1, lastRow: null, firstColumn: 0, lastColumn: null });
    expect(read?.rows).toHaveLength(20_000);
    expect(read?.rowCount).toBe(200_000);
  });
});
