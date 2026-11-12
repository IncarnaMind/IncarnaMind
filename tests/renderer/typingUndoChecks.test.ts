import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import { type ClaimCheckAttributes, MIND_CONTENT_FIELD } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { boundEditorTo, typeText } from "../helpers/editor";
import { copyInStep } from "../helpers/mindClient";

/*
 * ⌘Z takes back what the User typed, never a check's result that landed since (#2988). Two checked
 * sentences share a paragraph; the User types in the first while Check this note runs, a newer
 * result lands on the second, and ⌘Z takes the typing back: the second keeps the newer result.
 * The note is the window's copy, kept in step with the core's by encoded updates, in the editor
 * with the app's schema and its Yjs sync.
 */

const first = "Revenue was 10 in May.";
const second = "Costs were 8 in May.";
const words = `${first} ${second}`;

function check(id: string, text: string, state: ClaimCheckAttributes["state"]) {
  return {
    id,
    request: "check-note",
    action: "check-against-documents",
    state,
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-12T09:00:00.000Z",
  } satisfies ClaimCheckAttributes;
}

const paragraph: NodeJSON = {
  type: "paragraph",
  attrs: { id: "p" },
  content: [{ type: "text", text: words }],
};

/** Where each sentence's mark runs: touching, or with the space between them unmarked. */
const touching = { first: [0, first.length + 1], second: [first.length + 1, words.length] };
const apart = { first: [0, first.length], second: [first.length + 1, words.length] };

describe.each([
  {
    layout: "two checked sentences side by side in a paragraph",
    block: paragraph,
    marks: touching,
  },
  { layout: "an unchecked space between the two sentences", block: paragraph, marks: apart },
  {
    layout: "two checked sentences in a list item",
    block: {
      type: "bulletList",
      attrs: { id: "list" },
      content: [{ type: "listItem", content: [paragraph] }],
    },
    marks: touching,
  },
])("$layout", ({ block, marks }) => {
  test("⌘Z after typing in the first leaves a result that landed on the second since", () => {
    const core = new Y.Doc();
    const blocks = core.getXmlFragment(MIND_CONTENT_FIELD);
    blocks.push([createElement(block)]);
    let element = blocks.get(0);
    while (element instanceof Y.XmlElement && element.nodeName !== "paragraph")
      element = element.get(0);
    if (!(element instanceof Y.XmlElement)) throw new Error("No paragraph");
    const [from1, to1] = marks.first;
    const [from2, to2] = marks.second;
    markSentence(element, from1 ?? 0, to1 ?? 0, check("first", first, "supported"));
    markSentence(element, from2 ?? 0, to2 ?? 0, check("second", second, "supported"));

    const copy = copyInStep(core);
    const editor = boundEditorTo(copy);
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText) at = pos + (node.text ?? "").indexOf("10");
    });
    editor.commands.setTextSelection(at);
    typeText(editor, "about ");
    expect(editor.state.doc.textContent).toContain("Revenue was about 10 in May.");

    const landing = markedSentences(blocks).find((each) => each.check.id === "second");
    if (!landing) throw new Error("The second sentence has no check");
    markSentence(landing.element, landing.from, landing.to, {
      ...check("second", second, "contradicted"),
      checkedAt: "2026-11-12T09:01:00.000Z",
    });

    const landed = markedSentences(copy.getXmlFragment(MIND_CONTENT_FIELD)).find(
      (each) => each.check.id === "second",
    );
    expect(landed?.check.state).toBe("contradicted");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe(words);
    for (const note of [core, copy]) {
      const states = markedSentences(note.getXmlFragment(MIND_CONTENT_FIELD)).map((each) => [
        each.check.id,
        each.check.state,
      ]);
      expect(states).toEqual([
        ["first", "supported"],
        ["second", "contradicted"],
      ]);
    }
  });
});
