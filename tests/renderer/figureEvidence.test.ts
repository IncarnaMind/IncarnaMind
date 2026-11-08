import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { CellSelection } from "@tiptap/pm/tables";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { createElement, nodeOf } from "../../src/core/answers/blocks";
import {
  type AnswerAnalysis,
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
  type RetainedFigureAnalysis,
} from "../../src/core/api";
import {
  COPY_INCOMPLETE_ATTRIBUTE,
  CopyCitations,
  FIGURE_RUNS_ATTRIBUTE,
  reportCopyNotice,
  takeCopyNotice,
} from "../../src/renderer/src/editor/copyCitations";
import { wordFootnoteHtml } from "../../src/renderer/src/editor/copyNotes";
import { FigureEvidence } from "../../src/renderer/src/editor/figureEvidence";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { TitleLine } from "../../src/renderer/src/editor/titleLine";
import { noAnalysisOutput } from "../../src/shared/analysis";
import type { NodeJSON } from "../../src/shared/blockJson";
import {
  calculatedFigureNode,
  readCalculatedFigureAttributes,
} from "../../src/shared/calculatedFigures";
import {
  calculatedFiguresIn,
  figureRunId,
  figureRunsFor,
  figureRunsOfAnswer,
  installFigureRuns,
  readFigureRunClosure,
} from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { translate } from "../../src/shared/i18n";

const reported = vi.hoisted(() => vi.fn());
vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy({}, { get: () => () => () => undefined }),
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ documents: [], settings: { language: "en" }, reportError: reported }),
  },
}));

function domDocument() {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  Object.defineProperty(document, "implementation", {
    value: { createHTMLDocument: domDocument },
  });
  return document;
}

const disposeEditors: (() => void)[] = [];

function setup({
  empty = false,
  title = false,
  multiple = false,
  conflicting = false,
  formula = false,
  checked = false,
  runId = "run",
  copyRuns,
}: {
  empty?: boolean;
  title?: boolean;
  multiple?: boolean;
  conflicting?: boolean;
  formula?: boolean;
  checked?: boolean;
  runId?: string;
  copyRuns?: (blocks: readonly NodeJSON[]) => readonly RetainedFigureAnalysis[];
} = {}) {
  if (disposeEditors.length === 0)
    onTestFinished(() => {
      for (const dispose of disposeEditors.splice(0).reverse()) dispose();
      vi.unstubAllGlobals();
    });
  reported.mockClear();
  const document = domDocument();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("getComputedStyle", () => ({
    fontStyle: "",
    fontWeight: "",
    fontSize: "",
    fontFamily: "",
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const doc = new Y.Doc();
  disposeEditors.push(() => doc.destroy());
  const record: RetainedFigureAnalysis = {
    id: runId,
    title: "Total / 合计",
    language: "python",
    code: conflicting ? "result('total', 5 + 5)" : "result('total', 10)",
    inputs: [],
    versions: null,
    codeSha256: "a".repeat(64),
    ranAt: "2026-10-27T00:00:00.000Z",
    values: [
      {
        kind: "figure",
        name: "total",
        label: "Total / 合计",
        unit: null,
        value: 10,
        ...(checked && { check: { kind: "same" as const, value: 10 } }),
      },
      ...(multiple
        ? [{ kind: "figure" as const, name: "other", label: "Other / 其他", unit: null, value: 20 }]
        : []),
    ],
  };
  if (!empty)
    doc.transact(() => {
      doc.getXmlFragment(MIND_CONTENT_FIELD).push([
        createElement({
          type: "paragraph",
          attrs: { id: "paragraph" },
          content: [
            { type: "text", text: "Total / 合计 " },
            calculatedFigureNode(
              {
                label: "Total / 合计",
                formula: formula ? "total" : "",
                inputs: formula
                  ? [
                      {
                        name: "total",
                        label: "Total / 合计",
                        citation: {
                          passageId: "passage",
                          documentId: "document",
                          documentName: "Totals / 合计",
                          contentHash: "hash",
                          pageFrom: 1,
                          pageTo: 1,
                          location: { kind: "page", from: 1, to: 1 },
                          quote: "10",
                          check: "found",
                          checkReason: null,
                        },
                        number: {
                          chars: "10",
                          at: 0,
                          value: 10,
                          scale: 1,
                          scaleWord: null,
                          unit: { kind: "plain" },
                          decimals: 0,
                          approximate: false,
                          reading: null,
                        },
                        cell: null,
                        unitStatement: null,
                      },
                    ]
                  : [],
                value: 10,
                unit: { kind: "plain" },
                approximate: false,
                shown: "10",
                show: { language: "en", as: "number", decimals: 0, scale: null },
                literals: [],
                engine: FORMULA_VERSION,
                written: null,
                ...(!formula && { analysis: { analysis: 1, result: "total" } }),
              },
              "figure",
              formula ? null : runId,
            ),
            ...(multiple
              ? [
                  calculatedFigureNode(
                    {
                      label: "Other / 其他",
                      formula: "",
                      inputs: [],
                      value: 20,
                      unit: { kind: "plain" },
                      approximate: false,
                      shown: "20",
                      show: { language: "en", as: "number", decimals: 0, scale: null },
                      literals: [],
                      engine: FORMULA_VERSION,
                      written: null,
                      analysis: { analysis: 1, result: "other" },
                    },
                    "other-figure",
                    runId,
                  ),
                ]
              : []),
          ],
        }),
      ]);
      if (!formula) installFigureRuns(doc, [record]);
    });
  else
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([
      createElement({
        type: title ? "heading" : "paragraph",
        ...(title ? { attrs: { level: 1 } } : {}),
      }),
    ]);
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      FigureEvidence.configure({ doc }),
      CopyCitations.configure({
        figureRuns: copyRuns ?? ((selected: readonly NodeJSON[]) => figureRunsFor(doc, selected)),
      }),
      TitleLine,
    ],
  });
  disposeEditors.push(() => {
    if (!editor.isDestroyed) editor.destroy();
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const records = () =>
    figureRunsFor(
      doc,
      doc
        .getXmlFragment(MIND_CONTENT_FIELD)
        .toArray()
        .flatMap((node) => (node instanceof Y.XmlElement ? [nodeOf(node)] : [])),
    );
  return { doc, editor, records, record };
}

function selectedHtml(editor: Editor): string {
  return wordFootnoteHtml(
    editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML,
  );
}

function pasteHtml(editor: Editor, html: string, text = "10"): void {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/html" ? html : text) },
  });
  editor.view.dispatchEvent(event);
}

