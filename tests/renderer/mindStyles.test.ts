import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { DEFAULT_MIND_STYLE, type MindStyle } from "../../src/shared/mindStyle";
import { undoLines } from "../helpers/undoLines";

/*
 * A Mind's font and text size as the window handles them: a choice shows at once and is
 * written through the core, Undo puts the Mind back, a refusal puts it back at once, and a
 * font is called missing only when the page draws it as the generic family it falls back to.
 */

type Styles = typeof import("../../src/renderer/src/mindStyles");
let styles: Styles;
let undo: typeof import("../../src/renderer/src/undo");
let app: typeof import("../../src/renderer/src/store");
let said: ReturnType<typeof undoLines>["said"];

const written: [string, MindStyle][] = [];
/** What the core holds for each Mind: the page's `core.getMindStyle` and `setMindStyle`. */
const held = new Map<string, MindStyle>();
let refuse = false;
const reported: unknown[] = [];
const logged: unknown[] = [];
/** What `window.queryLocalFonts()` answers: the fonts Chromium lists, or a refusal. */
let localFonts: () => Promise<{ family: string; style: string }[]> = async () => [];

beforeAll(async () => {
  const handlers: Record<string, unknown> = {
    getMindStyle: async (mindId: string) => held.get(mindId) ?? DEFAULT_MIND_STYLE,
    setMindStyle: async (mindId: string, style: MindStyle) => {
      if (refuse) throw new Error("The core refused.");
      written.push([mindId, style]);
      held.set(mindId, style);
      return style;
    },
  };
  const bridge = new Proxy(handlers, {
    get: (target, name: string) => target[name] ?? (() => () => undefined),
  });
  const files = new Proxy(
    { logError: (report: unknown) => void logged.push(report) } as Record<string, unknown>,
    { get: (target, name: string) => target[name] ?? (() => () => undefined) },
  );
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: files,
    queryLocalFonts: () => localFonts(),
  };
  styles = await import("../../src/renderer/src/mindStyles");
  undo = await import("../../src/renderer/src/undo");
  app = await import("../../src/renderer/src/store");
  ({ said } = undoLines((await import("../../src/renderer/src/i18n")).translateNow));
  app.useAppStore.setState({ reportError: (error) => void reported.push(error) });
});

afterEach(() => {
  written.length = 0;
  held.clear();
  reported.length = 0;
  logged.length = 0;
  localFonts = async () => [];
  refuse = false;
  undo.useUndo.setState({ done: [], undone: [], line: null });
});

describe("choosing a font and a text size", () => {
  test("is written through the core and offers Undo, which puts the Mind back", async () => {
    await styles.chooseFont("a", "serif");
    expect(written).toEqual([["a", { font: "serif", size: "default" }]]);
    expect(said(undo.useUndo.getState().line?.change)).toBe("Font changed to Serif");

    await styles.chooseSize("a", "large");
    expect(written.at(-1)).toEqual(["a", { font: "serif", size: "large" }]);
    expect(said(undo.useUndo.getState().line?.change)).toBe("Text size changed to Large");

    await undo.useUndo.getState().undo();
    expect(held.get("a")).toEqual({ font: "serif", size: "default" });
    await undo.useUndo.getState().undo();
    expect(held.get("a")).toEqual(DEFAULT_MIND_STYLE);
    await undo.useUndo.getState().redo();
    expect(held.get("a")).toEqual({ font: "serif", size: "default" });
  });

  test("an installed font is chosen by its family, and named in the Undo line as it is", async () => {
    await styles.chooseFont("songti", { family: "Songti SC" });
    expect(held.get("songti")?.font).toEqual({ family: "Songti SC" });
    expect(said(undo.useUndo.getState().line?.change)).toBe("Font changed to Songti SC");
  });

  test("choosing what the Mind has already changes nothing and offers no Undo", async () => {
    await styles.chooseFont("untouched", "default");
    await styles.chooseSize("untouched", "default");
    expect(written).toEqual([]);
    expect(undo.useUndo.getState().line).toBeNull();
  });

  test("a Mind the window hasn't opened keeps the choice it already had", async () => {
    held.set("b", { font: "mono", size: "small" });
    await styles.chooseSize("b", "large");
    expect(held.get("b")).toEqual({ font: "mono", size: "large" });
  });

  test("when the core refuses, the Mind is as it was, with the problem shown and no Undo", async () => {
    await styles.chooseFont("c", "mono");
    undo.useUndo.setState({ done: [], undone: [], line: null });
    refuse = true;
    await styles.chooseFont("c", "serif");
    expect(held.get("c")).toEqual({ font: "mono", size: "default" });
    expect(reported).toHaveLength(1);
    expect(undo.useUndo.getState().line).toBeNull();
  });
});

