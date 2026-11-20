import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { Canvas, LayoutChange } from "../../src/core/api";
import type * as Menus from "../../src/renderer/src/commands/menus";
import type * as Registry from "../../src/renderer/src/commands/registry";
import type * as Palette from "../../src/renderer/src/palette";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * A Canvas an outside agent published (#3406), where the window shows Notes: its one menu, on its
 * row and on its tab, in rule 5's order; Delete with Undo; and ⌘K finding it by its title.
 */

const AT = "2026-11-19T09:00:00.000Z";
const canvas = (id: string, title: string): Canvas => ({
  id,
  title,
  folderId: null,
  agent: "Claude Code",
  version: 1,
  createdAt: AT,
  updatedAt: AT,
});
const TIDES = canvas("c-tides", "Tide chart");
const REPORT = canvas("c-report", "潮汐月报");

/** What the window asked the core, in order. */
const asked: [string, unknown[]][] = [];

const CANVAS_TAB = {
  groups: [
    {
      id: "group",
      tabs: [{ id: "tab", item: { kind: "canvas", canvasId: TIDES.id } }],
      activeTabId: "tab",
      width: 1,
    },
  ],
  focusedGroupId: "group",
  reopenable: 0,
} as never;

let menus: typeof Menus;
let registry: typeof Registry;
let palette: typeof Palette;

beforeAll(async () => {
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    on: () => () => undefined,
    changeLayout: (_window, change) => {
      asked.push(["changeLayout", [change]]);
      return Promise.resolve(CANVAS_TAB);
    },
    deleteCanvas: (id) => {
      asked.push(["deleteCanvas", [id]]);
      return Promise.resolve();
    },
    restore: (refs, options) => {
      asked.push(["restore", [refs, options]]);
      return Promise.resolve({ audioLost: [], audioExpired: [] });
    },
  };
  const bridge = new Proxy(
    {},
    {
      get: (_each, name) =>
        answers[String(name)] ??
        (() => Promise.resolve(String(name).startsWith("list") ? [] : undefined)),
    },
  );
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  // ⌘K's kinds draw their icons: a path the type-check leaves to Vite, as a component's is.
  const findingKinds = "../../src/renderer/src/findingKinds.tsx";
  await import(findingKinds);
  menus = await import("../../src/renderer/src/commands/menus");
  registry = await import("../../src/renderer/src/commands/registry");
  palette = await import("../../src/renderer/src/palette");
  const { useCanvases } = await import("../../src/renderer/src/canvases");
  useCanvases.setState({ canvases: [TIDES, REPORT] });
});

afterEach(() => {
  asked.length = 0;
});

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

const onCanvas = {
  selection: [],
  focus: { kind: "canvas", id: TIDES.id },
  surface: "sidebar",
} as const;
const onTab = { selection: [], focus: { kind: "tab", id: "tab" }, surface: "sidebar" } as const;

const idsIn = (entries: Menus.MenuEntry[]) =>
  entries.map((entry) =>
    entry === "rule" ? "—" : menus.isMenuItem(entry) ? entry.command.id : "more",
  );

const openedAs = () =>
  asked.flatMap(([method, [change]]) =>
    method === "changeLayout" && (change as LayoutChange).type === "open"
      ? [(change as Extract<LayoutChange, { type: "open" }>).where]
      : [],
  );

describe("a Canvas's menu", () => {
  test("is Open and Open in new tab, then Delete last after a rule: no Rename and no Move to…", () => {
    expect(idsIn(menus.buildMenu("canvas", onCanvas))).toEqual([
      "canvas.open",
      "canvas.openTab",
      "—",
      "canvas.delete",
    ]);
  });

  test("on its tab is the tab's own items, then Delete, and none of a Note's", async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    useAppStore.setState({ layout: CANVAS_TAB });
    try {
      const ids = idsIn(menus.buildMenu("tab", onTab));
      expect(ids.at(-2)).toBe("—");
      expect(ids.at(-1)).toBe("canvas.delete");
      expect(ids).toContain("tab.close");
      expect(ids.filter((id) => id.startsWith("mind."))).toEqual([]);
    } finally {
      useAppStore.setState({ layout: null });
    }
  });

  test("Open shows it where it is open, Open in new tab in a tab of its own", async () => {
    await registry.commands.run("canvas.open", onCanvas);
    await registry.commands.run("canvas.openTab", onCanvas);
    expect(openedAs()).toEqual([{ in: "place" }, { in: "group" }]);
  });

  test("Delete moves it to Recently deleted at once, says so, and Undo brings it back", async () => {
    const { useUndo } = await import("../../src/renderer/src/undo");
    await registry.commands.run("canvas.delete", onCanvas);
    expect(asked).toEqual([["deleteCanvas", [TIDES.id]]]);
    const change = useUndo.getState().done.at(-1);
    expect(change?.said(en, (name) => name)).toBe("Moved “Tide chart” to Recently deleted");
    expect(change?.said(zh, (name) => name)).toBe("已将“Tide chart”移到回收站");
    await change?.undo();
    expect(asked.at(-1)).toEqual([
      "restore",
      [[{ kind: "canvas", id: TIDES.id }], { reopen: true }],
    ]);
  });

  test("selected with a Note, the two delete together, as one step", async () => {
    const both = {
      selection: [
        { kind: "mind", id: "m-notes" },
        { kind: "canvas", id: TIDES.id },
      ],
      focus: null,
      surface: "sidebar",
    } as const;
    expect(idsIn(menus.buildMixedMenu(both))).toEqual(["selection.delete"]);
    await registry.commands.run("selection.delete", both);
    expect(asked.map(([method]) => method)).toContain("deleteCanvas");
    const { useUndo } = await import("../../src/renderer/src/undo");
    expect(
      useUndo
        .getState()
        .done.at(-1)
        ?.said(en, (name) => name),
    ).toBe("Moved 2 items to Recently deleted");
  });
});

describe("⌘K", () => {
  const names = (query: string) =>
    palette
      .nameGroups(palette.readQuery(query).words, palette.findings(en))
      .map((group) => [group.id, group.title, group.items.map((item) => item.name)]);

  test("finds a Canvas by its title, a Chinese one by its pinyin, under Canvases", () => {
    expect(names("tide chart")).toEqual([["canvases", "palette.group.canvases", ["Tide chart"]]]);
    expect(names("chaoxi")).toEqual([["canvases", "palette.group.canvases", ["潮汐月报"]]]);
    expect(en("palette.group.canvases")).toBe("Canvases");
    expect(zh("palette.group.canvases")).toBe("页面");
  });

  test("opens it where it is open, and in a new tab with the palette's own modifier", async () => {
    const [found] = palette
      .nameGroups(palette.readQuery("tide").words, palette.findings(en))
      .flatMap((group) => group.items);
    expect(found?.kind).toBe("object");
    if (!found) return;
    await palette.runItem(found);
    await palette.runItem(found, { inTab: true });
    expect(openedAs()).toEqual([{ in: "place" }, { in: "group" }]);
  });
});
