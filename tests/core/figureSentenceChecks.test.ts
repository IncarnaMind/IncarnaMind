import { getSchema } from "@tiptap/core";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import {
  everySentence,
  markedSentences,
  markSentence,
  selectedSentences,
  textOf,
  unmarkSentence,
  updateCheck,
} from "../../src/core/answers/checks/sentences";
import { type ClaimCheckAttributes, MIND_CONTENT_FIELD } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { checkedSentence } from "../../src/shared/claimChecks";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { INLINE_NODE, sentenceSpans } from "../../src/shared/sentences";

const schema = getSchema(noteExtensions());
function setup() {
  const doc = new Y.Doc();
  const block = createElement({
    type: "paragraph",
    attrs: { id: "block" },
    content: [
      calculatedFigureNode(
        {
          label: "Revenue / 收入",
          formula: "",
          inputs: [],
          value: 10,
          unit: { kind: "plain" },
          approximate: false,
          shown: "10",
          show: { language: "en", as: "number", decimals: 0, scale: null },
          literals: [],
          engine: FORMULA_VERSION,
          written: null,
          analysis: { analysis: 1, result: "revenue" },
        },
        "figure",
        "run",
      ),
    ],
  });
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([block]);
  return { doc, block, blocks: doc.getXmlFragment(MIND_CONTENT_FIELD) };
}
function check(text = INLINE_NODE): ClaimCheckAttributes {
  return {
    id: "check",
    request: "request",
    action: "check-against-documents",
    state: "unsupported",
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
    checkedAt: "2026-10-27T00:00:00.000Z",
  };
}

test("an atom-only numerical sentence is selectable without changing its one-character coordinates", () => {
  const { doc, blocks } = setup();
  const sentences = everySentence(blocks);
  expect(sentences).toHaveLength(1);
  expect(sentences[0]).toMatchObject({
    text: INLINE_NODE,
    from: 0,
    to: 1,
    figures: [{ id: "figure", reading: { chars: "10" } }],
  });
  const selected = selectedSentences(blocks, [
    { from: { blockId: "block", offset: 0 }, to: { blockId: "block", offset: 1 } },
  ]);
  expect(selected.ok && selected.sentences).toHaveLength(1);
  expect(sentenceSpans(INLINE_NODE)).toEqual([]);
  expect(sentenceSpans(INLINE_NODE, [0])).toEqual([{ from: 0, to: 1 }]);
  expect(
    checkedSentence({
      text: INLINE_NODE,
      hasFigures: true,
      check: null,
      skipped: false,
      kept: false,
    }).kind,
  ).toBe("to-check");
  doc.destroy();
});

test("the same Check survives the real Yjs/editor round trip on an atom with no text to mark", () => {
  const { doc, block, blocks } = setup();
  markSentence(block, 0, 1, check());
  expect(markedSentences(blocks)).toHaveLength(1);
  const editorDoc = yXmlFragmentToProseMirrorRootNode(blocks, schema);
  expect(claimSpans(editorDoc)).toMatchObject([{ check: { id: "check", state: "unsupported" } }]);
  const copied = new Y.Doc();
  prosemirrorToYXmlFragment(editorDoc, copied.getXmlFragment(MIND_CONTENT_FIELD));
  expect(markedSentences(copied.getXmlFragment(MIND_CONTENT_FIELD))[0]?.check.id).toBe("check");
  expect(updateCheck(blocks, "check", (current) => ({ ...current, state: "supported" }))).toBe(
    true,
  );
  expect(markedSentences(blocks)[0]?.check.state).toBe("supported");
  expect(unmarkSentence(block, 0, 1, "check-against-documents")).toBe(true);
  expect(markedSentences(blocks)).toEqual([]);
  copied.destroy();
  doc.destroy();
});

test("adding words returns the Check to its existing text owner without keeping a second copy", () => {
  const { doc, block, blocks } = setup();
  markSentence(block, 0, 1, check());
  block.insert(1, [new Y.XmlText(" revenue / 收入。")]);
  markSentence(block, 0, textOf(block).length, check(textOf(block)));
  const atom = block.get(0);
  if (!(atom instanceof Y.XmlElement)) throw new Error("No calculated figure.");
  expect(atom.getAttribute("claimCheck")).toBeUndefined();
  expect(markedSentences(blocks)).toHaveLength(1);
  doc.destroy();
});
