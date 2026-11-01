import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  CITATION_NODE,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import { readProposalAttribute, readProposalRef } from "../../../shared/proposals";
import { INLINE_NODE, isClaim, sentenceSpans } from "../../../shared/sentences";
import type { PendingProposal } from "./proposalReview";

/** A sentence of the Note, as a range of the editor's document. */
export interface SentenceRange {
  from: number;
  to: number;
}

/** What a node does in a change: a Proposal adds it or takes it out, or none. */
const proposalOf = (node: ProseMirrorNode) =>
  readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE] ?? null);

/**
 * The sentences a change would leave with no Citation once accepted (#352): each sentence its
 * words are in, read as its paragraph will read with this change accepted and the others not,
 * that makes a claim (`isClaim`, as the Note's checks count them) and holds no Citation. A
 * change that only takes words out leaves none of its own.
 */
export function uncitedSentences(
  doc: ProseMirrorNode,
  proposal: Pick<PendingProposal, "id" | "ranges">,
): SentenceRange[] {
  const paragraphs = new Set<number>();
  for (const range of proposal.ranges) {
    doc.nodesBetween(range.from, range.to, (node, at) => {
      if (node.isTextblock) paragraphs.add(at);
      return !node.isTextblock;
    });
  }
  const found: SentenceRange[] = [];
  for (const at of [...paragraphs].sort((a, b) => a - b)) {
    const paragraph = doc.nodeAt(at);
    if (!paragraph) continue;
    // A Block this change, or another, adds whole decides for every word in it.
    let wholly = false;
    let absent = false;
    const place = doc.resolve(at + 1);
    for (let depth = place.depth; depth > 0; depth--) {
      const whole = proposalOf(place.node(depth));
      if (!whole) continue;
      if (whole.kind === "insert" && whole.id === proposal.id) wholly = true;
      else if (whole.kind === "insert" || whole.id === proposal.id) absent = true;
    }
    if (absent) continue;
    let text = "";
    const positions: number[] = [];
    const mine = new Set<number>();
    const cited = new Set<number>();
    paragraph.forEach((child, offset) => {
      const start = at + 1 + offset;
      if (child.isText) {
        const adds = readProposalRef(
          child.marks.find((mark) => mark.type.name === PROPOSAL_INSERT_MARK)?.attrs ?? null,
        );
        const removes = readProposalRef(
          child.marks.find((mark) => mark.type.name === PROPOSAL_DELETE_MARK)?.attrs ?? null,
        );
        if ((adds && adds.id !== proposal.id) || removes?.id === proposal.id) return;
        const words = child.text ?? "";
        for (let index = 0; index < words.length; index++) {
          if (wholly || adds) mine.add(text.length);
          positions.push(start + index);
          text += words[index];
        }
        return;
      }
      const own = proposalOf(child);
      if (own && (own.kind === "insert" ? own.id !== proposal.id : own.id === proposal.id)) return;
      if (wholly || own) mine.add(text.length);
      if (child.type.name === CITATION_NODE) cited.add(text.length);
      positions.push(start);
      text += INLINE_NODE;
    });
    for (const span of sentenceSpans(text)) {
      const indices = Array.from({ length: span.to - span.from }, (_, index) => span.from + index);
      if (!indices.some((index) => mine.has(index))) continue;
      if (indices.some((index) => cited.has(index))) continue;
      if (!isClaim(text.slice(span.from, span.to))) continue;
      const from = positions[span.from];
      const last = positions[span.to - 1];
      if (from !== undefined && last !== undefined) found.push({ from, to: last + 1 });
    }
  }
  return found;
}
