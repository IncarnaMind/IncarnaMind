import { beforeAll, describe, expect, test, vi } from "vitest";
import type { Document, Mind } from "../../src/core/api";
import { buildMenu, buildMixedMenu, type MenuEntry } from "../../src/renderer/src/commands/menus";
import {
  type CommandContext,
  commands,
  labelOf,
  menuLabelOf,
} from "../../src/renderer/src/commands/registry";
import type { ObjectRef } from "../../src/renderer/src/objects";
import type { CommandId } from "../../src/shared/commands";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The selection bar and the right-click menu offer the same commands for the
 * selection, each saying how many (docs/agents/interaction.md, rule 6).
 */

const doc = (id: string): ObjectRef => ({ kind: "document", id });
const mind = (id: string): ObjectRef => ({ kind: "mind", id });
const folder = (id: string): ObjectRef => ({ kind: "folder", id });
const selectionOf = (selection: ObjectRef[], surface: CommandContext["surface"] = "library") =>
  ({ selection, focus: selection.at(-1) ?? null, surface }) satisfies CommandContext;

const idsIn = (entries: MenuEntry[]) =>
  entries.flatMap((entry) => (entry === "rule" ? [] : [entry.command.id]));

const english = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const chinese = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

/** A Mind as the store holds one. */
const mindOf = (id: string): Mind => ({
  id,
  title: "",
  autoTitle: "",
  kind: "mind",
  createdAt: "",
  updatedAt: "",
  folderId: null,
});

/** A ready Document as the store holds one. */
const documentOf = (id: string): Document => ({
  id,
  name: `Doc ${id}`,
  kind: "pdf",
  contentHash: "",
  path: `/${id}.pdf`,
  fileStatus: "available",
  keptByApp: false,
  linkedFolderId: null,
  size: 0,
  pageCount: null,
  status: "ready",
  progress: null,
  scan: null,
  failure: null,
  unreadParts: null,
  unreadPartsUnknown: false,
  folderId: null,
  tags: [],
  tagging: "off",
  taggingError: null,
  creationDate: null,
  modifiedAt: null,
  title: null,
  web: null,
  reference: null,
  ownFile: null,
  notCited: false,
  found: null,
  importedAs: null,
  createdAt: "",
  updatedAt: "",
});

beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    minds: ["m", "n"].map(mindOf),
    documents: ["a", "b", "c"].map(documentOf),
  });
});

describe("a selection of Documents", () => {
  const ctx = selectionOf([doc("a"), doc("b"), doc("c")]);
  const here = { "document.tags": () => undefined };

  test("is offered what applies to every one, and not what opens or renames one", () => {
    const ids = idsIn(buildMenu("document", { ...ctx, here }));
    expect(ids).toEqual(
      expect.arrayContaining(["document.ask", "document.startMind", "document.tags"]),
    );
    for (const one of [
      "document.open",
      "document.openTab",
      "document.rename",
      "document.openExternally",
      "document.showInFolder",
    ]) {
      expect(ids, one).not.toContain(one);
    }
  });

  test("says how many, in English and in Chinese", () => {
    const entries = buildMenu("document", { ...ctx, here }).flatMap((entry) =>
      entry === "rule" ? [] : [entry],
    );
    const ask = entries.find((entry) => entry.command.id === "document.ask");
    const start = entries.find((entry) => entry.command.id === "document.startMind");
    expect(ask && menuLabelOf(ask.command, ctx, english)).toBe("Ask about these 3 Documents");
    expect(ask && menuLabelOf(ask.command, ctx, chinese)).toBe("就这 3 个文档提问");
    expect(start && labelOf(start.command, ctx, english)).toBe(
      "Start a note from these 3 Documents",
    );
    expect(start && labelOf(start.command, ctx, chinese)).toBe("用这 3 个文档新建笔记");
  });

  test("offers Delete with the count", () => {
    const entries = buildMenu("document", { ...ctx, here }).flatMap((entry) =>
      entry === "rule" ? [] : [entry],
    );
    const remove = entries.find((entry) => entry.command.id === "document.delete");
    expect(remove && menuLabelOf(remove.command, ctx, english)).toBe("Delete 3 Documents");
    expect(remove && menuLabelOf(remove.command, ctx, chinese)).toBe("删除 3 个文档");
  });

  test("writes counts of a thousand or more as the page's title does, in both languages (#1350)", async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    const before = useAppStore.getState();
    const documents = Array.from({ length: 1731 }, (_, at) => doc(`d${at}`));
    useAppStore.setState({ documents: documents.map(({ id }) => documentOf(id)) });
    try {
      const many = selectionOf(documents);
      const found = new Map(
        buildMenu("document", many).flatMap((entry) =>
          entry === "rule" ? [] : [[entry.command.id, entry.command] as const],
        ),
      );
      const says = (id: CommandId, t: typeof english) => {
        const command = found.get(id);
        if (!command) throw new Error(`There is no ${id} here.`);
        return menuLabelOf(command, many, t);
      };
      expect(says("document.ask", english)).toBe("Ask about these 1,731 Documents");
      expect(says("document.delete", english)).toBe("Delete 1,731 Documents");
      expect(says("folder.newWith", english)).toBe("New Folder with 1,731 Documents");
      expect(says("document.ask", chinese)).toBe("就这 1,731 个文档提问");
      expect(says("document.delete", chinese)).toBe("删除 1,731 个文档");
      expect(says("folder.newWith", chinese)).toBe("新建文件夹并放入 1,731 个文档");
    } finally {
      useAppStore.setState({ documents: before.documents });
    }
  });

  test("a single Document keeps its own words", () => {
    const one = selectionOf([doc("a")]);
    const ask = commands.get("document.ask");
    expect(ask && labelOf(ask, one, english)).toBe("Ask about this Document");
    expect(idsIn(buildMenu("document", one))).toContain("document.open");
  });

  test("asks about all of them, not the first", async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    let asked: unknown;
    useAppStore.setState({
      askAbout: ((bridge: unknown) => {
        asked = bridge;
        return undefined;
      }) as never,
    });
    await commands.run("document.ask", ctx);
    expect(asked).toMatchObject({
      kind: "documents",
      count: 3,
      scope: { documentIds: ["a", "b", "c"] },
    });
  });
});

