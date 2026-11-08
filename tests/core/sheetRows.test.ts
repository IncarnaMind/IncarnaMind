/**
 * A sheet that holds an older and a current version of the same rows, the older struck through or
 * hidden by the file (#1979). What the model is shown marks each such row on its own line, with
 * its row, and says what the mark means, so an Answer about the current state never takes a
 * set-aside row for a current one, nor guesses from the rows' order.
 */
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import {
  confirmPrompt,
  evidencePrompt,
  presencePrompt,
} from "../../src/core/answers/checks/prompt";
import {
  figureRetryPrompt,
  quoteRetryPrompt,
  setAsideRowsMeaning,
  setAsideRowsNote,
} from "../../src/core/answers/prompt";
import { nearestExcerpt } from "../../src/core/answers/quoteRetry";
import { withSetAsideMarks } from "../../src/core/answers/sheetRows";
import { openDatabase } from "../../src/core/storage";
import { askAssistant } from "../helpers/assistant";
import { answerEnded, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { readMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxPackage } from "../helpers/office";
import { type SheetRow, sheetWithRows } from "../helpers/sheetRows";

const LANGUAGES = {
  en: {
    sheet: "Load",
    head: ["Item", "Unit mass (kg)", "Quantity", "Subtotal (kg)"],
    items: ["Glass beads", "Control weights", "TOTAL"],
    question: "What is the current total load?",
  },
  "zh-CN": {
    sheet: "载荷",
    head: ["物品", "单位质量（千克）", "数量", "小计（千克）"],
    items: ["玻璃珠", "控制砝码", "合计"],
    question: "当前的总载荷是多少？",
  },
} as const;
type Language = keyof typeof LANGUAGES;

/** The load worksheet's two versions: rows 2–4 the earlier, rows 5–7 the current. */
function worksheet(language: Language, earlier: Partial<SheetRow> = {}): Buffer {
  const { sheet, head, items } = LANGUAGES[language];
  const [beads, weights, total] = items;
  return sheetWithRows(sheet, [
    { cells: [...head] },
    { cells: [beads, 0.125, 2, 0.25], ...earlier },
    { cells: [weights, 0.05, 3, 0.15], ...earlier },
    { cells: [total, "", "", 0.4], ...earlier },
    { cells: [beads, 0.075, 2, 0.15] },
    { cells: [weights, 0.05, 2, 0.1] },
    { cells: [total, "", "", 0.25] },
  ]);
}

const NOTE =
  "Where a set-aside row and an unmarked one give one item different figures, the unmarked one is the sheet's current figure, and the set-aside one is never given as current.";

/** What the last request showed the model of a Tool's results. */
function told(model: MockLanguageModelV4, tool: string): string {
  const texts: string[] = [];
  for (const message of model.doStreamCalls.at(-1)?.prompt ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content)
      if (part.type === "tool-result" && part.toolName === tool && part.output.type === "text")
        texts.push(part.output.value);
  }
  return texts.join("\n");
}

async function asked(model: MockLanguageModelV4, file: Buffer, question: string) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const path = await writeSourceFile(await createTempDataFolder(), "Load worksheet.xlsx", file);
  await addAndProcess(core, [path]);
  const result = await core.askInConversation({ text: question });
  if (!result.asked) throw new Error("The Question wasn't asked.");
  await answerEnded(core, result.answerId);
  const { messages } = await core.getConversation(result.conversation.id);
  core.close();
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** The search result a model is shown for a Question about this sheet. */
async function shownToModel(language: Language, file: Buffer, query?: string): Promise<string> {
  const { items, question } = LANGUAGES[language];
  const model = scriptedModel((call) =>
    call.results.some((result) => result.tool === "search_documents")
      ? { text: "Done." }
      : { calls: [{ tool: "search_documents", input: { query: query ?? items.join(" ") } }] },
  );
  await asked(model, file, question);
  return told(model, "search_documents");
}

const linesOf = (result: string) => shownPassages(result).flatMap((each) => each.text.split("\n"));

describe.each(["en", "zh-CN"] as const)("%s", (language) => {
  const [beads, weights, total] = LANGUAGES[language].items;

  test("each row the file strikes through is marked on its own line, and the mark is explained", async () => {
    const result = await shownToModel(language, worksheet(language, { struck: true }));
    const lines = linesOf(result);
    expect(lines).toEqual(
      expect.arrayContaining([
        `[row 2, struck through] ${beads}\t0.125\t2\t0.25`,
        `[row 3, struck through] ${weights}\t0.05\t3\t0.15`,
        `[row 4, struck through] ${total}\t\t\t0.4`,
        `${beads}\t0.075\t2\t0.15`,
        `${weights}\t0.05\t2\t0.1`,
        `${total}\t\t\t0.25`,
      ]),
    );
    expect(lines.filter((line) => line.startsWith("[row "))).toHaveLength(3);
    expect(result).toContain(NOTE);
  });

  test("each row the file hides is marked on its own line", async () => {
    const result = await shownToModel(language, worksheet(language, { hidden: true }));
    expect(linesOf(result)).toEqual(
      expect.arrayContaining([
        `[row 2, hidden] ${beads}\t0.125\t2\t0.25`,
        `[row 4, hidden] ${total}\t\t\t0.4`,
        `${total}\t\t\t0.25`,
      ]),
    );
    expect(result).toContain(NOTE);
  });

  test("a sheet the file sets nothing aside in, or strikes only some cells of a row in, is shown as it was", async () => {
    for (const earlier of [{}, { struck: [1, 3] }] as const) {
      const result = await shownToModel(language, worksheet(language, earlier));
      expect(linesOf(result)).toContain(`${beads}\t0.125\t2\t0.25`);
      expect(result).not.toContain("[row ");
      expect(result).not.toContain(NOTE);
    }
  });
});

