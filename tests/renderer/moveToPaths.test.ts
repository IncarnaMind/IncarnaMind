import { describe, expect, test } from "vitest";
import type { LibraryGroup } from "../../src/core/api";
import { folderTreeOptions } from "../../src/renderer/src/folderPicker";
import { translate } from "../../src/shared/i18n";

/** A Folder as the picker reads it. */
const folder = (id: string, name: string, parentId: string | null = null): LibraryGroup =>
  ({
    id,
    name,
    description: "",
    parentId,
    countsOwnFiles: false,
    keepInside: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }) as LibraryGroup;

const t = (key: "move.inFolder", params: { path: string }) => translate("en", key, params);
const groups = [
  folder("a", "Thesis A"),
  folder("b", "Thesis B"),
  folder("a1", "Chapter 1", "a"),
  folder("b1", "Chapter 1", "b"),
  folder("a2", "Notes", "a"),
];

describe("Move to…'s tree of Folders (#2425)", () => {
  // protects=two Folders with one name are told apart by their place even before a query narrows the tree (#2425); fails_when=both read "Chapter 1" with nothing beside them; no_claim=where the place is drawn.
  test("shows the place of each Folder whose name another Folder in view has", () => {
    const options = folderTreeOptions(groups, "", t);
    const detail = (id: string) => options.find((option) => option.folder.id === id)?.detail;
    expect(detail("a1")).toBe("in Thesis A");
    expect(detail("b1")).toBe("in Thesis B");
    // A Folder no other shares a name with stays one word.
    expect(detail("a2")).toBeUndefined();
    expect(detail("a")).toBeUndefined();
  });
});
