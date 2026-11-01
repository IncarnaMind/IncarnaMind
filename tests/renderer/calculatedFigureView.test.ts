import { Editor, getSchema } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { EditorState } from "@tiptap/pm/state";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement as reactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import {
  type CalculatedFigure,
  type FigureInput,
  MIND_CONTENT_FIELD,
  type RetainedFigureAnalysis,
} from "../../src/core/api";
import { figureCommands } from "../../src/renderer/src/commands/figures";
import { editCalculatedFigure } from "../../src/renderer/src/editor/calculatedFigureActions";
import {
  citationClustersPlugin,
  formattingClusters,
} from "../../src/renderer/src/editor/citationClusters";
import { citationNumbersPlugin } from "../../src/renderer/src/editor/citationNumbers";
import { FigureEvidence } from "../../src/renderer/src/editor/figureEvidence";
import { figureHandle } from "../../src/renderer/src/editor/figureHandle";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { useCitationPeek } from "../../src/renderer/src/editor/peek";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import type { ClaimCheckShown } from "../../src/shared/claimChecks";
import {
  type CalculatedSources,
  calculatedCitations,
  calculatedSources,
  figureRunsFor,
  installFigureRuns,
} from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { translate } from "../../src/shared/i18n";

const state = vi.hoisted(() => ({
  language: "en" as "en" | "zh-CN",
  open: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock("../../src/renderer/src/store", () => {
  const store: { documents: never[]; reportError: typeof state.reportError } = {
    documents: [],
    reportError: state.reportError,
  };
  return {
    useAppStore: Object.assign((select: (value: typeof store) => unknown) => select(store), {
      getState: () => store,
    }),
  };
});
vi.mock("../../src/renderer/src/core", () => ({ core: { readScannedQuote: async () => null } }));
vi.mock("../../src/renderer/src/openCited", () => ({
  openCited: (...args: unknown[]) => state.open(...args),
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => state.language,
  useT: () => (key: Parameters<typeof translate>[1], values: Parameters<typeof translate>[2]) =>
    translate(state.language, key, values),
}));

const input: FigureInput = {
  name: "revenue",
  label: "Revenue 2026 / 2026年收入",
  citation: {
    documentId: "source",
    passageId: "p",
    documentName: "Invented accounts",
    contentHash: "v1",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page", from: 1, to: 1 },
    quote: "Revenue 1,200",
    check: "found",
    checkReason: null,
  },
  number: {
    chars: "1,200",
    at: 8,
    value: 1200,
    scale: 1,
    scaleWord: null,
    unit: { kind: "plain" },
    decimals: 0,
    approximate: false,
    reading: null,
  },
  cell: { sheet: "Results", ref: "B2", stored: 1200.01 },
  unitStatement: {
    citation: {
      documentId: "units",
      passageId: "u",
      documentName: "Units",
      contentHash: "uv",
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "page", from: 2, to: 2 },
      quote: "Amounts in pounds",
      check: "found",
      checkReason: null,
    },
    scale: 1,
    scaleWord: null,
    currency: "GBP",
  },
};
const formula: CalculatedFigure = {
  label: "Quarterly amount",
  formula: "revenue / 4",
  inputs: [input],
  value: 300,
  unit: { kind: "plain" },
  approximate: false,
  shown: "300",
  show: { language: "en", as: "number", decimals: 0, scale: null },
  literals: [{ text: "4", value: 4, at: 10 }],
  engine: FORMULA_VERSION,
  written: null,
};
const analysis: CalculatedFigure = {
  ...formula,
  formula: "",
  inputs: [],
  literals: [],
  analysis: { analysis: 1, result: "total" },
};
const record: RetainedFigureAnalysis = {
  id: "run",
  title: "Quarterly amounts",
  language: "python",
  code: "result('total', 300)",
  codeSha256: "a".repeat(64),
  ranAt: "2026-10-27T12:00:00.000Z",
  versions: null,
  inputs: [{ kind: "figure", name: "revenue", input, sha256: "b".repeat(64) }],
  values: [
    { kind: "figure", name: "total", label: "Total", value: 300, unit: null },
    { kind: "figure", name: "unused", label: "Unused", value: 999, unit: null },
  ],
};
const attrs = (figure = formula) => ({
  id: "figure",
  figure,
  analysisId: figure.analysis ? "run" : null,
});
const node = (figure = formula) =>
  calculatedFigureNode(figure, "figure", figure.analysis ? "run" : null);

const docs: Y.Doc[] = [];
function receiptDoc() {
  const doc = new Y.Doc();
  docs.push(doc);
  installFigureRuns(doc, [record]);
  return doc;
}

test("formula and retained Analysis use the same strict, bounded source closure", () => {
  expect(calculatedCitations(calculatedSources(attrs(), null))).toEqual([
    input.citation,
    input.unitStatement?.citation,
  ]);
  const doc = receiptDoc();
  const sources = calculatedSources(attrs(analysis), doc);
  expect(sources.analysis?.values.map((value) => value.name)).toEqual(["total"]);
  expect(sources.inputs).toEqual([input]);
  expect(() => calculatedSources(attrs(analysis), new Y.Doc())).toThrow();
});

test("actual common numbering feeds input clusters in Note order without moving ordinary Citation indices", () => {
  const schema = getSchema(noteExtensions());
  const content = [
    {
      type: "paragraph",
      content: [
        { type: "citation", attrs: { ...input.citation, id: "c1" } },
        node(),
        {
          type: "footnote",
          attrs: { id: "fn" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Own footnote" }] }],
        },
        { type: "citation", attrs: { ...input.citation, id: "c2" } },
      ],
    },
  ];
  const editor = EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content }),
    plugins: [citationNumbersPlugin(), citationClustersPlugin()],
  });
  const clusters = formattingClusters(editor, null);
  expect(clusters.map((cluster) => [cluster.citation, cluster.figure])).toEqual([
    [0, null],
    [null, "figure"],
    [1, null],
  ]);
  expect(clusters[1]?.works.map((work) => work.documentId)).toEqual(["source", "units"]);
});

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
  const globals: Record<string, unknown> = {
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
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
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
  state.language = "en";
  state.open.mockClear();
  state.reportError.mockClear();
  figureHandle.current = null;
});
afterEach(async () => {
  await act(() => root?.unmount());
  for (const editor of editors.splice(0)) editor.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
  root = null;
  figureHandle.current = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function editorWith(figure = formula) {
  const doc = receiptDoc();
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([
    createElement({
      type: "paragraph",
      attrs: { id: "p" },
      content: [{ type: "text", text: "Amount / 合计 " }, node(figure)],
    }),
  ]);
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      FigureEvidence.configure({ doc }),
    ],
  });
  editors.push(editor);
  vi.spyOn(editor.view, "focus").mockImplementation(() => {});
  let at = -1;
  editor.state.doc.descendants((value, pos) => {
    if (value.type.name === "calculatedFigure") at = pos;
  });
  if (at < 0) throw new Error("Missing calculated figure");
  return { editor, at, doc };
}

