import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { UnreadFile, UnreadParts } from "../../src/core";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { translate } from "../../src/shared/i18n";
import { unreadCountText, unreadFileText, unreadPartsCounts } from "../../src/shared/unreadFiles";
import { createTempDataFolder, NO_MODEL_FILES, startCore } from "../helpers/core";
import { createSourceFolder, linkAndProcess, writeSourceFile } from "../helpers/documents";
import { encryptedOfficeFile } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

/**
 * The files in a Search scope that couldn't be read, and why (#740): a
 * Linked folder with a .doc, a password-protected .docx and a scan, besides
 * a file that reads.
 */
describe("listUnreadFiles", () => {
  async function folderWithUnreadFiles() {
    const library = await createSourceFolder();
    await writeSourceFile(library, "Notes.md", "Spring tides happen at new moon.\n");
    await writeSourceFile(library, "Old/Contract.doc", "binary");
    await writeSourceFile(library, "Old/Budget.XLS", "binary");
    await writeSourceFile(library, "Locked.docx", encryptedOfficeFile());
    await writeSourceFile(library, "Scan.pdf", buildPdf([{ image: true }]));
    await writeSourceFile(library, "Broken.pdf", "This is not a PDF at all.");
    await writeSourceFile(library, "Picture.png", "not read, not a Document either");
    const core = startCore(await createTempDataFolder());
    await linkAndProcess(core, library);
    return { core };
  }

  test("names each file with its reason, by name: a format not read, a password, a scan, damage", async () => {
    const { core } = await folderWithUnreadFiles();

    const unread = await core.listUnreadFiles(null);

    expect(unread.map(({ name, reason, extension }) => ({ name, reason, extension }))).toEqual([
      { name: "Broken.pdf", reason: "damaged", extension: null },
      { name: "Budget.XLS", reason: "format", extension: ".xls" },
      { name: "Contract.doc", reason: "format", extension: ".doc" },
      { name: "Locked.docx", reason: "password", extension: null },
      { name: "Scan.pdf", reason: "scan", extension: null },
    ]);
    expect((await core.listLinkedFolders())[0]?.unsupportedFiles).toBe(2);
  });

  test("only what is in the scope: a Folder, a Tag or a Document", async () => {
    const { core } = await folderWithUnreadFiles();
    const folders = await core.listFolders();
    const old = folders.find((each) => each.relativePath === "");
    const documents = await core.listDocuments();
    const locked = documents.find((each) => each.name === "Locked");
    expect(documents.length).toBeGreaterThan(0);

    const inAll = await core.listUnreadFiles({
      folderIds: [old?.id ?? ""],
      tagIds: [],
      documentIds: [],
    });
    expect(inAll.map((file) => file.name).sort()).toEqual([
      "Broken.pdf",
      "Budget.XLS",
      "Contract.doc",
      "Locked.docx",
      "Scan.pdf",
    ]);

    const one = await core.listUnreadFiles({
      folderIds: [],
      tagIds: [],
      documentIds: [locked?.id ?? ""],
    });
    expect(one.map((file) => file.name)).toEqual(["Locked.docx"]);

    // A Document alone names no file in a format not read.
    const notes = documents.find((each) => each.name === "Notes");
    expect(
      await core.listUnreadFiles({ folderIds: [], tagIds: [], documentIds: [notes?.id ?? ""] }),
    ).toEqual([]);
  });

  test("a scan some of whose pages weren't read is named with those pages (#485)", async () => {
    const picture = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));
    const recognizer = createFakeTextRecognizer({
      script: { pages: { 1: { lines: ["Tariff schedule"] }, 3: { fail: "Failed on this page." } } },
    });
    const library = await createSourceFolder();
    await writeSourceFile(library, "Notes.md", "Spring tides happen at new moon.\n");
    await writeSourceFile(
      library,
      "Tariffs.pdf",
      buildPdf([{ scan: picture }, { scan: picture }, { scan: picture }]),
    );
    const core = startCore(await createTempDataFolder(), {
      textRecognizer: recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const documents = await linkAndProcess(core, library);
    const notes = documents.find((each) => each.name === "Notes");

    expect(await core.listUnreadFiles(null)).toMatchObject([
      { name: "Tariffs.pdf", reason: "pages", pages: [3] },
    ]);
    expect(
      await core.listUnreadFiles({ folderIds: [], tagIds: [], documentIds: [notes?.id ?? ""] }),
    ).toEqual([]);
  });

  test("nothing when everything in scope was read", async () => {
    const library = await createSourceFolder();
    await writeSourceFile(library, "Notes.md", "Spring tides happen at new moon.\n");
    const core = startCore(await createTempDataFolder());
    await linkAndProcess(core, library);
    expect(await core.listUnreadFiles(null)).toEqual([]);
  });
});

