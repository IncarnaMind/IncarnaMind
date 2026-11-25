/**
 * Verify a workbook someone else built (#3278): the User picks a sheet, or a range of it, or every
 * sheet (#3412), and it becomes a Note of tables, each row with a typed-in number a claim on what
 * it shows, each formula worked out again and the saved results that differ kept with the Note.
 * Which cell is typed in and which a formula comes from the file's structure.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { verificationOf } from "../../src/shared/verification";
import { checkGenerate, checkReply, listedSentences, type Plan } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { WorkbookBuilder } from "../helpers/financeWorkbooks";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxPackage } from "../helpers/office";

/** A plan with two years of typed-in costs, each total a formula, and one total whose saved result is wrong. */
function planWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  book
    .sheet("Plan")
    .text("A1", "Item")
    .text("B1", "2026")
    .text("C1", "2027")
    .text("A2", "Rent")
    .number("B2", 14000)
    .number("C2", 14000)
    .text("A3", "Salaries")
    .number("B3", 41500)
    .number("C3", 43000)
    .text("A4", "Total")
    .formula("B4", "SUM(B2:B3)", 55500)
    .formula("C4", "SUM(C2:C3)", 58000);
  book.sheet("Notes").text("A1", "Prepared by the finance team.");
  return book;
}

const RENT = "Rent — 2026: 14000; 2027: 14000";
const SALARIES = "Salaries — 2026: 41500; 2027: 43000";

async function setUp(
  plans: Record<string, Plan> = {
    [RENT]: { verdict: "supported" },
    [SALARIES]: { verdict: "supported" },
  },
  options?: { sort?: (prompt: string) => string | undefined },
) {
  const sorted: string[][] = [];
  const sortPrompts: string[] = [];
  const checkPrompts: string[] = [];
  const answer = checkGenerate(plans);
  const model = scriptedModel(
    (call: ModelCall) => {
      checkPrompts.push(call.prompt);
      return checkReply(call, plans);
    },
    {
      generate: (call) => {
        if (call.question === "find-claims") {
          sortPrompts.push(call.prompt);
          sorted.push(listedSentences(call.prompt).map(({ text }) => text));
          const custom = options?.sort?.(call.prompt);
          if (custom !== undefined) return { text: custom };
        }
        return answer(call);
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, "Costs.md", "# Costs\n\nRent is 14,000 a year.\n"),
  ]);
  const path = await writeSourceFile(sources, "Budget.xlsx", planWorkbook().xlsx());
  return { core, path, sorted, sortPrompts, checkPrompts, sources };
}

async function tableOf(core: Core, mindId: string) {
  const client = await connectToMind(core, mindId);
  await client.settled();
  const blocks: JSONContent[] = readMind(client).toJSON().content ?? [];
  return { client, blocks };
}

