import { describe, expect, test } from "vitest";
import type { Core, SearchScope } from "../../src/core";
import { unreadAskKey } from "../../src/shared/unreadFiles";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, linkAndProcess, writeSourceFile } from "../helpers/documents";

/*
 * A Folder of the Library names the files not read from the folders on disk its filed Documents
 * are in (#740), so filing a Document, moving it, or moving a Folder changes what its line names.
 * The window asks again when `unreadAskKey` changes (#2789), so each of those has to change it, and
 * a Document that can't change the line must not.
 */

const keyOf = async (core: Core) =>
  unreadAskKey(await core.listDocuments(), await core.listLinkedFolders(), await core.getLibrary());
const scopeOf = (folderId: string): SearchScope => ({
  folderIds: [folderId],
  tagIds: [],
  documentIds: [],
});
const names = async (core: Core, folderId: string) =>
  (await core.listUnreadFiles(scopeOf(folderId))).map((file) => file.name).sort();
const documentNamed = async (core: Core, name: string) => {
  const found = (await core.listDocuments()).find((document) => document.name === name);
  if (!found) throw new Error(`${name} wasn't added.`);
  return found;
};

async function harbour(files: Record<string, string>) {
  const core = startCore(await createTempDataFolder());
  const folder = await createSourceFolder();
  for (const [path, contents] of Object.entries(files)) {
    await writeSourceFile(folder, path, contents);
  }
  await linkAndProcess(core, folder);
  const group = (name: string, parentId?: string) =>
    core.createLibraryGroup({ name, description: "", ...(parentId && { parentId }) });
  return { core, group };
}

const beside = {
  "Old/Tides.md": "# Tides\n\nSpring tides happen at new moon.\n",
  "Old/Contract.doc": "binary",
};

describe("When a Document beside a file not read is filed, the line follows", () => {
  test("filing it into a Folder, and out of it", async () => {
    const { core, group } = await harbour(beside);
    const harbourFolder = await group("Harbour");
    const tides = await documentNamed(core, "Tides");
    expect(await names(core, harbourFolder.id)).toEqual([]);
    const empty = await keyOf(core);

    await core.assignDocumentGroup(tides.id, harbourFolder.id);
    expect(await names(core, harbourFolder.id)).toEqual(["Contract.doc"]);
    const filed = await keyOf(core);
    expect(filed).not.toBe(empty);

    await core.assignDocumentGroup(tides.id, null);
    expect(await names(core, harbourFolder.id)).toEqual([]);
    expect(await keyOf(core)).not.toBe(filed);
  });

  test("moving it between a Folder's subfolders", async () => {
    const { core, group } = await harbour(beside);
    const harbourFolder = await group("Harbour");
    const north = await group("North", harbourFolder.id);
    const south = await group("South", harbourFolder.id);
    const tides = await documentNamed(core, "Tides");
    await core.assignDocumentGroup(tides.id, north.id);
    expect(await names(core, north.id)).toEqual(["Contract.doc"]);
    expect(await names(core, south.id)).toEqual([]);
    const before = await keyOf(core);

    await core.assignDocumentGroup(tides.id, south.id);

    expect(await names(core, north.id)).toEqual([]);
    expect(await names(core, south.id)).toEqual(["Contract.doc"]);
    expect(await names(core, harbourFolder.id)).toEqual(["Contract.doc"]);
    expect(await keyOf(core)).not.toBe(before);
  });

  test("moving the Folder that holds it out of the Folder an Answer was asked in", async () => {
    const { core, group } = await harbour(beside);
    const harbourFolder = await group("Harbour");
    const north = await group("North", harbourFolder.id);
    await core.assignDocumentGroup((await documentNamed(core, "Tides")).id, north.id);
    expect(await names(core, harbourFolder.id)).toEqual(["Contract.doc"]);
    const before = await keyOf(core);

    await core.updateLibraryGroup(north.id, { name: "North", description: "", parentId: null });

    expect(await names(core, harbourFolder.id)).toEqual([]);
    expect(await keyOf(core)).not.toBe(before);
  });

  test("a Document of a Linked folder holding no file not read, filed into the Folder, changes nothing", async () => {
    const { core, group } = await harbour(beside);
    const other = await createSourceFolder();
    await writeSourceFile(other, "Notes.md", "# Notes\n\nHigh water.\n");
    await linkAndProcess(core, other);
    const quiet = await group("Quiet");
    const before = await keyOf(core);

    await core.assignDocumentGroup((await documentNamed(core, "Notes")).id, quiet.id);

    expect(await names(core, quiet.id)).toEqual([]);
    expect(await keyOf(core)).toBe(before);
  });
});

describe("When a Document that failed is filed, the line follows", () => {
  test("filing it into a Folder, and out of it", async () => {
    const { core, group } = await harbour({
      "Tides.md": "# Tides\n\nSpring tides happen at new moon.\n",
      "Broken.pdf": "This is not a PDF at all.",
    });
    const harbourFolder = await group("Harbour");
    const broken = await documentNamed(core, "Broken");
    expect(broken.status).toBe("failed");
    expect(await names(core, harbourFolder.id)).toEqual([]);
    const empty = await keyOf(core);

    await core.assignDocumentGroup(broken.id, harbourFolder.id);
    expect(await names(core, harbourFolder.id)).toEqual(["Broken.pdf"]);
    const filed = await keyOf(core);
    expect(filed).not.toBe(empty);

    await core.assignDocumentGroup(broken.id, null);
    expect(await names(core, harbourFolder.id)).toEqual([]);
    expect(await keyOf(core)).not.toBe(filed);
  });
});