function firstFigure(editor: Editor): { at: number; id: unknown } {
  let found: { at: number; id: unknown } | null = null;
  editor.state.doc.descendants((node, at) => {
    if (node.type.name === "calculatedFigure" && found === null) found = { at, id: node.attrs.id };
  });
  if (!found) throw new Error("The editor has no calculated figure.");
  return found;
}

test("paste into the empty title independently owns only the selected run, with one Undo", () => {
  const source = setup({ multiple: true });
  const selected = firstFigure(source.editor);
  source.editor.commands.setNodeSelection(selected.at);
  const html = selectedHtml(source.editor);
  source.editor.destroy();
  source.doc.destroy();
  const target = setup({ empty: true, title: true });
  const manager = yUndoPluginKey.getState(target.editor.state)?.undoManager;
  if (!manager) throw new Error("No collaborative Undo manager.");
  manager.clear();
  let updates = 0;
  target.doc.on("update", () => updates++);
  pasteHtml(target.editor, html);
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
  expect(target.records()).toMatchObject([{ id: "run", values: [{ name: "total", value: 10 }] }]);
  expect(target.records()[0]?.values).toHaveLength(1);
  expect(target.editor.state.doc.firstChild?.type.name).toBe("heading");
  expect(firstFigure(target.editor).id).not.toBe(selected.id);
  expect(updates).toBe(1);
  expect(manager.undoStack).toHaveLength(1);
  manager.undo();
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
  expect(target.editor.state.doc.firstChild?.childCount).toBe(0);
  manager.redo();
  expect(target.records()[0]?.values[0]?.value).toBe(10);
});

test("copy carries only the selected Analysis value once in inert HTML", () => {
  const { editor } = setup({ multiple: true });
  let first = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "calculatedFigure" && first < 0) first = pos;
  });
  editor.commands.setNodeSelection(first);
  const html = selectedHtml(editor);
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const carriers = holder.querySelectorAll("[data-incarnamind-figure-runs]");
  expect(carriers).toHaveLength(1);
  const runs = JSON.parse(carriers[0]?.getAttribute("data-incarnamind-figure-runs") ?? "null");
  expect(runs).toMatchObject([{ id: "run", values: [{ name: "total", value: 10 }] }]);
  expect(runs[0].values).toHaveLength(1);
  expect(runs[0]).not.toHaveProperty("output");
  expect(holder.textContent).toBe("10");
});

test("multiline paste keeps body formatting and repeat paste shares one run with fresh ids", () => {
  const source = setup({ multiple: true });
  source.editor.commands.insertContentAt(source.editor.state.doc.content.size, {
    type: "paragraph",
    content: [{ type: "text", text: "After / 之后" }],
  });
  source.editor.commands.selectAll();
  const html = selectedHtml(source.editor);
  const target = setup({ empty: true, title: true });
  pasteHtml(target.editor, html);
  expect(target.editor.state.doc.firstChild?.type.name).toBe("paragraph");
  expect(target.editor.state.doc.childCount).toBe(2);
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(3);
  pasteHtml(target.editor, html);
  const ids: unknown[] = [];
  target.editor.state.doc.descendants((node) => {
    if (node.type.name === "calculatedFigure") ids.push(node.attrs.id);
  });
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
  expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(3);
  expect(target.records()).toHaveLength(1);
});