test.each([false, true])(
  "the real editor %s action is one Undo step and reads the latest shown value",
  (convert) => {
    const { editor, at } = editorWith();
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(at, undefined, {
        ...editor.state.doc.nodeAt(at)?.attrs,
        figure: { ...formula, shown: "300.0" },
      }),
    );
    expect(editCalculatedFigure(editor, "other", at, convert)).toBe(false);
    expect(editCalculatedFigure(editor, "figure", at, convert)).toBe(true);
    expect(editor.state.doc.textContent).toBe(convert ? "Amount / 合计 300.0" : "Amount / 合计 ");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.nodeAt(at)?.attrs.figure.shown).toBe("300.0");
    expect(editor.commands.redo()).toBe(true);
  },
);

test("deleting the last Analysis figure prunes its receipt and Undo restores both", () => {
  const { editor, at, doc } = editorWith(analysis);
  expect(figureRunsFor(doc, [node(analysis)])).toHaveLength(1);
  expect(editCalculatedFigure(editor, "figure", at, false)).toBe(true);
  expect(() => figureRunsFor(doc, [node(analysis)])).toThrow();
  expect(editor.commands.undo()).toBe(true);
  expect(figureRunsFor(doc, [node(analysis)])).toHaveLength(1);
});

test("read-only editor and stale positions never remove the User’s text", () => {
  const { editor, at } = editorWith();
  const before = editor.getJSON();
  editor.setEditable(false);
  expect(editCalculatedFigure(editor, "figure", at, true)).toBe(false);
  editor.setEditable(true);
  expect(editCalculatedFigure(editor, "figure", undefined, true)).toBe(false);
  expect(editor.getJSON()).toEqual(before);
});

