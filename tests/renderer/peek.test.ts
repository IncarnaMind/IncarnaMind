import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { keysLabel } from "../../src/renderer/src/commands/keys";
import { buildMenu, isMenuItem, type MenuEntry } from "../../src/renderer/src/commands/menus";
import {
  type CommandContext,
  commands,
  labelOf,
  menuLabelOf,
} from "../../src/renderer/src/commands/registry";
import {
  DRAWN_UP_TO_BYTES,
  neighbour,
  PEEK_WIDTH,
  peekDraws,
  placePeek,
} from "../../src/renderer/src/peekPlace";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * Peek (Space): where it goes, which row it steps to, what its key does on a
 * row, and its command in the menus and ⌘K (docs/agents/interaction.md, rules 5 and 7).
 */

const edges = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});
const WINDOW = { width: 1600, height: 900 };
const SIZE = { width: PEEK_WIDTH, height: 440 };

describe("where a peek goes", () => {
  const sidebar = edges(0, 0, 248, 900);

  test("in the sidebar, over the card's side, level with its row", () => {
    const row = edges(8, 300, 240, 328);
    const spot = placePeek("sidebar", sidebar, row, SIZE, WINDOW);
    expect(spot.left).toBeGreaterThan(sidebar.right);
    expect(spot.top).toBe(row.top);
  });

  test("in the sidebar, kept inside the window when the row is near its foot", () => {
    const row = edges(8, 860, 240, 888);
    const spot = placePeek("sidebar", sidebar, row, SIZE, WINDOW);
    expect(spot.top + SIZE.height).toBeLessThanOrEqual(WINDOW.height);
  });

  test("in the Library, at the top right of its page", () => {
    const library = edges(256, 44, 1592, 892);
    const spot = placePeek("library", library, edges(0, 0, 0, 0), SIZE, WINDOW);
    expect(spot.left + SIZE.width).toBeLessThanOrEqual(library.right);
    expect(spot.left).toBeGreaterThan(library.left);
    expect(spot.top).toBeGreaterThanOrEqual(library.top);
  });

  test("in a Library too narrow for it, over its left edge rather than outside it", () => {
    const library = edges(256, 44, 500, 892);
    const spot = placePeek("library", library, edges(0, 0, 0, 0), SIZE, WINDOW);
    expect(spot.left).toBeGreaterThanOrEqual(library.left);
  });

  test("in a window smaller than it, at the window's corner", () => {
    const spot = placePeek("sidebar", sidebar, edges(8, 300, 240, 328), SIZE, {
      width: 300,
      height: 300,
    });
    expect(spot).toEqual({ left: 8, top: 8 });
  });
});

describe("which Documents a peek draws", () => {
  const ready = { status: "ready", failure: null };

  test("draws a small file of any kind", () => {
    for (const kind of ["docx", "pptx", "xlsx", "csv", "markdown", "text"]) {
      expect(peekDraws({ kind, size: 50_000, ...ready }), kind).toBe(true);
    }
  });

  test("shows only the kind of a large file that the viewer would read whole, but draws any PDF", () => {
    expect(peekDraws({ kind: "docx", size: DRAWN_UP_TO_BYTES + 1, ...ready })).toBe(false);
    expect(peekDraws({ kind: "text", size: 40_000_000, ...ready })).toBe(false);
    expect(peekDraws({ kind: "pdf", size: 400_000_000, ...ready })).toBe(true);
  });

  test("shows only the kind of a file that couldn't be read, but draws a scan some of whose pages couldn't", () => {
    const failed = { status: "failed", failure: { reason: "unreadable" } };
    expect(peekDraws({ kind: "pdf", size: 5_000, ...failed })).toBe(false);
    const unread = { status: "failed", failure: { reason: "pages-unread" } };
    expect(peekDraws({ kind: "pdf", size: 5_000, ...unread })).toBe(true);
  });
});

describe("the row a peek steps to", () => {
  const rows = ["a", "b", "c"];

  test("is the next row going down and the previous going up", () => {
    expect(neighbour(rows, "b", 1)).toBe("c");
    expect(neighbour(rows, "b", -1)).toBe("a");
  });

  test("is none past either end, or for a row that isn't in the list", () => {
    expect(neighbour(rows, "c", 1)).toBeUndefined();
    expect(neighbour(rows, "a", -1)).toBeUndefined();
    expect(neighbour(rows, "z", 1)).toBeUndefined();
  });
});

/** An element for the key handler to look at: it matches the selectors it was made to. */
class FakeElement {
  constructor(private readonly selectors: readonly string[]) {}
  matches(selector: string) {
    return this.selectors.some((each) => selector.includes(each));
  }
}