test("a long sheet's set-aside rows are marked at their own lines in every Passage, wherever one starts", async () => {
  const parts = Array.from({ length: 40 }, (_, index) => `Bracket type ${index + 1}`);
  const row = (index: number, cost: number) =>
    `${parts[index]}\t${cost}\t${index + 2}\t${cost * (index + 2)}`;
  const version = (base: number, struck: boolean): SheetRow[] =>
    parts.map((part, index) => ({
      cells: [part, base + index, index + 2, (base + index) * (index + 2)],
      struck,
    }));
  // Rows 2–41 are current; rows 42–81, their earlier version, are struck through.
  const file = sheetWithRows("Parts", [
    { cells: ["Part", "Unit cost", "Quantity", "Cost"] },
    ...version(20, false),
    ...version(10, true),
  ]);
  const passages = shownPassages(await shownToModel("en", file, parts.join(" ")));
  expect(passages.length).toBeGreaterThan(1);
  const lines = passages.flatMap((each) => each.text.split("\n"));
  const marked = lines.flatMap((line) => {
    const match = /^\[row (\d+), struck through\] (.*)$/.exec(line);
    return match ? [{ row: Number(match[1]), line: match[2] }] : [];
  });
  expect(marked.length).toBeGreaterThan(20);
  for (const each of marked) expect(each.line).toBe(row(each.row - 42, 10 + each.row - 42));
  const earlier = new Set(parts.map((_, index) => row(index, 10 + index)));
  expect(lines.filter((line) => earlier.has(line))).toEqual([]);
  expect(lines).toContain(row(0, 20));
});

test.each([
  ["a font whose strike is turned off", '<strike val="0"/>', ' hidden="false"', false],
  [
    "a strike and a hidden row as LibreOffice writes them",
    '<strike val="true"/>',
    ' hidden="true"',
    true,
  ],
])("%s", async (_name, strike, hidden, setAside) => {
  const file = xlsxPackage({
    sheets: [
      {
        name: "Load",
        xml: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Mass</t></is></c></row><row r="2"><c r="A2" s="1" t="inlineStr"><is><t>Glass beads</t></is></c><c r="B2" s="1"><v>0.125</v></c></row><row r="3"${hidden}><c r="A3" t="inlineStr"><is><t>Control weights</t></is></c><c r="B3"><v>0.05</v></c></row></sheetData>`,
      },
    ],
    styles: `<fonts count="2"><font><sz val="11"/></font><font>${strike}<sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0" fontId="0"/><xf numFmtId="0" fontId="1" applyFont="1"/></cellXfs>`,
  });
  const lines = linesOf(await shownToModel("en", file, "Glass beads Control weights"));
  expect(lines).toEqual(
    expect.arrayContaining(
      setAside
        ? ["[row 2, struck through] Glass beads\t0.125", "[row 3, hidden] Control weights\t0.05"]
        : ["Glass beads\t0.125", "Control weights\t0.05"],
    ),
  );
});

test("a quote copied with a row's mark is the row's own text, and found", async () => {
  const model = scriptedModel(
    (call) => {
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "Glass beads TOTAL" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(search.text)[0];
        const line = passage?.text.split("\n").find((each) => each.startsWith("[row 4,"));
        const citations = [
          { marker: 1, passage: passage?.id, location: "Load, row 4", quote: line },
        ];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: "The earlier total, which the file strikes through, was 0.4 kg [^1]." };
    },
    { judgesItsAnswers: true },
  );
  const answer = await asked(
    model,
    worksheet("en", { struck: true }),
    "What was the earlier total?",
  );
  expect(answer.citations).toEqual([
    expect.objectContaining({
      quote: "TOTAL\t\t\t0.4",
      check: "found",
      location: { kind: "rows", sheet: "Load", from: 4, to: 4 },
    }),
  ]);
});

test("a workbook read before the file's set-aside rows were kept is read again and marks them", async () => {
  const dataDir = await createTempDataFolder();
  const first = startCore(dataDir);
  const path = await writeSourceFile(
    await createTempDataFolder(),
    "Load worksheet.xlsx",
    worksheet("en", { struck: true }),
  );
  const [document] = await addAndProcess(first, [path]);
  if (!document) throw new Error("Missing Document.");
  first.close();
  const labels = () =>
    queryDatabase<{ label: string }>(
      dataDir,
      "SELECT label FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
      [document.id],
    ).map((row) => JSON.parse(row.label) as { struckRows?: number[] });
  expect(labels().map((label) => label.struckRows)).toEqual([[2, 3, 4]]);

  // As the build before left it: its version, and no struck-through rows in the labels.
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.transaction(() => {
      db.run("UPDATE documents SET processing_version = 23 WHERE id = ?", [document.id]);
      for (const { id, label } of db.all<{ id: string; label: string }>(
        "SELECT id, label FROM document_pages WHERE document_id = ?",
        [document.id],
      )) {
        const { struckRows: _struck, ...rest } = JSON.parse(label) as Record<string, unknown>;
        db.run("UPDATE document_pages SET label = ? WHERE id = ?", [JSON.stringify(rest), id]);
      }
    });
  } finally {
    db.close();
  }
  expect(labels().map((label) => label.struckRows)).toEqual([undefined]);

  const again = startCore(dataDir);
  expect((await again.listDocuments())[0]).toMatchObject({ id: document.id, status: "queued" });
  await waitForProcessing(again, [document.id]);
  expect(labels().map((label) => label.struckRows)).toEqual([[2, 3, 4]]);
  again.close();
});

