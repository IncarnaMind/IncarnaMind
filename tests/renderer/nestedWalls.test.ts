import { describe, expect, test } from "vitest";
import type {
  DocumentGroupAssignment,
  LibraryGroup,
  LibrarySnapshot,
  SearchScope,
} from "../../src/core/api";
import { keptFrom } from "../../src/renderer/src/components/documentOrFolder";
import type { ScopeLibrary } from "../../src/renderer/src/scope";
import { keptInsideName, scopeOutsideWalls } from "../../src/renderer/src/walls";

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
  suggested: false,
  status: "classified",
  error: null,
  model: null,
});
const library = {
  groups,
  assignments: [filed("lease", "sub"), filed("notice", "other")],
} satisfies Pick<LibrarySnapshot, "groups" | "assignments">;
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
