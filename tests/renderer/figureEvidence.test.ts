import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { createElement, nodeOf } from "../../src/core/answers/blocks";
import {
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
  type RetainedFigureAnalysis,
} from "../../src/core/api";
import { FigureEvidence } from "../../src/renderer/src/editor/figureEvidence";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { figureRunsFor, installFigureRuns } from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";

function setup() {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
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
  const record: RetainedFigureAnalysis = {
    id: "run",
    title: "Total / 合计",
    language: "python",
    code: "result('total', 10)",
    inputs: [],
    versions: null,
    codeSha256: "a".repeat(64),
    ranAt: "2026-10-27T00:00:00.000Z",
    values: [{ kind: "figure", name: "total", label: "Total / 合计", unit: null, value: 10 }],
  };
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
              formula: "",
              inputs: [],
              value: 10,
              unit: { kind: "plain" },
              approximate: false,
              shown: "10",
              show: { language: "en", as: "number", decimals: 0, scale: null },
              literals: [],
              engine: FORMULA_VERSION,
              written: null,
              analysis: { analysis: 1, result: "total" },
            },
            "figure",
            "run",
          ),
        ],
      }),
    ]);
    installFigureRuns(doc, [record]);
  });
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      FigureEvidence.configure({ doc }),
    ],
  });
  onTestFinished(() => {
    editor.destroy();
    doc.destroy();
    vi.unstubAllGlobals();
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
  return { doc, editor, records };
}

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
