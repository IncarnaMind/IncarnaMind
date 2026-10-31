import { beforeAll, describe, expect, test } from "vitest";
import {
  buildMenu,
  type MenuEntry,
  menuEntries,
  menuIds,
  registerMenu,
} from "../../src/renderer/src/commands/menus";
import {
  type Command,
  type CommandContext,
  commands,
} from "../../src/renderer/src/commands/registry";
import type { ObjectKind, ObjectRef } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

/*
 * Every object has one menu, in one order (docs/agents/interaction.md, rule
 * 5): the registry puts a feature's commands in the rule's order, leaves out
 * what doesn't apply and disables, with a reason, what applies but can't run
 * now. That every kind has a menu, and its order, is in conformance.test.ts.
 */

const focusOn = (kind: ObjectKind, here?: CommandContext["here"]): CommandContext => ({
  selection: [],
  focus: { kind, id: "one" },
  surface: "sidebar",
  ...(here && { here }),
});

const idsIn = (entries: MenuEntry[]) =>
  entries.map((entry) => (entry === "rule" ? "—" : entry.command.id));

beforeAll(async () => {
  // The commands reach the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    minds: [{ id: "one" } as never],
    documents: [
      { id: "one", path: "/Contracts/MSA.pdf", web: null, fileStatus: "available" } as never,
    ],
    linkedFolders: [{ id: "one", path: "/Contracts", status: "idle" } as never],
  });
});

