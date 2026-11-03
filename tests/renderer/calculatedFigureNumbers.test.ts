import { getSchema, type JSONContent } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { type Decoration, DecorationSet } from "@tiptap/pm/view";
import { expect, test } from "vitest";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  type FigureInput,
  FOOTNOTE_NODE,
} from "../../src/core/api";
import type { Language } from "../../src/core/language";
import {
  citationNumbersPlugin,
  figureNumberOf,
  numberedFigures,
  numberFootnotes,
  textBlockEdited,
} from "../../src/renderer/src/editor/citationNumbers";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  calculatedFigureNode,
  readCalculatedFigureAttributes,
} from "../../src/shared/calculatedFigures";
import type { CitationForm } from "../../src/shared/citationStyles";
import { FORMULA_VERSION } from "../../src/shared/formula";

const schema = getSchema(noteExtensions());
const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (id: string, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content,
});
const citation = (id: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: { documentId: id, documentName: id, check: "found" },
});
const footnote = (id: string): JSONContent => ({
  type: FOOTNOTE_NODE,
  attrs: { id },
  content: [text("Note")],
});
const calc = (id: string, language: Language = "en"): JSONContent =>
  calculatedFigureNode(
    {
      label: language === "en" ? "Growth" : "增幅",
      formula: "",
      inputs: [],
      value: 0.2,
      unit: { kind: "percent" },
      approximate: false,
      shown: "20.0%",
      show: { language, as: "percent", decimals: 1, scale: null },
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
      analysis: { analysis: 1, result: "growth" },
    },
    id,
    "run-1",
  );

test.each(["en", "zh-CN"] as const)(
  "calculated figures share Note-order numbering in %s",
  (language) => {
    const state = EditorState.create({
      doc: schema.nodeFromJSON({
        type: "doc",
        content: [
          paragraph("a", calc("f1", language), citation("c1"), footnote("n1")),
          paragraph("b", calc("f2", language), citation("c2")),
        ],
      }),
    });
    const numbered = numberFootnotes(state.doc);
    expect(numbered.citations.map((each) => each.number)).toEqual([2, 5]);
    expect(numbered.footnotes.map((each) => each.number)).toEqual([3]);
    expect(numbered.figures.map((each) => [each.attributes.id, each.number])).toEqual([
      ["f1", 1],
      ["f2", 4],
    ]);
  },
);

function stateWith(blocks: JSONContent[], form: CitationForm = "numbered"): EditorState {
  return EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content: blocks }),
    plugins: [citationNumbersPlugin(() => form), history()],
  });
}

function decorationsAt(state: EditorState, pos: number): Decoration[] {
  const found: Decoration[] = [];
  for (const plugin of state.plugins) {
    const source = plugin.props.decorations?.call(plugin, state);
    if (source instanceof DecorationSet)
      found.push(...source.find(pos, pos + 1).filter((each) => each.from === pos));
  }
  return found;
}

test("note-style clusters stay grouped until a calculated figure separates them", () => {
  const state = stateWith(
    [
      paragraph(
        "a",
        citation("c1"),
        text(" "),
        citation("c2"),
        calc("f1"),
        citation("c3"),
        text(" "),
        citation("c4"),
        footnote("n1"),
        calc("f2"),
      ),
    ],
    "note",
  );
  const numbered = numberFootnotes(state.doc, "note");
  expect(numbered.citations.map((each) => each.number)).toEqual([1, 1, 3, 3]);
  expect(numbered.citations.map((each) => each.footnote)).toEqual([true, false, true, false]);
  expect(numbered.figures.map((each) => each.number)).toEqual([2, 5]);
  expect(numbered.footnotes.map((each) => each.number)).toEqual([4]);
  expect(numberedFigures(state)).toEqual(numbered.figures);
});

test("in-text figures share the existing cited ordinal only, leaving user notes independent", () => {
  const state = stateWith(
    [
      paragraph(
        "a",
        calc("f1"),
        citation("c1"),
        footnote("n1"),
        calc("f2"),
        citation("c2"),
        footnote("n2"),
      ),
    ],
    "in-text",
  );
  const numbered = numberFootnotes(state.doc, "in-text");
  expect(numbered.figures.map((each) => each.number)).toEqual([1, 3]);
  expect(numbered.citations.map((each) => each.number)).toEqual([2, 4]);
  expect(numbered.citations.every((each) => !each.footnote)).toBe(true);
  expect(numbered.footnotes.map((each) => each.number)).toEqual([1, 2]);
  expect(
    numberedFigures(state).map((each) => figureNumberOf(decorationsAt(state, each.pos))),
  ).toEqual([1, 3]);
});

test.each([
  ["numbered", [1, 2], [3]],
  ["note", [1, 1], [2]],
  ["in-text", [1, 2], [1]],
] as const)("keeps existing %s numbers when there are no figures", (form, citations, footnotes) => {
  const state = stateWith(
    [paragraph("a", citation("c1"), text(" "), citation("c2"), footnote("n1"))],
    form,
  );
  const numbered = numberFootnotes(state.doc, form);
  expect(numbered.citations.map((each) => each.number)).toEqual(citations);
  expect(numbered.footnotes.map((each) => each.number)).toEqual(footnotes);
  expect(numbered.figures).toEqual([]);
  expect(numberedFigures(state)).toEqual([]);
});