describe("making a style the default for new Minds", () => {
  test("is a setting, and Undo puts the one before back", async () => {
    const updates: unknown[] = [];
    const updateSettings = vi.fn(async (patch: { user: { newMindStyle: MindStyle } }) => {
      updates.push(patch.user.newMindStyle);
      app.useAppStore.setState({
        settings: { user: { newMindStyle: patch.user.newMindStyle } } as never,
      });
    });
    app.useAppStore.setState({ updateSettings } as never);
    const style: MindStyle = { font: "serif", size: "large" };
    await styles.makeDefaultForNewMinds(style);
    expect(updates).toEqual([style]);
    expect(said(undo.useUndo.getState().line?.change)).toBe("New notes will start in this style");
    await undo.useUndo.getState().undo();
    expect(updates.at(-1)).toEqual(DEFAULT_MIND_STYLE);
    app.useAppStore.setState({ settings: null });
  });
});

describe("whether a font is installed", () => {
  /** A page whose generic families are 100, 90 and 80 wide, and which knows only these fonts. */
  const page =
    (...installed: string[]) =>
    (font: string) => {
      const base = font.endsWith("monospace") ? 100 : font.endsWith("sans-serif") ? 80 : 90;
      const family = /^"([^"]*)"/.exec(font)?.[1];
      return family && installed.includes(family) ? base + 7.5 : base;
    };

  test("is yes for a family the page draws differently from the generic one it falls back to", () => {
    expect(styles.isFontInstalled("Georgia", page("Georgia"))).toBe(true);
  });

  test("is no for a family that is drawn as the generic one", () => {
    expect(styles.isFontInstalled("Nowhere Sans", page("Georgia"))).toBe(false);
  });

  test("is yes when the page can't draw to find out, so a font is never called missing wrongly", () => {
    expect(styles.isFontInstalled("Nowhere Sans", null)).toBe(true);
  });

  test("takes a name with a quote in it as one name", () => {
    expect(styles.isFontInstalled('Bad"Name', page("BadName"))).toBe(true);
  });
});

describe("the fonts installed on this computer", () => {
  const face = (family: string, style = "Regular") => ({ family, style });

  test("are each family once, in order, without the system's hidden ones", async () => {
    localFonts = async () => [
      face("Songti SC"),
      face("Georgia"),
      face("Georgia", "Bold"),
      face(".SF NS"),
      face("Bad\u0000Name"),
      face("Arial"),
    ];
    expect(await styles.installedFamilies()).toEqual(["Arial", "Georgia", "Songti SC"]);
  });

  test("come back empty, quietly and logged, when the computer refuses to say", async () => {
    localFonts = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
    expect(await styles.installedFamilies()).toEqual([]);
    expect(reported).toEqual([]);
    expect(logged).toHaveLength(1);
  });

  test("come back empty when the page has no font list to ask", async () => {
    const page = (globalThis as unknown as { window: Record<string, unknown> }).window;
    const asked = page.queryLocalFonts;
    delete page.queryLocalFonts;
    try {
      expect(await styles.installedFamilies()).toEqual([]);
    } finally {
      page.queryLocalFonts = asked;
    }
    expect(reported).toEqual([]);
  });

  test("come back empty when there are none", async () => {
    localFonts = async () => [];
    expect(await styles.installedFamilies()).toEqual([]);
    expect(logged).toEqual([]);
  });
});
