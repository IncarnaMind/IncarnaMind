import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
  QUESTION_BLOCK,
} from "../../../core/api";
import { readProposalAttribute } from "../../../shared/proposals";
import { countText, NO_COUNT, type TextCount } from "../../../shared/wordCount";

/**
 * How long the editor is left alone before the count is worked out. Counting
 * runs after this pause, never in a keystroke's own turn, so typing stays as
 * fast in a long Mind as in a short one.
 */
export const COUNT_IDLE_MS = 300;

/**
 * The top-level Block types the count leaves out. Questions are what the User
 * asks, not part of what they write. Captions and the Bibliography would be
 * listed here (and offered as an option in the count's menu) once the editor
 * has such nodes. Footnotes are inline, and left out by `visibleText`.
 */
export const UNCOUNTED_BLOCKS: readonly string[] = [QUESTION_BLOCK];

/** A leaf's text: a line break is one, and a Citation marker or a formula is none. */
const leafText = (leaf: ProseMirrorNode) => (leaf.type.name === "hardBreak" ? "\n" : "");

/** Words or a node a Proposal adds: not the Mind's until it is accepted (#94). */
const proposed = (node: ProseMirrorNode) =>
  readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind === "insert" ||
  node.marks.some((mark) => mark.type.name === PROPOSAL_INSERT_MARK);

/**
 * `doc.textBetween(from, to, "\n", leafText)`, but without the text a
 * footnote holds (only its marker is in the line, and a marker counts as
 * none) or what a Proposal still waiting adds.
 */
function visibleText(doc: ProseMirrorNode, from: number, to: number): string {
  let text = "";
  let first = true;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === FOOTNOTE_NODE || proposed(node)) return false;
    const nodeText = node.isText
      ? (node.text ?? "").slice(Math.max(from, pos) - pos, to - pos)
      : node.isLeaf
        ? leafText(node)
        : "";
    if (node.isBlock && ((node.isLeaf && nodeText) || node.isTextblock)) {
      if (first) first = false;
      else text += "\n";
    }
    text += nodeText;
    return true;
  });
  return text;
}

/**
 * The text of the Mind (or of the range `from`–`to` of it), Block by Block with
 * a line break between, without Citation markers, formulas or the uncounted Blocks.
 */
export function countableText(
  doc: ProseMirrorNode,
  range: { from: number; to: number } | null = null,
  uncounted: readonly string[] = UNCOUNTED_BLOCKS,
): string {
  const parts: string[] = [];
  doc.forEach((block, offset) => {
    if (uncounted.includes(block.type.name) || proposed(block)) return;
    const start = offset;
    const end = offset + block.nodeSize;
    const from = range ? Math.max(range.from, start) : start;
    const to = range ? Math.min(range.to, end) : end;
    if (from >= to) return;
    parts.push(visibleText(doc, from, to));
  });
  return parts.join("\n");
}

export interface MindCount {
  /** The whole Mind. */
  total: TextCount;
  /** The selection, when there is one. */
  selection: TextCount | null;
}

const add = (a: TextCount, b: TextCount): TextCount => ({
  words: a.words + b.words,
  cjk: a.cjk + b.cjk,
  characters: a.characters + b.characters,
  charactersNoSpaces: a.charactersNoSpaces + b.charactersNoSpaces,
});

/**
 * Counts a Mind Block by Block (#812), keeping each Block's count, so the
 * count after an edit reads only the Blocks the edit changed: an unchanged
 * Block is the same node in the next document. Blocks are joined by a line
 * break, which ends a word and is no character, so the Blocks' counts add up
 * to the count of the Mind's text in one go (`countableText`).
 */
export function createMindCounter(uncounted: readonly string[] = UNCOUNTED_BLOCKS) {
  const counts = new WeakMap<ProseMirrorNode, TextCount>();
  let read = 0;

  return {
    /**
     * The Mind's count and the selection's, or null when `stop` said to stop
     * before every Block was counted: the Blocks counted are kept, so the
     * next call goes on from there. At least one Block is counted per call.
     */
    count(
      doc: ProseMirrorNode,
      selection: { from: number; to: number },
      stop: () => boolean = () => false,
    ): MindCount | null {
      read = 0;
      let total = NO_COUNT;
      let selected = NO_COUNT;
      const { from, to } = selection;
      let stopped = false;
      doc.forEach((block, start) => {
        if (stopped || uncounted.includes(block.type.name) || proposed(block)) return;
        const end = start + block.nodeSize;
        let count = counts.get(block);
        if (!count) {
          if (read > 0 && stop()) {
            stopped = true;
            return;
          }
          count = countText(visibleText(doc, start, end));
          counts.set(block, count);
          read++;
        }
        total = add(total, count);
        if (from >= to || to <= start || from >= end) return;
        selected = add(
          selected,
          from <= start && to >= end
            ? count
            : countText(visibleText(doc, Math.max(from, start), Math.min(to, end))),
        );
      });
      if (stopped) return null;
      return { total, selection: selected.characters > 0 ? selected : null };
    },

    /** How many Blocks the last count read, not having their count yet. */
    blocksRead: () => read,
  };
}