test("two equal displayed occurrences each count once, not their input citations", () => {
  const source = readCalculatedFigureAttributes(calc("f1").attrs);
  if (!source) throw new Error("Missing fixture receipt");
  const inputs: FigureInput[] = ["a", "b"].map((name) => ({
    name,
    label: name,
    citation: {
      passageId: "passage",
      documentId: "source",
      documentName: "Report",
      contentHash: "hash",
      pageFrom: null,
      pageTo: null,
      location: null,
      quote: "10%",
      check: "found",
      checkReason: null,
    },
    number: {
      chars: "10%",
      at: 0,
      value: 0.1,
      scale: 1,
      scaleWord: null,
      unit: { kind: "percent" },
      decimals: 0,
      approximate: false,
      reading: null,
    },
    cell: null,
    unitStatement: null,
  }));
  const formula = { ...source.figure, formula: "SUM(a, b)", inputs };
  delete formula.analysis;
  const first = calculatedFigureNode(formula, "f1");
  const second = calculatedFigureNode(formula, "f2");
  const state = stateWith([paragraph("a", first, text(" "), second, citation("source"))]);
  const numbered = numberFootnotes(state.doc);
  expect(numbered.figures.map((each) => each.number)).toEqual([1, 2]);
  expect(numbered.citations.map((each) => each.number)).toEqual([3]);
});

test("malformed receipts do not consume numbers or retain claimed verdicts", () => {
  const valid = calc("f1");
  const state = stateWith([
    paragraph(
      "a",
      {
        type: CALCULATED_FIGURE_NODE,
        attrs: { id: "bad", figure: {} },
      },
      { ...valid, attrs: { ...valid.attrs, checked: true } },
      citation("c1"),
    ),
  ]);
  const numbered = numberFootnotes(state.doc);
  expect(numbered.figures.map((each) => each.number)).toEqual([1]);
  expect(numbered.figures[0]?.attributes).toEqual(readCalculatedFigureAttributes(valid.attrs));
  expect(numbered.citations.map((each) => each.number)).toEqual([2]);
});

test.each(["delete", "convert"])("%s and Undo/Redo update the same numbered stream", (action) => {
  let state = stateWith([paragraph("a", calc("f1"), citation("c1"), footnote("n1"))]);
  const original = numberedFigures(state)[0];
  if (!original) throw new Error("Missing numbered figure");
  const tr =
    action === "delete"
      ? state.tr.delete(original.pos, original.pos + 1)
      : state.tr.replaceWith(original.pos, original.pos + 1, schema.text("20.0%"));
  expect(textBlockEdited(tr)).toBeNull();
  state = state.apply(tr);
  expect(numberedFigures(state)).toEqual([]);
  expect(numberFootnotes(state.doc).citations.map((each) => each.number)).toEqual([1]);
  expect(numberFootnotes(state.doc).footnotes.map((each) => each.number)).toEqual([2]);
  expect(
    undo(state, (change) => {
      state = state.apply(change);
    }),
  ).toBe(true);
  expect(numberedFigures(state).map((each) => each.number)).toEqual([1]);
  expect(numberFootnotes(state.doc).citations.map((each) => each.number)).toEqual([2]);
  expect(
    redo(state, (change) => {
      state = state.apply(change);
    }),
  ).toBe(true);
  expect(numberedFigures(state)).toEqual([]);
});

test("the typing fast path maps figure positions and decorations without changing numbers", () => {
  let state = stateWith([
    paragraph("a", text("Growth "), calc("f1"), citation("c1")),
    paragraph("b", calc("f2"), footnote("n1")),
  ]);
  const before = numberedFigures(state);
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
  expect(numberedFigures(state)).toBe(before);
  const tr = state.tr.insertText("收入 ", 1);
  expect(textBlockEdited(tr)).toBe(0);
  state = state.apply(tr);
  expect(numberedFigures(state).map((each) => each.pos)).toEqual(
    before.map((each) => each.pos + 3),
  );
  expect(numberedFigures(state).map((each) => each.number)).toEqual([1, 3]);
  expect(numberedFigures(state)[0]?.attributes).toBe(before[0]?.attributes);
  expect(
    numberedFigures(state).map((each) => figureNumberOf(decorationsAt(state, each.pos))),
  ).toEqual([1, 3]);
  expect(figureNumberOf([])).toBe(0);
});

test("replacing figure metadata leaves the fast path and refreshes the normalized receipt", () => {
  let state = stateWith([paragraph("a", calc("f1"), citation("c1"))]);
  const previous = numberedFigures(state)[0];
  if (!previous) throw new Error("Missing figure");
  const tr = state.tr.setNodeMarkup(previous.pos, undefined, {
    ...previous.attributes,
    figure: { ...previous.attributes.figure, label: "New label" },
  });
  expect(textBlockEdited(tr)).toBeNull();
  state = state.apply(tr);
  expect(numberedFigures(state)[0]?.attributes.figure.label).toBe("New label");
  state = state.apply(
    state.tr.setNodeMarkup(previous.pos, undefined, { id: "invalid", figure: {} }),
  );
  expect(numberedFigures(state)).toEqual([]);
  expect(numberFootnotes(state.doc).citations[0]?.number).toBe(1);
});

test("the existing style-change and redraw transactions refresh figure decorations", () => {
  let state = stateWith([paragraph("a", calc("f1"), footnote("n1"), calc("f2"))]);
  expect(numberedFigures(state).map((each) => each.number)).toEqual([1, 3]);
  state = state.apply(state.tr.setMeta("citationForm", "in-text"));
  expect(numberedFigures(state).map((each) => each.number)).toEqual([1, 2]);
  const first = numberedFigures(state)[0];
  if (!first) throw new Error("Missing figure");
  const before = decorationsAt(state, first.pos)[0]?.spec.generation;
  state = state.apply(state.tr.setMeta("redrawFootnotes", true));
  expect(decorationsAt(state, first.pos)[0]?.spec.generation).toBe(before + 1);
});
