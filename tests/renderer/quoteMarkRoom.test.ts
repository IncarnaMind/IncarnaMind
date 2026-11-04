import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * A Citation's mark in a page's margin drops its label when the margin is too narrow for it
 * (#2459). With the room a pixel or two short of the mark's width with its label, the mark
 * switched its label on and off at each render until React gave up, and the viewer's panel
 * crashed. This DOM lays nothing out, so the mark's boxes get the widths the viewer's CSS gives
 * them: a flex row with a 2px gap, 3px and 5px padding, an 11px icon, 6.6px digits; the label has
 * a 3px margin, a 1px border, 5px padding and 6.3px letters, and takes no room while it isn't
 * shown. Each width is rounded, as offsetWidth is.
 */

interface Size {
  full: number;
  compact: number;
}

let root: Root | null = null;
let container: HTMLElement;
/** The mark's label at each commit: "shown", "hidden" or "none". */
let commits: string[] = [];
let sizes: Size[] = [];

const textWidth = (element: Element) =>
  [...(element.textContent ?? "")].reduce((sum, char) => sum + (/\d/.test(char) ? 6.6 : 6.3), 0);

const isLabel = (element: Element) => element.classList.contains("quote-mark-label");
/** The label's form while it isn't shown is `absolute` in the viewer's CSS. */
const outOfFlow = (element: Element) =>
  [...element.classList].some((name) => name.startsWith("quote-mark-label--"));

function layoutWidth(element: Element): number {
  if (element.tagName.toLowerCase() === "svg") return 11;
  if (isLabel(element)) return 1 + 5 + textWidth(element);
  if (!element.classList.contains("quote-mark")) return textWidth(element);
  const items = [...element.children].filter((child) => !outOfFlow(child));
  const inside = items.reduce(
    (sum, child) => sum + layoutWidth(child) + (isLabel(child) ? 3 : 0),
    0,
  );
  return 3 + inside + 2 * Math.max(0, items.length - 1) + 5;
}

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => new Promise(() => undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: Element) {
      return Math.round(layoutWidth(this));
    },
  });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  commits = [];
  sizes = [];
  measures = [];
  probe = null;
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language: "en", device: {}, user: {} } } as never);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const markElement = () => container.querySelector('[data-testid="viewer-quote-mark"]');

function labelState(): string {
  const shown = markElement()?.getAttribute("data-label-shown");
  return shown === "true" ? "shown" : shown === "false" ? "hidden" : "none";
}

async function showMark(room: number | undefined, label = "p. 1–2", number = 2) {
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const markPath = "../../src/renderer/src/viewer/quoteMark.tsx";
  const {
    CitationMark,
  }: {
    CitationMark: ComponentType<{
      mark: { tone: "found"; number: number; label?: string };
      style: object;
      room?: number;
      onSize?: (size: Size) => void;
    }>;
  } = await import(markPath);
  await act(() =>
    root?.render(
      createElement(
        Profiler,
        { id: "mark", onRender: () => commits.push(labelState()) },
        createElement(CitationMark, {
          mark: { tone: "found", number, label },
          style: { top: 0, left: 0 },
          room,
          onSize: (size: Size) => sizes.push(size),
        }),
      ),
    ),
  );
}

interface Measured {
  full: number;
  compact: number;
  number: number | undefined;
  label: string | undefined;
}

/** What a viewer holding the mark's measure had at each render: the mark's number and its measure. */
let measures: { number: number; measured: Measured | null }[] = [];
let probe: ComponentType<{ number: number; label: string }> | null = null;

/** A viewer's side of the mark: the hook that holds the measure, and the mark that reports it. */
async function showProbe(number: number, label = "p. 1–2") {
  const markPath = "../../src/renderer/src/viewer/quoteMark.tsx";
  const {
    CitationMark,
    useMarkMeasure,
  }: {
    CitationMark: ComponentType<{
      mark: { tone: "found"; number: number; label?: string };
      style: object;
      onSize?: (size: Size) => void;
    }>;
    useMarkMeasure: (mark: { tone: "found"; number: number; label?: string } | null) => {
      measured: Measured | null;
      onSize: (size: Size) => void;
    };
  } = await import(markPath);
  probe ??= function Probe(props: { number: number; label: string }) {
    const mark = { tone: "found" as const, number: props.number, label: props.label };
    const { measured, onSize } = useMarkMeasure(mark);
    measures.push({ number: props.number, measured });
    return createElement(CitationMark, { mark, style: { top: 0, left: 0 }, onSize });
  };
  const Viewer = probe;
  await act(() => root?.render(createElement(Viewer, { number, label })));
}