interface CardProps {
  figure: CalculatedFigure;
  shown: ClaimCheckShown;
  replayed: boolean;
  sources: CalculatedSources | null;
  problem: boolean;
  onCopyFormula(): void;
}
async function card(props: CardProps) {
  const path = "../../src/renderer/src/editor/CalculatedFigureCard.tsx";
  const module: { CalculatedFigureCard: ComponentType<CardProps> } = await import(path);
  root ??= createRoot(container);
  await act(() => root?.render(reactElement(module.CalculatedFigureCard, props)));
}
test.each(["en", "zh-CN"] as const)(
  "%s card shows original formula, raw cell, unit quote and literals without claiming an unchecked execution",
  async (language) => {
    state.language = language;
    const copy = vi.fn();
    await card({
      figure: formula,
      shown: { state: "not-checked", reason: "unread" },
      replayed: false,
      sources: calculatedSources(attrs(), null),
      problem: false,
      onCopyFormula: copy,
    });
    expect(container.textContent).toContain("Revenue 2026 / 2026年收入 ÷ 4");
    expect(container.textContent).toContain("1,200 ÷ 4");
    expect(container.textContent).toContain("1,200.01");
    expect(container.textContent).toContain("Amounts in pounds");
    expect(container.textContent).toContain(translate(language, "figures.inline.savedNote"));
    expect(container.textContent).not.toContain(translate(language, "figures.inline.recalculated"));
    const buttons = [...container.querySelectorAll("button")];
    await act(() => {
      buttons
        .find((button) => button.textContent === translate(language, "figures.inline.copyFormula"))
        ?.click();
    });
    expect(copy).toHaveBeenCalledOnce();
    await act(() => {
      buttons
        .find((button) => button.textContent === translate(language, "figures.inline.openInput"))
        ?.click();
    });
    expect(state.open).toHaveBeenCalledWith(input.citation, { check: "found", withQuote: true });
  },
);

test("a retained Analysis card never becomes a fresh execution claim", async () => {
  const sources = calculatedSources(attrs(analysis), receiptDoc());
  await card({
    figure: analysis,
    shown: { state: "supported" },
    replayed: false,
    sources,
    problem: false,
    onCopyFormula: () => {},
  });
  expect(container.textContent).toContain("Saved Analysis · not run again");
  expect(container.textContent).toContain(record.code);
  expect(container.textContent).not.toContain("Inputs found · recalculated");
});

test("shared figure commands use the same callbacks and refuse another row or a read-only edit", () => {
  const handle = {
    id: "figure",
    editable: () => false,
    open: vi.fn(),
    copyFormula: vi.fn(),
    convertToText: vi.fn(),
    remove: vi.fn(),
    here: () => ({}),
  };
  figureHandle.current = handle;
  const context = { surface: "mind" as const, selection: [], focus: null };
  const open = figureCommands.find((command) => command.id === "figure.open");
  const remove = figureCommands.find((command) => command.id === "figure.remove");
  expect(open?.when?.(context)).toBe(true);
  open?.run(context);
  expect(handle.open).toHaveBeenCalledOnce();
  expect(remove?.when?.(context)).toBe(false);
  expect(open?.when?.({ ...context, focus: { kind: "check", id: "other" } })).toBe(false);
});

test("the shared hover hook holds across marker-to-card focus and clears pending work", async () => {
  vi.useFakeTimers();
  let current: ReturnType<typeof useCitationPeek> | null = null;
  function Probe() {
    const peek = useCitationPeek();
    current = peek;
    return reactElement("span", null, String(peek.peeking));
  }
  root = createRoot(container);
  await act(() => root?.render(reactElement(Probe)));
  const read = () => {
    if (!current) throw new Error("Missing hover state");
    return current;
  };
  await act(() => {
    read().hold("marker", true);
    vi.advanceTimersByTime(120);
  });
  expect(container.textContent).toBe("true");
  await act(() => {
    read().hold("marker", false);
    read().hold("card-focus", true);
    vi.advanceTimersByTime(200);
  });
  expect(container.textContent).toBe("true");
  await act(() => {
    read().clear();
    vi.runOnlyPendingTimers();
  });
  expect(container.textContent).toBe("false");
});

