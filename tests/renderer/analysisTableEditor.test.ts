/**
 * An Analysis table in the editor (#2378): its caption's marker takes its number in the one series
 * and stays at the end of its caption as the User edits the caption's words; Backspace beside it
 * selects it, as Word does a field, and a second Backspace takes it away as Convert to text does,
 * with one Undo. The cells are never counted as claims.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { NodeSelection } from "@tiptap/pm/state";
import { DOMParser } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { AnswerAnalysis } from "../../src/core/api";
import { ANALYSIS_TABLE_ATTRIBUTE, ANALYSIS_TABLE_NODE, CITATION_NODE } from "../../src/core/api";
import { readMindHandle } from "../../src/renderer/src/commands/handles";
import { offered } from "../../src/renderer/src/commands/registry";
import { tableCommands } from "../../src/renderer/src/commands/tables";
import {
  convertAnalysisTable,
  inAnalysisTable,
  TABLE_DATA_STATE,
  withoutTableBindings,
} from "../../src/renderer/src/editor/analysisTableCommands";
import { chartOfTable } from "../../src/renderer/src/editor/chartCommands";
import { numberFootnotes } from "../../src/renderer/src/editor/citationNumbers";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  TABLE_ACTIONS,
  tableMenuGroups,
  tableSpot,
} from "../../src/renderer/src/editor/tableCommands";
import { noAnalysisOutput } from "../../src/shared/analysis";
import type { AnalysisTableShown } from "../../src/shared/analysisTables";
import { installFigureRuns, retainFigureAnalysis } from "../../src/shared/figureRuns";

// The window's bridge to the core, which ⌘K's commands reach for as they load.
vi.mock("../../src/renderer/src/core", () => ({ core: { on: () => () => undefined } }));

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
  // Keyboard shortcuts are run by a key event, which the page here doesn't define.
  KeyboardEvent: class extends Event {
    constructor(type: string, { bubbles, cancelable, ...keys }: KeyboardEventInit = {}) {
      super(type, { bubbles, cancelable });
      Object.assign(this, keys);
    }
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
    // The app's Undo is the Note's Yjs history; this editor stands without one, so it brings its own.
    extensions: [...noteExtensions(), UndoRedo],
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

/** Where the caption's marker is; -1 without one. */
const markerAt = (editor: Editor) => {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === ANALYSIS_TABLE_NODE) at = pos;
    return true;
  });
  return at;
};

const captionText = (editor: Editor) => editor.state.doc.child(1).textContent;

/** A key pressed in the editor, as the browser hands it to the editor's keymaps. */
const press = (editor: Editor, key: string) =>
  editor.view.someProp("handleKeyDown", (handle) =>
    handle(editor.view, new KeyboardEvent("keydown", { key })),
  );

test("typing over the caption's words edits them and keeps the marker at the caption's end", () => {
  const editor = editorOf(NOTE);
  const end = markerAt(editor) + 1;
  const start = end - 1 - "Total amount by region".length;
  // Home, Shift+End, type: the selection takes in the marker, and the words are typed all the same.
  editor.commands.setTextSelection({ from: start, to: end });
  editor.commands.insertContent("Totals");
  expect(captionText(editor)).toBe("Totals");
  expect(markers(editor)).toBe(1);
  expect(editor.state.doc.child(1).lastChild?.type.name).toBe(ANALYSIS_TABLE_NODE);
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(true);
});

test.each([
  ["Totals", "Totals"],
  ["合计表", "合计表"],
])("retyping the caption key by key keeps every letter before the marker: %s", (typed, caption) => {
  const editor = editorOf(NOTE);
  const end = markerAt(editor) + 1;
  const start = end - 1 - "Total amount by region".length;
  editor.commands.setTextSelection({ from: start, to: end });
  for (const letter of typed) editor.commands.insertContent(letter);
  expect(captionText(editor)).toBe(caption);
  expect(editor.state.doc.child(1).lastChild?.type.name).toBe(ANALYSIS_TABLE_NODE);
  expect(markers(editor)).toBe(1);
});

test("Backspace beside the marker selects it, and a second takes it away as Convert to text does, with one Undo", () => {
  const editor = editorOf(NOTE);
  editor.commands.setTextSelection(markerAt(editor) + 1);
  press(editor, "Backspace");
  expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  expect(markers(editor)).toBe(1);
  press(editor, "Backspace");
  expect(markers(editor)).toBe(0);
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(false);
  expect(captionText(editor)).toBe("Total amount by region");
  editor.commands.undo();
  expect(markers(editor)).toBe(1);
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(true);
});

