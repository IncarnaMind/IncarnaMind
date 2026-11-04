/**
 * An Analysis table in the editor (#2378): its caption's marker takes its number in the one series,
 * goes only with Convert to text in the table's menu, and the cells are never counted as claims.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { afterEach, expect, test } from "vitest";
import { ANALYSIS_TABLE_ATTRIBUTE, ANALYSIS_TABLE_NODE, CITATION_NODE } from "../../src/core/api";
import {
  convertAnalysisTable,
  inAnalysisTable,
} from "../../src/renderer/src/editor/analysisTableCommands";
import { numberFootnotes } from "../../src/renderer/src/editor/citationNumbers";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { TABLE_ACTIONS } from "../../src/renderer/src/editor/tableCommands";

const BINDING = { id: "run-1", table: { result: "region_totals" } };

const text = (value: string): JSONContent => ({ type: "text", text: value });
const cell = (type: "tableHeader" | "tableCell", value: string): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [{ type: "paragraph", content: [text(value)] }],
});
const row = (type: "tableHeader" | "tableCell", ...values: string[]): JSONContent => ({
  type: "tableRow",
  content: values.map((value) => cell(type, value)),
});

const NOTE: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        text("Central's orders were the fewest."),
        {
          type: CITATION_NODE,
          attrs: {
            passageId: "p",
            documentId: "orders",
            documentName: "Orders",
            quote: "x",
            check: "found",
          },
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        text("Total amount by region"),
        { type: ANALYSIS_TABLE_NODE, attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: BINDING } },
      ],
    },
    {
      type: "table",
      attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: BINDING },
      content: [
        row("tableHeader", "region", "amount"),
        row("tableCell", "Central", "8,325"),
        row("tableCell", "North", "9,450"),
      ],
    },
  ],
};

// A mounted editor, as the app's: its plugins, the marker's guard among them, run on each change.
const page = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
Object.defineProperty(page, "styleSheets", { value: [] });
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function editorOf(content: JSONContent): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: noteExtensions(),
    content,
  });
  editors.push(editor);
  return editor;
}

const markers = (editor: Editor) => {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === ANALYSIS_TABLE_NODE) count++;
    return true;
  });
  return count;
};

/** Puts the cursor in the first value cell of the table. */
function intoTable(editor: Editor) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === "8,325") at = pos;
    return at < 0;
  });
  editor.commands.setTextSelection(at + 1);
}

test("the caption's marker takes the next number in the one series, after the Citation before it", () => {
  const editor = editorOf(NOTE);
  const numbered = numberFootnotes(editor.state.doc);
  expect(numbered.citations.map((each) => each.number)).toEqual([1]);
  expect(numbered.tables.map((each) => each.number)).toEqual([2]);
});

test("an edit can't delete the marker while its table stays the Analysis's", () => {
  const editor = editorOf(NOTE);
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === ANALYSIS_TABLE_NODE) at = pos;
    return true;
  });
  editor.commands.command(({ tr }) => {
    tr.delete(at, at + 1);
    return true;
  });
  expect(markers(editor)).toBe(1);
  // Typing in the caption still works.
  editor.commands.insertContentAt(at - "Total amount by region".length, "Totals: ");
  expect(editor.state.doc.textContent).toContain("Totals: Total amount by region");
});

test("Convert to text in the table's menu takes the marker away and leaves a typed table, one Undo", () => {
  const editor = editorOf(NOTE);
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(true);
  const action = TABLE_ACTIONS.find((each) => each.id === "convertToText");
  expect(action?.label).toBe("figures.inline.convert");
  expect(convertAnalysisTable(editor)).toBe(true);
  expect(markers(editor)).toBe(0);
  expect(inAnalysisTable(editor.state)).toBe(false);
  expect(editor.state.doc.textContent).toContain("Total amount by region");
});

test("the cells and caption are never claims; a table needing a look counts once", () => {
  const editor = editorOf(NOTE);
  const counted = (needsLook: boolean) =>
    noteHealth(editor.state.doc, {
      claims: [],
      citationCheck: () => "found",
      tableNeedsLook: () => needsLook,
    });
  const calm = counted(false);
  // Only the cited sentence before the caption is a claim to check.
  expect(calm.toCheck).toHaveLength(1);
  expect(calm.tableCells).toEqual([]);
  expect(calm.lookClaims).toEqual([]);
  expect(counted(true).lookClaims).toHaveLength(1);
});
