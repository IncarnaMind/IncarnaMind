import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, test } from "vitest";
import { ANSWER_BLOCK, CITATION_NODE, FOOTNOTE_NODE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  citationNumberAt,
  joinerFor,
  nextWord,
  sentencesIn,
  suggestionPlace,
} from "../../src/renderer/src/editor/suggestionPlace";

const schema = getSchema(noteExtensions());

const LONG = "The harbour survey depends on the tides, which rise twice a day";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const citation: JSONContent = {
  type: CITATION_NODE,
  attrs: { documentId: "d", documentName: "Tides", check: "found" },
};

/** A Mind of these Blocks, the caret at `at` (or the selection from `at` to `to`). */
function stateWith(blocks: JSONContent[], at: (doc: EditorState["doc"]) => number, to?: number) {
  const doc = schema.nodeFromJSON({ type: "doc", content: blocks });
  const from = at(doc);
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to ?? from),
  });
}

/** The end of the first top-level Block's text. */
const endOfFirst = (doc: EditorState["doc"]) => (doc.firstChild?.nodeSize ?? 2) - 1;

describe("where a suggestion goes", () => {
  test("at the end of a paragraph long enough, with the caret there and nothing selected", () => {
    expect(suggestionPlace(stateWith([paragraph(text(LONG))], endOfFirst))).toEqual({
      pos: LONG.length + 1,
      text: LONG,
    });
    // Mid-paragraph, a selection, or too short: none.
    expect(suggestionPlace(stateWith([paragraph(text(LONG))], () => 5))).toBeNull();
    expect(
      suggestionPlace(stateWith([paragraph(text(LONG))], () => 1, LONG.length + 1)),
    ).toBeNull();
    expect(suggestionPlace(stateWith([paragraph(text("Too short."))], endOfFirst))).toBeNull();
  });

  test("never in a heading, a Question, an Answer or code", () => {
    const heading = { type: "heading", attrs: { level: 2 }, content: [text(LONG)] };
    expect(suggestionPlace(stateWith([heading], endOfFirst))).toBeNull();
    const question = { type: "question", content: [text(LONG)] };
    expect(suggestionPlace(stateWith([question], endOfFirst))).toBeNull();
    const answer = { type: ANSWER_BLOCK, content: [paragraph(text(LONG))] };
    expect(
      suggestionPlace(stateWith([answer], (doc) => (doc.firstChild?.nodeSize ?? 4) - 2)),
    ).toBeNull();
    const code = { type: "codeBlock", content: [text(LONG)] };
    expect(suggestionPlace(stateWith([code], endOfFirst))).toBeNull();
  });

  test("in a list's paragraph, as body text", () => {
    const list = {
      type: "bulletList",
      content: [{ type: "listItem", content: [paragraph(text(LONG))] }],
    };
    // Inside the list item's paragraph: list, item, paragraph each open one.
    expect(suggestionPlace(stateWith([list], () => 3 + LONG.length))?.text).toBe(LONG);
  });

  test("its Citation takes the next number in its Block", () => {
    const state = stateWith([paragraph(text("One "), citation, text(LONG))], endOfFirst);
    expect(citationNumberAt(state, endOfFirst(state.doc))).toBe(2);
  });

  test("its Citation takes the next number in the Mind, which footnotes share", () => {
    // A footnote holding a Citation counts once: the Citation in it has no number.
    const footnote = { type: FOOTNOTE_NODE, content: [text("See "), citation] };
    const state = stateWith(
      [paragraph(text("Neap"), footnote, text(" tides "), citation), paragraph(text(LONG))],
      (doc) => doc.content.size - 1,
    );
    expect(citationNumberAt(state, state.doc.content.size - 1)).toBe(3);
  });

  test("a suggested Citation of a source and place already cited takes that footnote's number", () => {
    const state = stateWith([paragraph(text("One "), citation, text(LONG))], endOfFirst);
    const at = endOfFirst(state.doc);
    expect(citationNumberAt(state, at, citation.attrs ?? {})).toBe(1);
    // A place of its own gets the next footnote's number.
    expect(
      citationNumberAt(state, at, { documentId: "d", check: "found", pageFrom: 2, pageTo: 2 }),
    ).toBe(2);
  });

  test("a suggested Citation after two marks of one footnote takes the number after it", () => {
    const state = stateWith(
      [paragraph(text("One "), citation, text(" and "), citation, text(LONG))],
      endOfFirst,
    );
    // Both Citations are one Document and place, footnote 1; a new place is footnote 2, not 3.
    expect(citationNumberAt(state, endOfFirst(state.doc), { documentId: "other" })).toBe(2);
  });
});

describe("the words of a suggestion", () => {
  test("a space joins Latin text, nothing joins Chinese", () => {
    expect(joinerFor("the tides rise", "They come")).toBe(" ");
    expect(joinerFor("the tides rise ", "They come")).toBe("");
    expect(joinerFor("每个月有两次大潮，", "这时太阳")).toBe("");
  });

  test("⌥→ takes the next word, with what comes before it and the punctuation after it", () => {
    expect(nextWord(" They come at new moon.")).toBe(" They");
    expect(nextWord(" moon.")).toBe(" moon.");
    expect(nextWord("这时太阳和月亮的引力叠加在一起。")).toBe("这时");
  });

  test("sentences are counted in English and Chinese, the one being written too", () => {
    expect(sentencesIn("One. Two! Three")).toBe(3);
    expect(sentencesIn("One. Two!")).toBe(2);
    expect(sentencesIn("第一句。第二句？第三")).toBe(3);
    expect(sentencesIn("Version 2.5 is out")).toBe(1);
  });
});
