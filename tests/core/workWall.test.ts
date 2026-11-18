import { describe, expect, test } from "vitest";
import {
  NOT_IN_A_FOLDER_ID,
  type PassageSearchPlace,
  type SearchScope,
  type TurnPlace,
} from "../../src/core/api";
import { NotFoundError } from "../../src/core/errors";
import { createWorkWall } from "../../src/core/workWall";

/**
 * The work wall's rule, asked of the module itself: one Library, and what each place may read,
 * read again and file into. The Folder chain and the filings stand in for the Library module's.
 */

interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  keepInside: boolean;
}

const FOLDERS: FolderRow[] = [
  { id: "clientA", name: "Client A", parentId: null, keepInside: true },
  { id: "drafts", name: "Drafts", parentId: "clientA", keepInside: false },
  { id: "clientB", name: "Client B", parentId: null, keepInside: true },
  { id: "open", name: "Open", parentId: null, keepInside: false },
  { id: "sub", name: "Sub", parentId: "open", keepInside: false },
];

const FILED: Record<string, string | null> = {
  a1: "clientA",
  a2: "drafts",
  b1: "clientB",
  o1: "open",
  o2: "sub",
  free: null,
  written: null,
};

const NOTES: Record<string, string | null> = {
  noteA: "clientA",
  noteDrafts: "drafts",
  noteB: "clientB",
  noteOpen: "open",
  noteNone: null,
};

const CONVERSATIONS: Record<string, string | null> = { convA: "clientA", convNone: null };

const gone = () => new NotFoundError({ key: "error.folder.notFound" });

function wallOver(
  folders: FolderRow[] = FOLDERS,
  unscoped: (mindId: string | null) => string[] | null = () => null,
) {
  const filed = new Map(Object.entries(FILED));
  const wallOf = (folderId: string): string | null => {
    for (
      let at = folders.find((folder) => folder.id === folderId);
      at;
      at = folders.find((folder) => folder.id === at?.parentId)
    ) {
      if (at.keepInside) return at.id;
    }
    return null;
  };
  const tree = (folderId: string): string[] => [
    folderId,
    ...folders
      .filter((folder) => folder.parentId === folderId)
      .flatMap((folder) => tree(folder.id)),
  ];
  const filedIn = (folderId: string) => {
    const inside = folders.some((folder) => folder.id === folderId) ? tree(folderId) : [];
    return [...filed].filter(([, at]) => at !== null && inside.includes(at)).map(([id]) => id);
  };
  const wall = createWorkWall({
    library: () => ({
      folders: () => folders,
      wallOf,
      wallsOf: () => new Map(folders.map((folder) => [folder.id, wallOf(folder.id)])),
      treeDocumentIds: filedIn,
      allTreeDocumentIds: filedIn,
      assign: (documentId, folderId) => filed.set(documentId, folderId),
    }),
    documents: {
      ids: (filter) =>
        [...filed.keys()].filter((id) => filter.ids === undefined || filter.ids.includes(id)),
      getMany: (ids) => ids.map(() => ({ status: "ready", fileStatus: "available" })),
    },
    linkedFolders: { subtree: () => [] },
    ownFiles: { writtenFrom: (folderIds) => (folderIds.includes("drafts") ? ["written"] : []) },
    folderOfNote: (mindId) => (mindId === null ? null : (NOTES[mindId] ?? null)),
    folderOfTurn: ({ mindId, conversationId }) => {
      const folderOf = (among: Record<string, string | null>, id: string) => {
        if (!(id in among)) throw gone();
        return among[id] ?? null;
      };
      if (mindId !== null) return folderOf(NOTES, mindId);
      return conversationId === null ? null : folderOf(CONVERSATIONS, conversationId);
    },
    unscopedDocuments: unscoped,
    readableNote: (mindId) => mindId in NOTES,
  });
  return { wall, filed };
}

const scope = (parts: Partial<SearchScope>): SearchScope => ({
  folderIds: [],
  tagIds: [],
  documentIds: [],
  ...parts,
});
const sorted = (ids: readonly string[] | null) => (ids === null ? null : [...ids].sort());

