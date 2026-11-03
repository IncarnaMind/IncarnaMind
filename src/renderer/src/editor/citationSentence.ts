import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CALCULATED_FIGURE_NODE } from "../../../core/api";
import { sentenceSpans } from "../../../shared/sentences";
import { paragraphPlaces } from "./claimChecks";

/**
 * The sentence an inline node at `pos` is in, as checks read sentences, with its text as they read
 * it; null outside a paragraph's text.
 */
export function sentenceAround(
  doc: ProseMirrorNode,
  pos: number,
): { from: number; to: number; text: string } | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.depth === 0) return null;
  const places = paragraphPlaces($pos.parent, $pos.before());
  const at = places.inline.find((each) => each.pos === pos)?.at;
  if (at === undefined) return null;
  const figures = places.inline.flatMap(({ node, at: place }) =>
    node.type.name === CALCULATED_FIGURE_NODE ? [place] : [],
  );
  const span = sentenceSpans(places.text, figures).find((each) => each.from <= at && at < each.to);
  const from = span && places.starts[span.from];
  const to = span && places.ends[span.to - 1];
  return span === undefined || from === undefined || to === undefined
    ? null
    : { from, to, text: places.text.slice(span.from, span.to) };
}