test("an Answer's selected successful generation copies no unselected output", () => {
  const analysis: AnswerAnalysis = {
    number: 1,
    title: "Total / 合计",
    language: "python",
    code: "result('total', 10)",
    inputs: [],
    versions: null,
    codeSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    ranAt: "2026-10-27T00:00:00.000Z",
    ms: 5,
    end: { kind: "done" },
    output: {
      ...noAnalysisOutput(),
      printed: "unrelated printed output",
      results: [
        { kind: "figure", name: "total", label: "Total / 合计", value: 10, unit: null },
        { kind: "figure", name: "other", label: "Other / 其他", value: 20, unit: null },
      ],
    },
    markers: { figures: [{ result: "total", marker: 1 }], tables: [], charts: [] },
  };
  const answer = { id: "answer", analyses: [analysis] };
  const source = setup({
    runId: figureRunId(answer.id, analysis),
    copyRuns: (selected) => readFigureRunClosure(selected, figureRunsOfAnswer(answer, selected)),
  });
  source.editor.commands.setNodeSelection(firstFigure(source.editor).at);
  const html = selectedHtml(source.editor);
  source.editor.destroy();
  source.doc.destroy();
  const target = setup({ empty: true });
  pasteHtml(target.editor, html);
  const [kept] = target.records();
  expect(kept?.values.map(({ name }) => name)).toEqual(["total"]);
  expect(kept?.code).toBe(analysis.code);
  expect(kept).not.toHaveProperty("output");
  expect(html).not.toContain("unrelated printed output");
});

test("a checked figure pastes into its own Note, keeping the Note's own check (#2378)", () => {
  const source = setup({ checked: true });
  source.editor.commands.setNodeSelection(firstFigure(source.editor).at);
  const html = selectedHtml(source.editor);
  source.editor.commands.setTextSelection(source.editor.state.doc.content.size - 1);
  pasteHtml(source.editor, html);
  expect(reported).not.toHaveBeenCalled();
  let figures = 0;
  source.editor.state.doc.descendants((node) => {
    if (node.type.name === "calculatedFigure") figures++;
    return true;
  });
  expect(figures).toBe(2);
  const [record] = source.records();
  expect(record?.values[0]?.check).toEqual({ kind: "same", value: 10 });
});

test("transient paste ids do not weaken the durable figure reader", () => {
  const source = setup();
  const node = source.editor.state.doc.nodeAt(firstFigure(source.editor).at);
  const attrs = { ...node?.attrs, id: null };
  expect(readCalculatedFigureAttributes(attrs)).toBeNull();
  expect(readFigureRunClosure([{ type: "calculatedFigure", attrs }], [source.record])).toEqual([
    source.record,
  ]);
});

test("clipboard receipts stay inert provenance and import no execution or check claims", () => {
  const source = setup();
  source.editor.commands.setNodeSelection(firstFigure(source.editor).at);
  const holder = document.createElement("div");
  holder.innerHTML = selectedHtml(source.editor);
  const carrier = holder.querySelector("[data-incarnamind-figure-runs]");
  if (!carrier) throw new Error("The clipboard fixture has no receipt carrier.");
  const code = "print('</span><script>not executable</script>')";
  carrier.setAttribute(
    "data-incarnamind-figure-runs",
    JSON.stringify([
      {
        ...source.record,
        code,
        executionVerified: true,
        check: "supported",
        output: { printed: "not copied" },
        values: source.record.values.map((value) => ({
          ...value,
          check: { kind: "same", value: 10 },
        })),
      },
    ]),
  );
  expect(holder.querySelector("script")).toBeNull();
  const target = setup({ empty: true });
  pasteHtml(target.editor, holder.innerHTML);
  const [record] = target.records();
  expect(record?.code).toBe(code);
  expect(record).not.toHaveProperty("executionVerified");
  expect(record).not.toHaveProperty("check");
  expect(record).not.toHaveProperty("output");
  expect(record?.values[0]).not.toHaveProperty("check");
  expect(target.editor.view.dom.querySelector("script")).toBeNull();
});

test.each([
  "missing",
  "malformed",
  "duplicate",
  "missing-value",
  "different-value",
  "wrong-run",
  "invalid-later-record",
  "invalid-node",
  "conflict",
])("a %s receipt leaves the entire target and Undo unchanged", (problem) => {
  const source = setup();
  source.editor.commands.insertContentAt(source.editor.state.doc.content.size, {
    type: "paragraph",
    content: [{ type: "text", text: "After / 之后" }],
  });
  source.editor.commands.selectAll();
  const holder = document.createElement("div");
  holder.innerHTML = selectedHtml(source.editor);
  const carrier = holder.querySelector("[data-incarnamind-figure-runs]");
  if (!carrier) throw new Error("The clipboard fixture has no receipt carrier.");
  const records: RetainedFigureAnalysis[] = JSON.parse(
    carrier.getAttribute("data-incarnamind-figure-runs") ?? "null",
  );
  const record = records[0];
  if (!record) throw new Error("The clipboard fixture has no Analysis record.");
  if (problem === "missing") carrier.remove();
  else if (problem === "malformed") carrier.setAttribute("data-incarnamind-figure-runs", "{");
  else if (problem === "duplicate") holder.appendChild(carrier.cloneNode(true));
  else if (problem === "missing-value")
    carrier.setAttribute(
      "data-incarnamind-figure-runs",
      JSON.stringify([{ ...record, values: [] }]),
    );
  else if (problem === "different-value")
    carrier.setAttribute(
      "data-incarnamind-figure-runs",
      JSON.stringify([
        { ...record, values: record.values.map((value) => ({ ...value, value: 99 })) },
      ]),
    );
  else if (problem === "wrong-run")
    carrier.setAttribute(
      "data-incarnamind-figure-runs",
      JSON.stringify([{ ...record, id: "wrong-run" }]),
    );
  else if (problem === "invalid-later-record")
    carrier.setAttribute(
      "data-incarnamind-figure-runs",
      JSON.stringify([record, { ...record, id: "invalid", code: 5 }]),
    );
  else if (problem === "invalid-node")
    holder.querySelector("[data-figure]")?.setAttribute("data-figure", "{}");
  const target = setup({
    empty: problem !== "conflict",
    title: true,
    conflicting: problem === "conflict",
  });
  const manager = yUndoPluginKey.getState(target.editor.state)?.undoManager;
  if (!manager) throw new Error("No collaborative Undo manager.");
  manager.clear();
  const before = Y.encodeStateAsUpdate(target.doc);
  pasteHtml(target.editor, holder.innerHTML);
  expect(Y.encodeStateAsUpdate(target.doc)).toEqual(before);
  expect(manager.undoStack).toHaveLength(0);
  expect(reported).toHaveBeenCalledTimes(1);
  expect(reported.mock.calls[0]?.[0]).toMatchObject({ wording: { key: "error.figure.paste" } });
});

