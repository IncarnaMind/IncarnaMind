/**
 * A figure() figure is worked out again from the cells IncarnaMind read (#2444). A cell it
 * reads as text is one the code's pandas skips too, so the two could agree on a total the file
 * doesn't have: "(100)", 50 and 10 come to 60 for both, and to −40 in accounting notation.
 * Each column's numbers are read by the way the column writes them, the code reads them the
 * same, and a figure whose rows still hold a cell that isn't a number is not worked out again.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import type {
  AnalysisCell,
  AnalysisInput,
  AnalysisJob,
  AnalysisValue,
} from "../../src/shared/analysis";
import { answerEnded, type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { answerRequests, scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxPackage } from "../helpers/office";

const isNumber = (cell: AnalysisCell): cell is number =>
  typeof cell === "number" && Number.isFinite(cell);

/**
 * As the helper reads a column into pandas: numbers, when at least half its filled cells are,
 * the rest missing and listed, and the sum of what is left.
 */
function codeReads(input: Extract<AnalysisInput, { kind: "table" }>, column: number) {
  const cells = input.rows.map((row) => row[column] ?? null);
  const filled = cells.filter((cell) => cell !== null && cell !== "");
  const numbers = cells.filter(isNumber);
  const numeric = numbers.length > 0 && numbers.length * 2 >= filled.length;
  const rows = input.rowNumbers ?? [];
  const missing = numeric
    ? cells.flatMap((cell, at) =>
        isNumber(cell) ? [] : [{ row: rows[at] ?? 0, value: cell === null ? "" : String(cell) }],
      )
    : [];
  return { sum: numbers.reduce((total, value) => total + value, 0), missing };
}

/** The code each run stands in for: figure(heading, df[heading], "sum") for every column but the first. */
function sumsOfEveryColumn(job: AnalysisJob): FakeAnswer {
  const [input] = job.inputs;
  if (input?.kind !== "table") throw new Error("No table.");
  const results: AnalysisValue[] = [];
  const notNumbers = [];
  const rows = input.rowNumbers ?? [];
  for (const [column, heading] of input.columns.entries()) {
    if (column === 0) continue;
    const read = codeReads(input, column);
    results.push({
      kind: "figure",
      name: `c${column}`,
      label: heading,
      unit: null,
      value: read.sum,
      of: {
        input: input.name,
        columns: [heading],
        rows: [[rows[0] ?? 2, rows.at(-1) ?? 2]],
        count: rows.length,
        how: "sum",
      },
    });
    if (read.missing.length > 0) {
      notNumbers.push({
        input: input.name,
        column: heading,
        count: read.missing.length,
        cells: read.missing,
      });
    }
  }
  return { output: { results, notNumbers } };
}

function analysingModel(document: string, query: string): MockLanguageModelV4 {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query } }] };
    }
    if (!call.results.some((result) => result.tool === "run_analysis")) {
      const passages: ShownPassage[] = searches.flatMap((each) => shownPassages(each.text));
      const passage = passages.find((each) => each.document.startsWith(document));
      if (!passage) throw new Error(`No Passage of ${document} was shown.`);
      return {
        calls: [
          {
            tool: "run_analysis",
            input: {
              title: "Totals",
              inputs: [{ name: "ledger", passage: passage.id }],
              code: 'figure("total", inputs["ledger"]["Amount"], "sum")',
            },
          },
        ],
      };
    }
    return { text: "The total is [=1]." };
  });
}

function report(model: MockLanguageModelV4): string {
  const last = answerRequests(model).at(-1);
  for (const message of last?.prompt ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === "run_analysis") {
        if (part.output.type === "text") return part.output.value;
      }
    }
  }
  throw new Error("The model read no Analysis.");
}

async function analyse(
  file: { name: string; contents: string | Uint8Array },
  question: string,
  query = "Amount",
) {
  const model = analysingModel(file.name.replace(/\.\w+$/, ""), query);
  const runtime = createFakeAnalysisRuntime({ answer: sumsOfEveryColumn });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: runtime,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, file.name, file.contents)]);
  const asked = await core.askInConversation({ text: question });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  const [analysis] = answer.analyses;
  const [job] = runtime.jobs;
  const [input] = job?.inputs ?? [];
  if (!analysis || input?.kind !== "table") throw new Error("Nothing ran.");
  const checks = new Map(
    (analysis.recalculations ?? []).map((each) => {
      const result = analysis.output.results.find((value) => value.name === each.result);
      return [result?.label ?? "", each.check];
    }),
  );
  const column = (heading: string) => {
    const at = input.columns.indexOf(heading);
    return input.rows.map((row) => row[at] ?? null);
  };
  return { checks, column, report: report(model) };
}

