import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { sentenceSpans } from "../../../shared/sentences";
import { paragraphPlaces } from "./claimChecks";

/** The sentence an inline node at `pos` is in, as checks read sentences; null outside a paragraph's text. */
export function sentenceAround(
  doc: ProseMirrorNode,
  pos: number,
): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.depth === 0) return null;
  const places = paragraphPlaces($pos.parent, $pos.before());
  const at = places.inline.find((each) => each.pos === pos)?.at;
  if (at === undefined) return null;
  const span = sentenceSpans(places.text).find((each) => each.from <= at && at < each.to);
  const from = span && places.starts[span.from];
  const to = span && places.ends[span.to - 1];
  return from === undefined || to === undefined ? null : { from, to };
}