/** What a copy event puts on the clipboard, as the editor writes it. */
function copySelection(editor: Editor): string {
  const data = new Map<string, string>();
  const event = new window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => data.get(type) ?? "",
      setData: (type: string, value: string) => data.set(type, value),
      clearData: () => data.clear(),
    },
  });
  editor.view.dom.dispatchEvent(event);
  return data.get("text/html") ?? "";
}

function htmlHolder(markup: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  return holder;
}

test.each([
  [
    "en",
    "Copied as plain text: this figure’s saved inputs are incomplete, so its check didn’t come with it. Check the figure again, then copy it.",
  ],
  [
    "zh-CN",
    "已按纯文本复制：这个数字保存的输入不完整，核对结果没有一起复制。请重新核对这个数字后再复制。",
  ],
] as const)(
  "%s: copying a figure whose record is gone copies its value as plain text and says so",
  (language, wording) => {
    const { doc, editor } = setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      errors.mockRestore();
    });
    doc.transact(() => doc.getMap(MIND_FIGURE_RUNS_FIELD).clear());
    editor.commands.setNodeSelection(firstFigure(editor).at);
    const html = copySelection(editor);
    expect(errors).toHaveBeenCalled();
    // Its value, as text: no figure node and no evidence to paste.
    expect(htmlHolder(html).textContent).toContain("10");
    expect(htmlHolder(html).querySelector("[data-figure]")).toBeNull();
    expect(html).not.toContain(FIGURE_RUNS_ATTRIBUTE);
    // The mark goes with the notice: the clipboard keeps only the words.
    expect(html).not.toContain(COPY_INCOMPLETE_ATTRIBUTE);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]?.[0]).toMatchObject({
      wording: { key: "error.figure.copyIncomplete" },
    });
    expect(translate(language, "error.figure.copyIncomplete")).toBe(wording);

    // Pasting it into a Note gives the value as words, with no figure and no record.
    const target = setup({ empty: true });
    pasteHtml(target.editor, html);
    expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
    expect(target.editor.state.doc.textContent).toContain("10");
    let figures = 0;
    target.editor.state.doc.descendants((node) => {
      if (node.type.name === "calculatedFigure") figures++;
      return true;
    });
    expect(figures).toBe(0);
  },
);

test("a copy written by a caller reports its notice once", () => {
  const { doc, editor } = setup();
  doc.transact(() => doc.getMap(MIND_FIGURE_RUNS_FIELD).clear());
  editor.commands.setNodeSelection(firstFigure(editor).at);
  const { dom } = editor.view.serializeForClipboard(editor.state.selection.content());
  // The caller reports it once the write succeeds.
  expect(reported).not.toHaveBeenCalled();
  expect(takeCopyNotice(dom)).toBe(true);
  expect(dom.innerHTML).not.toContain(COPY_INCOMPLETE_ATTRIBUTE);
  expect(takeCopyNotice(dom)).toBe(false);
  reportCopyNotice();
  expect(reported).toHaveBeenCalledTimes(1);
});

test("a serialization that isn't a copy leaves no notice for a later copy", () => {
  const { doc, editor, record } = setup();
  doc.transact(() => doc.getMap(MIND_FIGURE_RUNS_FIELD).clear());
  editor.commands.setNodeSelection(firstFigure(editor).at);
  // Marked, but not copied: nothing is said.
  selectedHtml(editor);
  expect(reported).not.toHaveBeenCalled();
  // The record is back: the next copy carries the figure and its record, with no notice.
  doc.transact(() => installFigureRuns(doc, [record]));
  editor.commands.setNodeSelection(firstFigure(editor).at);
  copySelection(editor);
  expect(reported).not.toHaveBeenCalled();
});