test("a claim check of a sentence citing a struck-through row reads the row's mark and what it means", async () => {
  const model = scriptedModel(() => ({ text: "Done." }));
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const path = await writeSourceFile(
    await createTempDataFolder(),
    "Load worksheet.xlsx",
    worksheet("en", { struck: true }),
  );
  const [document] = await addAndProcess(core, [path]);
  const [passage] = await core.searchPassages("TOTAL");
  if (!document || !passage) throw new Error("The worksheet wasn't added.");
  await core.checkClaim({
    claim: "The current total load is 0.4 kg.",
    cited: [
      {
        documentName: document.name,
        documentId: document.id,
        contentHash: document.contentHash,
        passageId: passage.passageId,
        quote: "TOTAL\t\t\t0.4",
      },
    ],
  });
  core.close();
  const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
  expect(prompt).toContain(JSON.stringify("[row 4, struck through] TOTAL\t\t\t0.4").slice(1, -1));
  expect(prompt).toContain(NOTE);
});

describe("each set-aside row is found where the Passage was cut from its sheet", () => {
  test("a sheet whose header and rows start with an empty cell, as a revision worksheet is laid out", async () => {
    const file = sheetWithRows("Load", [
      { cells: ["", "Item", "Unit mass (kg)", "Quantity", "Subtotal (kg)"] },
      { cells: ["Revision A", "Glass beads", 0.125, 2, 0.25], struck: true },
      { cells: ["", "Control weights", 0.05, 3, 0.15], struck: true },
      { cells: ["", "TOTAL", "", "", 0.4], struck: true },
      { cells: ["Revision B", "Glass beads", 0.075, 2, 0.15] },
      { cells: ["", "Control weights", 0.05, 2, 0.1] },
      { cells: ["", "TOTAL", "", "", 0.25] },
    ]);
    const result = await shownToModel("en", file);
    expect(linesOf(result)).toEqual([
      "Item\tUnit mass (kg)\tQuantity\tSubtotal (kg)",
      "[row 2, struck through] Revision A\tGlass beads\t0.125\t2\t0.25",
      "[row 3, struck through] \tControl weights\t0.05\t3\t0.15",
      "[row 4, struck through] \tTOTAL\t\t\t0.4",
      "Revision B\tGlass beads\t0.075\t2\t0.15",
      "\tControl weights\t0.05\t2\t0.1",
      "\tTOTAL\t\t\t0.25",
    ]);
    expect(result).toContain(NOTE);
  });

  test("a long table from column B, under a title in A1: every Passage marks its own struck rows", async () => {
    const parts = Array.from({ length: 40 }, (_, index) => `Bracket type ${index + 1}`);
    const version = (base: number, struck: boolean): SheetRow[] =>
      parts.map((part, index) => ({
        cells: ["", part, base + index, index + 2, (base + index) * (index + 2)],
        struck,
      }));
    // Rows 3–42 are current; rows 43–82, their earlier version, are struck through.
    const file = sheetWithRows("Parts", [
      { cells: ["Parts list, revision B"] },
      { cells: ["", "Part", "Unit cost", "Quantity", "Cost"] },
      ...version(20, false),
      ...version(10, true),
    ]);
    const passages = shownPassages(await shownToModel("en", file, parts.join(" ")));
    expect(passages.length).toBeGreaterThan(1);
    const row = (index: number, cost: number) =>
      `\t${parts[index]}\t${cost}\t${index + 2}\t${cost * (index + 2)}`;
    const earlier = new Map(parts.map((_, index) => [row(index, 10 + index), 43 + index]));
    const current = new Set(parts.map((_, index) => row(index, 20 + index)));
    let marked = 0;
    for (const passage of passages) {
      for (const line of passage.text.split("\n")) {
        const plain = line.replace(/^\[Parts, rows \d+–\d+\] /, "").trimStart();
        const match = /^\[row (\d+), struck through\] (.*)$/.exec(plain);
        if (match) {
          marked++;
          const text = match[2] ?? "";
          expect(earlier.get(text) ?? earlier.get(`\t${text}`)).toBe(Number(match[1]));
          continue;
        }
        expect(earlier.has(`\t${plain}`) || earlier.has(plain)).toBe(false);
      }
    }
    expect(marked).toBeGreaterThan(20);
    const lines = passages.flatMap((each) => each.text.split("\n"));
    expect(lines.some((line) => current.has(line))).toBe(true);
  });

  test("a row too wide for one Passage is marked on every part of it each Passage shows", async () => {
    const file = sheetWithRows("Notes", [
      { cells: ["Item", "Note", "Cost"] },
      { cells: ["Beads", `${"s".repeat(2400)} earlier`, 1], struck: true },
      { cells: ["Beads", `${"c".repeat(2400)} now`, 2] },
    ]);
    const passages = shownPassages(await shownToModel("en", file, "Beads earlier now"));
    const lines = passages.flatMap((each) => each.text.split("\n"));
    const earlier = lines.filter((line) => line.includes("sss"));
    expect(earlier.length).toBeGreaterThan(1);
    for (const line of earlier) expect(line).toMatch(/^(?:\[[^\]]+\] )?\[row 2, struck through\] /);
    const now = lines.filter((line) => line.includes("ccc"));
    expect(now.length).toBeGreaterThan(1);
    for (const line of now) expect(line).not.toContain("[row ");
  });

  test("of two rows that read the same, only the one the file strikes through is marked", async () => {
    const file = sheetWithRows("Load", [
      { cells: ["Item", "Unit mass (kg)", "Quantity"] },
      { cells: ["Glass beads", 0.05, 2] },
      { cells: ["Glass beads", 0.05, 2], struck: true },
      { cells: ["Control weights", 0.05, 3] },
    ]);
    expect(linesOf(await shownToModel("en", file, "Glass beads Control weights"))).toEqual([
      "Item\tUnit mass (kg)\tQuantity",
      "Glass beads\t0.05\t2",
      "[row 3, struck through] Glass beads\t0.05\t2",
      "Control weights\t0.05\t3",
    ]);
  });

  test("a struck row that starts a later Unit keeps the Unit's mark first, though its text is folded", async () => {
    // No row looks like a header, so a later Unit starts with a row of its own, not the header.
    const file = sheetWithRows("Parts", [
      ...Array.from({ length: 10 }, (_, index) => ({
        cells: [`Part ${index + 1} now`, 20 + index, index + 2],
      })),
      ...Array.from({ length: 60 }, (_, index) => ({
        cells: [`⼤ part ${index + 1} earlier, as quoted by the supplier`, 10 + index, 2],
        struck: true,
      })),
    ]);
    const lines = shownPassages(await shownToModel("en", file, "part earlier now")).flatMap(
      (each) => each.text.split("\n"),
    );
    expect(
      lines.some((line) =>
        /^\[Parts, rows \d+–\d+\] \[row \d+, struck through\] 大 part/.test(line),
      ),
    ).toBe(true);
    expect(lines.filter((line) => /^\[row \d+, struck through\] \[/.test(line))).toEqual([]);
  });
});

