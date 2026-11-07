import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement as reactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { AnswerAnalysis } from "../../src/core/api";
import { ANALYSIS_TABLE_ATTRIBUTE, ANALYSIS_TABLE_NODE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { noAnalysisOutput } from "../../src/shared/analysis";
import { installFigureRuns, retainFigureAnalysis } from "../../src/shared/figureRuns";
import { translate } from "../../src/shared/i18n";

/*
 * The caption's marker reads its table wherever the table is: with the caption moved below it,
 * the marker still gives the table's state, never "unavailable" (#2378).
 */

vi.mock("../../src/renderer/src/store", () => {
  const store = { status: { kind: "loading" } };
  return {
    useAppStore: Object.assign((select: (value: typeof store) => unknown) => select(store), {
      getState: () => store,
    }),
  };
});
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => "en",
  useT: () => (key: Parameters<typeof translate>[1], values: Parameters<typeof translate>[2]) =>
    translate("en", key, values),
}));
vi.mock("../../src/renderer/src/turnWall", () => ({ useKeptInsideOf: () => () => null }));
// The marker's menu reaches the app's commands, which listen to the core as they load.
vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy({}, { get: () => () => undefined }),
}));

const BINDING = { id: "run-1", table: { result: "region_totals" } };

const text = (value: string): JSONContent => ({ type: "text", text: value });
const row = (type: "tableHeader" | "tableCell", ...values: string[]): JSONContent => ({
  type: "tableRow",
  content: values.map((value) => ({
    type,
    attrs: { colspan: 1, rowspan: 1 },
    content: [{ type: "paragraph", content: [text(value)] }],
  })),
});

const CAPTION: JSONContent = {
  type: "paragraph",
  content: [
    text("Total amount by region"),
    { type: ANALYSIS_TABLE_NODE, attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: BINDING } },
  ],
};
/** Its North cell no longer the Analysis's 9,450: the table needs a look. */
const TABLE: JSONContent = {
  type: "table",
  attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: BINDING },
  content: [
    row("tableHeader", "region", "amount"),
    row("tableCell", "Central", "8,325"),
    row("tableCell", "North", "9,999"),
  ],
};

const RUN: AnswerAnalysis = {
  number: 1,
  title: "Orders by region",
  language: "python",
  code: "result('region_totals', …)",
  inputs: [
    {
      kind: "range",
      name: "orders",
      citation: {
        passageId: "p",
        documentId: "orders",
        documentName: "Orders",
        contentHash: "hash",
        pageFrom: 1,
        pageTo: 1,
        location: { kind: "rows", sheet: "Orders", from: 1, to: 41 },
        quote: "region\tamount",
        check: "found",
        checkReason: null,
      },
      range: "A1:E41",
      rows: 40,
      columns: 5,
      rowCount: 40,
      cut: false,
      sha256: "a".repeat(64),
    },
  ],
  versions: null,
  codeSha256: "b".repeat(64),
  outputSha256: "c".repeat(64),
  end: { kind: "done" },
  output: {
    ...noAnalysisOutput(),
    results: [
      {
        kind: "table",
        name: "region_totals",
        label: "Total amount by region",
        unit: null,
        table: {
          columns: ["region", "amount"],
          rows: [
            ["Central", 8325],
            ["North", 9450],
          ],
          rowCount: 2,
          columnCount: 2,
        },
      },
    ],
  },
  ms: 1,
  ranAt: "2026-11-04T00:00:00.000Z",
  markers: { figures: [], tables: [{ result: "region_totals", marker: 1 }], charts: [] },
};

let root: Root | null = null;
let container: HTMLElement;
const editors: Editor[] = [];
beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (): number => 0,
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = globalThis.document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  for (const editor of editors.splice(0)) editor.destroy();
  vi.unstubAllGlobals();
});

/** The marker as the Note draws it, in a Note of `blocks` that keeps the run. */
async function markerState(blocks: JSONContent[]): Promise<string | null> {
  const kept = retainFigureAnalysis(RUN, BINDING.id, [], [BINDING]);
  if (!kept) throw new Error("No record kept.");
  const doc = new Y.Doc();
  installFigureRuns(doc, [kept]);
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: noteExtensions(),
    content: { type: "doc", content: blocks },
  });
  editors.push(editor);
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === ANALYSIS_TABLE_NODE) at = pos;
    return at < 0;
  });
  const node = editor.state.doc.nodeAt(at);
  const path = "../../src/renderer/src/editor/AnalysisTableView.tsx";
  const module: { AnalysisTableView: ComponentType<Record<string, unknown>> } = await import(path);
  root ??= createRoot(container);
  await act(() =>
    root?.render(
      reactElement(module.AnalysisTableView, {
        node,
        editor,
        decorations: [],
        innerDecorations: [],
        getPos: () => at,
        selected: false,
        extension: null,
        HTMLAttributes: {},
        updateAttributes: () => {},
        deleteNode: () => {},
        view: editor.view,
        doc,
      }),
    ),
  );
  return (
    container.querySelector('[data-testid="analysis-table-marker"]')?.getAttribute("data-state") ??
    null
  );
}

test("the marker reads its table below its caption or above it", async () => {
  const above = await markerState([CAPTION, TABLE]);
  expect(above).toBe("unsupported");
  await act(() => root?.unmount());
  root = null;
  expect(await markerState([TABLE, CAPTION])).toBe(above);
});
