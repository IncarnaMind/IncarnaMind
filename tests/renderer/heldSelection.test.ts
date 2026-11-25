import { Editor, type JSONContent } from "@tiptap/core";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import { describe, expect, onTestFinished, test } from "vitest";
import { CITATION_NODE } from "../../src/core/api";
import { HeldSelection, holdSelection } from "../../src/renderer/src/editor/heldSelection";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const cited = (name: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: { documentId: name, documentName: name, check: "found" },
});

/** "Our plan" and a Citation at 9, " and more" and a Citation at 19, then ".": the paragraph's text starts at 1. */
const content: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Our plan" },
        cited("one"),
        { type: "text", text: " and more" },
        cited("two"),
        { type: "text", text: "." },
      ],
    },
  ],
};

const FIRST = 9;
const SECOND = 19;

/** The Note's plugins on a state of their own, which a headless editor doesn't keep. */
function note() {
  const editor = new Editor({
    element: null,
    extensions: [...noteExtensions(), HeldSelection],
    content,
  });
  onTestFinished(() => editor.destroy());
  let state = EditorState.create({
    doc: editor.state.doc,
    plugins: editor.extensionManager.plugins,
  });
  const dispatch = (tr: Transaction) => {
    state = state.apply(tr);
  };
  return {
    /** Stands in for the editor where the selection is held. */
    editor: {
      isDestroyed: false,
      get state() {
        return state;
      },
      view: { dispatch },
    } as unknown as Editor,
    choose: (selection: (now: EditorState) => Selection) =>
      dispatch(state.tr.setSelection(selection(state))),
    get state() {
      return state;
    },
  };
}

const between = (from: number, to: number) => (state: EditorState) =>
  TextSelection.create(state.doc, from, to);

type Drawn = { from: number; to: number; class: string | undefined };

/** What the selection's plugin draws: each decoration's range and class. */
function drawn(state: EditorState): Drawn[] {
  const found: Drawn[] = [];
  for (const plugin of state.plugins) {
    const set = plugin.props.decorations?.call(plugin, state) as unknown as {
      find?: () => Decoration[];
    } | null;
    for (const decoration of set?.find?.() ?? []) {
      const { attrs } = (decoration as unknown as { type: { attrs: { class?: string } } }).type;
      found.push({ from: decoration.from, to: decoration.to, class: attrs.class });
    }
  }
  return found.filter(
    (each) => each.class === "citation-in-selection" || each.class === "held-selection",
  );
}

const citationsIn = (state: EditorState) =>
  drawn(state)
    .filter((each) => each.class === "citation-in-selection")
    .map((each) => each.from);

describe("a Citation inside a selection is marked for the stylesheet", () => {
  test("each Citation a text selection covers whole, and no other", () => {
    const here = note();
    here.choose(between(1, 21));
    expect(citationsIn(here.state)).toEqual([FIRST, SECOND]);

    here.choose(between(5, 15));
    expect(citationsIn(here.state)).toEqual([FIRST]);

    here.choose(between(10, 21));
    expect(citationsIn(here.state)).toEqual([SECOND]);
  });

  test("one the selection only reaches the edge of is outside it", () => {
    const here = note();
    here.choose(between(1, FIRST));
    expect(citationsIn(here.state)).toEqual([]);
    here.choose(between(FIRST + 1, 15));
    expect(citationsIn(here.state)).toEqual([]);
    here.choose(between(FIRST, FIRST + 1));
    expect(citationsIn(here.state)).toEqual([FIRST]);
  });

  test("a select all covers every Citation, a caret none", () => {
    const here = note();
    here.choose((state) => new AllSelection(state.doc));
    expect(citationsIn(here.state)).toEqual([FIRST, SECOND]);
    here.choose(between(5, 5));
    expect(citationsIn(here.state)).toEqual([]);
  });

  test("one selected alone as a node keeps ProseMirror's own outline", () => {
    const here = note();
    here.choose((state) => NodeSelection.create(state.doc, FIRST));
    expect(citationsIn(here.state)).toEqual([]);
  });

  test("a held selection is still drawn over its words, beside the Citations", () => {
    const here = note();
    here.choose(between(1, 21));
    expect(drawn(here.state).filter((each) => each.class === "held-selection")).toEqual([]);
    holdSelection(here.editor, true);
    expect(drawn(here.state)).toEqual(
      expect.arrayContaining([
        { from: 1, to: 21, class: "held-selection" },
        { from: FIRST, to: FIRST + 1, class: "citation-in-selection" },
        { from: SECOND, to: SECOND + 1, class: "citation-in-selection" },
      ]),
    );
  });
});