test("a serialization that isn't a copy leaves the notice for the copy to say", () => {
  const { doc, editor } = setup();
  doc.transact(() => doc.getMap(MIND_FIGURE_RUNS_FIELD).clear());
  editor.commands.setNodeSelection(firstFigure(editor).at);
  // A drag or another serialization is not a copy: nothing is said yet.
  selectedHtml(editor);
  expect(reported).not.toHaveBeenCalled();
  copySelection(editor);
  expect(reported).toHaveBeenCalledTimes(1);
});

test("a complete figure sharing its paragraph with an incomplete one keeps its record (#2378)", () => {
  const source = setup({ multiple: true });
  source.doc.transact(() => {
    source.doc.getMap(MIND_FIGURE_RUNS_FIELD).delete(JSON.stringify(["run", "total"]));
  });
  source.editor.commands.selectAll();
  const html = copySelection(source.editor);
  const holder = htmlHolder(html);
  expect(holder.textContent).toContain("10");
  expect(holder.querySelectorAll("[data-figure]")).toHaveLength(1);
  expect(html).toContain(FIGURE_RUNS_ATTRIBUTE);
  expect(reported).toHaveBeenCalledTimes(1);

  const target = setup({ empty: true });
  pasteHtml(target.editor, html);
  // The paste is not refused: the carrier and the figure it names agree.
  expect(reported).not.toHaveBeenCalled();
  expect(target.editor.state.doc.textContent).toContain("10");
  let figures = 0;
  target.editor.state.doc.descendants((node) => {
    if (node.type.name === "calculatedFigure") {
      figures++;
      expect(node.attrs.analysisId).toBe("run");
      expect(node.attrs.figure.shown).toBe("20");
    }
    return true;
  });
  expect(figures).toBe(1);
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).has(JSON.stringify(["run"]))).toBe(true);
});

test("a copy whose figures can't be read together writes them all as text", () => {
  let sourceDoc: Y.Doc | null = null;
  const source = setup({
    multiple: true,
    copyRuns: (blocks) => {
      if (calculatedFiguresIn(blocks).length > 1) throw new Error("the set can't be read");
      if (!sourceDoc) throw new Error("No document");
      return figureRunsFor(sourceDoc, blocks);
    },
  });
  sourceDoc = source.doc;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());

  source.editor.commands.selectAll();
  const html = copySelection(source.editor);
  const holder = htmlHolder(html);
  expect(holder.textContent).toContain("10");
  expect(holder.textContent).toContain("20");
  expect(holder.querySelector("[data-figure]")).toBeNull();
  expect(html).not.toContain(FIGURE_RUNS_ATTRIBUTE);
  expect(reported).toHaveBeenCalledTimes(1);
  expect(reported.mock.calls[0]?.[0]).toMatchObject({
    wording: { key: "error.figure.copyIncomplete" },
  });
  expect(errors).toHaveBeenCalled();
});

test("a complete figure in another Block keeps its record beside an incomplete one", () => {
  const source = setup();
  const other = {
    label: "Other",
    formula: "",
    inputs: [],
    value: 20,
    unit: { kind: "plain" as const },
    approximate: false,
    shown: "20",
    show: { language: "en" as const, as: null, decimals: 0, scale: null },
    literals: [],
    engine: FORMULA_VERSION,
    written: null,
    analysis: { analysis: 1, result: "other" },
  };
  const runB = {
    ...source.record,
    id: "run-b",
    values: [{ kind: "figure" as const, name: "other", label: "Other", value: 20, unit: null }],
  };
  source.doc.transact(() => {
    installFigureRuns(source.doc, [runB]);
    source.editor.commands.insertContentAt(source.editor.state.doc.content.size, {
      type: "paragraph",
      attrs: { id: "second" },
      content: [{ type: "text", text: "Other " }, calculatedFigureNode(other, "figure-b", "run-b")],
    });
  });
  // The first figure's value goes; the second keeps its own record.
  source.doc.transact(() =>
    source.doc.getMap(MIND_FIGURE_RUNS_FIELD).delete(JSON.stringify(["run", "total"])),
  );
  source.editor.commands.selectAll();
  const html = copySelection(source.editor);
  const holder = htmlHolder(html);
  expect(holder.textContent).toContain("10");
  expect(holder.querySelectorAll("[data-figure]")).toHaveLength(1);
  expect(html).toContain(FIGURE_RUNS_ATTRIBUTE);
  expect(reported).toHaveBeenCalledTimes(1);

  const target = setup({ empty: true });
  pasteHtml(target.editor, html);
  expect(reported).not.toHaveBeenCalled();
  expect(target.editor.state.doc.textContent).toContain("10");
  let figures = 0;
  target.editor.state.doc.descendants((node) => {
    if (node.type.name === "calculatedFigure") {
      figures++;
      expect(node.attrs.analysisId).toBe("run-b");
      expect(node.attrs.figure.shown).toBe("20");
    }
    return true;
  });
  expect(figures).toBe(1);
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).has(JSON.stringify(["run-b"]))).toBe(true);
});