describe("Verify a workbook", () => {
  test("without a sheet, its sheets are listed with what each holds, and nothing is made", async () => {
    const { core, path } = await setUp();

    const result = await core.verifyDocument({ path });

    expect(result).toMatchObject({
      ok: false,
      reason: "choose-sheet",
      sheets: [
        { name: "Plan", rows: 4, typed: 4, formulas: 2 },
        { name: "Notes", rows: 1, typed: 0, formulas: 0 },
      ],
    });
    expect((await core.listMinds()).length).toBe(0);
  });

  test("a sheet becomes a Note of one table; its formulas are worked out again and the one that differs is kept", async () => {
    const { core, path } = await setUp();

    const result = await core.verifyDocument({ path, sheet: "Plan" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client, blocks } = await tableOf(core, result.mind.id);

    expect(blocks.map((block) => block.type)).toEqual(["heading", "table"]);
    expect(blocks[0]?.content?.[0]?.text).toBe("Plan");
    const rows = blocks[1]?.content ?? [];
    expect(
      rows.map((row) => row.content?.map((cell) => cell.content?.[0]?.content?.[0]?.text)),
    ).toEqual([
      ["Item", "2026", "2027"],
      ["Rent", "14000", "14000"],
      ["Salaries", "41500", "43000"],
      ["Total", "55500", "58000"],
    ]);
    const verification = verificationOf(client.doc);
    expect(verification?.workbook).toMatchObject({
      sheet: "Plan",
      range: null,
      checked: 2,
      unchecked: 0,
      differs: [{ cell: "C4", saved: "58000", worked: "57000" }],
    });
    expect(verification?.workbook?.formulaBlocks).toHaveLength(2);
    expect(Object.keys(verification?.pages ?? {}).length).toBeGreaterThan(8);
  });

  test("only the rows with typed-in numbers are claims: a formula's number is the workbook's own working", async () => {
    const { core, path, sorted } = await setUp();
    const result = await core.verifyDocument({ path, sheet: "Plan" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);

    expect(
      (await core.findClaims({ requestId: crypto.randomUUID(), mindId: result.mind.id })).kind,
    ).toBe("found");

    // The sheet's name is shown too: the model, not a rule on its length, finds it states nothing.
    expect(sorted.flat()).toEqual(["Plan", RENT, SALARIES]);
  });

  test("a range checks only its cells", async () => {
    const { core, path } = await setUp();

    const result = await core.verifyDocument({ path, sheet: "Plan", range: "A1:B4" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client, blocks } = await tableOf(core, result.mind.id);

    expect(blocks[0]?.content?.[0]?.text).toBe("Plan!A1:B4");
    expect(blocks[1]?.content?.[0]?.content).toHaveLength(2);
    expect(verificationOf(client.doc)?.workbook).toMatchObject({
      range: "A1:B4",
      checked: 1,
      differs: [],
    });
  });

  test("a sheet the workbook doesn't have, or a range that isn't one, is refused", async () => {
    const { core, path } = await setUp();

    expect(await core.verifyDocument({ path, sheet: "Missing" })).toEqual({
      ok: false,
      reason: "range",
    });
    expect(await core.verifyDocument({ path, sheet: "Plan", range: "B2-C9" })).toEqual({
      ok: false,
      reason: "range",
    });
    expect((await core.listMinds()).length).toBe(0);
  });

  test("a workbook that can't be read says so, and a sheet of formulas only is still checked", async () => {
    const { core, sources } = await setUp();
    const broken = await writeSourceFile(sources, "Broken.xlsx", "this is not a workbook");
    expect(await core.verifyDocument({ path: broken })).toEqual({
      ok: false,
      reason: "unreadable",
    });

    const book = new WorkbookBuilder();
    book.sheet("Calc").number("A1", 2).formula("B1", "A1*3", 7).formula("C1", "A1+1", 3);
    const only = await writeSourceFile(sources, "Formulas.xlsx", book.xlsx());
    const result = await core.verifyDocument({ path: only, sheet: "Calc" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client } = await tableOf(core, result.mind.id);
    expect(verificationOf(client.doc)?.workbook).toMatchObject({
      checked: 2,
      differs: [{ cell: "B1", saved: "7", worked: "6" }],
    });
  });

  test("a range with more typed-in numbers than one check takes is refused with how many", async () => {
    const { core, sources } = await setUp();
    const book = new WorkbookBuilder();
    const sheet = book.sheet("Log");
    for (let row = 1; row <= 1001; row++)
      sheet.text(`A${row}`, `Entry ${row}`).number(`B${row}`, row);
    const path = await writeSourceFile(sources, "Log.xlsx", book.xlsx());

    expect(await core.verifyDocument({ path, sheet: "Log" })).toEqual({
      ok: false,
      reason: "too-many",
      typed: 1001,
      most: 1000,
    });
    const smaller = await core.verifyDocument({ path, sheet: "Log", range: "A1:B50" });
    expect(smaller.ok).toBe(true);
  });

  test("a sheet with nothing to check says so", async () => {
    const { core, path } = await setUp();

    expect(await core.verifyDocument({ path, sheet: "Notes" })).toEqual({
      ok: false,
      reason: "no-text",
    });
  });

  // protects=a workbook a program wrote, which saves no formula results, still has its formulas worked out and shown (#3412); fails_when=a formula with no saved result is counted unchecked or left blank, or a cell after one that can't be worked out shows a guess
  test("a formula the file saved no result for is worked out and shown; one that can't be worked out, and a cell after it, say so and show nothing", async () => {
    const { core, sources } = await setUp();
    const book = new WorkbookBuilder();
    book
      .sheet("Model")
      .text("A1", "Item")
      .text("B1", "Value")
      .text("A2", "Tonnes")
      .number("B2", 3450)
      .text("A3", "Price")
      .number("B3", 700)
      .text("A4", "Cost")
      .formula("B4", "B2*B3", null)
      .text("A5", "Looked up")
      .formula("B5", "NOSUCHFUNCTION(B2)", null)
      .text("A6", "Twice that")
      .formula("B6", "B5*2", null);
    const path = await writeSourceFile(sources, "Model.xlsx", book.xlsx({ withoutResults: true }));

    const result = await core.verifyDocument({ path, sheet: "Model" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client, blocks } = await tableOf(core, result.mind.id);

    const rows = blocks[1]?.content ?? [];
    expect(
      rows.map((row) => row.content?.map((cell) => cell.content?.[0]?.content?.[0]?.text ?? "")),
    ).toEqual([
      ["Item", "Value"],
      ["Tonnes", "3450"],
      ["Price", "700"],
      ["Cost", "2415000"],
      ["Looked up", ""],
      ["Twice that", ""],
    ]);
    expect(verificationOf(client.doc)?.workbook).toMatchObject({
      checked: 0,
      unsaved: 1,
      unchecked: 2,
      differs: [],
    });
  });

  // protects=a cell with no saved result after a formula that can't be worked out shows nothing though a cell between them has a saved result (#3412); fails_when=the saved value in between stands in, and the last cell shows a figure and counts as worked out though its chain couldn't be
  test("a cell after a formula that can't be worked out shows nothing, though a cell between them saved a result", async () => {
    const { core, sources } = await setUp();
    const book = new WorkbookBuilder();
    book
      .sheet("Model")
      .text("A1", "Item")
      .text("B1", "Value")
      .text("A2", "Tonnes")
      .number("B2", 3450)
      .text("A3", "Looked up")
      .formula("B3", "NOSUCHFUNCTION(B2)", null)
      .text("A4", "Plus one")
      .formula("B4", "B3+1", 10)
      .text("A5", "Plus two")
      .formula("B5", "B4+1", null);
    const path = await writeSourceFile(sources, "Chain.xlsx", book.xlsx());

    const result = await core.verifyDocument({ path, sheet: "Model" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client, blocks } = await tableOf(core, result.mind.id);

    const rows = blocks[1]?.content ?? [];
    expect(
      rows.map((row) => row.content?.map((cell) => cell.content?.[0]?.content?.[0]?.text ?? "")),
    ).toEqual([
      ["Item", "Value"],
      ["Tonnes", "3450"],
      ["Looked up", ""],
      ["Plus one", "10"],
      ["Plus two", ""],
    ]);
    expect(verificationOf(client.doc)?.workbook).toMatchObject({
      checked: 0,
      unsaved: 0,
      unchecked: 3,
      differs: [],
    });
  });

  // protects=a cell after a formula whose saved result is wrong is compared on its own formula (#3412); fails_when=it is worked from the wrong saved value, and a right cell is flagged as differing
  test("a cell after a formula whose saved result differs is worked from the value worked out, and only the wrong one is flagged", async () => {
    const { core, sources } = await setUp();
    const book = new WorkbookBuilder();
    book
      .sheet("Budget")
      .text("A1", "Line")
      .text("B1", "Value")
      .text("A2", "Tonnes")
      .number("B2", 3450)
      .text("A3", "Price")
      .number("B3", 700)
      .text("A4", "Cost")
      .formula("B4", "B2*B3", 2451000)
      .text("A5", "Discount")
      .number("B5", 0)
      .text("A6", "After discount")
      .formula("B6", "B4-B5", 2415000);
    const path = await writeSourceFile(sources, "Budget 2026.xlsx", book.xlsx());

    const result = await core.verifyDocument({ path, sheet: "Budget" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client } = await tableOf(core, result.mind.id);

    expect(verificationOf(client.doc)?.workbook).toMatchObject({
      checked: 2,
      differs: [{ cell: "B4", saved: "2451000", worked: "2415000" }],
    });
  });

  // protects=no mark sits beside a figure the check never judged (#3412): a row of a formula's result and a note is no claim, and a row with typed-in numbers is judged with its formula's result; fails_when=a row is judged on its words with its formula's result left out, and its mark is shown beside that result
  test("a row whose number is a formula's result is no claim, even with a note beside it; a row with typed-in numbers is judged with its total", async () => {
    const ROW = "Rent — 2026: 14000; 2027: 14000; Total: 28000";
    const { core, sorted, sources } = await setUp({ [ROW]: { verdict: "supported" } });
    const book = new WorkbookBuilder();
    book
      .sheet("Plan")
      .text("A1", "Item")
      .text("B1", "2026")
      .text("C1", "2027")
      .text("D1", "Total")
      .text("E1", "Note")
      .text("A2", "Rent")
      .number("B2", 14000)
      .number("C2", 14000)
      .formula("D2", "B2+C2", 28000)
      .text("A3", "Rent next year")
      .formula("C3", "C2", 14000)
      .text("E3", "Taken from the lease");
    const path = await writeSourceFile(sources, "Rent plan.xlsx", book.xlsx());

    const result = await core.verifyDocument({ path, sheet: "Plan" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    expect(
      (await core.findClaims({ requestId: crypto.randomUUID(), mindId: result.mind.id })).kind,
    ).toBe("found");

    expect(sorted.flat()).toEqual(["Plan", ROW]);
  });

  // protects=a whole workbook is checked in one call, each sheet its own table, within the check's one limit on typed-in numbers (#3412); fails_when=only one sheet is read, a differing cell doesn't name its sheet, or the limit is counted a sheet at a time
  test("every sheet at once: each with something to check is a table under its name, a differing cell names its sheet, and the limit counts every sheet's numbers together", async () => {
    const { core, sources } = await setUp();
    const book = planWorkbook();
    book.sheet("Inputs").text("A1", "Tonnes").number("B1", 3450);
    const path = await writeSourceFile(sources, "Plan and inputs.xlsx", book.xlsx());

    const result = await core.verifyDocument({ path, allSheets: true });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client, blocks } = await tableOf(core, result.mind.id);

    expect(blocks.map((block) => [block.type, block.content?.[0]?.text])).toEqual([
      ["heading", "Plan"],
      ["table", undefined],
      ["heading", "Inputs"],
      ["table", undefined],
    ]);
    expect(verificationOf(client.doc)?.workbook).toMatchObject({
      sheet: "",
      checked: 2,
      differs: [{ cell: "Plan!C4", saved: "58000", worked: "57000" }],
    });

    const large = new WorkbookBuilder();
    for (const name of ["First", "Second"]) {
      const sheet = large.sheet(name);
      for (let row = 1; row <= 600; row++)
        sheet.text(`A${row}`, `Entry ${row}`).number(`B${row}`, row);
    }
    const both = await writeSourceFile(sources, "Two logs.xlsx", large.xlsx());
    expect(await core.verifyDocument({ path: both, allSheets: true })).toEqual({
      ok: false,
      reason: "too-many",
      typed: 1200,
      most: 1000,
    });
    expect((await core.verifyDocument({ path: both, sheet: "First" })).ok).toBe(true);
  });

  // protects=a formula the file saved no result for shows what it works out to in its cell's own number format, as the file would show it (#3412); fails_when=a money or percent cell shows a plain number, or a cell with no format shows one
  test("a formula with no saved result shows what it works out to in its cell's number format, and one with none plainly", async () => {
    const { core, sources } = await setUp();
    const text = (ref: string, words: string) =>
      `<c r="${ref}" t="inlineStr"><is><t>${words}</t></is></c>`;
    const book = xlsxPackage({
      styles:
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="£#,##0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="10" applyNumberFormat="1"/></cellXfs>',
      sheets: [
        {
          name: "Costs",
          xml: `<sheetData><row r="1">${text("A1", "Item")}${text("B1", "Value")}</row><row r="2">${text("A2", "Rent")}<c r="B2"><v>14000</v></c></row><row r="3">${text("A3", "Insurance")}<c r="B3"><v>2200</v></c></row><row r="4">${text("A4", "Total")}<c r="B4" s="1"><f>B2+B3</f><v></v></c></row><row r="5">${text("A5", "Total again")}<c r="B5"><f>B2+B3</f></c></row><row r="6">${text("A6", "Insurance share")}<c r="B6" s="2"><f>B3/B4</f></c></row></sheetData>`,
        },
      ],
    });
    const path = await writeSourceFile(sources, "Costs.xlsx", book);

    const result = await core.verifyDocument({ path, sheet: "Costs" });
    if (!result.ok) throw new Error(`Not verified: ${result.reason}`);
    const { client, blocks } = await tableOf(core, result.mind.id);

    const rows = blocks[1]?.content ?? [];
    expect(
      rows.map((row) => row.content?.map((cell) => cell.content?.[0]?.content?.[0]?.text ?? "")),
    ).toEqual([
      ["Item", "Value"],
      ["Rent", "14000"],
      ["Insurance", "2200"],
      ["Total", "£16,200.00"],
      ["Total again", "16200"],
      ["Insurance share", "13.58%"],
    ]);
    expect(verificationOf(client.doc)?.workbook).toMatchObject({ unsaved: 3, unchecked: 0 });
  });

  // protects=a workbook whose cells are all inline strings with figures written as text is listed, turned into a check Note, and its rows read as claims, while an empty or notes-only sheet still says there is nothing to check (#3575); fails_when=a text-only workbook returns no-text, a headerless row with a text figure is swallowed as a header, or a notes-only / headers-only sheet is checked
  test("a sheet whose figures are written as text is checked as table rows; empty, header-only and single-column notes sheets still say nothing to check (#3575)", async () => {
    const CAP = "Liability cap — Clause: Clause 12.1; Amount: GBP 500,000";
    const NOTICE = "Notice period — Clause: Clause 15.2; Amount: 14 days";
    const { core, sorted, sources } = await setUp({
      [CAP]: { verdict: "supported" },
      [NOTICE]: { verdict: "contradicted" },
    });
    const inline = (ref: string, words: string) =>
      `<c r="${ref}" t="inlineStr"><is><t>${words}</t></is></c>`;
    const book = xlsxPackage({
      sheets: [
        {
          name: "Schedule",
          xml: `<sheetData><row r="1">${inline("A1", "Term")}${inline("B1", "Clause")}${inline("C1", "Amount")}</row><row r="2">${inline("A2", "Liability cap")}${inline("B2", "Clause 12.1")}${inline("C2", "GBP 500,000")}</row><row r="3">${inline("A3", "Notice period")}${inline("B3", "Clause 15.2")}${inline("C3", "14 days")}</row></sheetData>`,
        },
        {
          name: "Headerless",
          xml: `<sheetData><row r="1">${inline("A1", "Revenue")}${inline("B1", "USD 1 million")}</row><row r="2">${inline("A2", "Liability cap")}${inline("B2", "GBP 500,000")}</row></sheetData>`,
        },
        {
          name: "HeadersOnly",
          xml: `<sheetData><row r="1">${inline("A1", "Term")}${inline("B1", "Amount")}</row></sheetData>`,
        },
        {
          name: "SingleColumnNotes",
          xml: `<sheetData><row r="1">${inline("A1", "Notes")}</row><row r="2">${inline("A2", "Prepared for internal review.")}</row></sheetData>`,
        },
      ],
    });
    const path = await writeSourceFile(sources, "Terms.xlsx", book);

    expect(await core.verifyDocument({ path })).toMatchObject({
      ok: false,
      reason: "choose-sheet",
      sheets: [
        { name: "Schedule", rows: 3, typed: 0, formulas: 0, textRows: 2 },
        { name: "Headerless", rows: 2, typed: 0, formulas: 0, textRows: 2 },
        { name: "HeadersOnly", rows: 1, typed: 0, formulas: 0 },
        { name: "SingleColumnNotes", rows: 2, typed: 0, formulas: 0 },
      ],
    });

    expect(await core.verifyDocument({ path, sheet: "HeadersOnly" })).toEqual({
      ok: false,
      reason: "no-text",
    });
    expect(await core.verifyDocument({ path, sheet: "SingleColumnNotes" })).toEqual({
      ok: false,
      reason: "no-text",
    });

    const verified = await core.verifyDocument({ path, sheet: "Schedule" });
    if (!verified.ok) throw new Error(`Not verified: ${verified.reason}`);
    expect(
      (await core.findClaims({ requestId: crypto.randomUUID(), mindId: verified.mind.id })).kind,
    ).toBe("found");
    expect(sorted.flat()).toEqual(["Schedule", CAP, NOTICE]);

    const headerless = await core.verifyDocument({ path, sheet: "Headerless" });
    if (!headerless.ok) throw new Error(`Not verified: ${headerless.reason}`);
    const { blocks } = await tableOf(core, headerless.mind.id);
    expect(
      (blocks[1]?.content ?? []).map((row) =>
        row.content?.map((cell) => [cell.type, cell.content?.[0]?.content?.[0]?.text]),
      ),
    ).toEqual([
      [
        ["tableCell", "Revenue"],
        ["tableCell", "USD 1 million"],
      ],
      [
        ["tableCell", "Liability cap"],
        ["tableCell", "GBP 500,000"],
      ],
    ]);
  });

  // protects=a workbook's check hands the whole sheet (section headings, units and notes) to both the sort and the row judge, and a row the sort labels "note" is skipped rather than checked as a claim (#3506); fails_when=the sheet is omitted from verification, sort or claim prompts, or a "note" row is still sent to check
  test("whole-sheet context reaches both sort and claim checks, and rows sorted as 'note' are skipped (#3506)", async () => {
    const { core, path, sortPrompts, checkPrompts } = await setUp(
      { [RENT]: { verdict: "supported" } },
      {
        sort: (prompt) => {
          const replies: Record<string, string> = {};
          for (const { number, text } of listedSentences(prompt)) {
            replies[String(number)] = text === RENT ? "claim" : text === SALARIES ? "note" : "no";
          }
          return JSON.stringify(replies);
        },
      },
    );

    const verified = await core.verifyDocument({ path, sheet: "Plan" });
    if (!verified.ok) throw new Error(`Not verified: ${verified.reason}`);
    const { client } = await tableOf(core, verified.mind.id);
    expect(verificationOf(client.doc)?.sheets).toMatchObject({
      1: expect.stringContaining("Row 2: Rent | 14000 | 14000"),
    });

    const found = await core.findClaims({
      requestId: crypto.randomUUID(),
      mindId: verified.mind.id,
    });
    expect(found).toMatchObject({ kind: "found" });
    expect(sortPrompts.join("\n")).toContain('"sheets"');
    expect(sortPrompts.join("\n")).toContain("Row 2: Rent | 14000 | 14000");

    const checked = await core.verifyClaims({
      requestId: crypto.randomUUID(),
      mindId: verified.mind.id,
    });
    expect(checked).toMatchObject({ kind: "checked" });
    const joined = checkPrompts.join("\n");
    expect(joined).toContain("<sheet>");
    expect(joined).toContain(RENT);
    expect(joined).not.toContain(`<sentence>\n${SALARIES}`);
  });
});