test("Enter at the caption's end opens a line above the table, and the table stays the Analysis's", () => {
  const editor = editorOf(NOTE);
  editor.commands.setTextSelection(markerAt(editor) + 1);
  press(editor, "Enter");
  editor.commands.insertContent("Read with the notes below.");
  expect(markers(editor)).toBe(1);
  expect(editor.state.doc.child(1).lastChild?.type.name).toBe(ANALYSIS_TABLE_NODE);
  expect(editor.state.doc.child(2).textContent).toBe("Read with the notes below.");
  expect(editor.state.doc.child(3).type.name).toBe("table");
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(true);
});

test("a caption made a heading keeps its marker, and its table stays the Analysis's", () => {
  const editor = editorOf(NOTE);
  editor.commands.setTextSelection(markerAt(editor));
  editor.commands.toggleHeading({ level: 2 });
  expect(editor.state.doc.child(1).type.name).toBe("heading");
  expect(markers(editor)).toBe(1);
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(true);
});

test("a marker whose table is deleted goes with it, and the caption's words stay", () => {
  const editor = editorOf(NOTE);
  intoTable(editor);
  editor.commands.deleteTable();
  expect(markers(editor)).toBe(0);
  expect(editor.state.doc.textContent).toContain("Total amount by region");
});

test("a table whose caption line is deleted is a typed table, as Convert to text leaves it", () => {
  const editor = editorOf(NOTE);
  const caption = editor.state.doc.child(0).nodeSize;
  editor.commands.command(({ tr }) => {
    tr.delete(caption, caption + editor.state.doc.child(1).nodeSize);
    return true;
  });
  expect(markers(editor)).toBe(0);
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(false);
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
  editor.commands.undo();
  expect(markers(editor)).toBe(1);
  intoTable(editor);
  expect(inAnalysisTable(editor.state)).toBe(true);
});

test("a pasted table with no record of its run comes in typed: its binding and marker are taken off", () => {
  const editor = editorOf(NOTE);
  const pasted = withoutTableBindings(editor.state.doc.content);
  let bound = 0;
  let marked = 0;
  pasted.forEach((node) => {
    if (node.type.name === "table" && node.attrs[ANALYSIS_TABLE_ATTRIBUTE] !== null) bound++;
    node.descendants((child) => {
      if (child.type.name === ANALYSIS_TABLE_NODE) marked++;
      return true;
    });
  });
  expect([bound, marked]).toEqual([0, 0]);
  expect(pasted.child(1).textContent).toBe("Total amount by region");
});

test("the cells and caption are never claims; a table needing a look counts once", () => {
  const editor = editorOf(NOTE);
  const shown = (state: AnalysisTableShown["state"], rules: (null | "sum")[] = ["sum"]) =>
    noteHealth(editor.state.doc, {
      claims: [],
      citationCheck: () => "found",
      tableShown: () => ({
        state,
        missing: 0,
        columns: rules.map((how, at) => ({
          column: at + 1,
          heading: "amount",
          rule: how && { input: "orders", key: "region", value: "amount", how },
          rows: 40,
          differs: [],
          footed: [],
        })),
      }),
    });
  const calm = shown({ kind: "recalculated" });
  // Only the cited sentence before the caption is a claim to check; the table is one earned verdict.
  expect(calm.toCheck).toHaveLength(1);
  expect(calm.tableCells).toEqual([]);
  expect(calm.lookClaims).toEqual([]);
  expect(calm.supported).toBe(1);
  expect(shown({ kind: "differs" }).lookClaims).toHaveLength(1);
  // Each column not recalculated counts as one figure not recalculated.
  const twoUnearned = shown({ kind: "calculated" }, [null, null]);
  expect(twoUnearned.notRecalculated).toHaveLength(2);
  expect(twoUnearned.supported).toBe(0);
});

test("a sentence typed into the caption line is counted as the core checks it; a caption with “vs.” still names its table", () => {
  const editor = editorOf(NOTE);
  const toCheck = () =>
    noteHealth(editor.state.doc, {
      claims: [],
      citationCheck: () => "found",
      tableShown: () => ({ state: { kind: "recalculated" }, missing: 0, columns: [] }),
    }).toCheck;
  const captionStart = editor.state.doc.child(0).nodeSize + 1;
  const typeIntoCaption = (words: string) =>
    editor.commands.command(({ tr }) => {
      tr.insertText(words, captionStart);
      return true;
    });
  typeIntoCaption("Sales vs. budget: ");
  expect(toCheck()).toHaveLength(1);
  typeIntoCaption("North's total amount grew 40% to 12,000. ");
  expect(toCheck()).toContain(captionStart);
});

/** The Note with its caption line moved below its table, as an edit elsewhere can leave it. */
const CAPTION_BELOW: JSONContent = {
  ...NOTE,
  content: [NOTE.content?.[0], NOTE.content?.[2], NOTE.content?.[1]].filter(
    (each): each is JSONContent => each !== undefined,
  ),
};