describe("rows out of view that the file doesn't set aside", () => {
  const sheet = (sheetPr: string, hidden: string) =>
    xlsxPackage({
      sheets: [
        {
          name: "Load",
          xml: `${sheetPr}<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Mass</t></is></c></row><row r="2"${hidden}><c r="A2" t="inlineStr"><is><t>Glass beads</t></is></c><c r="B2"><v>0.125</v></c></row><row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Control weights</t></is></c><c r="B3"><v>0.05</v></c></row></sheetData>`,
        },
      ],
    });

  test.each([
    ["rows a filter hides", '<sheetPr filterMode="1"/>', ' hidden="1"'],
    [
      "rows a filter hides, as LibreOffice writes it",
      '<sheetPr filterMode="true"/>',
      ' hidden="1"',
    ],
  ])("%s are read as ordinary rows", async (_name, sheetPr, hidden) => {
    const result = await shownToModel("en", sheet(sheetPr, hidden), "Glass beads Control weights");
    expect(linesOf(result)).toEqual(
      expect.arrayContaining(["Glass beads\t0.125", "Control weights\t0.05"]),
    );
    expect(result).not.toContain("[row ");
    expect(result).not.toContain(NOTE);
  });

  test("a collapsed group's detail rows are read as ordinary rows, and a row hidden by hand is set aside", async () => {
    const result = await shownToModel(
      "en",
      sheet("", ' hidden="1" outlineLevel="1"'),
      "Glass beads Control weights",
    );
    expect(linesOf(result)).toEqual(
      expect.arrayContaining(["Glass beads\t0.125", "[row 3, hidden] Control weights\t0.05"]),
    );
  });
});