test("a figure whose record is only partly kept copies as words without a carrier", () => {
  const { doc, editor } = setup();
  // The run's record stays, but the figure's own value is gone: a partial record.
  doc.transact(() => doc.getMap(MIND_FIGURE_RUNS_FIELD).delete(JSON.stringify(["run", "total"])));
  editor.commands.setNodeSelection(firstFigure(editor).at);
  const html = copySelection(editor);
  expect(html).not.toContain(FIGURE_RUNS_ATTRIBUTE);
  expect(htmlHolder(html).textContent).toContain("10");
  expect(reported).toHaveBeenCalledTimes(1);
  expect(reported.mock.calls[0]?.[0]).toMatchObject({
    wording: { key: "error.figure.copyIncomplete" },
  });

  const target = setup({ empty: true });
  pasteHtml(target.editor, html);
  expect(reported).not.toHaveBeenCalled();
  expect(target.editor.state.doc.textContent).toContain("10");
});

test("a copied figure written as text keeps its marks", () => {
  const { doc, editor } = setup();
  doc.transact(() => doc.getMap(MIND_FIGURE_RUNS_FIELD).clear());
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "calculatedFigure") at = pos;
    return true;
  });
  if (at < 0) throw new Error("Missing figure");
  const bold = editor.schema.marks.bold;
  if (!bold) throw new Error("Missing bold");
  editor.view.dispatch(editor.state.tr.addMark(at, at + 1, bold.create()));
  editor.commands.setNodeSelection(at);
  expect(htmlHolder(copySelection(editor)).querySelector("strong")?.textContent).toBe("10");
});

test("Answer copy reports the plain-text notice only once the clipboard has it", async () => {
  const source = setup();
  const { copyAnswer, lendAnswerEditor } = await import("../../src/renderer/src/answerEditors");
  // No window selection here: the Answer copies whole, as it does with nothing selected.
  Object.defineProperty(document, "getSelection", { value: () => null, configurable: true });
  source.doc.transact(() => source.doc.getMap(MIND_FIGURE_RUNS_FIELD).clear());
  const release = lendAnswerEditor("answer", source.editor);
  onTestFinished(release);
  const writes: unknown[][] = [];
  let resolve: () => void = () => undefined;
  const write = vi.fn((items: unknown[]) => {
    writes.push(items);
    return new Promise<void>((done) => {
      resolve = done;
    });
  });
  const savedNavigator = globalThis.navigator;
  const savedClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(readonly items: Record<string, Blob>) {}
    },
  );
  onTestFinished(() => {
    vi.stubGlobal("navigator", savedNavigator);
    vi.stubGlobal("ClipboardItem", savedClipboardItem);
  });

  const copied = copyAnswer("answer");
  await vi.waitFor(() => expect(write).toHaveBeenCalled());
  // Not before the clipboard takes it.
  expect(reported).not.toHaveBeenCalled();
  resolve();
  await expect(copied).resolves.toBe(true);
  expect(reported).toHaveBeenCalledTimes(1);
  expect(reported.mock.calls[0]?.[0]).toMatchObject({
    wording: { key: "error.figure.copyIncomplete" },
  });
  const item = writes[0]?.[0] as { items: Record<string, Blob> };
  expect(await item.items["text/html"]?.text()).not.toContain(COPY_INCOMPLETE_ATTRIBUTE);
});

test("Answer copy the clipboard refuses reports the refusal alone", async () => {
  const source = setup();
  const { copyAnswer, lendAnswerEditor } = await import("../../src/renderer/src/answerEditors");
  Object.defineProperty(document, "getSelection", { value: () => null, configurable: true });
  source.doc.transact(() => source.doc.getMap(MIND_FIGURE_RUNS_FIELD).clear());
  const release = lendAnswerEditor("refused", source.editor);
  onTestFinished(release);
  const denied = new Error("denied");
  const savedNavigator = globalThis.navigator;
  const savedClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  vi.stubGlobal("navigator", { clipboard: { write: vi.fn().mockRejectedValue(denied) } });
  vi.stubGlobal("ClipboardItem", class {});
  onTestFinished(() => {
    vi.stubGlobal("navigator", savedNavigator);
    vi.stubGlobal("ClipboardItem", savedClipboardItem);
  });

  await expect(copyAnswer("refused")).resolves.toBe(false);
  expect(reported).toHaveBeenCalledTimes(1);
  expect(reported.mock.calls[0]?.[0]).toBe(denied);
});

test.each(["Revenue 10", "收入10"])("plain text %s keeps the existing title paste", (text) => {
  const target = setup({ empty: true, title: true });
  pasteHtml(target.editor, "", text);
  expect(target.editor.state.doc.firstChild?.type.name).toBe("heading");
  expect(target.editor.state.doc.textContent).toBe(text);
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
  expect(reported).not.toHaveBeenCalled();
});

test("a formula-only copy keeps default insertion with no run carrier or pasted check", () => {
  const source = setup({ formula: true });
  source.editor.commands.setNodeSelection(firstFigure(source.editor).at);
  const html = selectedHtml(source.editor);
  expect(html).not.toContain("data-incarnamind-figure-runs");
  const target = setup({ empty: true, title: true });
  pasteHtml(target.editor, `<span data-claim-check="forged">${html}</span>`);
  expect(target.editor.state.doc.firstChild?.type.name).toBe("heading");
  expect(firstFigure(target.editor).id).not.toBe("figure");
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
  target.editor.state.doc.descendants((node) => {
    expect(node.marks.some(({ type }) => type.name === "claimCheck")).toBe(false);
  });
  expect(reported).not.toHaveBeenCalled();
});

