import { describe, expect, test } from "vitest";
import {
  type Document,
  type DocumentGroupAssignment,
  type LibraryGroup,
  NOT_IN_A_FOLDER_ID,
} from "../../src/core/api";
import {
  agentFolderRows,
  onlyNotInAFolder,
  projectPlaces,
  sharedInside,
} from "../../src/renderer/src/agentFolders";

let next = 0;
const doc = (): Document => ({ id: `doc-${++next}` }) as Document;

const folder = (id: string, name = id): LibraryGroup => ({
  id,
  name,
  description: "",
  parentId: null,
  countsOwnFiles: false,
  boundFolderId: null,
  keepInside: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

/** A row at the top level, outside every wall. */
const top = (id: string, name: string | null, documents: number) => ({
  id,
  name,
  documents,
  depth: 0,
  walled: false,
  sharedWith: [],
  place: null,
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
      top("board", "Board", 1),
      top("finance", "Finance", 2),
      top(NOT_IN_A_FOLDER_ID, null, 1),
    ]);
    expect(onlyNotInAFolder(rows)).toBe(false);
  });

  test("leaves Not in a Folder out while every Document is filed, unless the agent has it", () => {
    const a = doc();
    expect(agentFolderRows([board], [a], [filed(a, "board")])).toEqual([top("board", "Board", 1)]);
    expect(agentFolderRows([board], [a], [filed(a, "board")], true)).toEqual([
      top("board", "Board", 1),
      top(NOT_IN_A_FOLDER_ID, null, 0),
    ]);
  });

  test("with no Document at all, Not in a Folder is offered, the place an agent starts from (#3364)", () => {
    expect(agentFolderRows([board], [], [])).toEqual([
      top("board", "Board", 0),
      top(NOT_IN_A_FOLDER_ID, null, 0),
    ]);
    const rows = agentFolderRows([], [], []);
    expect(rows).toEqual([top(NOT_IN_A_FOLDER_ID, null, 0)]);
    expect(onlyNotInAFolder(rows)).toBe(true);
  });

  test("with no Folders, Not in a Folder is the only choice, and holds every Document", () => {
    const documents = [doc(), doc(), doc()];
    const rows = agentFolderRows([], documents, []);
    expect(rows).toEqual([top(NOT_IN_A_FOLDER_ID, null, 3)]);
    expect(onlyNotInAFolder(rows)).toBe(true);
  });

  test("leaves the app's own examples out of Not in a Folder, as an agent never reads them there (#3364)", () => {
    const [own, example] = [doc(), doc()] as [Document, Document];
    const isExample = (document: Document) => document === example;
    expect(agentFolderRows([], [own, example], [], false, isExample)).toEqual([
      top(NOT_IN_A_FOLDER_ID, null, 1),
    ]);
    // With only the examples, there is nothing of the User's yet: Not in a Folder, for what comes.
    expect(agentFolderRows([board], [example], [], false, isExample)).toEqual([
      top("board", "Board", 0),
      top(NOT_IN_A_FOLDER_ID, null, 0),
    ]);
  });

  test("counts a Document whose Folder is gone, or that was never filed, as in none", () => {
    const [gone, never, none] = [doc(), doc(), doc()] as [Document, Document, Document];
    const rows = agentFolderRows(
      [board],
      [gone, never, none],
      [filed(gone, "deleted"), filed(none, null)],
    );
    expect(rows.at(-1)).toEqual(top(NOT_IN_A_FOLDER_ID, null, 3));
  });

  test("counts tens of thousands of Documents in none", () => {
    const documents = Array.from({ length: 20_000 }, doc);
    const [first] = documents as [Document];
    const rows = agentFolderRows([board], documents, [filed(first, "board")]);
    expect(rows).toEqual([top("board", "Board", 1), top(NOT_IN_A_FOLDER_ID, null, 19_999)]);
  });

  // protects=a ticked Folder shares the Folders inside it up to a wall, and each row counts what an agent given it reads (#3394); fails_when=an inner Folder is listed apart from its parent, a walled Folder is shared by the one above it, or a count takes in a wall's Documents
  test("lists each Folder under the one it is inside, shared with those above it up to a wall", () => {
    const place = (id: string, parentId: string | null, keepInside = false): LibraryGroup => ({
      ...folder(id, id[0]?.toUpperCase() + id.slice(1)),
      parentId,
      keepInside,
    });
    const folders = [
      place("coast", null),
      place("yard", "engineering"),
      place("legal", "coast", true),
      place("engineering", "coast"),
      place("drafts", "legal"),
    ];
    const [a, b, c, d] = [doc(), doc(), doc(), doc()] as [Document, Document, Document, Document];
    const rows = agentFolderRows(
      folders,
      [a, b, c, d],
      [filed(a, "coast"), filed(b, "yard"), filed(c, "legal"), filed(d, "drafts")],
    );
    expect(
      rows.map((row) => [row.id, row.depth, row.walled, row.sharedWith, row.documents]),
    ).toEqual([
      ["coast", 0, false, [], 2],
      ["legal", 1, true, [], 2],
      ["drafts", 2, false, ["legal"], 1],
      ["engineering", 1, false, ["coast"], 1],
      ["yard", 2, false, ["engineering", "coast"], 1],
    ]);
    expect(sharedInside(folders, ["coast"]).sort()).toEqual(["engineering", "yard"]);
    expect(sharedInside(folders, ["legal"])).toEqual(["drafts"]);
    expect(sharedInside(folders, ["engineering"])).toEqual(["yard"]);
    expect(sharedInside(folders, ["coast", "engineering"])).toEqual(["yard"]);
  });
});