describe("what else reads a sheet's Passages", () => {
  test("the one request for an Answer's Citations shows the rows' marks, and what they mean", async () => {
    const requests: string[] = [];
    const model = scriptedModel((call) => {
      if (call.json) {
        requests.push(call.prompt);
        return { text: '{"citations": []}' };
      }
      if (!call.results.some((result) => result.tool === "search_documents"))
        return { calls: [{ tool: "search_documents", input: { query: "Glass beads TOTAL" } }] };
      // A marker with no record behind it: its Citation is asked for.
      return { text: "The current total load is 0.25 kg [^1]." };
    });
    await asked(model, worksheet("en", { struck: true }), "What is the current total load?");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("[row 4, struck through] TOTAL\t\t\t0.4");
    expect(requests[0]).toContain(NOTE);
  });

  test("a mark the Answer copies is said in words, in the Answer's language", async () => {
    for (const [language, question, written, said] of [
      [
        "en",
        "What was the earlier total?",
        "It was 0.4 kg [row 4, struck through].",
        "It was 0.4 kg (struck through in the file).",
      ],
      [
        "zh-CN",
        "之前的总载荷是多少？",
        "之前是 0.4 千克 [row 4, struck through]。",
        "之前是 0.4 千克（文件中已加删除线）。",
      ],
    ] as const) {
      const model = scriptedModel((call) =>
        call.results.some((result) => result.tool === "search_documents")
          ? { text: written }
          : { calls: [{ tool: "search_documents", input: { query: "TOTAL 合计" } }] },
      );
      const answer = await asked(model, worksheet(language, { struck: true }), question);
      expect(answer.text).toContain(said);
      expect(answer.text).not.toContain("[row 4");
    }
  });

  test("an Analysis reads every row, and names the set-aside ones it holds and a figure counts", async () => {
    // The code sums the whole Subtotal column, as a model's figure(df["Subtotal (kg)"], "sum") does.
    const runtime = createFakeAnalysisRuntime({
      answer: (job) => {
        const [input] = job.inputs;
        const rows = input?.kind === "table" ? (input.rowNumbers ?? []) : [];
        const at = input?.kind === "table" ? input.columns.indexOf("Subtotal (kg)") : -1;
        const cells = input?.kind === "table" ? input.rows.map((row) => row[at]) : [];
        const value = cells.reduce<number>(
          (sum, cell) => sum + (typeof cell === "number" ? cell : 0),
          0,
        );
        return {
          output: {
            results: [
              {
                kind: "figure",
                name: "total",
                label: "Total load",
                unit: null,
                value,
                of: {
                  input: "load",
                  columns: ["Subtotal (kg)"],
                  rows: [[rows[0] ?? 2, rows.at(-1) ?? 2]],
                  count: rows.length,
                  how: "sum",
                },
              },
            ],
          },
        };
      },
    });
    const model = scriptedModel((call) => {
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "Glass beads TOTAL" } }] };
      if (!call.results.some((result) => result.tool === "run_analysis")) {
        const passage = shownPassages(search.text)[0];
        const inputs = [{ name: "load", passage: passage?.id }];
        return {
          calls: [{ tool: "run_analysis", input: { title: "Load", inputs, code: "pass" } }],
        };
      }
      return { text: "Done." };
    });
    for (const [earlier, said] of [
      [{ struck: true }, "rows 2–4, which the file strikes through"],
      [{ hidden: true }, "rows 2–4, which the file hides"],
      [
        { struck: true, hidden: true },
        "rows 2–4, which the file strikes through, and rows 2–4, which the file hides",
      ],
      [{}, null],
    ] as const) {
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
      const path = await writeSourceFile(
        await createTempDataFolder(),
        "Load worksheet.xlsx",
        worksheet("en", earlier),
      );
      await addAndProcess(core, [path]);
      const result = await core.askInConversation({ text: "Sum the load." });
      if (!result.asked) throw new Error("The Question wasn't asked.");
      await answerEnded(core, result.answerId);
      core.close();
      const input = runtime.jobs.at(-1)?.inputs[0];
      expect(input?.kind === "table" ? input.rowNumbers : null).toEqual([2, 3, 4, 5, 6, 7]);
      const report = told(model, "run_analysis");
      expect(report).toContain("Total load");
      if (said) {
        expect(report).toContain(`it holds ${said}: drop such rows by their numbers`);
        expect(report).toContain(`it counts ${said}: never give it as the sheet's current figure`);
      } else {
        expect(report).not.toContain("it holds rows");
        expect(report).not.toContain("it counts rows");
      }
    }
  });

  test("calculate names each input it reads from a row the file sets aside", async () => {
    const model = scriptedModel((call) => {
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "Glass beads TOTAL" } }] };
      const passage = shownPassages(search.text)[0]?.id;
      const calculated = call.results.filter((result) => result.tool === "calculate").length;
      const figure = (rows: readonly [string, string]) => ({
        marker: calculated + 1,
        label: "Load",
        inputs: [
          { name: "a", passage, quote: rows[0], number: rows[0].split("\t").at(-1) },
          { name: "b", passage, quote: rows[1], number: rows[1].split("\t").at(-1) },
        ],
        formula: "a + b",
      });
      if (calculated === 0)
        return {
          calls: [
            {
              tool: "calculate",
              input: {
                figures: [
                  figure(["Glass beads\t0.125\t2\t0.25", "Control weights\t0.05\t3\t0.15"]),
                ],
              },
            },
          ],
        };
      if (calculated === 1)
        return {
          calls: [
            {
              tool: "calculate",
              input: {
                figures: [figure(["Glass beads\t0.075\t2\t0.15", "Control weights\t0.05\t2\t0.1"])],
              },
            },
          ],
        };
      return { text: "The load is [=2]." };
    });
    await asked(model, worksheet("en", { struck: true }), "What is the current total load?");
    const results = (model.doStreamCalls.at(-1)?.prompt ?? []).flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" &&
            part.toolName === "calculate" &&
            part.output.type === "text"
              ? [part.output.value]
              : [],
          )
        : [],
    );
    const [earlier, current] = results;
    expect(earlier).toContain("Recorded [=1] = 0.40");
    expect(earlier).toContain(
      "a is in row 2, which the file strikes through; b is in row 3, which the file strikes through",
    );
    expect(current).toContain("Recorded [=2] = 0.25");
    expect(current).not.toContain("which the file strikes through");
  });
});

