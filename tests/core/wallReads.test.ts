import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import type { SqlValue } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

/**
 * The Library reads a move costs do not grow with the number of Folders behind a wall (#246):
 * the Folder → nearest-wall map is built once per change and reused, so the same move reads the
 * Folders as many times in a Library of 100 as in one of 10.
 */

const reads = { groups: 0 };

vi.mock("../../src/core/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/storage")>();
  return {
    ...original,
    openDatabase: (path: string) => {
      const db = original.openDatabase(path);
      return {
        ...db,
        all: (sql: string, params?: readonly SqlValue[]) => {
          if (/FROM library_groups/i.test(sql)) reads.groups += 1;
          return db.all(sql, params);
        },
      };
    },
  };
});

/** A Library of `folders` Folders: a wall holding three Documents, and a sub-Folder to file them in. */
async function libraryOf(folders: number) {
  const core: Core = startCore(await createTempDataFolder());
  for (let index = 0; index < folders - 2; index += 1) {
    await core.createLibraryGroup({ name: `Folder ${index}`, description: "" });
  }
  const wall = await core.createLibraryGroup({ name: "Client A", description: "" });
  await core.updateLibraryGroup(wall.id, {
    name: wall.name,
    description: wall.description,
    keepInside: true,
  });
  const drafts = await core.createLibraryGroup({
    name: "Drafts",
    description: "",
    parentId: wall.id,
  });
  const files = await Promise.all(
    ["One", "Two", "Three"].map(async (name) => {
      const folder = await createTempDataFolder();
      return writeSourceFile(folder, `${name}.txt`, `${name}: the client's terms.`);
    }),
  );
  const documents = await addAndProcess(core, files);
  for (const document of documents) await core.assignDocumentGroup(document.id, wall.id);
  return { core, wall, drafts, documentIds: documents.map((each) => each.id) };
}

/** The Library reads one move of the three Documents into the wall's sub-Folder makes. */
async function readsOfMove(folders: number): Promise<number> {
  const { core, wall, drafts, documentIds } = await libraryOf(folders);
  reads.groups = 0;
  await core.moveToFolder({ documentIds, folderId: drafts.id, wall: wall.id });
  return reads.groups;
}

describe("the Library reads a walled move costs", () => {
  test("the same move reads the Folders as often with 100 Folders as with 10", async () => {
    const small = await readsOfMove(10);
    const big = await readsOfMove(100);
    expect(big).toBe(small);
  }, 60_000);
});
