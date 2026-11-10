import { describe, expect, test } from "vitest";
import type { LibraryGroup } from "../../src/core/api";
import { resolveSearchScope } from "../../src/renderer/src/resolveSearchScope";
import { folderScope } from "../../src/shared/searchScope";

const group = (id: string, parentId: string | null, keepInside: boolean): LibraryGroup => ({
  id,
  name: id,
  description: "",
  parentId,
  countsOwnFiles: false,
  keepInside,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
});

const none = { draft: null, libraryFolderId: null, groups: [] } as const;

describe("The one Search scope the chat box and the line above the conversation share (#2948)", () => {
  // protects=a Note in a kept Folder that holds no Document searches that Folder, not All Documents; fails_when=the empty-Folder fallback runs behind a wall; no_claim=the chip's looks.
  test("a kept Folder that holds nothing is the scope, not All Documents", () => {
    const { scope, resolved } = resolveSearchScope({
      ...none,
      folderId: "matter",
      folderHolds: false,
      wall: "matter",
    });
    expect(scope).toEqual(folderScope("matter"));
    expect(resolved).toEqual(folderScope("matter"));
  });

  // protects=a Note in a Folder inside a kept Folder that holds a Document searches the kept Folder, as the core will; fails_when=its own Folder is named instead; no_claim=the Folder's own scope without a wall.
  test("a Note in a Folder inside a kept Folder takes the kept Folder", () => {
    const { resolved } = resolveSearchScope({
      ...none,
      folderId: "inner",
      folderHolds: true,
      wall: "outer",
    });
    expect(resolved).toEqual(folderScope("outer"));
  });

  // protects=with no Note, the Library showing a kept Folder gives that Folder alone; fails_when=a chosen scope or the Documents outside it are let in; no_claim=a Folder with no wall.
  test("the Library showing a kept Folder gives that Folder alone", () => {
    const { resolved, libraryWalled } = resolveSearchScope({
      draft: { folderIds: [], tagIds: [], documentIds: ["lease"] },
      folderId: null,
      folderHolds: false,
      wall: null,
      libraryFolderId: "matter",
      groups: [group("matter", null, true)],
    });
    expect(libraryWalled).toBe(true);
    expect(resolved).toEqual(folderScope("matter"));
  });

  // protects=the Library showing a Folder with no wall puts it first and keeps what was chosen; fails_when=the chosen scope is dropped; no_claim=the order of the rest.
  test("the Library showing an ordinary Folder puts it in front of the chosen scope", () => {
    const { scope, resolved, libraryWalled } = resolveSearchScope({
      draft: { folderIds: ["other"], tagIds: [], documentIds: ["lease"] },
      folderId: null,
      folderHolds: false,
      wall: null,
      libraryFolderId: "plain",
      groups: [group("plain", null, false), group("other", null, false)],
    });
    expect(libraryWalled).toBe(false);
    expect(scope.folderIds).toEqual(["other"]);
    expect(resolved).toEqual({ folderIds: ["plain", "other"], tagIds: [], documentIds: ["lease"] });
  });

  // protects=without a wall or a Library Folder the scope is as it was: the Note's own Folder while it holds a Document, else none; fails_when=an ordinary Folder starts to be fenced; no_claim=Tags.
  test("without a kept Folder the scope reads as it did", () => {
    expect(
      resolveSearchScope({ ...none, folderId: "plain", folderHolds: true, wall: null }).resolved,
    ).toEqual(folderScope("plain"));
    expect(
      resolveSearchScope({ ...none, folderId: "plain", folderHolds: false, wall: null }).resolved,
    ).toEqual({ folderIds: [], tagIds: [], documentIds: [] });
  });
});