const csv = (rows: readonly (readonly string[])[]) =>
  rows
    .map((row) => row.map((cell) => (/[",]/.test(cell) ? `"${cell}"` : cell)).join(","))
    .join("\n");

describe("a figure over cells written as text", () => {
  test("a CSV's numbers are read in the column's own notation, and the code sums the same numbers", async () => {
    const { checks, column, report } = await analyse(
      {
        name: "ledger.csv",
        contents: csv([
          ["Item", "Single", "Pair", "Dollars", "Share", "Comma", "Plain", "Grouped"],
          ["a", "(100)", "(100)", "$1,200", "8%", "1.234,56", "100", "1,200"],
          ["b", "50", "(20)", "$50", "5%", "2,5", "", "3,400.50"],
          ["c", "10", "50", "$-5", "10%", "1.234", " ", "50"],
          ["d", "5", "10", "5", "1%", "1", "10", "10"],
          ["e", "5", "10", "5", "1%", "1", "50", "10"],
        ]),
      },
      "What are the totals?",
      "Pair",
    );

    expect(column("Pair")).toEqual([-100, -20, 50, 10, 10]);
    expect(checks.get("Pair")).toEqual({ kind: "same", value: -50 });
    expect(column("Dollars")).toEqual([1200, 50, -5, 5, 5]);
    expect(checks.get("Dollars")).toEqual({ kind: "same", value: 1255 });
    expect(column("Share")).toEqual([0.08, 0.05, 0.1, 0.01, 0.01]);
    expect(checks.get("Share")).toEqual({ kind: "same", value: expect.closeTo(0.25, 12) });
    // "1.234,56" and "2,5" write decimals with a comma, so "1.234" is a thousand and more.
    expect(column("Comma")).toEqual([1234.56, 2.5, 1234, 1, 1]);
    expect(checks.get("Comma")).toEqual({ kind: "same", value: expect.closeTo(2473.06, 9) });
    // A column of only numbers and blanks is worked out again as before.
    expect(column("Plain")).toEqual([100, null, null, 10, 50]);
    expect(checks.get("Plain")).toEqual({ kind: "same", value: 160 });
    expect(column("Grouped")).toEqual([1200, 3400.5, 50, 10, 10]);
    expect(checks.get("Grouped")).toEqual({ kind: "same", value: 4670.5 });

    // One "(100)" among plain numbers could be a negative or a note: it stays text, and the
    // figure that would skip it isn't worked out again.
    expect(column("Single")).toEqual(["(100)", 50, 10, 5, 5]);
    expect(checks.get("Single")).toEqual({
      kind: "unchecked",
      reason: `1 cell of Single in the rows it names isn't a number: row 2 "(100)"`,
    });
    expect(report).toContain(
      `- c1: no marker, so it can't be used: IncarnaMind couldn't work it out again: 1 cell of Single in the rows it names isn't a number: row 2 "(100)".`,
    );
    expect(report).toContain(
      `1 cell of Single in ledger isn't a number, so the code reads it as missing: row 2 "(100)".`,
    );
    expect(report).toMatch(
      /- \[=1\] Pair: \S+50 \(the sum of Pair in 5 rows of ledger \(rows 2–6\)/,
    );
  });

  test.each([
    ["a percent among plain numbers", ["8%", "5", "10%", "1"], ['row 2 "8%"', 'row 4 "10%"']],
    ["a unit and an error", ["1.2万", "50", "#N/A", "10"], ['row 2 "1.2万"', 'row 4 "#N/A"']],
    [
      "a word, a dash and a mark",
      ["n/a", "-", "'100", "10", "20", "30"],
      ['row 2 "n/a"', 'row 3 "-"', `row 4 "'100"`],
    ],
    [
      "two notations of a negative",
      ["(100)", "(20)", "-5", "10"],
      ['row 2 "(100)"', 'row 3 "(20)"'],
    ],
    ["two currencies", ["$100", "€20", "5", "10"], ['row 2 "$100"', 'row 3 "€20"']],
    ["both ways of writing decimals", ["1,234.50", "1,2", "5", "10"], ['row 2 "1,234.50"']],
    [
      "a sign after the number, a date and TRUE",
      ["5-", "2026-01-31", "TRUE", "10", "20", "30"],
      ['row 2 "5-"', 'row 3 "2026-01-31"', 'row 4 "TRUE"'],
    ],
  ])("%s isn't worked out again, and the model reads which cells", async (_, cells, named) => {
    const { checks, report } = await analyse(
      {
        name: "ledger.csv",
        contents: csv([["Item", "Amount"], ...cells.map((cell, at) => [`r${at}`, cell])]),
      },
      "What is the total?",
    );

    const check = checks.get("Amount");
    expect(check?.kind).toBe("unchecked");
    for (const cell of named) {
      expect(check?.kind === "unchecked" && check.reason).toContain(cell);
      expect(report).toContain(cell);
    }
    expect(report).not.toContain("[=1]");
  });

  test("a Chinese CSV reads full-width digits, full-width parentheses and Chinese minus signs", async () => {
    const { checks, column, report } = await analyse(
      {
        name: "ledger.csv",
        contents: csv([
          ["项目", "Amount", "调整", "单位"],
          ["甲", "１，２００", "（100）", "1.2万"],
          ["乙", "−100", "（２０）", "5"],
          ["丙", "负50", "50", "10"],
          ["丁", "10", "10", "20"],
        ]),
      },
      "这些金额合计是多少？",
    );

    expect(column("Amount")).toEqual([1200, -100, -50, 10]);
    expect(checks.get("Amount")).toEqual({ kind: "same", value: 1060 });
    expect(column("调整")).toEqual([-100, -20, 50, 10]);
    expect(checks.get("调整")).toEqual({ kind: "same", value: -60 });
    // 万 states a unit the column's other cells don't: read neither way, it is named.
    expect(column("单位")).toEqual(["1.2万", 5, 10, 20]);
    expect(checks.get("单位")).toEqual({
      kind: "unchecked",
      reason: `1 cell of 单位 in the rows it names isn't a number: row 2 "1.2万"`,
    });
    expect(report).toContain(`1 cell of 单位 in ledger isn't a number`);
  });

  test("a workbook's number cells read as the file stores them, its text cells by their column", async () => {
    const styles = [
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0;(#,##0)"/></numFmts>`,
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`,
      `<borders count="1"><border><left/><right/><top/><bottom/></border></borders>`,
      `<cellXfs count="4">`,
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`,
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`,
      `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`,
      `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`,
      `</cellXfs>`,
    ].join("");
    const shared = ["Item", "Amount", "Notes", "Rate", "Day", "10", "n/a", "5%", "Euro"];
    const euro = ["1.234,50", "2,5", "1.234"];
    const s = (ref: string, text: string) =>
      `<c r="${ref}" t="s"><v>${[...shared, ...euro].indexOf(text)}</v></c>`;
    const n = (ref: string, value: number, style = 0) =>
      `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;
    const bool = (ref: string) => `<c r="${ref}" t="b"><v>1</v></c>`;
    const rows = [
      [
        s("A1", "Item"),
        s("B1", "Amount"),
        s("C1", "Notes"),
        s("D1", "Rate"),
        s("E1", "Day"),
        s("F1", "Euro"),
      ],
      [
        s("A2", "Item"),
        n("B2", -100, 1),
        s("C2", "n/a"),
        n("D2", 0.08, 2),
        n("E2", 46114, 3),
        s("F2", "1.234,50"),
      ],
      [s("A3", "Item"), n("B3", 50), n("C3", 50), s("D3", "5%"), n("E3", 46115, 3), s("F3", "2,5")],
      [s("A4", "Item"), s("B4", "10"), bool("C4"), n("D4", 0.1, 2), n("E4", 3), s("F4", "1.234")],
      [s("A5", "Item"), n("B5", 5), n("C5", 10), n("D5", 0.01, 2), n("E5", 4), n("F5", 1)],
    ];
    const workbook = xlsxPackage({
      sheets: [
        {
          name: "Ledger",
          xml: `<sheetData>${rows.map((cells, at) => `<row r="${at + 1}">${cells.join("")}</row>`).join("")}</sheetData>`,
        },
      ],
      styles,
      sharedStrings: [...shared, ...euro].map((text) => `<si><t>${text}</t></si>`),
    });

    const { checks, column } = await analyse({ name: "ledger.xlsx", contents: workbook }, "Total?");

    // −100 shows "(100)" by its format; "10" is text the column's numbers read.
    expect(column("Amount")).toEqual([-100, 50, 10, 5]);
    expect(checks.get("Amount")).toEqual({ kind: "same", value: -35 });
    expect(column("Notes")).toEqual(["n/a", 50, "TRUE", 10]);
    expect(checks.get("Notes")).toEqual({
      kind: "unchecked",
      reason: `2 cells of Notes in the rows it names aren't numbers: row 2 "n/a", row 4 "TRUE"`,
    });
    // A percent typed as text beside percent-formatted numbers: the text says nothing of the
    // numbers' scale, so it stays text.
    expect(column("Rate")).toEqual([0.08, "5%", 0.1, 0.01]);
    expect(checks.get("Rate")?.kind).toBe("unchecked");
    expect(column("Day")).toEqual(["2026-04-02", "2026-04-03", 3, 4]);
    expect(checks.get("Day")).toEqual({
      kind: "unchecked",
      reason: `2 cells of Day in the rows it names aren't numbers: row 2 "2026-04-02", row 3 "2026-04-03"`,
    });
    // Text the workbook stores as text is read by its column's notation, as a CSV's is.
    expect(column("Euro")).toEqual([1234.5, 2.5, 1234, 1]);
    expect(checks.get("Euro")).toEqual({ kind: "same", value: 2472 });
  });
});
