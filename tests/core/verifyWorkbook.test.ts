/**
 * Verify a workbook someone else built (#3278): the User picks a sheet, or a range of it, and it
 * becomes a Note of one table, each row a claim on its typed-in numbers, each formula worked out
 * again and the saved results that differ kept with the Note. Which cell is typed in and which a
 * formula comes from the file's structure.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { verificationOf } from "../../src/shared/verification";
import { checkGenerate, checkReply, listedSentences } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { WorkbookBuilder } from "../helpers/financeWorkbooks";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

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

async function setUp() {
  const sorted: string[][] = [];
  const plans = {
    [RENT]: { verdict: "supported" as const },
    [SALARIES]: { verdict: "supported" as const },
  };
  const answer = checkGenerate(plans);
  const model = scriptedModel((call: ModelCall) => checkReply(call, plans), {
    generate: (call) => {
      if (call.question === "find-claims") {
        sorted.push(listedSentences(call.prompt).map(({ text }) => text));
      }
      return answer(call);
    },
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, "Costs.md", "# Costs\n\nRent is 14,000 a year.\n"),
  ]);
  const path = await writeSourceFile(sources, "Budget.xlsx", planWorkbook().xlsx());
  return { core, path, sorted, sources };
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

    expect(sorted.flat()).toEqual([RENT, SALARIES]);
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
});