describe("a Project in the list (#3507)", () => {
  // protects=a Project's row names the folder on disk it is bound to, its Linked folder's or one inside it, in the path's own separators; any other Folder names none (ADR-0030); fails_when=the picker gives a Project no place, or a wrong one
  test("names the folder on disk a Project is bound to, and none for another Folder", () => {
    const quay = { ...folder("quay", "Quay works"), boundFolderId: "disk-root" };
    const yard = { ...folder("yard", "Yard"), boundFolderId: "disk-yard" };
    const places = projectPlaces(
      [quay, yard, folder("legal", "Legal")],
      [
        { id: "disk-root", linkedFolderId: "linked", relativePath: "" },
        { id: "disk-yard", linkedFolderId: "linked", relativePath: "plans/yard" },
      ],
      [{ id: "linked", path: "/Users/ada/Quay works", folderId: "disk-root" }],
    );
    expect(places).toEqual(
      new Map([
        ["quay", "/Users/ada/Quay works"],
        ["yard", "/Users/ada/Quay works/plans/yard"],
      ]),
    );
    expect(
      projectPlaces(
        [yard],
        [{ id: "disk-yard", linkedFolderId: "linked", relativePath: "plans/yard" }],
        [{ id: "linked", path: "C:\\Users\\ada\\Quay works", folderId: "disk-root" }],
      ).get("yard"),
    ).toBe("C:\\Users\\ada\\Quay works\\plans\\yard");
    // A Linked folder's own Folder, before a scan has made its row.
    expect(
      projectPlaces(
        [quay],
        [],
        [{ id: "linked", path: "/Users/ada/Quay works", folderId: "disk-root" }],
      ),
    ).toEqual(new Map([["quay", "/Users/ada/Quay works"]]));
    const rows = agentFolderRows(
      [quay, folder("legal", "Legal")],
      [],
      [],
      false,
      () => false,
      places,
    );
    expect(rows.map((row) => [row.id, row.place])).toEqual([
      ["quay", "/Users/ada/Quay works"],
      ["legal", null],
      [NOT_IN_A_FOLDER_ID, null],
    ]);
  });
});
