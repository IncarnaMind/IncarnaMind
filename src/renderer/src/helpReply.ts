/**
 * A help button's Answer during a call, read line by line as the panel
 * lays it out (the shape src/core/answers/meetingHelp.ts asks for): options
 * or readings, the recommended first after "★", each followed by "→" and what
 * it leads to; or up to three short lines. It reads a part still streaming.
 */
import type { AnswerStatus } from "../../core/api";
import {
  EFFECT_MARK,
  HELP_SHAPE,
  type HelpShape,
  LINE_MARK,
  type MeetingHelpKind,
  plainLine,
  RECOMMENDED_MARK,
} from "../../shared/meetingHelp";

/** A run of text, a Citation's marker ("[^2]") or a calculated figure's ("[=1]"). */
export type ReplyPiece =
  | { kind: "text"; text: string }
  | { kind: "citation"; marker: number }
  | { kind: "figure"; marker: number };

export interface ReplyItem {
  recommended: boolean;
  /** It began with a list's mark ("- "), as each of the short lines does. */
  bullet: boolean;
  /** The sentence to say, the reading, or the line. */
  lead: ReplyPiece[];
  /** Lines between it and its "→": a reading's moment of the transcript. */
  notes: ReplyPiece[][];
  /** What it leads to; null before its "→" line. */
  effect: ReplyPiece[] | null;
}

const DEFINITION = /^\[\^\d+\]:/;

export function pieces(text: string): ReplyPiece[] {
  const found: ReplyPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(/\[\^(\d+)\]|\[=(\d+)\]/g)) {
    const before = text.slice(at, match.index);
    if (before) found.push({ kind: "text", text: before });
    found.push(
      match[1] !== undefined
        ? { kind: "citation", marker: Number(match[1]) }
        : { kind: "figure", marker: Number(match[2]) },
    );
    at = match.index + match[0].length;
  }
  const rest = text.slice(at);
  if (rest) found.push({ kind: "text", text: rest });
  return found;
}

const OPENING_QUOTES = /^\s*["“「]+/;
const CLOSING_QUOTES = /["”」]+\s*$/;

/**
 * An option's sentence as the User would say it, in quotation marks: the model writes it bare,
 * and any marks it added anyway are taken off first. Its Citations stay after the closing mark.
 */
export function quoted(lead: readonly ReplyPiece[]): ReplyPiece[] {
  const texts = lead.flatMap((piece, index) => (piece.kind === "text" ? [index] : []));
  const first = texts[0];
  const last = texts.at(-1);
  if (first === undefined || last === undefined) return [...lead];
  return lead.map((piece, index) => {
    if (piece.kind !== "text") return piece;
    let text = piece.text;
    if (index === first) text = `“${text.replace(OPENING_QUOTES, "")}`;
    if (index === last) text = `${text.trimEnd().replace(CLOSING_QUOTES, "")}”`;
    return { kind: "text", text };
  });
}

/**
 * What the panel shows of a reply in its button's shape: at most two options or readings, after
 * the one line "Am I leading them?" or "the live text is behind" puts first (`leadIn`), the last
 * included before its "→" line; or at most three short lines. What a model adds anyway (a lead-in,
 * a remark between options, a third option) is left out, but a line after the last option shows
 * as written. The same text shows no less once the reply ends than while it was `streaming`.
 */
export function shownItems(
  items: readonly ReplyItem[],
  { shape, leadIn, streaming }: { shape: HelpShape; leadIn: boolean; streaming: boolean },
): ReplyItem[] {
  const [first] = items;
  if (shape === "lines") {
    const bullets = items.filter((item) => item.bullet);
    const lead = leadIn && first && !first.bullet ? [first] : [];
    // While it is written, text before the first short line is a model's notes, taken back once it
    // records its Citations (#2526): the outline stays in its place instead.
    const rest = bullets.length > 0 ? bullets : streaming ? [] : items.slice(lead.length);
    return [...lead, ...rest].slice(0, 3);
  }
  const lead = leadIn && first && first.effect === null ? [first] : [];
  // While it is written, text before the first "★" line is a model's notes, taken back once it
  // records its Citations (#2526): the outline stays in its place instead.
  const star = items.findIndex((item) => item.recommended);
  const from = !streaming ? 0 : star === -1 ? items.length : star;
  const last = items.at(-1);
  // An item with no "→" line that another follows is a remark between options. The last is an
  // option still being written, or one whose "→" line never came (#2767): it stays as written once
  // the reply ends, so what showed doesn't vanish.
  const options = items
    .slice(from)
    .filter((item) => !lead.includes(item) && (item.effect !== null || item === last))
    .slice(0, 2);
  return [...lead, ...options];
}

/**
 * What the panel shows of a button's Answer. One stopped while it was written is read as it was
 * then: what came before its first option is still a model's notes (#2526).
 */
export function helpItems(
  answer: { text: string; status: AnswerStatus; steps?: { textBehind?: true } | null },
  kind: MeetingHelpKind,
): ReplyItem[] {
  return shownItems(readHelpReply(answer.text), {
    shape: HELP_SHAPE[kind],
    leadIn: kind === "leading" || answer.steps?.textBehind === true,
    streaming: answer.status === "streaming" || answer.status === "stopped",
  });
}

/**
 * The number each Citation shows with, from 1 in the order the shown items cite them, as the
 * assistant numbers an Answer's: a marker is the core's ("[^9001]" for a figure's input), never
 * the User's. A marker `cited` doesn't know isn't shown, so it takes no number.
 */
export function citationNumbers(
  items: readonly ReplyItem[],
  cited: (marker: number) => boolean,
): Map<number, number> {
  const numbers = new Map<number, number>();
  for (const item of items) {
    for (const piece of [item.lead, ...item.notes, item.effect ?? []].flat()) {
      if (piece.kind === "citation" && !numbers.has(piece.marker) && cited(piece.marker))
        numbers.set(piece.marker, numbers.size + 1);
    }
  }
  return numbers;
}

export function readHelpReply(markdown: string): ReplyItem[] {
  const items: ReplyItem[] = [];
  for (const raw of markdown.split("\n")) {
    const line = plainLine(raw);
    if (line === "" || DEFINITION.test(line) || /^#+\s/.test(line)) continue;
    const current = items.at(-1);
    if (EFFECT_MARK.test(line)) {
      const effect = pieces(line.replace(EFFECT_MARK, ""));
      if (current && current.effect === null) current.effect = effect;
      else items.push({ recommended: false, bullet: false, lead: [], notes: [], effect });
      continue;
    }
    const recommended = RECOMMENDED_MARK.test(line);
    const bullet = LINE_MARK.test(line);
    const text = line.replace(RECOMMENDED_MARK, "").replace(LINE_MARK, "");
    if (!recommended && !bullet && current && current.effect === null && current.lead.length > 0) {
      current.notes.push(pieces(text));
      continue;
    }
    items.push({ recommended, bullet, lead: pieces(text), notes: [], effect: null });
  }
  // One recommendation: a second star a model adds is dropped.
  const first = items.findIndex((item) => item.recommended);
  return items.map((item, index) => (index === first ? item : { ...item, recommended: false }));
}
