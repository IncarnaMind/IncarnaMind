import { getSchema, type JSONContent } from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { describe, expect, test } from "vitest";
import { CITATION_NODE, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import {
  citationNumbersPlugin,
  numberCitations,
  numberedCitations,
  numberFootnotes,
  textBlockEdited,
} from "../../src/renderer/src/editor/citationNumbers";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const schema = getSchema(noteExtensions());

const citation = (documentId: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: { documentId, documentName: documentId, check: "found" },
});

/** A Citation of a Document's page, as the editor stores it after a check found its quote. */
const placed = (documentId: string, page: number, check = "found"): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    documentId,
    documentName: documentId,
    contentHash: `${documentId}-v1`,
    pageFrom: page,
    pageTo: page,
    quote: "A quote from the page.",
    check,
    checkReason: null,
  },
});

const paragraph = (id: string, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content,
});

const text = (value: string): JSONContent => ({ type: "text", text: value });

/** An editor's state holding these Blocks, with the Citation numbers. */
const stateWith = (blocks: JSONContent[]) =>
  EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content: blocks }),
    plugins: [citationNumbersPlugin()],
  });

/** Each Citation's key and the Document it cites. */
const listed = (state: EditorState) =>
  numberedCitations(state).map((each) => `${each.key} ${each.attributes.documentId}`);

describe("Citation numbers", () => {
  test("number the Citations within each Block, top to bottom", () => {
    const state = stateWith([
      paragraph("a", text("Tides "), citation("tides"), text(" and "), citation("moon")),
      paragraph("b", text("Notes")),
      paragraph("c", citation("harbour")),
    ]);

    expect(listed(state)).toEqual(["a:1 tides", "a:2 moon", "c:1 harbour"]);
    expect(numberedCitations(state)).toEqual(numberCitations(state.doc));
  });

  test("follow the document as it changes, worked out once per change for every reader", () => {
    let state = stateWith([
      paragraph("a", text("Tides "), citation("tides")),
      paragraph("b", text("Notes")),
      paragraph("c", citation("harbour")),
    ]);
    const before = numberedCitations(state);

    // A selection isn't a change: the same list.
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(numberedCitations(state)).toBe(before);

    // Typing before a Citation moves it.
    state = state.apply(state.tr.insertText("Spring ", 1));
    const after = numberedCitations(state);
    expect(after.map((each) => each.pos)).toEqual(before.map((each) => each.pos + 7));
    expect(after).toEqual(numberCitations(state.doc));

    // A Citation added before another renumbers it.
    state = state.apply(state.tr.insert(1, schema.nodeFromJSON(citation("moon"))));
    expect(listed(state)).toEqual(["a:1 moon", "a:2 tides", "c:1 harbour"]);
  });

  test("move along as text is typed, in a Note or beside them, without being worked out again", () => {
    let state = stateWith([
      paragraph("a", text("Tides "), citation("tides")),
      paragraph("b", text("Notes")),
      paragraph("c", citation("harbour"), text(" and "), citation("moon")),
    ]);
    const plugin = state.plugins[0];
    const decorated = (current: EditorState) =>
      (plugin?.getState(current) as { decorations: DecorationSet } | undefined)?.decorations
        .find()
        .map((each) => [each.from, each.spec.citationNumber]) ?? [];
    const notes = 1 + (state.doc.firstChild?.nodeSize ?? 0);
    for (const key of "Spring and neap") {
      state = state.apply(state.tr.insertText(key, notes + 1));
    }
    state = state.apply(state.tr.delete(notes + 1, notes + 3));
    // Between the last two Citations, and before the first.
    const harbour = numberedCitations(state)[1]?.pos ?? 0;
    state = state.apply(state.tr.insertText(" tides", harbour + 1));
    state = state.apply(state.tr.insertText("The ", 1));

    expect(listed(state)).toEqual(["a:1 tides", "c:1 harbour", "c:2 moon"]);
    expect(numberedCitations(state)).toEqual(numberCitations(state.doc));
    expect(decorated(state)).toEqual(
      numberCitations(state.doc).map((each) => [each.pos, each.number]),
    );
  });

  test("a Numbered Citation of a source and place already cited repeats that footnote's number", () => {
    // The Word export has one footnote for each source and place (#1381), so the marks the
    // reader matches to it say the same number (#2292).
    const state = stateWith([
      paragraph("a", placed("tides", 1), text(" and "), placed("tides", 1), text(".")),
      paragraph("b", placed("tides", 2)),
      paragraph("c", placed("tides", 1), placed("moon", 1)),
    ]);
    expect(
      numberedCitations(state).map((each) => `${each.number}${each.footnote ? "" : " reused"}`),
    ).toEqual(["1", "1 reused", "2", "1 reused", "3"]);
  });

  test("a source and place whose check differs, or another version, is a footnote of its own", () => {
    const state = stateWith([
      paragraph("a", placed("tides", 1), placed("tides", 1, "not-found"), text(" and "), {
        ...placed("tides", 1),
        attrs: { ...placed("tides", 1).attrs, contentHash: "tides-v2" },
      }),
    ]);
    expect(numberedCitations(state).map((each) => each.number)).toEqual([1, 2, 3]);
    expect(numberedCitations(state).every((each) => each.footnote)).toBe(true);
  });

  test("a footnote the User wrote keeps the number the export gives the next source and place", () => {
    const own: JSONContent = {
      type: "footnote",
      attrs: { id: "own-1" },
      content: [{ type: "text", text: "Mine." }],
    };
    const state = stateWith([
      paragraph("a", placed("tides", 1), own, placed("tides", 1)),
      paragraph("b", placed("moon", 1)),
    ]);
    // One footnote for the repeated source and place, the User's second, the new one third.
    expect(numberedCitations(state).map((each) => each.number)).toEqual([1, 1, 3]);
  });

  test("a Citation a change still waiting adds or removes is a footnote of its own, so later numbers stay", () => {
    const pending = {
      ...placed("tides", 1),
      attrs: {
        ...placed("tides", 1).attrs,
        [PROPOSAL_ATTRIBUTE]: { id: "p1", request: "r", kind: "insert" },
      },
    };
    const state = stateWith([
      paragraph("a", pending),
      paragraph("b", placed("tides", 1), placed("moon", 1)),
    ]);
    // The change's mark takes one note, the live mark of the same place another, so Moon is 3
    // in the file and on screen.
    expect(numberedCitations(state).map((each) => each.number)).toEqual([1, 2, 3]);
  });

  test("a Document removed since turns a found and a not-found mark of one place into one footnote", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [paragraph("a", placed("tides", 1), placed("tides", 1, "not-found"))],
    });
    // Live, the two checks differ, so they are two footnotes; with the Document gone neither can
    // be checked, and they are the one unverified footnote the file writes.
    expect(
      numberFootnotes(doc, "numbered", {
        documents: [{ id: "tides", contentHash: "tides-v1" }],
      }).citations.map((each) => each.number),
    ).toEqual([1, 2]);
    expect(
      numberFootnotes(doc, "numbered", { documents: [] }).citations.map((each) => each.number),
    ).toEqual([1, 1]);
  });
});

