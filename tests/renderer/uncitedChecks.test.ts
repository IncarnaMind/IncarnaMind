/**
 * An Answer's uncited sentence its judgement marked (#3410) is found in the assistant's text by its
 * words: washed, with its check's mark after it, and nothing for a sentence that holds a Citation
 * or another sentence. In English and Chinese.
 */
import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { expect, test, vi } from "vitest";
import { CITATION_NODE, type UncitedCheck } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

// The module reads the bridge at load: nothing here reaches the core.
vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => {} },
  files: {},
}));

const { uncitedCheckDecorations } = await import("../../src/renderer/src/editor/uncitedChecks");

const schema = getSchema(noteExtensions({}));

const check = (sentence: string, kind: UncitedCheck["check"]): UncitedCheck => ({
  sentence,
  check: kind,
  verdict: "The Landlord does the repairs.",
  judgedAt: "2026-11-19T00:00:00.000Z",
});

const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const text = (words: string) => ({ type: "text", text: words });
const citation = { type: CITATION_NODE, attrs: { quote: "A quote.", check: "found" } };

const docOf = (...paragraphs: object[]) =>
  ProseMirrorNode.fromJSON(schema, { type: "doc", content: paragraphs });

/** Each decoration's words or place, and its kind. */
function shown(doc: ProseMirrorNode, checks: readonly UncitedCheck[]) {
  return uncitedCheckDecorations(doc, checks).map((decoration) =>
    decoration.from === decoration.to
      ? { widget: decoration.from }
      : { wash: doc.textBetween(decoration.from, decoration.to) },
  );
}

// protects=a marked sentence is washed over its words and its mark goes right after them, in English and Chinese, while the sentence beside it is left alone; fails_when=another sentence is washed, the mark lands elsewhere, or a Chinese sentence isn't found; no_claim=how the mark and card look, which the screenshots show.
test.each([
  ["en", "The Tenant must repair the roof. The deposit is £4,800."],
  ["zh", "承租人应修复屋顶。押金为4800元。"],
])("in %s, the marked sentence is washed and marked, its neighbour isn't", (_language, words) => {
  const [first] = words.split(/(?<=[.。])\s?/);
  const doc = docOf(paragraph(text(words)));
  const decorations = shown(doc, [check(first ?? "", "contradicted")]);
  expect(decorations).toEqual([{ wash: first }, { widget: 1 + (first?.length ?? 0) }]);
});

// protects=a sentence that holds a Citation is never one the uncited mark finds, though its words match; fails_when=the mark shows beside a cited sentence; no_claim=none beyond protects.
test("a sentence with a Citation in it takes no uncited mark", () => {
  const doc = docOf(paragraph(text("The Tenant must repair the roof"), citation, text(".")));
  expect(shown(doc, [check("The Tenant must repair the roof.", "unsupported")])).toEqual([]);
});