// "p. 1–2" has two digits and four other signs: the label's box is 1 + 5 + 38.4 = 44.4px. The
// mark is 3 + 11 + 2 + 6.6 + 5 = 27.6px without it (28 rounded), and 27.6 + 2 + 3 + 44.4 = 77px
// with it.
const FULL = 77;
const COMPACT = 28;

describe("the mark's label in a margin around its width (#2459)", () => {
  test("narrowing the room across the mark's width settles at each step", async () => {
    for (const room of [90, 78, 77, 76.5, 76, 75, 74, 40]) {
      commits = [];
      await showMark(room);
      expect(labelState(), `room ${room}`).toBe(room >= FULL ? "shown" : "hidden");
      expect(commits.length, `commits at room ${room}`).toBeLessThanOrEqual(3);
    }
  });

  test("widening the room across the mark's width settles at each step", async () => {
    for (const room of [40, 74, 75, 76, 76.5, 77, 78, 90]) {
      commits = [];
      await showMark(room);
      expect(labelState(), `room ${room}`).toBe(room >= FULL ? "shown" : "hidden");
      expect(commits.length, `commits at room ${room}`).toBeLessThanOrEqual(3);
    }
  });

  test("a mark first shown with the room just short of its width settles", async () => {
    for (const room of [76.5, 76, 75.5, 75]) {
      await act(() => root?.unmount());
      root = createRoot(container);
      commits = [];
      await showMark(room);
      expect(labelState(), `room ${room}`).toBe("hidden");
      expect(commits.length, `commits at room ${room}`).toBeLessThanOrEqual(3);
    }
  });

  test("tells its place the same widths whether its label shows or not", async () => {
    await showMark(90);
    await showMark(74);
    await showMark(0);
    await showMark(undefined);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toEqual({ full: FULL, compact: COMPACT });
  });

  test("tells its place the widths of the label it shows, never those of the label before it", async () => {
    await showMark(90, "p. 1");
    expect(sizes.at(-1)).toEqual({ full: 64, compact: COMPACT });
    sizes = [];
    await showMark(90, "p. 1–2");
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toEqual({ full: FULL, compact: COMPACT });
  });

  test("tells its place the widths of the number it shows, never those of the number before it", async () => {
    await showMark(120, "p. 1–2", 9);
    expect(sizes.at(-1)).toEqual({ full: 77, compact: 28 });
    sizes = [];
    await showMark(120, "p. 1–2", 10);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toEqual({ full: 84, compact: 34 });
  });

  test("the mark and its copies stay out of the words a quote is found in and a selection reads", async () => {
    // As the viewers read a page's words (`textNodes`): none under `data-quote-skip`.
    const read = (node: Node): string =>
      node.nodeType === 3
        ? (node.textContent ?? "")
        : (node as Element).hasAttribute?.("data-quote-skip")
          ? ""
          : [...node.childNodes].map(read).join("");
    for (const room of [90, 40]) {
      await showMark(room);
      expect(markElement()?.textContent, `room ${room}`).toBe("2p. 1–2");
      expect(read(container), `room ${room}`).toBe("");
    }
  });

  test("a mark with no label shows no label at any room", async () => {
    for (const room of [0, 27, 28, 29, 90]) {
      sizes = [];
      await showMark(room, "");
      expect(labelState(), `room ${room}`).toBe("none");
      for (const size of sizes) expect(size).toEqual({ full: COMPACT, compact: COMPACT });
    }
  });
});

describe("a viewer's measure of its mark, read only for the number and label it was taken for", () => {
  test("the next number of the same row, a digit wider: no render sees the narrower measure", async () => {
    await showProbe(9);
    expect(measures.at(-1)?.measured).toEqual({
      full: 77,
      compact: 28,
      number: 9,
      label: "p. 1–2",
    });
    measures = [];
    await showProbe(10);
    const ten = measures.filter((each) => each.number === 10);
    expect(ten.length).toBeGreaterThan(0);
    for (const each of ten) expect(each.measured?.full ?? 84).toBe(84);
    expect(ten.at(-1)?.measured).toEqual({ full: 84, compact: 34, number: 10, label: "p. 1–2" });
  });

  test("the next number of the same row, as wide: measured again, so the mark is placed", async () => {
    await showProbe(1);
    expect(measures.at(-1)?.measured).toEqual({
      full: 77,
      compact: 28,
      number: 1,
      label: "p. 1–2",
    });
    measures = [];
    await showProbe(2);
    expect(measures.at(-1)?.measured).toEqual({
      full: 77,
      compact: 28,
      number: 2,
      label: "p. 1–2",
    });
  });
});