describe("A change that only edits inside one text block", () => {
  const blocks = [
    paragraph("a", text("Tides "), citation("tides"), text(" and "), citation("moon")),
    paragraph("b", text("Notes")),
    paragraph("c", text("More")),
  ];
  const start = EditorState.create({ doc: schema.nodeFromJSON({ type: "doc", content: blocks }) });
  /** Where the text of the Block at this index starts. */
  const textOf = (index: number) => {
    let at = 0;
    start.doc.forEach((_node, offset, i) => {
      if (i === index) at = offset + 1;
    });
    return at;
  };

  test("is typing, deleting or formatting in one text block, beside its Citations too", () => {
    const notes = textOf(1);
    expect(textBlockEdited(start.tr.insertText("x", notes + 2))).toBe(notes - 1);
    expect(textBlockEdited(start.tr.insertText("x", notes))).toBe(notes - 1);
    expect(textBlockEdited(start.tr.delete(notes, notes + 2))).toBe(notes - 1);
    expect(textBlockEdited(start.tr.addMark(notes, notes + 3, schema.mark("bold")))).toBe(
      notes - 1,
    );
    // Before, after and between Citations: they stay the same Citations.
    const tides = textOf(0);
    expect(textBlockEdited(start.tr.insertText("x", tides + 6))).toBe(tides - 1);
    expect(textBlockEdited(start.tr.insertText("x", tides + 7))).toBe(tides - 1);
    expect(textBlockEdited(start.tr.delete(tides + 8, tides + 10))).toBe(tides - 1);
  });

  test("isn't one that adds, removes or replaces a Citation, spans blocks, or changes none", () => {
    const notes = textOf(1);
    const tides = textOf(0);
    // A Citation pasted in, deleted, or replaced by another.
    const moon = schema.nodeFromJSON(citation("moon"));
    expect(textBlockEdited(start.tr.insert(notes + 1, moon))).toBeNull();
    expect(textBlockEdited(start.tr.delete(tides + 6, tides + 7))).toBeNull();
    expect(textBlockEdited(start.tr.replaceWith(tides + 6, tides + 7, moon))).toBeNull();
    // Enter splits the block; Backspace at its start joins two.
    expect(textBlockEdited(start.tr.split(notes + 2))).toBeNull();
    expect(textBlockEdited(start.tr.join(notes - 1))).toBeNull();
    expect(textBlockEdited(start.tr.delete(notes + 2, textOf(2) + 1))).toBeNull();
    // A Note turned into a heading.
    expect(
      textBlockEdited(
        start.tr.setBlockType(notes, notes, schema.nodes.heading as NodeType, { level: 2 }),
      ),
    ).toBeNull();
    // Two edits at once, or only a new selection.
    expect(
      textBlockEdited(start.tr.insertText("x", notes + 1).insertText("y", textOf(2) + 2)),
    ).toBeNull();
    expect(
      textBlockEdited(start.tr.setSelection(TextSelection.create(start.doc, notes))),
    ).toBeNull();
  });
});
