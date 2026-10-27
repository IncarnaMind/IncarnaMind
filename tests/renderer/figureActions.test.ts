import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import { type Citation, type ClaimCheckAttributes, MIND_CONTENT_FIELD } from "../../src/core/api";
import { figureSchedule } from "../../src/core/figureSchedule";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  addFigureCitation,
  changeFiguresToSource,
  editNote,
  type FigureEdit,
  keepFigureViews,
  type NoteState,
  setFigureTotalRole,
} from "../../src/renderer/src/editor/figureActions";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { registerMindEditor } from "../../src/renderer/src/editor/openEditors";
import type { NodeJSON } from "../../src/shared/blockJson";
import { emptyFigureFinding } from "../../src/shared/figureChecks";
import { fingerprintOfMind } from "../../src/shared/mindState";

vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({
      documents: [],
      minds: [{ id: "note", folderId: null }],
      settings: { language: "en" },
    }),
  },
}));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});
const words = "Revenue 10 and profit 2, but uncertain.";
function basis(): ClaimCheckAttributes {
  return {
    id: "parent",
    request: "old",
    action: "check-against-documents",
    state: "unsupported",
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text: words,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-27T00:00:00.000Z",
  };
}
const citation: Citation = {
  passageId: "p",
  documentId: "source",
  documentName: "Accounts",
  contentHash: "hash",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "page", from: 1, to: 1 },
  quote: "Revenue 8",
  check: "found",
  checkReason: null,
};
function setup(
  nodes: NodeJSON[] = [
    { type: "paragraph", attrs: { id: "p" }, content: [{ type: "text", text: words }] },
  ],
  checked = true,
) {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({
    fontStyle: "",
    fontWeight: "",
    fontSize: "",
    fontFamily: "",
  }));
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.push(nodes.map(createElement));
  if (checked) {
    const paragraph = blocks.get(0);
    if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph");
    const figures = figuresInMind(blocks).map((figure, index) => ({
      ...basis(),
      ...emptyFigureFinding(figure),
      state: index === 0 ? ("contradicted" as const) : ("supported" as const),
    }));
    markSentence(paragraph, 0, words.length, { ...basis(), figures, remainder: basis() });
  }
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const unregister = registerMindEditor("note", editor);
  cleanup.push(() => {
    unregister();
    editor.destroy();
    doc.destroy();
  });
  const read = () =>
    figureSchedule({
      mindId: "note",
      name: "Results",
      basis: fingerprintOfMind(doc),
      blocks,
      versions: new Map([["source", "hash"]]),
      folderId: null,
      scope: null,
    });
  /** Makes a schedule's change as the schedule does: in the note's open editor. */
  const edit = (change: (note: NoteState) => FigureEdit | null) => editNote("note", doc, change);
  return { doc, blocks, editor, read, edit };
}

test("selected personal-view choice keeps sibling evidence and adverse prose, with one real Undo", () => {
  const { blocks, editor, read, edit } = setup();
  const before = markedSentences(blocks)[0]?.check;
  const schedule = read();
  const first = schedule.rows[0];
  if (!first) throw new Error("No figure");
  edit((note) => keepFigureViews(note, schedule, [first.id]));
  const kept = markedSentences(blocks)[0]?.check;
  expect(kept?.figures?.[0]?.kept).toBe(true);
  expect(kept?.figures?.[1]).toEqual(before?.figures?.[1]);
  expect(kept?.remainder).toEqual(before?.remainder);
  editor.commands.undo();
  expect(markedSentences(blocks)[0]?.check).toEqual(before);
});

test("a figure can be kept before any model is configured or any Check ran", () => {
  const { blocks, editor, read, edit } = setup(undefined, false);
  const schedule = read();
  const first = schedule.rows[0];
  if (!first) throw new Error("No figure");
  edit((note) => keepFigureViews(note, schedule, [first.id]));
  const check = markedSentences(blocks)[0]?.check;
  expect(check?.figures?.[0]?.kept).toBe(true);
  expect(check?.figures?.[1]).toMatchObject({ state: "not-checked", reason: "unread" });
  expect(check?.remainder).toBeUndefined();
  editor.commands.undo();
  expect(markedSentences(blocks)).toEqual([]);
});

test("a stale schedule cannot change a newer Note", () => {
  const { doc, editor, read, edit } = setup();
  const old = read();
  const first = old.rows[0];
  if (!first) throw new Error("No figure");
  editor.commands.insertContent("Edited ");
  const before = fingerprintOfMind(doc);
  expect(() => edit((note) => keepFigureViews(note, old, [first.id]))).toThrow("figures changed");
  expect(fingerprintOfMind(doc)).toBe(before);
});

