/**
 * Which text a selection in the note is, as Edit with AI changes it (#93): in
 * paragraphs and headings, by their Block ids and offsets into their text
 * (`TextPlace`), as the core reads it.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { TextPlace } from "../../../core/api";

/** How much of a selection a label quotes: a chip above it holds all of it. */
export const QUOTE_CHARACTERS = 48;

/**
 * A selection in one line, cut short: for the composer's edit chip, and the Question Explain
 * asks with (#2348). An inline node shows as nothing, as in the core's own reading.
 */
export function quoteOf(text: string): string {
  const flat = text
    .replace(/\uFFFC/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...flat];
  return characters.length > QUOTE_CHARACTERS
    ? `${characters.slice(0, QUOTE_CHARACTERS - 1).join("")}…`
    : flat;
}

/** The text a selection covers, as Edit with AI changes it. */
export interface EditSelection {
  from: TextPlace;
  to: TextPlace;
  /** As the core compares it: an inline node as U+FFFC, a line per paragraph or heading. */
  text: string;
  /** Where it is in the editor. */
  range: { from: number; to: number };
}

const TEXT_BLOCKS: ReadonlySet<string> = new Set(["paragraph", "heading"]);
/** What Edit with AI doesn't change: a Question, code and formulas on their own line. */
const NOT_EDITED: ReadonlySet<string> = new Set(["question", "codeBlock", "blockMath"]);

/**
 * The part of a paragraph's or heading's text from `from` to `to` (positions
 * in the editor), as the core reads it: where it starts and ends, an inline
 * node counting as one whatever it holds (a footnote holds its text), and
 * its text, an inline node as U+FFFC.
 */
function readBlock(node: ProseMirrorNode, start: number, from: number, to: number) {
  let offset = 0;
  let first = 0;
  let last = 0;
  let text = "";
  let pos = start;
  node.forEach((child) => {
    const size = child.isText ? child.nodeSize : 1;
    const end = pos + child.nodeSize;
    if (pos < from) first = offset + Math.min(size, from - pos);
    if (pos < to) last = offset + Math.min(size, to - pos);
    if (end > from && pos < to) {
      text += child.isText ? (child.text ?? "").slice(Math.max(0, from - pos), to - pos) : "\uFFFC";
    }
    offset += size;
    pos = end;
  });
  return { from: first, to: last, text };
}

/**
 * The text from `from` to `to` (the selection by default) as Edit with AI
 * changes it, or null: nothing but spaces is selected, or it starts or ends
 * outside a paragraph or heading (in a Question, in code), or an Answer
 * being written holds it.
 */
export function selectionForEdit(
  state: EditorState,
  range: { from: number; to: number } = state.selection,
): EditSelection | null {
  const { from, to } = range;
  if (from >= to) return null;
  const blocks: { id: string; from: number; to: number; text: string }[] = [];
  let refused = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (refused) return false;
    if (node.type.name === "answer" && node.attrs.status === "streaming") refused = true;
    if (refused || NOT_EDITED.has(node.type.name)) return false;
    if (!node.isTextblock) return true;
    const id: unknown = node.attrs.id;
    if (TEXT_BLOCKS.has(node.type.name) && typeof id === "string") {
      blocks.push({ id, ...readBlock(node, pos + 1, from, to) });
    }
    return false;
  });
  const first = blocks[0];
  const last = blocks.at(-1);
  if (refused || !first || !last) return null;
  const text = blocks.map((block) => block.text).join("\n");
  if (text.trim() === "") return null;
  return {
    from: { blockId: first.id, offset: first.from },
    to: { blockId: last.id, offset: last.to },
    text,
    range: { from, to },
  };
}