describe("a selection of Minds", () => {
  const ctx = selectionOf([mind("m"), mind("n")], "sidebar");

  test("is offered Move to and New Folder with these, and not what opens, exports or deletes one", () => {
    const here = { "mind.moveTo": () => undefined, "mind.rename": () => undefined };
    const ids = idsIn(buildMenu("mind", { ...ctx, here }));
    expect(ids).toEqual(["mind.moveTo", "folder.newWith"]);
  });
});

describe("a selection of Minds and Documents", () => {
  test("is offered only what applies to every kind selected: New Folder with these", () => {
    const ctx = selectionOf([mind("m"), doc("a")], "sidebar");
    expect(idsIn(buildMenu("document", ctx))).toEqual(["folder.newWith"]);
    expect(idsIn(buildMenu("mind", ctx))).toEqual(["folder.newWith"]);
  });
});

describe("a selection of several kinds", () => {
  const fromMind = { "mind.moveTo": () => undefined };

  test("of Minds and Documents is offered Move to… and Delete for all of them, with the count", () => {
    const ctx = { ...selectionOf([mind("m"), doc("a"), doc("b")], "sidebar"), here: fromMind };
    const entries = buildMixedMenu(ctx).flatMap((entry) => (entry === "rule" ? [] : [entry]));
    expect(entries.map((entry) => entry.command.id)).toEqual([
      "selection.moveTo",
      "selection.delete",
    ]);
    expect(entries.map((entry) => menuLabelOf(entry.command, ctx, english))).toEqual([
      "Move 3 items to…",
      "Delete 3 items",
    ]);
    expect(entries.map((entry) => menuLabelOf(entry.command, ctx, chinese))).toEqual([
      "将 3 项移动到…",
      "删除 3 项",
    ]);
  });

  test("holding a Folder is offered only Delete, since Folders don't go inside Folders", () => {
    const ctx = { ...selectionOf([folder("f"), mind("m")], "sidebar"), here: fromMind };
    expect(idsIn(buildMixedMenu(ctx))).toEqual(["selection.delete"]);
  });
});

test("Retry reloads a failed viewer through its place, and keeps indexing retries for failed Documents elsewhere", async () => {
  const { useAppStore } = await import("../../src/renderer/src/store");
  const before = useAppStore.getState();
  const reload = vi.fn();
  const retryDocument = vi.fn(async () => undefined);
  const one = selectionOf([doc("a")], "viewer");
  const here = { "document.retry": reload };
  try {
    useAppStore.setState({ documents: [documentOf("a"), documentOf("b")], retryDocument });
    expect(idsIn(buildMenu("document", one))).not.toContain("document.retry");
    expect(idsIn(buildMenu("document", { ...one, here }))).toContain("document.retry");
    await commands.run("document.retry", { ...one, here });
    expect(reload).toHaveBeenCalledOnce();
    expect(retryDocument).not.toHaveBeenCalled();
    expect(
      idsIn(buildMenu("document", { ...selectionOf([doc("a"), doc("b")]), here })),
    ).not.toContain("document.retry");
    useAppStore.setState({ documents: [{ ...documentOf("a"), status: "failed" }] });
    await commands.run("document.retry", one);
    expect(retryDocument).toHaveBeenCalledExactlyOnceWith("a");
    useAppStore.setState({ documents: [{ ...documentOf("a"), fileStatus: "missing" }] });
    expect(idsIn(buildMenu("document", { ...one, here }))).not.toContain("document.retry");
  } finally {
    useAppStore.setState(before);
  }
});