describe("the menus", () => {
  test("a Mind's is Open, Open in new tab, Outline, Duplicate, Export…, its AI use statement and check record, History, Check this note, Tie out figures, Check for contradictions, Style, Make this a Skill, Move to and New Folder with this note, Rename, then Delete after a rule", () => {
    const here = {
      "mind.citationStyle": () => undefined,
      "mind.moveTo": () => undefined,
      "mind.rename": () => undefined,
    };
    expect(idsIn(buildMenu("mind", focusOn("mind", here)))).toEqual([
      "mind.open",
      "mind.openTab",
      "—",
      "mind.outline",
      "mind.duplicate",
      "mind.exportMenu",
      "mind.aiUseStatement",
      "mind.checkRecord",
      "mind.history",
      "mind.check",
      "mind.tieOut",
      "mind.checkContradictions",
      "mind.citationStyle",
      "mind.style",
      "skill.fromMind",
      "—",
      "mind.moveTo",
      "folder.newWith",
      "—",
      "mind.rename",
      "—",
      "mind.delete",
    ]);
    // Rename and Move to start in the row, so a place without one doesn't offer them.
    expect(idsIn(buildMenu("mind", focusOn("mind")))).toEqual([
      "mind.open",
      "mind.openTab",
      "—",
      "mind.outline",
      "mind.duplicate",
      "mind.exportMenu",
      "mind.aiUseStatement",
      "mind.checkRecord",
      "mind.history",
      "mind.check",
      "mind.tieOut",
      "mind.checkContradictions",
      "mind.style",
      "skill.fromMind",
      "—",
      "folder.newWith",
      "—",
      "mind.delete",
    ]);
    // The page's ⋯ offers Style as a submenu of its own, and nothing to open the Mind it is on.
    const page = idsIn(
      buildMenu("mind", focusOn("mind"), ["mind.style", "mind.open", "mind.openTab"]),
    );
    expect(page).not.toContain("mind.style");
    expect(page).not.toContain("mind.open");
    expect(page).not.toContain("mind.openTab");
    expect(page).toContain("skill.fromMind");
    expect(page).toContain("mind.exportMenu");
  });

  test("no Mind menu lists the export formats, which the Export button's menu and ⌘K have", () => {
    for (const kind of ["mind", "tab"] as const) {
      const ids = menuIds(kind);
      expect(
        ids.filter((id) => id.startsWith("mind.exportAs") || id === "mind.export"),
        kind,
      ).toEqual([]);
      expect(
        ids.filter((id) => id === "mind.exportMenu"),
        kind,
      ).toHaveLength(1);
    }
  });

  test("a Mind's and a Document's menus start with Open and Open in new tab, named alike; the tab menu's one row for a split is Split to the right", () => {
    const here = { "document.rename": () => undefined };
    expect(idsIn(buildMenu("mind", focusOn("mind"))).slice(0, 2)).toEqual([
      "mind.open",
      "mind.openTab",
    ]);
    expect(idsIn(buildMenu("document", focusOn("document", here))).slice(0, 2)).toEqual([
      "document.open",
      "document.openTab",
    ]);
    for (const id of ["mind.openTab", "document.openTab"] as const) {
      expect(commands.get(id)?.label).toBe("mind.openTab");
      expect(commands.get(id)?.shortcut).toBeUndefined();
      expect(commands.get(id)?.rowKeys).toBeUndefined();
    }
    expect(translate("en", "mind.openTab")).toBe("Open in new tab");
    expect(translate("zh-CN", "mind.openTab")).toBe("在新标签页中打开");

    expect(menuIds("tab").filter((id) => id.startsWith("tab.split"))).toEqual(["tab.split"]);
    expect(commands.get("tab.split")?.menuLabel).toBe("tabs.menu.split");
    expect(translate("en", "tabs.menu.split")).toBe("Split to the right");
    expect(translate("zh-CN", "tabs.menu.split")).toBe("向右拆分");
    // One act, one name: no string calls the same act "Open to the side".
    expect(Object.values(en).filter((words) => /^open to the side$/i.test(words))).toEqual([]);
    expect(
      Object.values(zhCN).filter((words) => /^(?:在旁边打开|在侧边打开)$/.test(words)),
    ).toEqual([]);
  });

  test("Delete is the last item of a Mind's menu, and a tab's is its own items, then Delete", () => {
    expect(idsIn(buildMenu("mind", focusOn("mind"))).at(-1)).toBe("mind.delete");
    // A tab's menu has no layout here to build from: Delete is the one item of its last section.
    const entries = menuEntries("tab");
    const last = Math.max(...entries.map((each) => each.section));
    expect(entries.filter((each) => each.section === last).map((each) => each.id)).toEqual([
      "mind.delete",
    ]);
  });

  test("a Document's file group is Open in default app, Show the file, Copy path, then Get info", () => {
    const here = { "document.rename": () => undefined };
    const ids = idsIn(buildMenu("document", focusOn("document", here)));
    const start = ids.indexOf("document.openExternally");
    expect(ids.slice(start, ids.indexOf("—", start))).toEqual([
      "document.openExternally",
      "document.showInFolder",
      "file.copyPath",
      "file.info",
    ]);
    expect(ids.at(-1)).toBe("document.delete");
  });

  test("a Linked folder's has Copy path and Get info with its file items", () => {
    const ids = idsIn(buildMenu("linkedFolder", focusOn("linkedFolder")));
    expect(ids).toEqual(
      expect.arrayContaining([
        "linkedFolder.reveal",
        "file.copyPath",
        "file.info",
        "linkedFolder.locate",
      ]),
    );
    expect(ids.indexOf("file.copyPath")).toBe(ids.indexOf("linkedFolder.reveal") + 1);
  });

  test("a feature adds its items to a kind's menu, and they take their group's place", () => {
    const registered: Command[] = [
      {
        id: "test.late",
        label: "mind.open",
        group: "move",
        appliesTo: ["conversation"],
        reversible: true,
        run: () => undefined,
      },
      {
        id: "test.early",
        label: "mind.open",
        group: "open",
        appliesTo: ["conversation"],
        reversible: true,
        run: () => undefined,
      },
      {
        id: "test.last",
        label: "mind.open",
        group: "danger",
        appliesTo: ["conversation"],
        reversible: { confirm: "deleted.confirm.foot" },
        run: () => undefined,
      },
    ];
    for (const command of registered) commands.register(command);
    // Registered in any order, from different places.
    registerMenu("conversation", ["test.last", "test.late"]);
    registerMenu("conversation", ["test.early", "test.late"]);
    expect(menuIds("conversation")).toEqual(["test.last", "test.late", "test.early"]);
    expect(idsIn(buildMenu("conversation", focusOn("conversation")))).toEqual([
      "test.early",
      "—",
      "test.late",
      "—",
      "test.last",
    ]);
  });

  test("leave out a command that doesn't apply, and disable one that can't run now, with its reason", () => {
    const base = {
      label: "mind.open",
      group: "main",
      reversible: true,
      run: () => undefined,
    } as const;
    commands.register({ ...base, id: "test.notHere", appliesTo: ["folder"], when: () => false });
    commands.register({ ...base, id: "test.wrongKind", appliesTo: ["document"] });
    commands.register({
      ...base,
      id: "test.notNow",
      appliesTo: ["folder"],
      enabled: () => ({ reason: "documents.file.missingReason" }),
    });
    commands.register({ ...base, id: "test.fine", appliesTo: ["folder"] });
    registerMenu("folder", ["test.notHere", "test.wrongKind", "test.notNow", "test.fine"]);
    const entries = buildMenu("folder", focusOn("folder"));
    const items = entries.flatMap((entry) => (entry === "rule" ? [] : [entry]));
    const byId = Object.fromEntries(items.map((item) => [item.command.id, item.enabled]));
    expect(byId["test.notHere"]).toBeUndefined();
    expect(byId["test.wrongKind"]).toBeUndefined();
    expect(byId["test.notNow"]).toEqual({ reason: "documents.file.missingReason" });
    expect(byId["test.fine"]).toBe(true);
  });

  test("act on the selection when it holds the row, whose count a label can say", () => {
    const selection: ObjectRef[] = [
      { kind: "document", id: "a" },
      { kind: "document", id: "b" },
      { kind: "document", id: "c" },
    ];
    commands.register({
      id: "test.count",
      label: (ctx, t) => `${t("deleted.restore")} ${ctx.selection.length}`,
      group: "danger",
      appliesTo: ["document"],
      reversible: true,
      run: () => undefined,
    });
    registerMenu("document", ["test.count"]);
    const ctx: CommandContext = { selection, focus: selection[0] ?? null, surface: "library" };
    const item = buildMenu("document", ctx).find(
      (entry) => entry !== "rule" && entry.command.id === "test.count",
    );
    expect(item).toBeDefined();
    // And a selection with something that isn't a Document is no menu for Documents.
    const mixed: CommandContext = { ...ctx, selection: [...selection, { kind: "mind", id: "m" }] };
    expect(
      buildMenu("document", mixed).some((e) => e !== "rule" && e.command.id === "test.count"),
    ).toBe(false);
  });

  test("a comparison column's menu shows the heading's own keys: F2 edits it and Delete removes it", async () => {
    const { menuKeysLabel } = await import("../../src/renderer/src/commands/keymap");
    const edit = commands.get("comparison.column.edit");
    const remove = commands.get("comparison.column.remove");
    expect(edit?.rowKeys).toBe("F2");
    expect(remove?.rowKeys).toBe("Delete");
    expect(edit && menuKeysLabel(edit)).toBe("F2");
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    expect(remove && menuKeysLabel(remove)).toBe(mac ? "⌦" : "Delete");
  });
});