const growth: FigureInput = {
  ...input,
  name: "Assumptions_B4",
  label: "Revenue growth (Growth)",
  citation: {
    ...input.citation,
    location: { kind: "rows", sheet: "Assumptions", from: 4, to: 4 },
    quote: "Revenue growth\t5.0%",
  },
  number: {
    ...input.number,
    chars: "5.0%",
    at: 15,
    value: 0.05,
    unit: { kind: "percent" },
    decimals: 1,
  },
  cell: { sheet: "Assumptions", ref: "B4", stored: 0.05 },
  unitStatement: null,
};
const whatIf: CalculatedFigure = {
  ...formula,
  label: "EBITDA 2027 at 3% growth",
  formula: "",
  inputs: [growth],
  value: 240.39994,
  shown: "240.4",
  literals: [],
  workbook: {
    cell: {
      sheet: "DCF",
      ref: "E5",
      label: "EBITDA 2027",
      formula: "E4*Margin",
      value: 240.39994,
      citation: { ...growth.citation, quote: "EBITDA\t231.0\t242.6\t254.7" },
    },
    steps: [
      { sheet: "DCF", ref: "E4", label: "Revenue 2027", formula: "D4*(1+Growth)", value: 1092.727 },
    ],
    formulaCells: 5,
    moreInputs: 0,
    saved: 254.6775,
    savedShown: "254.7",
    change: { input: "Assumptions_B4", value: 0.03, shown: "3.0%" },
    kept: [],
    engine: 1,
  },
};
const keptValue: CalculatedFigure = {
  ...whatIf,
  label: "Figure",
  value: 5.2,
  shown: "5.2",
  workbook: {
    ...(whatIf.workbook as NonNullable<CalculatedFigure["workbook"]>),
    change: null,
    saved: 5.2,
    savedShown: "5.2",
    kept: [{ sheet: "Cases", ref: "C2", reason: "volatile", name: "RAND" }],
  },
};

test.each(["en", "zh-CN"] as const)(
  "%s: a workbook figure's card shows its formula chain, the input a what-if changed, and the cells that kept saved values",
  async (language) => {
    state.language = language;
    await card({
      figure: whatIf,
      shown: { state: "not-checked", reason: "unread" },
      replayed: false,
      sources: calculatedSources(attrs(whatIf), null),
      problem: false,
      onCopyFormula: () => {},
    });
    const text = container.textContent ?? "";
    expect(text).toContain("EBITDA 2027 · DCF!E5 = E4*Margin");
    expect(text).toContain("Revenue 2027 · DCF!E4 = D4*(1+Growth)");
    expect(text).toContain(
      translate(language, "figures.workbook.change", {
        input: "Revenue growth (Growth)",
        cell: "Assumptions!B4",
        from: "5.0%",
        to: "3.0%",
      }),
    );
    expect(text).toContain(translate(language, "figures.workbook.inWorkbook", { value: "254.7" }));
    expect(text).toContain(translate(language, "figures.workbook.workedOut"));
    expect(text).toContain(translate(language, "figures.workbook.note"));
    expect(text).toContain("Revenue growth\t5.0%");
    expect(text).not.toContain(translate(language, "figures.workbook.savedValue"));
    expect(text).not.toContain(translate(language, "figures.inline.recalculated"));

    await card({
      figure: keptValue,
      shown: { state: "not-checked", reason: "unread" },
      replayed: false,
      sources: calculatedSources(attrs(keptValue), null),
      problem: false,
      onCopyFormula: () => {},
    });
    const kept = container.textContent ?? "";
    expect(kept).toContain(
      translate(language, "figures.workbook.kept.volatile", { cell: "Cases!C2", name: "RAND" }),
    );
    expect(kept).toContain(translate(language, "figures.workbook.savedValue"));
    expect(kept).toContain(translate(language, "figures.workbook.keptNote"));
    expect(kept).not.toContain(translate(language, "figures.workbook.note"));
    expect(kept).not.toContain(translate(language, "figures.workbook.workedOut"));
  },
);
