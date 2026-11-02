/**
 * A sheet that holds an older and a current version of the same rows (#1979): the file strikes
 * the older rows through or hides them, or nothing says which is current. What the model is shown
 * of the sheet names the rows the file sets aside and the rows that give one item different
 * figures, with what they mean, so an Answer about the current state never takes a set-aside row
 * for a current one, nor guesses from the rows' order.
 */
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { scriptedModel, scriptedModels } from "../helpers/models";
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

function searchingModel(query: string): MockLanguageModelV4 {
  return scriptedModel((call) =>
    call.results.some((result) => result.tool === "search_documents")
      ? { text: "Done." }
      : { calls: [{ tool: "search_documents", input: { query } }] },
  );
}

/** What the last request showed the model from its searches. */
function searchResult(model: MockLanguageModelV4): string {
  const texts: string[] = [];
  for (const message of model.doStreamCalls.at(-1)?.prompt ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content)
      if (
        part.type === "tool-result" &&
        part.toolName === "search_documents" &&
        part.output.type === "text"
      )
        texts.push(part.output.value);
  }
  return texts.join("\n");
}

async function shownToModel(language: Language, file: Buffer, dataDir?: string): Promise<string> {
  const { items, question } = LANGUAGES[language];
  const model = searchingModel(items.join(" "));
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
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
  const asked = await core.askInConversation({ text: question });
  if (!asked.asked) throw new Error("The Question wasn't asked.");
  await answerEnded(core, asked.answerId);
  core.close();
  return searchResult(model);
}

const passageTag = (result: string) => /<passage [^>]*>/.exec(result)?.[0] ?? "";

describe.each(["en", "zh-CN"] as const)("%s", (language) => {
  test("the rows the file strikes through are named on their Passage, with what that means", async () => {
    const result = await shownToModel(language, worksheet(language, { struck: true }));
    expect(passageTag(result)).toContain('struck="rows 2–4"');
    expect(passageTag(result)).not.toContain("hidden=");
    expect(result).toContain(
      "A figure from one is never the sheet's current figure; give it only as an earlier or removed one, and say the file strikes it through.",
    );
  });

  test("the rows the file hides are named on their Passage, with what that means", async () => {
    const result = await shownToModel(language, worksheet(language, { hidden: true }));
    expect(passageTag(result)).toContain('hidden="rows 2–4"');
    expect(passageTag(result)).not.toContain("struck=");
    expect(result).toContain(
      "Where a hidden row and a shown one give one item different figures, the shown one is the figure the sheet shows now",
    );
  });

  test("rows that give one item different figures are named, and the Answer is told not to guess which is current", async () => {
    const result = await shownToModel(language, worksheet(language));
    expect(passageTag(result)).toContain('repeated="rows 2 and 5; rows 3 and 6; rows 4 and 7"');
    expect(passageTag(result)).not.toMatch(/struck=|hidden=/);
    expect(result).toContain(
      "Such rows are usually separate entries, to list or add up as the Question asks. Only a Question about the item as it stands now, or about what changed, makes them an earlier and a later version of it",
    );
    expect(result).toContain(
      "if nothing does, say that the Document doesn't make clear which row is current, give each with its Citation, and never take one for the current figure by its place in the sheet.",
    );
  });

  test("rows a status in their own cells tells apart, and a sheet with one version, are named as nothing", async () => {
    const { sheet, head, items } = LANGUAGES[language];
    const [beads, weights] = items;
    const statused = await shownToModel(
      language,
      sheetWithRows(sheet, [
        { cells: ["Revision", ...head] },
        { cells: ["A", beads, 0.125, 2, 0.25] },
        { cells: ["B", beads, 0.075, 2, 0.15] },
        { cells: ["B", weights, 0.05, 2, 0.1] },
      ]),
    );
    const single = await shownToModel(
      language,
      sheetWithRows(sheet, [
        { cells: [...head] },
        { cells: [beads, 0.075, 2, 0.15] },
        { cells: [weights, 0.05, 2, 0.1] },
      ]),
    );
    for (const result of [statused, single]) {
      expect(passageTag(result)).toContain('location="');
      expect(passageTag(result)).not.toMatch(/struck=|hidden=|repeated=/);
      expect(result).not.toContain('In a Passage marked repeated="…"');
    }
  });
});

test("a workbook read before the file's struck-through and hidden rows were named is read again and names them", async () => {
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
