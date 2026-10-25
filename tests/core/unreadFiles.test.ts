import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
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
