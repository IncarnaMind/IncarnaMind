/**
 * A call-help reply, read line by line as its panel lays it out (the shape
 * src/core/answers/meetingHelp.ts asks for): options or readings, the recommended first after "★",
 * each followed by "→" and what it leads to; or up to three short lines. It reads a part still
 * streaming.
 *
 * It is also what an option is, for every reader (#2925): the panel shows an option to say in
 * quotation marks of its own, so a pair the model wrapped the whole option in comes off, and the
 * core keeps the reply as read here once it ends. Its check, the assistant, Check again, a pinned
 * reply and the note it is added to then all read the words the panel shows. Nothing else comes off:
 * a reading or a short line is read as written, its moment of the call in its quotation marks.
 */
import type { AnswerStatus } from "../core/api";
import { MARKER } from "./answerSentences";
import { FIGURE_MARKER } from "./figureMarkers";
import {
  EFFECT_MARK,
  HELP_SHAPE,
  type HelpShape,
  LINE_MARK,
  type MeetingHelpKind,
  plainLine,
  RECOMMENDED_MARK,
} from "./meetingHelp";

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
  /** An option to say, which the panel shows in quotation marks of its own. */
  said: boolean;
  /** The sentence to say, the reading, or the line. */
  lead: ReplyPiece[];
  /** Lines between it and its "→": a reading's moment of the transcript. */
  notes: ReplyPiece[][];
  /** What it leads to; null before its "→" line. */
  effect: ReplyPiece[] | null;
}

/** How a reply is laid out: its button's shape, a line put first, and whether it is still written. */
export interface HelpLayout {
  shape: HelpShape;
  leadIn: boolean;
  streaming: boolean;
}

/**
 * How a button's reply is laid out: "Am I leading them?" puts its answer first, and a reply asked
 * while the live text was behind puts that line first. One stopped while it was written is read as it was
 * then: what came before its first option is still a model's notes (#2526).
 */
export const helpLayout = (
  kind: MeetingHelpKind,
  { status, textBehind }: { status: AnswerStatus; textBehind: boolean },
): HelpLayout => ({
  shape: HELP_SHAPE[kind],
  leadIn: kind === "leading" || textBehind,
  streaming: status === "streaming" || status === "stopped",
});

const DEFINITION = /^\[\^\d{1,4}\]:/;
const MARKERS = new RegExp(`${MARKER.source}|${FIGURE_MARKER.source}`, "g");

