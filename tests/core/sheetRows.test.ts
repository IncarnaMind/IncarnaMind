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
import { openDatabase } from "../../src/core/storage";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
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
      db.run("UPDATE documents SET processing_version = 22 WHERE id = ?", [document.id]);
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
