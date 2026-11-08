import { describe, expect, test } from "vitest";
import type { Core, SearchScope } from "../../src/core";
import { unreadAskKey } from "../../src/shared/unreadFiles";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  createSourceFolder,
  linkAndProcess,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";

/*
 * The window asks again for a scope's unread files when `unreadAskKey` of its Documents and Linked
 * folders changes (#2772). A Document added to or taken from a Linked folder holding a file not read
 * can change a Folder's answer, so it changes the key; one in any other Linked folder can't, so it
 * doesn't. Filing a Document into a Folder changes neither key, here or before (#2789).
 */

const keyOf = async (core: Core) =>
  unreadAskKey(await core.listDocuments(), await core.listLinkedFolders());
const names = async (core: Core, scope: SearchScope) =>
  (await core.listUnreadFiles(scope)).map((file) => file.name).sort();

async function harbour() {
  const core = startCore(await createTempDataFolder());
  const folder = await createSourceFolder();
  await writeSourceFile(folder, "Tides.md", "# Tides\n\nSpring tides happen at new moon.\n");
  await writeSourceFile(folder, "Old/Contract.doc", "binary");
  const group = await core.createLibraryGroup({ name: "Harbour", description: "" });
  await linkAndProcess(core, folder, { groupId: group.id });
  const scope: SearchScope = { folderIds: [group.id], tagIds: [], documentIds: [] };
  return { core, groupId: group.id, scope, folder };
}

describe("When a Folder's unread files can change, so does what the window watches", () => {
  test("taking out the Document beside a file not read changes both", async () => {
    const { core, scope } = await harbour();
    expect(await names(core, scope)).toEqual(["Contract.doc"]);
    const before = await keyOf(core);
    const tides = (await core.listDocuments()).find((document) => document.name === "Tides");
    if (!tides) throw new Error("Tides wasn't added.");
    await core.deleteDocuments([tides.id]);
    expect(await names(core, scope)).toEqual([]);
    expect(await keyOf(core)).not.toBe(before);
  });

  test("a Document added beside a file not read changes the key", async () => {
    const { core, folder } = await harbour();
    const before = await keyOf(core);
    await writeSourceFile(
      folder,
      "Old/Lamps.md",
      "# Lamps\n\nThe harbour lamps were lit at dusk.\n",
    );
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      const found = documents.filter((document) => document.name === "Lamps");
      expect(found.map((document) => document.status)).toEqual(["ready"]);
    });
    expect(await keyOf(core)).not.toBe(before);
  });

  test("Documents of a Linked folder holding no unread file, filed into the Folder, change neither", async () => {
    const { core, groupId, scope } = await harbour();
    const other = await createSourceFolder();
    await writeSourceFile(other, "Notes 1.md", "# Notes 1\n\nHigh water 1.\n");
    await linkAndProcess(core, other);
    const before = await keyOf(core);
    for (let i = 2; i <= 4; i++) {
      await writeSourceFile(other, `Deep/Notes ${i}.md`, `# Notes ${i}\n\nHigh water ${i}.\n`);
    }
    await core.reconcileDocuments();
    const notes = await waitForDocuments(core, (documents) => {
      const found = documents.filter((document) => document.name.startsWith("Notes"));
      expect(found.map((document) => document.status)).toEqual([
        "ready",
        "ready",
        "ready",
        "ready",
      ]);
    }).then((documents) => documents.filter((document) => document.name.startsWith("Notes")));
    for (const note of notes) await core.assignDocumentGroup(note.id, groupId);
    expect(await names(core, scope)).toEqual(["Contract.doc"]);
    expect(await keyOf(core)).toBe(before);
  });
});