test("adding a selected Source Citation is in the Note's real Undo", () => {
  const { editor, read, edit } = setup();
  const schedule = read();
  const row = schedule.rows[0];
  if (!row) throw new Error("No figure");
  const before = editor.getJSON();
  edit((note) => addFigureCitation(note, schedule, row, citation));
  expect(editor.getJSON()).not.toEqual(before);
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "citation" && node.attrs.passageId === "p") found = true;
  });
  expect(found).toBe(true);
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
});

test("the selected contradictory amount changes to its checked Source, cites it, and undoes together", () => {
  const { blocks, editor, read, edit } = setup();
  const parent = markedSentences(blocks)[0];
  const first = parent?.check.figures?.[0];
  if (!parent || !first) throw new Error("No first figure");
  markSentence(parent.element, parent.from, parent.to, {
    ...parent.check,
    figures: [
      {
        ...first,
        sourceInput: {
          name: "revenue",
          label: "Revenue",
          citation,
          number: {
            at: 8,
            chars: "8",
            value: 8,
            unit: { kind: "plain" },
            decimals: 0,
            scale: 1,
            scaleWord: null,
            approximate: false,
            reading: null,
          },
          cell: null,
          unitStatement: null,
        },
      },
      ...(parent.check.figures?.slice(1) ?? []),
    ],
  });
  const schedule = read();
  const row = schedule.rows[0];
  if (!row) throw new Error("No row");
  const before = editor.getJSON();
  edit((note) => changeFiguresToSource(note, schedule, [row.id]));
  expect(editor.getText()).toContain("Revenue 8");
  expect(editor.getText()).toContain("profit 2");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
});

const paragraph = (text: string, id: string): NodeJSON => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text }],
});
test("total roles are stored on real table rows and columns, then one Undo removes each choice", () => {
  const { blocks, editor, read, edit } = setup(
    [
      {
        type: "table",
        attrs: { id: "table" },
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph("Item", "h0")] },
              { type: "tableHeader", content: [paragraph("Value", "h1")] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("Other", "r10")] },
              { type: "tableCell", content: [paragraph("10", "r11")] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("Closing", "r20")] },
              { type: "tableCell", content: [paragraph("10", "r21")] },
            ],
          },
        ],
      },
    ],
    false,
  );
  let schedule = read();
  const row = schedule.rows.at(-1);
  if (!row) throw new Error("No amount");
  expect(row.footing).toEqual([]);
  edit((note) => setFigureTotalRole(note, schedule, row, ["row"], true));
  expect(read().rows.at(-1)?.footing).toMatchObject([{ axis: "row", sum: 10, agrees: true }]);
  editor.commands.undo();
  expect(read().rows.at(-1)?.footing).toEqual([]);
  schedule = read();
  const target = schedule.rows.at(-1);
  if (!target) throw new Error("No row");
  const before = editor.getJSON();
  edit((note) => setFigureTotalRole(note, schedule, target, ["column"], false));
  const table = blocks.get(0);
  if (!(table instanceof Y.XmlElement)) throw new Error("No table");
  for (const row of table.toArray()) {
    if (!(row instanceof Y.XmlElement)) continue;
    const cells = row.toArray();
    const cell = cells[1];
    expect(cell instanceof Y.XmlElement && cell.getAttribute("figureColumnRole")).toBe("detail");
  }
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
  expect(claimSpans(editor.state.doc)).toEqual([]);
});

test("with the note not open in an editor, the schedule changes its copy, with an Undo of its own", async () => {
  const { blocks, doc, read } = setup();
  const before = markedSentences(blocks)[0]?.check;
  const schedule = read();
  const first = schedule.rows[0];
  if (!first) throw new Error("No figure");
  const undoable = editNote("a note no editor shows", doc, (note) =>
    keepFigureViews(note, schedule, [first.id]),
  );
  expect(undoable).not.toBeNull();
  const kept = markedSentences(blocks)[0]?.check;
  expect(kept?.figures?.[0]?.kept).toBe(true);
  expect(kept?.figures?.[1]).toEqual(before?.figures?.[1]);
  await undoable?.undo();
  expect(markedSentences(blocks)[0]?.check).toEqual(before);
  await undoable?.redo?.();
  expect(markedSentences(blocks)[0]?.check?.figures?.[0]?.kept).toBe(true);
});
