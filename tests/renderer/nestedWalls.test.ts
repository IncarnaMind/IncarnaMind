import { describe, expect, test } from "vitest";
import type { DocumentGroupAssignment, LibraryGroup, SearchScope } from "../../src/core/api";
import { keptFrom } from "../../src/renderer/src/components/documentOrFolder";
import type { ScopeLibrary } from "../../src/renderer/src/scope";
import {
  documentWalls,
  keptInsideName,
  scopeOutsideWalls,
  type WallLibrary,
} from "../../src/renderer/src/walls";

/**
 * A Folder that keeps its work inside it covers the Folders inside it (#246): a Document in a
 * sub-Folder is behind the wall, and a Note in a sub-Folder is inside it.
 */

const folder = (
  id: string,
  name: string,
  parentId: string | null,
  keepInside = false,
): LibraryGroup => ({
  id,
  name,
  description: "",
  parentId,
  countsOwnFiles: false,
  keepInside,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const groups = [
  folder("wall", "Client A", null, true),
  folder("sub", "Drafts", "wall"),
  folder("other", "General", null),
];
const filed = (documentId: string, groupId: string): DocumentGroupAssignment => ({
  documentId,
  groupId,
  source: "user",
  status: "classified",
  error: null,
  model: null,
});
const library = {
  groups,
  assignments: [filed("lease", "sub"), filed("notice", "other")],
  documents: [],
  minds: [],
} satisfies WallLibrary;
const scopeLibrary: ScopeLibrary = {
  folders: [],
  groups,
  tags: [],
  documents: [],
  assignments: library.assignments,
};
const scope = (folderIds: string[], documentIds: string[] = []): SearchScope => ({
  folderIds,
  tagIds: [],
  documentIds,
});

describe("a wall around Folders inside a Folder", () => {
  test("a Document in a sub-Folder is behind the wall, and a Note in the sub-Folder is inside it", () => {
    expect(keptInsideName(library, "lease", null)).toBe("Client A");
    expect(keptInsideName(library, "lease", "other")).toBe("Client A");
    expect(keptInsideName(library, "lease", "wall")).toBeNull();
    expect(keptInsideName(library, "lease", "sub")).toBeNull();
  });

  test("a scope outside the wall leaves out a sub-Folder of it, and a scope inside keeps its own", () => {
    expect(scopeOutsideWalls(library, scope(["sub"], ["lease"]), null)).toEqual(scope([], []));
    expect(scopeOutsideWalls(library, scope(["sub"], ["lease"]), "sub")).toEqual(
      scope(["sub"], ["lease"]),
    );
  });

  test("the @ picker says a sub-Folder of a wall is kept inside it", () => {
    const folder = {
      kind: "folder" as const,
      id: "sub",
      name: "Drafts",
      path: ["Client A"],
      documentKind: null,
      count: 1,
    };
    expect(keptFrom(scopeLibrary, folder, null)).toEqual({ inside: "Client A" });
    expect(keptFrom(scopeLibrary, folder, "wall")).toBeNull();
    expect(keptFrom(scopeLibrary, folder, "other")).toBe("outside");
    const document = {
      kind: "document" as const,
      id: "lease",
      name: "Lease",
      path: [],
      documentKind: "pdf" as const,
    };
    expect(keptFrom(scopeLibrary, document, "wall")).toBeNull();
    expect(keptFrom(scopeLibrary, document, "other")).toBe("outside");
  });
});

/**
 * A Folder keeping its work inside it, inside another that does, is a wall of its own, as the
 * core reads it (`tests/core/nestedWallReads.test.ts`).
 */
describe("a wall inside a wall", () => {
  const nested = [
    folder("outer", "Client A", null, true),
    folder("inner", "Sealed", "outer", true),
    folder("drafts", "Drafts", "inner"),
  ];
  const walls = {
    groups: nested,
    assignments: [
      filed("lease", "outer"),
      filed("memo", "inner"),
      filed("draft", "drafts"),
      { ...filed("guess", "inner"), source: "automatic" },
    ],
    documents: [],
    minds: [],
  } satisfies WallLibrary;
  const pickerLibrary: ScopeLibrary = {
    folders: [],
    groups: nested,
    tags: [],
    documents: [],
    assignments: walls.assignments,
  };
  const choice = (kind: "folder" | "document", id: string) => ({ kind, id });

  test("each Document is behind its nearest wall, and says whether the User filed it there", () => {
    expect(Object.fromEntries(documentWalls(walls))).toEqual({
      lease: { wallId: "outer", byUser: true },
      memo: { wallId: "inner", byUser: true },
      draft: { wallId: "inner", byUser: true },
      guess: { wallId: "inner", byUser: false },
    });
  });

  test.each([
    ["the outer wall's Document from a Note in the inner wall", "lease", "inner", "Client A"],
    [
      "the outer wall's Document from a Folder inside the inner wall",
      "lease",
      "drafts",
      "Client A",
    ],
    ["the inner wall's Document from a Note in the outer wall", "memo", "outer", "Sealed"],
    ["the inner wall's Document from a Folder inside it", "memo", "drafts", null],
    ["the outer wall's Document from a Note in the outer wall", "lease", "outer", null],
  ])("a Citation to %s", (_name, documentId, folderId, keptInside) => {
    expect(keptInsideName(walls, documentId, folderId)).toBe(keptInside);
  });

  test("the picker offers a Note its own wall's Folders and Documents only", () => {
    expect(keptFrom(pickerLibrary, choice("folder", "outer"), "outer")).toBeNull();
    expect(keptFrom(pickerLibrary, choice("document", "lease"), "outer")).toBeNull();
    expect(keptFrom(pickerLibrary, choice("folder", "inner"), "outer")).toBe("outside");
    expect(keptFrom(pickerLibrary, choice("folder", "drafts"), "outer")).toBe("outside");
    expect(keptFrom(pickerLibrary, choice("document", "memo"), "outer")).toBe("outside");
    expect(keptFrom(pickerLibrary, choice("folder", "outer"), "inner")).toBe("outside");
    expect(keptFrom(pickerLibrary, choice("document", "lease"), "inner")).toBe("outside");
    expect(keptFrom(pickerLibrary, choice("folder", "drafts"), "inner")).toBeNull();
    expect(keptFrom(pickerLibrary, choice("document", "draft"), "inner")).toBeNull();
    // One Organize filed there is the wall's, but a Note behind it doesn't search it.
    expect(keptFrom(pickerLibrary, choice("document", "guess"), "inner")).toBe("outside");
    expect(keptFrom(pickerLibrary, choice("document", "guess"), null)).toEqual({
      inside: "Sealed",
    });
  });
});
