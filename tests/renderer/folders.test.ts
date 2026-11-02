import { describe, expect, test } from "vitest";
import {
  buildFolderTree,
  flattenFolderTree,
  folderPath,
  folderPathLabel,
  folderWallOf,
  isInsideFolder,
} from "../../src/renderer/src/folders";

/** The parts of a Folder the tree reads. */
const folder = (id: string, parentId: string | null = null, keepInside = false) => ({
  id,
  name: id,
  parentId,
  keepInside,
});

describe("the Folder tree", () => {
  const folders = [
    folder("thesis"),
    folder("chapter", "thesis"),
    folder("july", "chapter"),
    folder("field", "thesis"),
    folder("finance"),
    folder("orphan", "gone"),
  ];

  test("builds the tree in the order given, and a Folder whose parent is gone shows at the top", () => {
    const tree = buildFolderTree(folders);
    expect(tree.map((node) => [node.folder.id, node.depth])).toEqual([
      ["thesis", 0],
      ["finance", 0],
      ["orphan", 0],
    ]);
    expect(tree[0]?.children.map((node) => [node.folder.id, node.depth])).toEqual([
      ["chapter", 1],
      ["field", 1],
    ]);
    expect(flattenFolderTree(tree).map((node) => node.folder.id)).toEqual([
      "thesis",
      "chapter",
      "july",
      "field",
      "finance",
      "orphan",
    ]);
  });

  test("a Folder's path is its own name last: “Thesis › Chapter 2”", () => {
    expect(folderPath(folders, "july")).toEqual(["thesis", "chapter", "july"]);
    expect(folderPathLabel(folders, "chapter")).toBe("thesis › chapter");
    expect(folderPathLabel(folders, null)).toBe("");
    expect(isInsideFolder(folders, "july", "thesis")).toBe(true);
    expect(isInsideFolder(folders, "thesis", "july")).toBe(false);
  });

  test("a wall is found from a Folder inside it too", () => {
    const walled = [folder("finance", null, true), folder("invoices", "finance")];
    expect(folderWallOf(walled, "invoices")).toBe("finance");
    expect(folderWallOf(walled, "finance")).toBe("finance");
    expect(folderWallOf(walled, "other")).toBeNull();
  });
});