describe("what a place reads", () => {
  test.each<[string, string | null, SearchScope | null, string[]]>([
    ["outside, no scope: every Document no wall keeps", "noteOpen", null, ["free", "o1", "o2"]],
    ["outside, a walled Folder: nothing", "noteOpen", scope({ folderIds: ["clientA"] }), []],
    [
      "outside, a walled Folder beside an open one: the open one",
      "noteOpen",
      scope({ folderIds: ["open", "clientA"] }),
      ["o1", "o2"],
    ],
    [
      "outside, a picked Document behind a wall is left out",
      "noteOpen",
      scope({ documentIds: ["a1", "o1"] }),
      ["o1"],
    ],
    [
      "no Note, one walled Folder alone: inside it",
      null,
      scope({ folderIds: ["clientA"] }),
      ["a1", "a2"],
    ],
    ["no Note, two walls: nothing", null, scope({ folderIds: ["clientA", "clientB"] }), []],
    ["inside, no scope: the wall's Folder", "noteA", null, ["a1", "a2"]],
    [
      "inside, an outside Folder can't widen it",
      "noteA",
      scope({ folderIds: ["open"] }),
      ["a1", "a2"],
    ],
    [
      "inside, a Folder inside the wall narrows it",
      "noteA",
      scope({ folderIds: ["drafts"] }),
      ["a2"],
    ],
    [
      "inside, a picked Document can't widen it",
      "noteA",
      scope({ documentIds: ["o1"] }),
      ["a1", "a2"],
    ],
    ["a deleted Note reads as one in no Folder", "noteGone", null, ["free", "o1", "o2"]],
  ])("%s", (_name, mindId, asked, expected) => {
    expect(sorted(wallOver().wall.resolveScope(asked, mindId))).toEqual(expected);
  });

  test("with no wall and no scope, every Document: null", () => {
    const plain = FOLDERS.map((folder) => ({ ...folder, keepInside: false }));
    expect(wallOver(plain).wall.resolveScope(null, "noteOpen")).toBeNull();
  });

  test("a search with no scope reads only what 'every Document' means for it", () => {
    const { wall } = wallOver(FOLDERS, () => ["o1", "a1"]);
    expect(wall.scopeDocuments(null, "noteOpen")).toEqual(["o1"]);
    expect(sorted(wall.scopeDocuments(scope({ folderIds: ["open"] }), "noteOpen"))).toEqual([
      "o1",
      "o2",
    ]);
  });

  test("Folders named for a search: one wall alone stays, a wall among others goes", () => {
    const { wall } = wallOver();
    expect(wall.folderIdsInScope(["clientA"])).toEqual(["clientA"]);
    expect(wall.folderIdsInScope(["clientA", "open"])).toEqual(["open"]);
  });

  test("what a Note's Question searches: what was chosen, and the wall when that would leave it", () => {
    const { wall } = wallOver();
    expect(wall.searchedScope(null, "noteOpen")).toBeNull();
    expect(wall.searchedScope(scope({ folderIds: ["open"] }), "noteOpen")).toEqual(
      scope({ folderIds: ["open"] }),
    );
    expect(wall.searchedScope(null, "noteA")).toEqual(scope({ folderIds: ["clientA"] }));
    expect(wall.searchedScope(scope({ folderIds: ["open"] }), "noteA")).toEqual(
      scope({ folderIds: ["clientA"] }),
    );
    expect(wall.searchedScope(scope({ folderIds: ["drafts"] }), "noteA")).toEqual(
      scope({ folderIds: ["drafts"] }),
    );
    expect(wall.searchedScope(null, "noteNone")).toBeNull();
  });

  test.each<[string, PassageSearchPlace, string[]]>([
    [
      "a turn in a walled Note",
      { kind: "turn", mindId: "noteA", conversationId: null },
      ["a1", "a2"],
    ],
    [
      "a turn in an open Note",
      { kind: "turn", mindId: "noteOpen", conversationId: null },
      ["free", "o1", "o2"],
    ],
    [
      "asked from a Note still readable",
      { kind: "asked", askedFrom: { mindId: "noteA" }, folderAskedIn: "open" },
      ["a1", "a2"],
    ],
    [
      "asked from a deleted Note, no Folder recorded",
      { kind: "asked", askedFrom: { mindId: "noteA", deleted: true } },
      [],
    ],
    [
      "asked with no Note, in a walled Folder",
      { kind: "asked", askedFrom: null, folderAskedIn: "clientA" },
      ["a1", "a2"],
    ],
    [
      "asked with no Note, in no Folder",
      { kind: "asked", askedFrom: null, folderAskedIn: "" },
      ["free", "o1", "o2"],
    ],
  ])("a local search reads, %s", (_name, place, expected) => {
    expect(sorted(wallOver().wall.documentsToSearch(null, place))).toEqual(expected);
  });
});

describe("which wall a thing is behind", () => {
  test.each<[string, Partial<SearchScope>, boolean]>([
    ["the wall's own Folder", { folderIds: ["clientA"] }, true],
    ["a Folder inside the wall", { folderIds: ["drafts"] }, true],
    ["a Folder outside beside one inside", { folderIds: ["drafts", "open"] }, false],
    ["another wall's Folder", { folderIds: ["clientB"] }, false],
    ["Not in a Folder", { folderIds: ["not-in-a-folder"] }, false],
    ["a Tag as well as a Folder inside", { folderIds: ["drafts"], tagIds: ["t1"] }, false],
    ["a Document as well", { folderIds: ["drafts"], documentIds: ["a2"] }, false],
    ["no Folder at all", {}, false],
  ])("a scope naming %s is inside Client A's wall: %s", (_name, parts, expected) => {
    expect(wallOver().wall.scopeInsideWall(scope(parts), "clientA")).toBe(expected);
  });

  const { wall } = wallOver();

  test("a Folder: its nearest wall", () => {
    expect(wall.walledFolderId("drafts")).toBe("clientA");
    expect(wall.walledFolderId("sub")).toBeNull();
    expect(wall.walledFolderId(null)).toBeNull();
    expect(wall.walledFolderId(NOT_IN_A_FOLDER_ID)).toBeNull();
  });

  test("a Note and a turn: their Folder's", () => {
    expect(wall.walledFolder("noteDrafts")).toBe("clientA");
    expect(wall.walledFolder("noteGone")).toBeNull();
    expect(wall.turnWall({ mindId: null, conversationId: "convA" })).toBe("clientA");
    expect(wall.turnWall({ mindId: null, conversationId: null })).toBeNull();
    expect(() => wall.turnWall({ mindId: "noteGone", conversationId: null })).toThrow(
      NotFoundError,
    );
  });

  test("a Document: where it is filed, or the Note IncarnaMind wrote it from", () => {
    expect(wall.walledDocument("a2")).toBe("clientA");
    expect(wall.walledDocument("written")).toBe("clientA");
    expect(wall.walledDocument("o1")).toBeNull();
    expect(wall.walledFolderName("a1")).toBe("Client A");
    expect(sorted(wall.walledDocuments())).toEqual(["a1", "a2", "b1", "written"]);
    expect(sorted(wall.filedInWall("clientA"))).toEqual(["a1", "a2"]);
  });
});

