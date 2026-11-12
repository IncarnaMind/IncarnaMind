/**
 * A help button's Answer during a call, read line by line as the panel
 * lays it out (the shape src/core/answers/meetingHelp.ts asks for): options
 * or readings, the recommended first after "★", each followed by "→" and what
 * it leads to; or up to three short lines. It reads a part still streaming.
 */
import type { AnswerStatus, MarkedCitation } from "../../core/api";
import {
  EFFECT_MARK,
  HELP_SHAPE,
  type HelpShape,
  LINE_MARK,
  type MeetingHelpKind,
  plainLine,
  RECOMMENDED_MARK,
} from "../../shared/meetingHelp";

/**
 * A run of text, a Citation's marker ("[^2]") or a calculated figure's ("[=1]"). A Citation's `at`
 * is its marker's place among the reply's Citation markers, from 0, as the core counts them.
 */
export type ReplyPiece =
  | { kind: "text"; text: string }
  | { kind: "citation"; marker: number; at: number }
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

/** The pieces of `text`, whose first Citation marker is the reply's `first`. */
export function pieces(text: string, first: number): ReplyPiece[] {
  const found: ReplyPiece[] = [];
  let from = 0;
  let cited = first;
  for (const match of text.matchAll(/\[\^(\d+)\]|\[=(\d+)\]/g)) {
    const before = text.slice(from, match.index);
    if (before) found.push({ kind: "text", text: before });
    found.push(
      match[1] !== undefined
        ? { kind: "citation", marker: Number(match[1]), at: cited++ }
        : { kind: "figure", marker: Number(match[2]) },
    );
    from = match.index + match[0].length;
  }
  const rest = text.slice(from);
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
  shown: { shape: HelpShape; leadIn: boolean; streaming: boolean },
): ReplyItem[] {
  const { lead, options } = laidOut(items, shown);
  return [...lead, ...options];
}

function laidOut(
  items: readonly ReplyItem[],
  { shape, leadIn, streaming }: { shape: HelpShape; leadIn: boolean; streaming: boolean },
): { lead: ReplyItem[]; options: ReplyItem[] } {
  const [first] = items;
  if (shape === "lines") {
    const bullets = items.filter((item) => item.bullet);
    const lead = leadIn && first && !first.bullet ? [first] : [];
    // While it is written, text before the first short line is a model's notes, taken back once it
    // records its Citations (#2526): the outline stays in its place instead.
    const rest = bullets.length > 0 ? bullets : streaming ? [] : items.slice(lead.length);
    return { lead, options: rest.slice(0, 3 - lead.length) };
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
  return { lead, options };
}

type HelpAnswer = { text: string; status: AnswerStatus; steps?: { textBehind?: true } | null };

/**
 * What the panel shows of a button's Answer: the line it puts first, then the options, readings
 * or short lines. One stopped while it was written is read as it was then: what came before its
 * first option is still a model's notes (#2526).
 */
export function helpParts(
  answer: HelpAnswer,
  kind: MeetingHelpKind,
): { lead: ReplyItem[]; options: ReplyItem[] } {
  return laidOut(readHelpReply(answer.text), {
    shape: HELP_SHAPE[kind],
    leadIn: kind === "leading" || answer.steps?.textBehind === true,
    streaming: answer.status === "streaming" || answer.status === "stopped",
  });
}

export function helpItems(answer: HelpAnswer, kind: MeetingHelpKind): ReplyItem[] {
  const { lead, options } = helpParts(answer, kind);
  return [...lead, ...options];
}

/**
 * Whether a button's Answer has anything to pin or add to the note: it ended with an option,
 * reading or short line, or with the lead-in of "Am I leading them?", which is its answer; the
 * app's own line that the live text is behind isn't.
 */
export function helpToKeep(answer: HelpAnswer, kind: MeetingHelpKind): boolean {
  const { lead, options } = helpParts(answer, kind);
  return (
    answer.status === "done" && (options.length > 0 || (kind === "leading" && lead.length > 0))
  );
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

/**
 * Whether a help reply's Citation shows ✓ where it is cited (`at`): the sentence check passed the
 * sentence it is cited in there (#2847). A found quote alone shows none, nor does a line too short
 * to be judged, and a marker reused by a sentence that didn't pass keeps the ✓ its own earned.
 */
export const sentencePassed = (citation: Pick<MarkedCitation, "passedAt">, at: number): boolean =>
  citation.passedAt?.includes(at) === true;

/**
 * Why a help reply's Citation was never checked, where the User can do something about it: the
 * Answer's checking limit or the monthly limit reached, or a model too small to judge. Null
 * otherwise, a line the check doesn't judge among them.
 */
export function uncheckedReason(
  citation: Pick<MarkedCitation, "check" | "checkReason">,
): "answer-limit" | "monthly-limit" | "small-model" | null {
  if (citation.check !== "not-checked") return null;
  const reason = citation.checkReason;
  return reason === "answer-limit" || reason === "monthly-limit" || reason === "small-model"
    ? reason
    : null;
}

const CITATION_MARKER = /\[\^\d+\]/g;

export function readHelpReply(markdown: string): ReplyItem[] {
  const items: ReplyItem[] = [];
  let cited = 0;
  for (const raw of markdown.split("\n")) {
    const first = cited;
    cited += raw.match(CITATION_MARKER)?.length ?? 0;
    const line = plainLine(raw);
    if (line === "" || DEFINITION.test(line) || /^#+\s/.test(line)) continue;
    const current = items.at(-1);
    if (EFFECT_MARK.test(line)) {
      const effect = pieces(line.replace(EFFECT_MARK, ""), first);
      if (current && current.effect === null) current.effect = effect;
      else items.push({ recommended: false, bullet: false, lead: [], notes: [], effect });
      continue;
    }
    const recommended = RECOMMENDED_MARK.test(line);
    const bullet = LINE_MARK.test(line);
    const text = line.replace(RECOMMENDED_MARK, "").replace(LINE_MARK, "");
    if (!recommended && !bullet && current && current.effect === null && current.lead.length > 0) {
      current.notes.push(pieces(text, first));
      continue;
    }
    items.push({ recommended, bullet, lead: pieces(text, first), notes: [], effect: null });
  }
  // One recommendation: a second star a model adds is dropped.
  const first = items.findIndex((item) => item.recommended);
  return items.map((item, index) => (index === first ? item : { ...item, recommended: false }));
}