test("a workbook's formula Tools say when a figure or the input changed is in a row the file sets aside", async () => {
  const money = (value: number) => ({ value, format: "0.00" as const });
  const cost = (row: number, value: number) => ({
    formula: `B${row}*C${row}`,
    value,
    format: "0.00" as const,
  });
  const file = sheetWithRows("Quote", [
    { cells: ["Item", "Unit cost", "Quantity", "Cost"] },
    { cells: ["Widgets", money(4), 20, cost(2, 80)], struck: true },
    { cells: ["Brackets", money(2.5), 8, cost(3, 20)], struck: true },
    {
      cells: ["Total", "", "", { formula: "SUM(D2:D3)", value: 100, format: "0.00" }],
      struck: true,
    },
    { cells: ["Widgets", money(3.6), 10, cost(5, 36)] },
    { cells: ["Brackets", money(2.5), 8, cost(6, 20)] },
    { cells: ["Total", "", "", { formula: "SUM(D5:D6)", value: 56, format: "0.00" }] },
  ]);
  const plan = (passage: string) => [
    { tool: "trace_formulas", input: { passage, cell: "Quote!D4", label: "Total" } },
    {
      tool: "what_if",
      input: {
        passage,
        cell: "Quote!D4",
        label: "Total",
        changes: [{ input: "Quote!C2", value: "15" }],
      },
    },
    { tool: "trace_formulas", input: { passage, cell: "Quote!D7", label: "Total" } },
    {
      tool: "what_if",
      input: {
        passage,
        cell: "Quote!D7",
        label: "Total",
        changes: [{ input: "Quote!C5", value: "15" }],
      },
    },
  ];
  const model = scriptedModel((call) => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search)
      return { calls: [{ tool: "search_documents", input: { query: "Widgets Brackets Total" } }] };
    const done = call.results.filter((result) => result.tool !== "search_documents").length;
    const next = plan(shownPassages(search.text)[0]?.id ?? "P1")[done];
    return next ? { calls: [next] } : { text: "Done." };
  });
  await asked(model, file, "What would the quote come to with 15 widgets?");
  const results = (model.doStreamCalls.at(-1)?.prompt ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" && part.output.type === "text" ? [part.output.value] : [],
        )
      : [],
  );
  const [earlierTrace, earlierWhatIf, currentTrace, currentWhatIf] = results.slice(-4);
  expect(earlierTrace).toContain(
    "Quote!D4, the figure, is in row 4, which the file strikes through",
  );
  expect(earlierTrace).toContain("(in row 2, which the file strikes through)");
  expect(earlierWhatIf).toContain(
    "Quote!C2, the input changed, is in row 2, which the file strikes through",
  );
  for (const result of [currentTrace, currentWhatIf]) {
    expect(result).toContain("Recorded [=");
    expect(result).not.toContain("which the file strikes through");
  }
});

test("a retry's excerpt that starts partway through a set-aside row keeps the row's mark", () => {
  const text = [
    "Item\tNote\tUnit mass (kg)\tQuantity",
    "[row 2, struck through] Glass beads\tWeighed on the old scale. Checked twice. Logged by the lab. Sent to the auditor.\t0.125\t2",
    "Glass beads\tWeighed on the new scale. Checked once. Logged by the lab. Sent to the buyer.\t0.075\t2",
  ].join("\n");
  const tokens = (each: string) => Math.ceil(each.length / 4);
  expect(
    nearestExcerpt(text, "Sent to the auditor.\t0.125\t2", "It was 0.125 kg.", 12, tokens),
  ).toBe("[row 2, struck through] Sent to the auditor.\t0.125\t2");
  expect(nearestExcerpt(text, "Sent to the buyer.\t0.075\t2", "It is 0.075 kg.", 12, tokens)).toBe(
    "Logged by the lab. Sent to the buyer.\t0.075\t2",
  );
});

test("a row struck through but for its revision's label, merged down beside it, is set aside", async () => {
  const file = xlsxPackage({
    sheets: [
      {
        name: "Load",
        xml: `<sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Item</t></is></c><c r="C1" t="inlineStr"><is><t>Mass</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Revision A</t></is></c><c r="B2" s="1" t="inlineStr"><is><t>Glass beads</t></is></c><c r="C2" s="1"><v>0.125</v></c></row><row r="3"><c r="B3" s="1" t="inlineStr"><is><t>TOTAL</t></is></c><c r="C3" s="1"><v>0.4</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>Revision B</t></is></c><c r="B4" t="inlineStr"><is><t>Glass beads</t></is></c><c r="C4" s="1"><v>0.075</v></c></row><row r="5"><c r="B5" t="inlineStr"><is><t>TOTAL</t></is></c><c r="C5"><v>0.25</v></c></row></sheetData><mergeCells count="2"><mergeCell ref="A2:A3"/><mergeCell ref="A4:A5"/></mergeCells>`,
      },
    ],
    styles: `<fonts count="2"><font><sz val="11"/></font><font><strike/><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0" fontId="0"/><xf numFmtId="0" fontId="1" applyFont="1"/></cellXfs>`,
  });
  // Row 4's struck mass beside a plain item is a cell struck in a current row, not a row set aside.
  expect(linesOf(await shownToModel("en", file, "Glass beads TOTAL"))).toEqual([
    "Item\tMass",
    "[row 2, struck through] Revision A\tGlass beads\t0.125",
    "[row 3, struck through] \tTOTAL\t0.4",
    "Revision B\tGlass beads\t0.075",
    "\tTOTAL\t0.25",
  ]);
});