/** The pieces of `text`, whose first Citation marker is the reply's `first`. */
export function pieces(text: string, first: number): ReplyPiece[] {
  const found: ReplyPiece[] = [];
  let from = 0;
  let cited = first;
  for (const match of text.matchAll(MARKERS)) {
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

/** A line's star and list mark, in either order ("- ★ …"), and its words after them. */
function marksOf(line: string): { recommended: boolean; bullet: boolean; text: string } {
  let recommended = false;
  let bullet = false;
  let text = line;
  for (;;) {
    if (RECOMMENDED_MARK.test(text)) {
      recommended = true;
      text = text.replace(RECOMMENDED_MARK, "");
    } else if (LINE_MARK.test(text)) {
      bullet = true;
      text = text.replace(LINE_MARK, "");
    } else {
      return { recommended, bullet, text };
    }
  }
}

/** Each reply's item, with the line its lead is on; an item of a "→" line alone has none. */
function itemsOf(lines: readonly string[]): { item: ReplyItem; line: number | null }[] {
  const found: { item: ReplyItem; line: number | null }[] = [];
  let cited = 0;
  for (const [index, raw] of lines.entries()) {
    const first = cited;
    cited += raw.match(MARKER)?.length ?? 0;
    const line = plainLine(raw);
    if (line === "" || DEFINITION.test(line) || /^#+\s/.test(line)) continue;
    const current = found.at(-1)?.item;
    if (EFFECT_MARK.test(line)) {
      const effect = pieces(line.replace(EFFECT_MARK, ""), first);
      if (current && current.effect === null) current.effect = effect;
      else {
        const item = {
          recommended: false,
          bullet: false,
          said: false,
          lead: [],
          notes: [],
          effect,
        };
        found.push({ item, line: null });
      }
      continue;
    }
    const { recommended, bullet, text } = marksOf(line);
    if (!recommended && !bullet && current && current.effect === null && current.lead.length > 0) {
      current.notes.push(pieces(text, first));
      continue;
    }
    const lead = pieces(text, first);
    found.push({
      item: { recommended, bullet, said: false, lead, notes: [], effect: null },
      line: index,
    });
  }
  // One recommendation: a second star a model adds is dropped.
  const star = found.find(({ item }) => item.recommended)?.item;
  for (const { item } of found) if (item !== star) item.recommended = false;
  return found;
}

/** A help reply's items, read as written. */
export function readHelpReply(markdown: string): ReplyItem[] {
  return itemsOf(markdown.split("\n")).map(({ item }) => item);
}

/** An option to say: one in a reply of options, with its "→" line. */
const saysAloud = (item: ReplyItem, shape: HelpShape) =>
  shape === "options" && item.effect !== null;

function laidOut(
  items: readonly ReplyItem[],
  { shape, leadIn, streaming }: HelpLayout,
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

/** What the panel shows of `items`: the line put first, then the options, readings or short lines. */
function shown(items: readonly ReplyItem[], layout: HelpLayout) {
  const { lead, options } = laidOut(items, layout);
  return {
    lead,
    options: options.map((item) => ({ ...item, said: saysAloud(item, layout.shape) })),
  };
}

/**
 * What the panel shows of a reply in its button's shape: at most two options or readings, after
 * the one line "Am I leading them?" or "the live text is behind" puts first (`leadIn`), the last
 * included before its "→" line; or at most three short lines. What a model adds anyway (a lead-in,
 * a remark between options, a third option) is left out, but a line after the last option shows
 * as written. The same text shows no less once the reply ends than while it was `streaming`.
 */
export function shownItems(items: readonly ReplyItem[], layout: HelpLayout): ReplyItem[] {
  const { lead, options } = shown(items, layout);
  return [...lead, ...options];
}

/** Each opening quotation mark with its closing one. */
const PAIRS = ['""', "“”", "「」", "『』", "«»"];
const BEFORE_WORDS = [/^\s+/, /^(?:\*\*|__)/, RECOMMENDED_MARK, LINE_MARK];
/** Bold, spaces, Citation markers and a sentence's end after a line's words. */
const AFTER_WORDS = new RegExp(`(?:\\s|\\*\\*|__|${MARKER.source}|[.!?。！？])*$`, "u");

/** Where a line's words start, after its indent, bold, star and list mark. */
function wordsStart(line: string): number {
  let at = 0;
  for (;;) {
    const rest = line.slice(at);
    const mark = BEFORE_WORDS.map((each) => each.exec(rest)?.[0] ?? "").find(Boolean);
    if (!mark) return at;
    at += mark.length;
  }
}

/** `line` without the pair of quotation marks its words are wrapped in whole, if they are. */
function withoutOwnPair(line: string): string {
  const from = wordsStart(line);
  const to = from + (AFTER_WORDS.exec(line.slice(from))?.index ?? line.length - from);
  const opening = PAIRS.find((pair) => pair[0] === line[from]);
  const closing = PAIRS.find((pair) => pair[1] === line[to - 1]);
  const words = line.slice(from + 1, to - 1);
  if (!opening || !closing || to - from < 3 || words.trim() === "") return line;
  // A mark of its kind inside belongs to another quotation: the line holds quotations, not one pair.
  if ([...opening, ...closing].some((mark) => words.includes(mark))) return line;
  return `${line.slice(0, from)}${words}${line.slice(to)}`;
}

/** An option's line read: a pair inside its pair would come off at the next reading too, so it stays. */
function optionRead(line: string): string {
  const once = withoutOwnPair(line);
  return withoutOwnPair(once) === once ? once : line;
}

export interface HelpReplyRead {
  /** The reply's Markdown as read: what the core keeps once it ends. */
  text: string;
  /** The line the panel puts first. */
  lead: ReplyItem[];
  /** The options, readings or short lines the panel shows. */
  options: ReplyItem[];
}

/**
 * A reply as its panel shows it and its check reads it, in its button's `layout`: each option to
 * say that the panel shows is read without a pair of quotation marks the model wrapped it in whole.
 * No marker is added or taken off, so each keeps its place. Reading the text read gives it again.
 */
export function helpReplyRead(markdown: string, layout: HelpLayout): HelpReplyRead {
  const lines = markdown.split("\n");
  const written = itemsOf(lines);
  const items = written.map(({ item }) => item);
  const said = laidOut(items, layout).options.filter((item) => saysAloud(item, layout.shape));
  const text = lines
    .map((line, index) =>
      written.some((each) => each.line === index && said.includes(each.item))
        ? optionRead(line)
        : line,
    )
    .join("\n");
  return { text, ...shown(readHelpReply(text), layout) };
}