/** The line an Answer, a check and an export show, and each file's line with its reason. */
describe("unreadCountText and unreadFileText", () => {
  const file = (name: string): UnreadFile => ({
    id: name,
    name,
    reason: "format",
    extension: ".doc",
    documentId: null,
    pages: [],
  });

  test.each([
    ["en", 1, "1 file couldn’t be read"],
    ["en", 3, "3 files couldn’t be read"],
    ["zh-CN", 1, "1 个文件未能读取"],
    ["zh-CN", 3, "3 个文件未能读取"],
  ] as const)("says the count in %s: %i", (language, count, said) => {
    const files = Array.from({ length: count }, (_, index) => file(`Old ${index}.doc`));
    expect(unreadCountText(files, (key, params) => translate(language, key, params))).toBe(said);
  });

  test("names a file and why it couldn't be read, in English and Chinese", () => {
    expect(
      unreadFileText(file("Contract.doc"), (key, params) => translate("en", key, params)),
    ).toBe(
      "Contract.doc: Format not read yet (.doc). Convert it to PDF, Word, PowerPoint or Excel.",
    );
    expect(
      unreadFileText(file("Contract.doc"), (key, params) => translate("zh-CN", key, params)),
    ).toBe("Contract.doc：暂不支持此格式（.doc）。请转换为 PDF、Word、PowerPoint 或 Excel。");
  });
});

/** A workbook read in part says which sheets and rows weren't read (#740). */
describe("what a workbook didn't read", () => {
  const budget = (parts: UnreadParts): UnreadFile => ({
    id: "budget",
    name: "Budget 2026.xlsx",
    reason: "parts",
    extension: null,
    documentId: "budget",
    pages: [],
    parts,
  });
  const t =
    (language: "en" | "zh-CN") =>
    (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
  const parts: UnreadParts = {
    hiddenSheets: ["Q3 raw"],
    rowsCut: [{ sheet: "Planning", from: 5001 }],
    sheetsNotRead: ["Later"],
  };

  test("names the hidden sheets and each sheet's unread rows, in English and Chinese", () => {
    expect(unreadFileText(budget(parts), t("en"))).toBe(
      "Budget 2026.xlsx: the hidden sheet “Q3 raw” wasn’t read; “Planning”: rows 5,001+ weren’t read; “Later”: the whole sheet wasn’t read",
    );
    expect(unreadFileText(budget(parts), t("zh-CN"))).toBe(
      "Budget 2026.xlsx：隐藏工作表“Q3 raw”未读取；“Planning”：第 5,001 行及之后的内容未读取；“Later”：整张工作表未读取",
    );
  });

  test("counts them for the AI use statement, which names no file", () => {
    const two: UnreadParts = {
      hiddenSheets: ["Q3 raw", "Q4 raw"],
      rowsCut: [{ sheet: "Planning", from: 5001 }],
      sheetsNotRead: [],
    };
    expect(unreadPartsCounts([budget(two), budget(parts)], t("en"))).toEqual([
      "3 hidden sheets weren’t read",
      "3 sheets have rows that weren’t read",
    ]);
  });
});
