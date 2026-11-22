/**
 * Where a Citation goes in its sentence: before the sentence's closing punctuation, after the
 * Citations already there ("…in the quarter[1][2]."). Every way a Citation enters a Note asks
 * here: the card's adds, a pick, a fix, a check's own landing, and Markdown an AI wrote, where a
 * Citation put after the stop ("…in the quarter.[1]") is that sentence's, as `sentenceSpans`
 * reads it, and stands before the stop. Pure: the core and the window share it.
 */
import { CITATION_NODE } from "../core/api";
import type { NodeJSON } from "./blockJson";
import { INLINE_NODE, sentenceSpans } from "./sentences";

const CLOSING = /[\s.!?。！？…;；:："'”’)）\]】」』]+$/u;
const TAIL = new RegExp(`[\\s${INLINE_NODE}]*$`, "u");
const SENTENCE_STOP = /[.!?。！？…]/u;

/** How many characters at the end of `words` are closing punctuation, with the spaces among and after it. */
const citationClosingLength = (words: string): number => CLOSING.exec(words)?.[0].length ?? 0;

/**
 * Where the closing punctuation of a sentence's `words` (an inline node being one U+FFFC) starts,
 * and where the inline nodes after it start; null when none stands after its stop. Inline nodes
 * at the end of a sentence with no stop ("a total of 5[=1]", "Note: [1]") are its own words, not
 * after anything.
 */
function stopOf(words: string): { stop: number; after: number } | null {
  const tail = TAIL.exec(words)?.[0] ?? "";
  if (!tail.includes(INLINE_NODE)) return null;
  const head = words.slice(0, words.length - tail.length);
  const closing = citationClosingLength(head);
  if (!SENTENCE_STOP.test(head.slice(head.length - closing))) return null;
  return { stop: head.length - closing, after: head.length };
}

/**
 * How many characters back from the end of a sentence's `words` (an inline node being one
 * U+FFFC) a Citation of it goes: before its closing punctuation, and before the spaces at its end.
 * A Citation already after the stop ("…quarter. [1]") stays where it is, and the new one goes
 * before the stop, not after that one.
 */
export function citationBackstep(words: string): number {
  const found = stopOf(words);
  return found ? words.length - found.stop : citationClosingLength(words);
}

/** One character of a text node, or one inline node, of a Block's content. */
type Unit = { char: string; marks: string } | { node: NodeJSON };

const isNode = (unit: Unit | undefined): unit is { node: NodeJSON } =>
  unit !== undefined && "node" in unit;

const isCitation = (unit: Unit | undefined): unit is { node: NodeJSON } =>
  isNode(unit) && unit.node.type === CITATION_NODE;

/** What `citationsBeforeTheStop` leaves alone, and what it takes for a repeat. */
export interface CitationPlacing {
  /** Whether a Citation may move: the new ones. Every one, when it isn't given. */
  moves?: (citation: NodeJSON) => boolean;
  /** Whether `held`, a Citation the sentence has, is the one `moved` repeats. */
  repeats?: (moved: NodeJSON, held: NodeJSON) => boolean;
}

/**
 * A Block's inline content with the Citations that stand after a sentence's stop put before it,
 * after those there, and those that repeat one the sentence holds taken out (`dropped`). A
 * Citation right after the stop, with spaces between, is that sentence's, as `sentenceSpans`
 * reads it. One inside the next sentence is the next sentence's, and isn't touched; nor is a
 * Citation `moves` doesn't name, the words, or anything past a line break.
 */
export function citationsBeforeTheStop(
  content: readonly NodeJSON[],
  placing: CitationPlacing = {},
): { content: NodeJSON[]; dropped: NodeJSON[] } {
  if (!content.some((node) => node.type === CITATION_NODE)) {
    return { content: [...content], dropped: [] };
  }
  const units: Unit[] = [];
  let text = "";
  for (const node of content) {
    if (node.type !== "text") {
      units.push({ node });
      text += node.type === "hardBreak" ? "\n" : INLINE_NODE;
      continue;
    }
    const marks = JSON.stringify(node.marks ?? []);
    // Code is no sentence: its stops end nothing.
    const code = node.marks?.some((mark) => mark.type === "code") ?? false;
    const words = node.text ?? "";
    for (let at = 0; at < words.length; at++) {
      const char = words.charAt(at);
      units.push({ char, marks });
      text += code ? "x" : char;
    }
  }
  const dropped: NodeJSON[] = [];
  const moves = placing.moves ?? (() => true);
  // The last sentence first, so what is taken out and put in leaves the places of the earlier ones.
  for (const span of sentenceSpans(text).reverse()) {
    const found = stopOf(text.slice(span.from, span.to));
    if (!found) continue;
    const run = span.from + found.after;
    const candidates: number[] = [];
    for (let at = run; at < span.to && text.charAt(at) !== "\n"; at++) {
      const unit = units[at];
      if (isCitation(unit) && moves(unit.node)) candidates.push(at);
    }
    if (candidates.length === 0) continue;

    const standing = units
      .slice(span.from, span.to)
      .filter((unit, offset) => isCitation(unit) && !candidates.includes(span.from + offset))
      .flatMap((unit) => (isNode(unit) ? [unit.node] : []));
    const put: NodeJSON[] = [];
    const gone = new Set<number>();
    for (const at of candidates) {
      const unit = units[at];
      if (!isNode(unit)) continue;
      const repeated = [...standing, ...put].some((held) => placing.repeats?.(unit.node, held));
      if (repeated) dropped.push(unit.node);
      else put.push(unit.node);
      gone.add(at);
      // The spaces before it go with it, or the stop would be followed by a gap.
      for (let before = at - 1; before >= run && !isNode(units[before]); before--) {
        if (!/\s/u.test(text.charAt(before))) break;
        gone.add(before);
      }
    }
    const stop = span.from + found.stop;
    units.splice(
      stop,
      units.length - stop,
      ...put.map((node): Unit => ({ node })),
      ...units.slice(stop).filter((_, offset) => !gone.has(stop + offset)),
    );
  }

  const merged: NodeJSON[] = [];
  let open: { marks: string; text: string } | null = null;
  const flush = () => {
    if (!open) return;
    const marks = JSON.parse(open.marks) as NodeJSON["marks"];
    merged.push({ type: "text", text: open.text, ...(marks && marks.length > 0 ? { marks } : {}) });
    open = null;
  };
  for (const unit of units) {
    if (isNode(unit)) {
      flush();
      merged.push(unit.node);
    } else if (open && open.marks === unit.marks) open.text += unit.char;
    else {
      flush();
      open = { marks: unit.marks, text: unit.char };
    }
  }
  flush();
  return { content: merged, dropped };
}
