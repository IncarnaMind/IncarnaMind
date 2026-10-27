import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
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
import { CopyCitations } from "../../src/renderer/src/editor/copyCitations";
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
  figureRunId,
  figureRunsFor,
  figureRunsOfAnswer,
  installFigureRuns,
  readFigureRunClosure,
} from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";

const reported = vi.hoisted(() => vi.fn());
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
  runId = "run",
  copyRuns,
}: {
  empty?: boolean;
  title?: boolean;
  multiple?: boolean;
  conflicting?: boolean;
  formula?: boolean;
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
      { kind: "figure", name: "total", label: "Total / 合计", unit: null, value: 10 },
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

test("deleting the last Analysis figure and its run emits one update and one Undo item", () => {
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
  expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
  expect(updates).toBe(1);
  expect(manager.undoStack).toHaveLength(1);
  manager.undo();
  expect(records()[0]?.values[0]?.value).toBe(10);
  expect(editor.state.doc.nodeAt(at)?.type.name).toBe("calculatedFigure");
  manager.redo();
  expect(doc.getMap(MIND_FIGURE_RUNS_FIELD).size).toBe(0);
  expect(editor.state.doc.nodeAt(at)).toBeNull();
});

test("an unrelated edit leaves the retained generation unchanged", () => {
  const { editor, records } = setup();
  const before = records();
  editor.view.dispatch(editor.state.tr.insertText("My ", 1));
  expect(records()).toEqual(before);
});