test("rows an AutoFilter hides are read as ordinary rows, and a row hidden outside it is set aside", async () => {
  const file = xlsxPackage({
    sheets: [
      {
        name: "Expenses",
        xml: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Taxi</t></is></c><c r="B2"><v>18.4</v></c></row><row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Lunch</t></is></c><c r="B3"><v>12.5</v></c></row><row r="4" hidden="1"><c r="A4" t="inlineStr"><is><t>Hotel</t></is></c><c r="B4"><v>140</v></c></row></sheetData><autoFilter ref="A1:B3"><filterColumn colId="0"><filters><filter val="Taxi"/></filters></filterColumn></autoFilter>`,
      },
    ],
  });
  expect(linesOf(await shownToModel("en", file, "Taxi Lunch Hotel"))).toEqual([
    "Item\tAmount",
    "Taxi\t18.4",
    "Lunch\t12.5",
    "[row 4, hidden] Hotel\t140",
  ]);
});

test("a mark the assistant copies into a Note is said in words there too", async () => {
  const model = scriptedModel((call) => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search)
      return { calls: [{ tool: "search_documents", input: { query: "Glass beads TOTAL" } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const passage = shownPassages(search.text)[0]?.id;
      const record = { marker: 1, passage, quote: "TOTAL\t\t\t0.4" };
      return { calls: [{ tool: "cite", input: { citations: [record] } }] };
    }
    if (!call.results.some((result) => result.tool === "add_to_mind")) {
      const content = "The earlier total was 0.4 kg [row 4, struck through] [^1].";
      return { calls: [{ tool: "add_to_mind", input: { content } }] };
    }
    return { text: "I added the earlier total, 0.4 kg [row 4, struck through], to the Note." };
  });
  const { core, mind, client } = await setUpWithDocuments(model, [
    { name: "Load worksheet.xlsx", contents: worksheet("en", { struck: true }) },
  ]);
  const answer = await askAssistant(core, { text: "Note the earlier total.", mindId: mind.id });
  await client.settled();
  expect(answer.text).toContain(
    "the earlier total, 0.4 kg (struck through in the file), to the Note",
  );
  const written = readMind(client).textContent;
  expect(written).toContain("The earlier total was 0.4 kg (struck through in the file)");
  expect(written).not.toContain("[row 4");
  core.close();
});

describe("a model that answers in one pass, without Tools", () => {
  const WRITTEN = "The earlier total was 0.4 kg [row 4, struck through].";
  const SAID = "The earlier total was 0.4 kg (struck through in the file).";

  /** `modelId` on its provider refuses Tools; the catalog says whether it can still give JSON. */
  async function answered(kind: "anthropic" | "openai", modelId: string, reply: string) {
    const systems: string[] = [];
    const model = scriptedModel((call) => {
      if (call.tools.length > 0)
        return { error: { status: 400, message: "This model does not support tools" } };
      systems.push(call.system);
      return { text: reply };
    });
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
      answerPaths: { retrievesFirst: () => false },
    });
    const saved = await core.saveChatProvider({ kind, apiKey: "sk-test", modelId });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const path = await writeSourceFile(
      await createTempDataFolder(),
      "Load worksheet.xlsx",
      worksheet("en", { struck: true }),
    );
    await addAndProcess(core, [path]);
    const result = await core.askInConversation({ text: "What was the earlier total load?" });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    const ended = await answerEnded(core, result.answerId);
    const { messages } = await core.getConversation(result.conversation.id);
    core.close();
    const answer = messages.find((message) => message.id === result.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");
    return { answer, systems, ended };
  }

  test("in structured output, it reads what a row's mark means, and a mark it copies is said in words", async () => {
    const reply = JSON.stringify({ answer: WRITTEN, citations: [] });
    const { answer, systems, ended } = await answered("anthropic", "claude-haiku-5-5", reply);
    expect(ended).toMatchObject({ payload: { citationSupport: "structured-output" } });
    expect(systems.some((system) => system.includes("[row 4, struck through] TOTAL"))).toBe(true);
    expect(systems.some((system) => system.includes(NOTE))).toBe(true);
    expect(answer.text).toContain(SAID);
    expect(answer.text).not.toContain("[row 4");
  });

  test("in a plain Answer, it reads what a row's mark means, and a mark it copies is said in words", async () => {
    const { answer, systems, ended } = await answered("openai", "gpt-4-turbo", WRITTEN);
    expect(ended).toMatchObject({ payload: { citationSupport: "none" } });
    expect(systems.some((system) => system.includes("[row 4, struck through] TOTAL"))).toBe(true);
    expect(systems.some((system) => system.includes(NOTE))).toBe(true);
    expect(answer.text).toContain(SAID);
    expect(answer.text).not.toContain("[row 4");
  });
});

describe("filters, as Excel and LibreOffice keep them", () => {
  const rows = `<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Taxi</t></is></c><c r="B2"><v>18.4</v></c></row><row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Lunch</t></is></c><c r="B3"><v>12.5</v></c></row><row r="4" hidden="1"><c r="A4" t="inlineStr"><is><t>Hotel</t></is></c><c r="B4"><v>140</v></c></row>`;
  const criterion = `<filterColumn colId="0"><filters><filter val="Taxi"/></filters></filterColumn>`;
  const shown = async (file: Buffer) => linesOf(await shownToModel("en", file, "Taxi Lunch Hotel"));
  const expected = ["Item\tAmount", "Taxi\t18.4", "Lunch\t12.5", "[row 4, hidden] Hotel\t140"];

  test("a custom view's filter after the sheet's own doesn't replace it", async () => {
    const file = xlsxPackage({
      sheets: [
        {
          name: "Expenses",
          xml: `<sheetData>${rows}</sheetData><autoFilter ref="A1:B3">${criterion}</autoFilter><customSheetViews><customSheetView guid="{00000000-0000-0000-0000-000000000001}"><autoFilter ref="A1:B4"/></customSheetView></customSheetViews>`,
        },
      ],
    });
    expect(await shown(file)).toEqual(expected);
  });

  test("with the sheet's filter on, a row hidden outside the filter's range is still set aside", async () => {
    const file = xlsxPackage({
      sheets: [
        {
          name: "Expenses",
          xml: `<sheetPr filterMode="1"/><sheetData>${rows}</sheetData><autoFilter ref="A1:B3">${criterion}</autoFilter>`,
        },
      ],
    });
    expect(await shown(file)).toEqual(expected);
  });

  test("rows a Table's own filter hides are read as ordinary rows", async () => {
    const file = xlsxPackage({
      sheets: [
        {
          name: "Expenses",
          xml: `<sheetData>${rows}</sheetData><tableParts count="1"><tablePart r:id="rIdT1"/></tableParts>`,
          rels: `<Relationship Id="rIdT1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>`,
        },
      ],
      parts: [
        {
          name: "xl/tables/table1.xml",
          data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Expenses" displayName="Expenses" ref="A1:B3"><autoFilter ref="A1:B3">${criterion}</autoFilter><tableColumns count="2"><tableColumn id="1" name="Item"/><tableColumn id="2" name="Amount"/></tableColumns></table>`,
        },
      ],
    });
    expect(await shown(file)).toEqual(expected);
  });
});