describe("reading a cited Document again", () => {
  const { wall } = wallOver();

  test.each<[string | null, string, boolean]>([
    ["noteOpen", "o1", true],
    ["noteOpen", "a1", false],
    ["noteOpen", "written", false],
    ["noteA", "a1", true],
    ["noteDrafts", "a1", true],
    ["noteA", "written", true],
    ["noteA", "o1", true],
    ["noteB", "a1", false],
    [null, "a1", true],
  ])("from the Note %s, %s: %s", (mindId, documentId, may) => {
    expect(wall.mayRecheckIn(mindId, documentId)).toBe(may);
  });

  test.each<[TurnPlace, string, boolean]>([
    [{ mindId: "noteA", conversationId: null }, "a1", true],
    [{ mindId: null, conversationId: "convA" }, "a1", true],
    [{ mindId: null, conversationId: "convNone" }, "a1", false],
    [{ mindId: null, conversationId: null }, "a1", true],
    [{ mindId: "noteGone", conversationId: null }, "a1", false],
    [{ mindId: null, conversationId: "convGone" }, "a1", false],
    [{ mindId: "noteGone", conversationId: null }, "o1", true],
  ])("from where it is shown %o, %s: %s", (place, documentId, may) => {
    expect(wall.mayRecheckFrom(place, documentId)).toBe(may);
  });
});

describe("where work is filed", () => {
  const nested: FolderRow[] = [
    ...FOLDERS,
    { id: "sealed", name: "Sealed", parentId: "clientA", keepInside: true },
  ];

  test.each<[string, string | null, string | null, { folderId: string | null } | null]>([
    ["outside, nowhere asked", null, null, { folderId: null }],
    ["outside, an open Folder", null, "sub", { folderId: "sub" }],
    ["outside, a walled Folder takes nothing", null, "clientA", { folderId: null }],
    ["outside, a Folder inside a wall takes nothing", null, "drafts", { folderId: null }],
    ["outside, a Folder that is gone", null, "gone", null],
    ["inside, nowhere asked: the wall's Folder", "clientA", null, { folderId: "clientA" }],
    ["inside, a Folder inside the wall", "clientA", "drafts", { folderId: "drafts" }],
    ["inside, an outside Folder: not filed", "clientA", "open", null],
    ["inside, another wall: not filed", "clientA", "clientB", null],
    ["inside, a wall nested in it: not filed", "clientA", "sealed", null],
    ["the wall's Folder is gone: not filed", "gone", null, null],
    ["the wall was switched off: as outside", "open", "sub", { folderId: "sub" }],
  ])("%s", (_name, wallId, asked, expected) => {
    expect(wallOver(nested).wall.filedWithin(wallId, asked)).toEqual(expected);
  });

  test.each<[string | null, string | null, string | null, boolean]>([
    [null, "open", null, true],
    [null, "open", "clientA", false],
    [null, "clientA", null, false],
    ["clientA", "drafts", "clientA", true],
    ["clientA", "drafts", "clientB", false],
  ])("on the side %s, into %s, a Document behind %s: %s", (wallId, folderId, behind, may) => {
    expect(wallOver().wall.mayFileWithin(wallId, folderId, behind)).toBe(may);
  });

  test("a Document is filed by the walls as they are, and one behind another wall stays", () => {
    const { wall, filed } = wallOver();
    expect(wall.fileWithin("o1", null, "sub")).toEqual({ folderId: "sub" });
    expect(filed.get("o1")).toBe("sub");
    expect(wall.fileWithin("a1", null, "open")).toBeNull();
    expect(filed.get("a1")).toBe("clientA");
    expect(wall.fileWithin("free", "clientA", null)).toEqual({ folderId: "clientA" });
    expect(filed.get("free")).toBe("clientA");
    expect(wall.fileWithin("o2", null, null)).toEqual({ folderId: null });
    expect(filed.get("o2")).toBe("sub");
  });
});
