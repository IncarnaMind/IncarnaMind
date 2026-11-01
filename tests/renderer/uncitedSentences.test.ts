/**
 * The sentences an outside agent's change would leave with no Citation (#352), which its bar
 * counts and selects one at a time: those its own words are in, read as the paragraph reads
 * with it accepted, that make a claim and hold no Citation.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, onTestFinished, test } from "vitest";
import { PROPOSAL_ATTRIBUTE } from "../../src/core";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { ProposalReview, pendingIn } from "../../src/renderer/src/editor/proposalReview";
import { uncitedSentences } from "../../src/renderer/src/editor/uncitedSentences";

const ref = (id: string) => ({ id, request: "agent" });
const adds = (id: string) => [{ type: "proposalInsert", attrs: ref(id) }];
const removes = (id: string) => [{ type: "proposalDelete", attrs: ref(id) }];
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});
const citation: JSONContent = {
  type: "citation",
  attrs: { documentId: "d1", documentName: "Tides", quote: "Spring tides.", check: "found" },
};
const addedWhole = (id: string, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { [PROPOSAL_ATTRIBUTE]: { ...ref(id), kind: "insert" } },
  content,
});

/** The sentences of the change `id`, as the text they select. */
function uncitedOf(content: JSONContent[], id: string): string[] {
  const editor = new Editor({
    element: null,
    extensions: [...noteExtensions(), ProposalReview],
    content: { type: "doc", content },
  });
  onTestFinished(() => editor.destroy());
  const state = EditorState.create({
    doc: editor.state.doc,
    plugins: editor.extensionManager.plugins,
  });
  const proposal = pendingIn(state).find((each) => each.id === id);
  if (!proposal) throw new Error(`No change ${id}.`);
  return uncitedSentences(state.doc, proposal).map(({ from, to }) =>
    state.doc.textBetween(from, to),
  );
}

describe("The sentences a change leaves with no Citation", () => {
  test("are each sentence of a paragraph it adds that cites nothing, in order", () => {
    expect(
      uncitedOf(
        [
          addedWhole(
            "p1",
            text("Neap tides come at the quarter moons. Their range is the smallest of the month."),
          ),
        ],
        "p1",
      ),
    ).toEqual([
      "Neap tides come at the quarter moons.",
      "Their range is the smallest of the month.",
    ]);
  });

  test("leave out a sentence with a Citation, and in Chinese count each sentence", () => {
    expect(
      uncitedOf(
        [
          addedWhole(
            "p1",
            text("Spring tides come twice a month "),
            citation,
            text(". Their range is the largest of the month."),
          ),
        ],
        "p1",
      ),
    ).toEqual(["Their range is the largest of the month."]);
    expect(
      uncitedOf([addedWhole("p1", text("大潮每月出现两次。小潮出现在上弦月和下弦月。"))], "p1"),
    ).toEqual(["大潮每月出现两次。", "小潮出现在上弦月和下弦月。"]);
  });

  test("are only the sentences its own words are in: not the User's beside it, nor another change's", () => {
    const paragraph: JSONContent = {
      type: "paragraph",
      content: [
        text("Tides rise "),
        text("twice", removes("p1")),
        text("two times", adds("p1")),
        text(" a day. Neap tides are small. "),
        text("King tides flood the harbour wall.", adds("p2")),
      ],
    };
    // As the User sees the sentence: the word it takes out is still there, struck.
    expect(uncitedOf([paragraph], "p1")).toEqual(["Tides rise twicetwo times a day."]);
    expect(uncitedOf([paragraph], "p2")).toEqual(["King tides flood the harbour wall."]);
  });

  test("are none for a change that only takes words out", () => {
    expect(
      uncitedOf(
        [
          {
            type: "paragraph",
            content: [text("Tides rise "), text("very ", removes("p1")), text("twice a day.")],
          },
        ],
        "p1",
      ),
    ).toEqual([]);
  });
});