const english = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const chinese = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);
const idsIn = (entries: MenuEntry[]) =>
  entries.flatMap((entry) => (isMenuItem(entry) ? [entry.command.id] : []));

let peek: typeof import("../../src/renderer/src/peek");

beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  Object.assign(globalThis, {
    window: { incarnamind: bridge, incarnamindFiles: bridge },
    Element: FakeElement,
  });
  await import("../../src/renderer/src/commands/app");
  peek = await import("../../src/renderer/src/peek");
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    documents: ["a", "b"].map(
      (id) =>
        ({ id, name: `Doc ${id}`, kind: "pdf", status: "ready", fileStatus: "available" }) as never,
    ),
  });
});

afterEach(() => peek.usePeek.getState().close());

describe("Space on a Document's row", () => {
  const row = { id: "the row" } as unknown as HTMLElement;

  function press(
    over: Partial<{
      key: string;
      target: FakeElement;
      repeat: boolean;
      shiftKey: boolean;
      metaKey: boolean;
      isComposing: boolean;
    }> = {},
  ) {
    let prevented = false;
    const event = {
      key: " ",
      target: new FakeElement(["data-tree-row"]),
      currentTarget: row,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: over.isComposing ?? false },
      preventDefault: () => {
        prevented = true;
      },
      ...over,
    };
    peek.peekRowProps("a", "library").onKeyDownCapture(event as never);
    return prevented;
  }

  test("peeks at the Document, in the list it is in, and doesn't open it as a button would", () => {
    expect(press()).toBe(true);
    expect(peek.usePeek.getState().target).toEqual({
      documentId: "a",
      surface: "library",
      row,
    });
  });

  test("a second time puts the peek away", () => {
    press();
    press();
    expect(peek.usePeek.getState().target).toBeNull();
  });

  test("held down, doesn't open and close it again and again", () => {
    press();
    expect(press({ repeat: true })).toBe(true);
    expect(peek.usePeek.getState().target?.documentId).toBe("a");
  });

  test("leaves the other buttons in the row, and other keys and chords, alone", () => {
    expect(press({ target: new FakeElement(["data-object-menu"]) })).toBe(false);
    expect(press({ key: "Enter" })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(press({ shiftKey: true })).toBe(false);
    expect(press({ isComposing: true })).toBe(false);
    expect(peek.usePeek.getState().target).toBeNull();
  });
});

describe("the Peek command", () => {
  const on = (surface: CommandContext["surface"], ids: string[] = ["a"]): CommandContext => ({
    selection: [],
    focus: null,
    surface,
    ...(ids.length === 1
      ? { focus: { kind: "document", id: ids[0] ?? "" } }
      : { selection: ids.map((id) => ({ kind: "document" as const, id })) }),
  });

  test("is offered for one Document in the sidebar and in the Library", () => {
    for (const surface of ["sidebar", "library"] as const) {
      expect(idsIn(buildMenu("document", on(surface)))).toContain("document.peek");
    }
  });

  test("is not offered for several, or where there is no list beside it", () => {
    expect(idsIn(buildMenu("document", on("library", ["a", "b"])))).not.toContain("document.peek");
    for (const surface of ["viewer", "mind"] as const) {
      expect(idsIn(buildMenu("document", on(surface)))).not.toContain("document.peek");
    }
  });

  test("is in the menu after the ways to open the Document, with Space beside it", () => {
    const ids = idsIn(buildMenu("document", on("sidebar")));
    expect(ids.indexOf("document.peek")).toBe(ids.indexOf("document.openTab") + 1);
    const command = commands.get("document.peek");
    expect(command?.rowKeys).toBe("Space");
    expect(keysLabel("Space", true)).toBe("Space");
    expect(keysLabel("Space", false)).toBe("Space");
  });

  test("is called Peek in English and 预览 in Chinese", () => {
    const command = commands.get("document.peek");
    const ctx = on("sidebar");
    expect(command && menuLabelOf(command, ctx, english)).toBe("Peek");
    expect(command && labelOf(command, ctx, chinese)).toBe("预览");
  });
});

test("the peek's words are in both languages", () => {
  const keys: MessageKey[] = ["peek.label", "peek.kind", "peek.ask"];
  for (const key of keys) {
    expect(english(key, { name: "Tides" })).not.toBe("");
    expect(chinese(key, { name: "潮汐" })).not.toBe("");
  }
  expect(english("peek.label", { name: "Tides" })).toBe("Peek: Tides");
  expect(chinese("peek.label", { name: "潮汐" })).toBe("预览：潮汐");
});
