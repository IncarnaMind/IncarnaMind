import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  CITATION_NODE,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import { readProposalAttribute, readProposalRef } from "../../../shared/proposals";
import { INLINE_NODE } from "../../../shared/sentences";
import { type ChangedParagraph, uncitedSpans } from "../../../shared/uncitedSentences";
import type { PendingProposal } from "./proposalReview";

/** A sentence of the Note, as a range of the editor's document. */
export interface SentenceRange {
  from: number;
  to: number;
}

const CELLS: ReadonlySet<string> = new Set(["tableCell", "tableHeader"]);

/** What a node does in a change: a Proposal adds it or takes it out, or none. */
const proposalOf = (node: ProseMirrorNode) =>
  readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE] ?? null);

/**
 * The sentences a change would leave with no Citation once accepted (#352), as the agent is
 * told of them (`uncitedSpans`): each paragraph it is in, read with the changes of its request
 * accepted and the others not, so a Citation another of the agent's changes adds cites.
 */
export function uncitedSentences(
  doc: ProseMirrorNode,
  proposal: Pick<PendingProposal, "id" | "request" | "ranges">,
): SentenceRange[] {
  const { id, request } = proposal;
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
    // A Block a change adds whole decides for every word in it.
    let wholly = false;
    let skipped = false;
    let kind: ChangedParagraph["kind"] =
      paragraph.type.name === "heading" ? "heading" : "paragraph";
    const place = doc.resolve(at + 1);
    for (let depth = place.depth; depth > 0; depth--) {
      if (CELLS.has(place.node(depth).type.name)) kind = "cell";
      const whole = proposalOf(place.node(depth));
      if (!whole) continue;
      if (whole.kind === "insert" && whole.request === request) wholly ||= whole.id === id;
      else if (whole.kind === "insert" || whole.request === request) skipped = true;
    }
    if (skipped) continue;
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
        if ((adds && adds.request !== request) || removes?.request === request) return;
        const words = child.text ?? "";
        for (let index = 0; index < words.length; index++) {
          if (wholly || adds?.id === id) mine.add(text.length);
          positions.push(start + index);
          text += words[index];
        }
        return;
      }
      const own = proposalOf(child);
      if (own && (own.kind === "insert" ? own.request !== request : own.request === request)) {
        return;
      }
      // What another request's change takes out is still here, and isn't this change's.
      if (wholly || (own?.kind === "insert" && own.id === id)) mine.add(text.length);
      if (child.type.name === CITATION_NODE) cited.add(text.length);
      positions.push(start);
      text += INLINE_NODE;
    });
    for (const span of uncitedSpans({ text, mine, cited, kind })) {
      const from = positions[span.from];
      const last = positions[span.to - 1];
      if (from !== undefined && last !== undefined) found.push({ from, to: last + 1 });
    }
  }
  return found;
}
