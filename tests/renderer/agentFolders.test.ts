import { describe, expect, test } from "vitest";
import {
  type Document,
  type DocumentGroupAssignment,
  type LibraryGroup,
  NOT_IN_A_FOLDER_ID,
} from "../../src/core/api";
import { agentFolderRows, onlyNotInAFolder } from "../../src/renderer/src/agentFolders";

let next = 0;
const doc = (): Document => ({ id: `doc-${++next}` }) as Document;

const folder = (id: string, name = id): LibraryGroup => ({
  id,
  name,
  description: "",
  countsOwnFiles: false,
  keepInside: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const filed = (document: Document, groupId: string | null) =>
  ({ documentId: document.id, groupId }) satisfies Pick<
    DocumentGroupAssignment,
    "documentId" | "groupId"
  >;

describe("what an agent may be allowed to read", () => {
  const board = folder("board", "Board");
  const finance = folder("finance", "Finance");

  test("lists the Folders in order, with their Documents, then Not in a Folder", () => {
    const [a, b, c, d] = [doc(), doc(), doc(), doc()] as [Document, Document, Document, Document];
    const rows = agentFolderRows(
      [board, finance],
      [a, b, c, d],
      [filed(a, "finance"), filed(b, "finance"), filed(c, "board")],
    );
    expect(rows).toEqual([
      { id: "board", name: "Board", documents: 1 },
      { id: "finance", name: "Finance", documents: 2 },
      { id: NOT_IN_A_FOLDER_ID, name: null, documents: 1 },
    ]);
    expect(onlyNotInAFolder(rows)).toBe(false);
  });

  test("leaves Not in a Folder out while it holds nothing, and lists a Folder that holds nothing", () => {
    const a = doc();
    expect(agentFolderRows([board], [a], [filed(a, "board")])).toEqual([
      { id: "board", name: "Board", documents: 1 },
    ]);
    expect(agentFolderRows([board], [], [])).toEqual([
      { id: "board", name: "Board", documents: 0 },
    ]);
    expect(agentFolderRows([], [], [])).toEqual([]);
  });

  test("with no Folders, Not in a Folder is the only choice, and holds every Document", () => {
    const documents = [doc(), doc(), doc()];
    const rows = agentFolderRows([], documents, []);
    expect(rows).toEqual([{ id: NOT_IN_A_FOLDER_ID, name: null, documents: 3 }]);
    expect(onlyNotInAFolder(rows)).toBe(true);
  });

  test("counts a Document whose Folder is gone, or that was never filed, as in none", () => {
    const [gone, never, none] = [doc(), doc(), doc()] as [Document, Document, Document];
    const rows = agentFolderRows(
      [board],
      [gone, never, none],
      [filed(gone, "deleted"), filed(none, null)],
    );
    expect(rows.at(-1)).toEqual({ id: NOT_IN_A_FOLDER_ID, name: null, documents: 3 });
  });

  test("counts tens of thousands of Documents in none", () => {
    const documents = Array.from({ length: 20_000 }, doc);
    const [first] = documents as [Document];
    const rows = agentFolderRows([board], documents, [filed(first, "board")]);
    expect(rows).toEqual([
      { id: "board", name: "Board", documents: 1 },
      { id: NOT_IN_A_FOLDER_ID, name: null, documents: 19_999 },
    ]);
  });
});