test("deleting the last Analysis figure emits one update and one Undo item, and keeps its record", () => {
  const { doc, editor, records } = setup();
  expect(records()[0]?.values[0]?.value).toBe(10);
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "calculatedFigure") at = pos;
  });
  expect(at).toBeGreaterThan(0);
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  if (!manager) throw new Error("No collaborative Undo manager.");
  manager.clear();
  let updates = 0;
  doc.on("update", () => updates++);
  editor.view.dispatch(editor.state.tr.delete(at, at + 1));
  // No edit removes a record: an earlier change's Undo may bring the figure back (#2378).
  expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
  expect(records()).toEqual([]);
  expect(updates).toBe(1);
  expect(manager.undoStack).toHaveLength(1);
  manager.undo();
  expect(records()[0]?.values[0]?.value).toBe(10);
  expect(editor.state.doc.nodeAt(at)?.type.name).toBe("calculatedFigure");
  manager.redo();
  expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
  expect(editor.state.doc.nodeAt(at)).toBeNull();
});

test("an unrelated edit leaves the retained generation unchanged", () => {
  const { editor, records } = setup();
  const before = records();
  editor.view.dispatch(editor.state.tr.insertText("My ", 1));
  expect(records()).toEqual(before);
});

function figurePositions(editor: Editor): number[] {
  const found: number[] = [];
  editor.state.doc.descendants((node, at) => {
    if (node.type.name === "calculatedFigure") found.push(at);
    return true;
  });
  return found;
}

test("deleting one of a run's figures prunes only its value, and Undo brings both back", () => {
  const { doc, editor, records } = setup({ multiple: true });
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  if (!manager) throw new Error("No collaborative Undo manager.");
  const runs = doc.getMap(MIND_FIGURE_RUNS_FIELD);
  expect(runs.size).toBe(3);
  expect(
    records()[0]
      ?.values.map((value) => value.name)
      .sort(),
  ).toEqual(["other", "total"]);
  const [first] = figurePositions(editor);
  if (first === undefined) throw new Error("Missing figure");
  editor.view.dispatch(editor.state.tr.delete(first, first + 1));
  // The record the figure that is still there names stays, and so does the deleted figure's.
  expect(runs.size).toBe(3);
  expect(records()[0]?.values.map((value) => value.name)).toEqual(["other"]);
  manager.undo();
  expect(runs.size).toBe(3);
  expect(
    records()[0]
      ?.values.map((value) => value.name)
      .sort(),
  ).toEqual(["other", "total"]);
});

test("a write that takes one of two same figures, then an edit deleting the other, keeps the record for Undo", () => {
  const { doc, editor, records } = setup();
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  if (!manager) throw new Error("No collaborative Undo manager.");
  let figure: { type: string; attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "calculatedFigure" && figure === null)
      figure = node.toJSON() as { type: string; attrs: Record<string, unknown> };
    return true;
  });
  if (!figure) throw new Error("Missing figure");
  const copy = figure as { type: string; attrs: Record<string, unknown> };
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
    ...copy,
    attrs: { ...copy.attrs, id: "second" },
  });
  expect(figurePositions(editor)).toHaveLength(2);
  manager.clear();

  // The write takes the first away: a change from the document prunes nothing.
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  if (!(paragraph instanceof Y.XmlElement)) throw new Error("Missing paragraph");
  const elements = paragraph.toArray();
  const at = elements.findIndex(
    (child) => child instanceof Y.XmlElement && child.nodeName === "calculatedFigure",
  );
  if (at < 0) throw new Error("Missing figure element");
  doc.transact(() => paragraph.delete(at, 1), ySyncPluginKey);
  expect(figurePositions(editor)).toHaveLength(1);
  expect(records()[0]?.values.map((value) => value.name)).toEqual(["total"]);
  // The write and the edit are two moments: Undo brings each back on its own.
  manager.stopCapturing();

  // The editor deletes the other: no edit removes a record, so a change's Undo finds it (#2378).
  const [remaining] = figurePositions(editor);
  if (remaining === undefined) throw new Error("Missing figure");
  editor.view.dispatch(editor.state.tr.delete(remaining, remaining + 1));
  expect(figurePositions(editor)).toHaveLength(0);
  expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(2);
  manager.undo();
  expect(figurePositions(editor)).toHaveLength(1);
  expect(records()[0]?.values.map((value) => value.name)).toEqual(["total"]);
  manager.undo();
  expect(figurePositions(editor)).toHaveLength(2);
  expect(records()[0]?.values.map((value) => value.name)).toEqual(["total"]);
});

