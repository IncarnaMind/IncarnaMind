import { beforeAll, describe, expect, test } from "vitest";
import type { LibraryGroup } from "../../src/core/api";
import {
  buildMenu,
  isMenuItem,
  isMoreEntry,
  menuEntries,
} from "../../src/renderer/src/commands/menus";
import type { CommandContext } from "../../src/renderer/src/commands/registry";

const QUAY: LibraryGroup = {
  id: "quay",
  name: "Quay",
  description: "",
  parentId: null,
  boundFolderId: "quay-on-disk",
} as LibraryGroup;

const on = (id: string): CommandContext => ({
  selection: [],
  focus: { kind: "folder", id },
  surface: "sidebar",
  here: { "folder.rename": () => undefined, "folder.moveTo": () => undefined },
});

const offered = (id: string) =>
  [
    ...buildMenu("folder", on(id)),
    ...buildMenu("folder", on(id)).flatMap((entry) => (isMoreEntry(entry) ? entry.more : [])),
  ].flatMap((entry) => (isMenuItem(entry) ? [entry.command.id] : []));

let setState: (state: object) => void = () => {};

beforeAll(async () => {
  // The commands reach the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  const { useAppStore } = await import("../../src/renderer/src/store");
  setState = (state) => useAppStore.setState(state);
  expect(menuEntries("folder").length).toBeGreaterThan(0);
});

describe("a Folder's menu", () => {
  // protects=a Folder bound to a folder this window can't find (renamed on disk, or merged into one around it) is a plain Folder in its menu: it can be deleted, and offers no Unlink or File as one Folder (#3613); fails_when=its menu hides Delete with nothing to take its place
  test("bound to a folder that can't be found, it is a plain Folder that can be deleted", () => {
    setState({
      library: { groups: [QUAY], assignments: [], settings: { taggingStopped: [] } },
      folders: [],
      linkedFolders: [],
    });
    expect(offered("quay")).toContain("folder.delete");
    expect(offered("quay")).not.toContain("linkedFolder.unlink");
    expect(offered("quay")).not.toContain("linkedFolder.fileAsFolder");
  });

  // protects=a Folder bound to its Linked folder offers Unlink in place of Delete, and File as one Folder (#3613); fails_when=it offers Delete, or no way to unlink
  test("bound to its Linked folder, it offers Unlink and File as one Folder, not Delete", () => {
    setState({
      library: { groups: [QUAY], assignments: [], settings: { taggingStopped: [] } },
      folders: [],
      linkedFolders: [
        { id: "linked", folderId: "quay-on-disk", path: "/Work/Quay", status: "idle" },
      ],
    });
    expect(offered("quay")).not.toContain("folder.delete");
    expect(offered("quay")).toContain("linkedFolder.unlink");
    expect(offered("quay")).toContain("linkedFolder.fileAsFolder");
  });
});