test("a caption below its table is still its table's: Convert to text from either takes both", () => {
  const fromTable = editorOf(CAPTION_BELOW);
  intoTable(fromTable);
  expect(convertAnalysisTable(fromTable)).toBe(true);
  expect(markers(fromTable)).toBe(0);
  intoTable(fromTable);
  expect(inAnalysisTable(fromTable.state)).toBe(false);
  const fromMarker = editorOf(CAPTION_BELOW);
  fromMarker.commands.setTextSelection(markerAt(fromMarker) + 1);
  press(fromMarker, "Backspace");
  press(fromMarker, "Backspace");
  expect(markers(fromMarker)).toBe(0);
  intoTable(fromMarker);
  expect(inAnalysisTable(fromMarker.state)).toBe(false);
});

test("the table's menu opens with Open calculation card, and keeps it and Convert to text whatever the table can do", () => {
  expect(tableMenuGroups(true, false)[0]).toEqual(["openCalculation"]);
  expect(tableMenuGroups(true, false).flat()).toContain("convertToText");
  expect(tableMenuGroups(true, false).flat()).not.toContain("chart");
  expect(tableMenuGroups(true, true).flat()).toContain("chart");
  const typed = tableMenuGroups(false, true).flat();
  expect(typed).not.toContain("openCalculation");
  expect(typed).not.toContain("convertToText");
});

test("the cursor's table says whether it is an Analysis's own", () => {
  const editor = editorOf(NOTE);
  intoTable(editor);
  expect(tableSpot(editor.state)?.analysis).toBe(true);
  convertAnalysisTable(editor);
  intoTable(editor);
  expect(tableSpot(editor.state)?.analysis).toBe(false);
});

test("⌘K reaches the table at the cursor of the Note in front, its calculation's commands only on an Analysis's own", () => {
  const editor = editorOf(NOTE);
  intoTable(editor);
  readMindHandle.current = { editor, mindId: "mind-1" } as unknown as NonNullable<
    typeof readMindHandle.current
  >;
  try {
    // The context ⌘K gives: the Note in front as its focus.
    const palette = {
      selection: [],
      focus: { kind: "mind" as const, id: "mind-1" },
      surface: "palette" as const,
    };
    const command = (id: string) => tableCommands.find((each) => each.id === id);
    const open = command("table.openCalculation");
    const remove = command("table.delete");
    if (!open || !remove) throw new Error("Missing commands.");
    expect(offered(open, palette)).toBe(true);
    expect(offered(remove, palette)).toBe(true);
    // Another Note in focus isn't the one in front; a context with no focus at all is the Note's own.
    expect(offered(open, { ...palette, focus: { kind: "mind", id: "mind-2" } })).toBe(false);
    expect(offered(open, { selection: [], focus: null, surface: "mind" })).toBe(true);
    convertAnalysisTable(editor);
    intoTable(editor);
    expect(offered(open, palette)).toBe(false);
    expect(offered(remove, palette)).toBe(true);
  } finally {
    readMindHandle.current = null;
  }
});

test("a marker gives its table's state as a figure's marker does: a differing cell needs a look", () => {
  expect(TABLE_DATA_STATE).toEqual({
    recalculated: "supported",
    calculated: "not-checked",
    differs: "unsupported",
    "needs-recheck": "needs-recheck",
    "kept-inside": "not-checked",
    unavailable: "not-checked",
  });
});

test("in-text Citations number the caption's marker in the same series", () => {
  const editor = editorOf(NOTE);
  const numbered = numberFootnotes(editor.state.doc, "in-text");
  expect(numbered.tables.map((each) => each.number)).toEqual([2]);
});

test("Chart from table charts an Analysis's own table from its run, never from its cells' text", () => {
  const run: AnswerAnalysis = {
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
              ["Central", 8325.4],
              ["North", 9450.2],
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
  const kept = retainFigureAnalysis(run, BINDING.id, [], [BINDING]);
  if (!kept) throw new Error("No record kept.");
  const doc = new Y.Doc();
  installFigureRuns(doc, [kept]);
  const editor = editorOf(NOTE);
  intoTable(editor);
  const values = (chart: ReturnType<typeof chartOfTable>) =>
    chart?.data.rows.map((row) => row.values[0]?.value);
  // The cells read 8,325 and 9,450; the run gave 8,325.4 and 9,450.2.
  expect(values(chartOfTable(editor.state, "en", doc))).toEqual([8325.4, 9450.2]);
  expect(values(chartOfTable(editor.state, "en", undefined))).toEqual([8325, 9450]);
});
