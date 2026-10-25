import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { describe, expect, test } from "vitest";
import { ANSWER_BLOCK, QUESTION_BLOCK } from "../../src/core";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { foldToggled, questionFoldPlugin } from "../../src/renderer/src/editor/questionFold";
import { sentencesEnd, spokenText } from "../../src/renderer/src/editor/spokenText";

const schema = getSchema(noteExtensions());

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});

/** A Mind with one Question, its Answer and a Note, and the fold plugin of Mind `mindId`. */
function stateOf(mindId: string): EditorState {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: QUESTION_BLOCK, attrs: { id: "q1" }, content: [{ type: "text", text: "Why?" }] },
      { type: ANSWER_BLOCK, attrs: { id: "a1", questionId: "q1" }, content: [paragraph("So.")] },
      paragraph("Notes"),
    ],
  });
  return EditorState.create({ doc, plugins: [questionFoldPlugin(mindId)] });
}

/** The Blocks the fold decorations mark, by type, with how. */
function folded(state: EditorState): string[] {
  const [plugin] = state.plugins;
  const set = plugin?.props.decorations?.call(plugin, state) as DecorationSet | null | undefined;
  return (set?.find() ?? []).map((decoration) => {
    const node = state.doc.nodeAt(decoration.from);
    return `${node?.type.name}: ${(decoration.spec as { folded?: unknown }).folded !== undefined ? "folded" : "hidden"}`;
  });
}

const toggled = (state: EditorState, questionId: string) =>
  state.apply(foldToggled(state.tr, questionId));

describe("folding a Question", () => {
  test("hides its Answer, marks the Question as folded, stores nothing, and shows it again", () => {
    const state = stateOf("mind-1");
    expect(folded(state)).toEqual([]);
    const shut = toggled(state, "q1");
    expect(folded(shut)).toEqual(["question: folded", "answer: hidden"]);
    // How it looks, not what the Mind holds.
    expect(shut.doc.eq(state.doc)).toBe(true);
    expect(folded(toggled(shut, "q1"))).toEqual([]);
  });

  test("stays folded when the Mind is opened again in this window, and only in its own Mind", () => {
    toggled(stateOf("mind-2"), "q1");
    expect(folded(stateOf("mind-2"))).toHaveLength(2);
    expect(folded(stateOf("mind-3"))).toEqual([]);
  });
});

describe("what a streaming Answer reads out", () => {
  test("its whole sentences so far, Latin and Chinese", () => {
    expect(sentencesEnd("Spring tides come twice. They are", 0)).toBe(24);
    expect(sentencesEnd("It is 2.5 m high", 0)).toBe(0);
    expect(sentencesEnd("大潮每月两次。小潮", 0)).toBe(7);
    expect(sentencesEnd("One. Two. Three", 5)).toBe(9);
  });

  test("words, without Citation markers, code, formulas or Markdown marks", () => {
    expect(
      spokenText(
        "Your Documents answer this [^1].\n\n- It **streams** in\n- Math: $E = mc^2$\n\n```js\nlog();\n```\n\nThat is all.",
      ),
    ).toBe("Your Documents answer this. It streams in Math: That is all.");
  });

  // protects=a Citation's id the model wrote as text isn't read aloud while the Answer streams (#1800); fails_when=the screen reader says "C1"; no_claim=none beyond protects.
  test("a Citation's id written as text is not read out", () => {
    expect(
      spokenText(
        "It drops recurrence [Attention, p. 1 · C1]. 它不用循环【Attention, p. 1 · C2】。",
      ),
    ).toBe("It drops recurrence. 它不用循环。");
  });
});