test("a write's figure keeps its record though the editor deletes another Analysis's figure", () => {
  const { doc, editor, record, records } = setup();
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  if (!manager) throw new Error("No collaborative Undo manager.");
  let first: { type: string; attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "calculatedFigure" && first === null)
      first = node.toJSON() as { type: string; attrs: Record<string, unknown> };
    return true;
  });
  if (!first) throw new Error("Missing figure");
  const other = {
    label: "Other",
    formula: "",
    inputs: [],
    value: 20,
    unit: { kind: "plain" as const },
    approximate: false,
    shown: "20",
    show: { language: "en" as const, as: null, decimals: 0, scale: null },
    literals: [],
    engine: FORMULA_VERSION,
    written: null,
    analysis: { analysis: 2, result: "other" },
  };
  const runB = {
    ...record,
    id: "run-b",
    values: [{ kind: "figure" as const, name: "other", label: "Other", value: 20, unit: null }],
  };
  doc.transact(() => {
    installFigureRuns(doc, [runB]);
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([
      createElement({
        type: "paragraph",
        attrs: { id: "p2" },
        content: [
          { type: "text", text: "Other " },
          calculatedFigureNode(other, "figure-b", "run-b"),
        ],
      }),
    ]);
  });
  expect(figurePositions(editor)).toHaveLength(2);
  manager.clear();

  // A write takes the first Analysis's figure away.
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  if (!(paragraph instanceof Y.XmlElement)) throw new Error("Missing paragraph");
  const at = paragraph
    .toArray()
    .findIndex((child) => child instanceof Y.XmlElement && child.nodeName === "calculatedFigure");
  if (at < 0) throw new Error("Missing figure element");
  doc.transact(() => paragraph.delete(at, 1), ySyncPluginKey);
  expect(figurePositions(editor)).toHaveLength(1);
  manager.stopCapturing();

  // The editor deletes the other Analysis's figure: its record, and the write's, both stay.
  const [remaining] = figurePositions(editor);
  if (remaining === undefined) throw new Error("Missing figure");
  editor.view.dispatch(editor.state.tr.delete(remaining, remaining + 1));
  expect(figurePositions(editor)).toHaveLength(0);
  expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(4);

  manager.undo();
  manager.undo();
  expect(figurePositions(editor)).toHaveLength(2);
  const firstRun = records().find((run) => run.id === "run");
  expect(firstRun?.values.map((value) => value.name)).toEqual(["total"]);
});

test("cells copied from an Analysis's own table go as that table with its run, paste bound into another Note and typed into their own (#2378)", () => {
  const source = setup({ empty: true });
  const binding = { id: "run", table: { result: "totals" } };
  const cell = (type: "tableHeader" | "tableCell", text: string): NodeJSON => ({
    type,
    attrs: { colspan: 1, rowspan: 1 },
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const rows: [string, number][] = [
    ["North", 9450],
    ["South", 8700],
  ];
  source.doc.transact(() => {
    installFigureRuns(source.doc, [
      {
        ...source.record,
        values: [],
        tables: [
          {
            key: binding.table,
            label: "Total amount by region",
            table: { columns: ["region", "amount"], rows, rowCount: 2, columnCount: 2 },
            columns: [
              {
                column: 1,
                rule: { input: "orders", key: "region", value: "amount", how: "sum" },
                rows: 20,
              },
            ],
          },
        ],
      },
    ]);
    source.doc.getXmlFragment(MIND_CONTENT_FIELD).push([
      createElement({
        type: "paragraph",
        attrs: { id: "caption" },
        content: [
          { type: "text", text: "Total amount by region" },
          { type: "analysisTable", attrs: { analysisTable: binding } },
        ],
      }),
      createElement({
        type: "table",
        attrs: { id: "table", analysisTable: binding },
        content: [
          {
            type: "tableRow",
            content: [cell("tableHeader", "region"), cell("tableHeader", "amount")],
          },
          ...rows.map(([region, total]) => ({
            type: "tableRow",
            content: [cell("tableCell", region), cell("tableCell", total.toLocaleString("en"))],
          })),
        ],
      }),
      createElement({ type: "paragraph", attrs: { id: "after" }, content: [] }),
    ]);
  });
  const cells: number[] = [];
  source.editor.state.doc.descendants((node, at) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") cells.push(at);
    return true;
  });
  const first = cells[0];
  const last = cells.at(-1);
  if (first === undefined || last === undefined) throw new Error("No cells.");
  source.editor.view.dispatch(
    source.editor.state.tr.setSelection(CellSelection.create(source.editor.state.doc, first, last)),
  );
  const html = copySelection(source.editor);
  expect(html).toContain(FIGURE_RUNS_ATTRIBUTE);

  const target = setup({ empty: true });
  pasteHtml(target.editor, html, "region\tamount");
  let bound = 0;
  target.editor.state.doc.descendants((node) => {
    if (node.type.name === "table" && node.attrs.analysisTable) bound++;
    return true;
  });
  expect(bound).toBe(1);
  expect(target.doc.getMap(MIND_FIGURE_RUNS_FIELD).has(JSON.stringify(["run"]))).toBe(true);

  // Pasted back into the Note that holds the table, the copy is a table the User typed.
  source.editor.commands.setTextSelection(source.editor.state.doc.content.size - 1);
  pasteHtml(source.editor, html, "region\tamount");
  const tables = { bound: 0, typed: 0, markers: 0 };
  source.editor.state.doc.descendants((node) => {
    if (node.type.name === "table") tables[node.attrs.analysisTable ? "bound" : "typed"]++;
    if (node.type.name === "analysisTable") tables.markers++;
    return true;
  });
  expect(tables).toEqual({ bound: 1, typed: 1, markers: 1 });
});