test("a revision's label written once above its struck rows sets its first row aside too", async () => {
  const file = sheetWithRows("Load", [
    { cells: ["Revision", "Item", "Unit mass (kg)", "Quantity", "Subtotal (kg)"] },
    { cells: ["A (superseded)", "Glass beads", 0.125, 2, 0.25], struck: [1, 2, 3, 4] },
    { cells: ["", "Control weights", 0.05, 3, 0.15], struck: true },
    { cells: ["", "TOTAL", "", "", 0.4], struck: true },
    { cells: ["B (current)", "Glass beads", 0.075, 2, 0.15] },
    { cells: ["", "Control weights", 0.05, 2, 0.1] },
    { cells: ["", "TOTAL", "", "", 0.25] },
  ]);
  expect(linesOf(await shownToModel("en", file))).toEqual([
    "Revision\tItem\tUnit mass (kg)\tQuantity\tSubtotal (kg)",
    "[row 2, struck through] A (superseded)\tGlass beads\t0.125\t2\t0.25",
    "[row 3, struck through] \tControl weights\t0.05\t3\t0.15",
    "[row 4, struck through] \tTOTAL\t\t\t0.4",
    "B (current)\tGlass beads\t0.075\t2\t0.15",
    "\tControl weights\t0.05\t2\t0.1",
    "\tTOTAL\t\t\t0.25",
  ]);
});

test("a retry's excerpt of a Passage whose set-aside rows aren't marked line by line keeps saying so", () => {
  const warning = "[rows the file sets aside, not marked line by line: rows 30–31 struck through]";
  const text = [
    warning,
    ...Array.from({ length: 28 }, (_, index) => `Filler line ${index + 1}\t${index}`),
    "Glass beads\t0.125\t2",
    "Glass beads\t0.075\t2",
  ].join("\n");
  const tokens = (each: string) => Math.ceil(each.length / 4);
  const excerpt = nearestExcerpt(text, "Glass beads\t0.125\t2", "It was 0.125 kg.", 24, tokens);
  expect(excerpt.startsWith(`${warning}\n`)).toBe(true);
  expect(excerpt).toContain("Glass beads\t0.125\t2");
  expect(excerpt).not.toContain("Filler line 1\t");
});

test("a Passage found twice in its Units with other marks, or not at all, names its set-aside rows instead", () => {
  const units = [
    {
      page: 1,
      kind: "rows" as const,
      label: { sheet: "Load", from: 1, to: 4, rows: [1, 2, 3, 4], column: 0, struckRows: [4] },
      text: "Item\tQty\nBeads\t2\nWeights\t3\nBeads\t2",
    },
  ];
  const unplaced = "[rows the file sets aside, not marked line by line: row 4 struck through]";
  expect(withSetAsideMarks("Beads\t2", "Beads\t2", units)).toBe(`${unplaced}\nBeads\t2`);
  expect(withSetAsideMarks("Pins\t9", "Pins\t9", units)).toBe(`${unplaced}\nPins\t9`);
  expect(withSetAsideMarks("Weights\t3\nBeads\t2", "Weights\t3\nBeads\t2", units)).toBe(
    "Weights\t3\n[row 4, struck through] Beads\t2",
  );
  expect(withSetAsideMarks("Item\tQty\nBeads\t2", "Item\tQty\nBeads\t2", units)).toBe(
    "Item\tQty\nBeads\t2",
  );
  expect(setAsideRowsNote(unplaced)).toContain("none of them is known to be current");
  expect(setAsideRowsNote("[row 4, struck through] Beads\t2")).not.toContain("known to be current");
});

test.each([
  [
    "a claim check's request for evidence",
    (passage: string) =>
      evidencePrompt({
        claim: "The total is 0.4 kg.",
        verdict: "unsupported",
        says: null,
        passages: [{ id: "P1", text: passage }],
      }),
  ],
  [
    "a contradiction's confirmation",
    (passage: string) =>
      confirmPrompt({ claim: "The total is 0.25 kg.", quote: "TOTAL\t\t\t0.4", passage }),
  ],
  [
    "a look for what a sentence says is absent",
    (passage: string) =>
      presencePrompt({
        claim: "The sheet has no total.",
        absent: "a total",
        quote: "TOTAL\t\t\t0.4",
        document: "Load",
        passage,
      }),
  ],
  [
    "the request for exact quotes",
    (passage: string) =>
      quoteRetryPrompt([
        {
          marker: 1,
          sentence: "The total is 0.4 kg.",
          quote: "TOTAL 0.4",
          passage: "P1",
          text: passage,
        },
      ]),
  ],
  [
    "the request to fix figures",
    (passage: string) =>
      figureRetryPrompt([
        {
          marker: 1,
          given: "{}",
          problems: ["No such quote."],
          passages: [{ id: "P1", text: passage }],
        },
      ]),
  ],
])("%s says what a set-aside row's mark means, only when one is shown", (_name, prompt) => {
  const meaning = setAsideRowsMeaning("[row 4, struck through]");
  expect(prompt("[row 4, struck through] TOTAL\t\t\t0.4\nTOTAL\t\t\t0.25")).toContain(meaning);
  expect(prompt("TOTAL\t\t\t0.4\nTOTAL\t\t\t0.25")).not.toContain(meaning);
});
