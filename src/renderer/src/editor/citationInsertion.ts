import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { citationBackstep } from "../../../shared/citationPlace";
import { INLINE_NODE } from "../../../shared/sentences";

/**
 * Where a new Citation of the words `from`–`to` of a paragraph goes: at their end, before the
 * closing punctuation they end with, and after the Citations before it. Every add asks here
 * (`citationBackstep` is the rule), so none puts one after the stop.
 */
export function citationInsertionPoint(doc: ProseMirrorNode, from: number, to: number): number {
  return to - citationBackstep(doc.textBetween(from, to, "\n", INLINE_NODE));
}
