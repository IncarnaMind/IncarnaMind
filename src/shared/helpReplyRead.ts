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
  type CallHelpKind,
  EFFECT_MARK,
  HELP_SHAPE,
  type HelpShape,
  LINE_MARK,
  plainLine,
  RECOMMENDED_MARK,
} from "./meetingHelp";

/**
 * A run of text, in bold where the model marked it ("**…**"), a Citation's marker ("[^2]") or a
 * calculated figure's ("[=1]"). A Citation's `at` is its marker's place among the reply's Citation
 * markers, from 0, as the core counts them.
 */
export type ReplyPiece =
  | { kind: "text"; text: string; bold?: true }
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

/** How a reply is laid out: its shape, a line put first, and whether it is still written. */
export interface HelpLayout {
  shape: HelpShape;
  leadIn: boolean;
  streaming: boolean;
}

/**
 * How a button's reply, or a typed question's, is laid out: "Am I leading them?" puts its answer
 * first, and a reply asked while the live text was behind puts that line first. One stopped while
 * it was written is read as it was then: what came before its first option is still a model's
 * notes (#2526).
 */
export const helpLayout = (
  kind: CallHelpKind,
  { status, textBehind }: { status: AnswerStatus; textBehind: boolean },
): HelpLayout => ({
  shape: HELP_SHAPE[kind],
  leadIn: kind === "leading" || textBehind,
  streaming: status === "streaming" || status === "stopped",
});

const DEFINITION = /^\[\^\d{1,4}\]:/;
const MARKERS = new RegExp(`${MARKER.source}|${FIGURE_MARKER.source}`, "g");
const BOLD_MARK = /\*\*|__/g;
const OPENING_BOLD = /^(?:\*\*|__)+/;

/**
 * The pieces of `text`, whose first Citation marker is the reply's `first`. A bold run may hold a
 * Citation; a bold mark left open, as while it streams, is shown as nothing and bolds nothing.
 */
export function pieces(text: string, first: number): ReplyPiece[] {
  const found: ReplyPiece[] = [];
  const marks = text.match(BOLD_MARK)?.length ?? 0;
  const paired = marks - (marks % 2);
  let seen = 0;
  let bold = false;
  const addText = (run: string) => {
    let at = 0;
    for (const mark of run.matchAll(BOLD_MARK)) {
      const part = run.slice(at, mark.index);
      if (part) found.push({ kind: "text", text: part, ...(bold && { bold: true }) });
      if (++seen <= paired) bold = !bold;
      at = mark.index + mark[0].length;
    }
    const rest = run.slice(at);
    if (rest) found.push({ kind: "text", text: rest, ...(bold && { bold: true }) });
  };
  let from = 0;
  let cited = first;
  for (const match of text.matchAll(MARKERS)) {
    addText(text.slice(from, match.index));
    found.push(
      match[1] !== undefined
        ? { kind: "citation", marker: Number(match[1]), at: cited++ }
        : { kind: "figure", marker: Number(match[2]) },
    );
    from = match.index + match[0].length;
  }
  addText(text.slice(from));
  return found;
}

/** `line` without the `mark` it starts with, keeping a bold mark opened before it ("**→** …"). */
function withoutMark(line: string, mark: RegExp): string {
  const opened = OPENING_BOLD.exec(line)?.[0] ?? "";
  return opened + line.slice(opened.length).replace(mark, "");
}

/**
 * A line's star and list mark, in either order ("- ★ …"), and its words after them, a bold mark
 * opened before them kept ("**★ …**").
 */
function marksOf(line: string): { recommended: boolean; bullet: boolean; text: string } {
  let recommended = false;
  let bullet = false;
  let opened = "";
  let text = line;
  for (;;) {
    const bold = OPENING_BOLD.exec(text)?.[0];
    if (bold) {
      opened += bold;
      text = text.slice(bold.length);
    } else if (RECOMMENDED_MARK.test(text)) {
      recommended = true;
      text = text.replace(RECOMMENDED_MARK, "");
    } else if (LINE_MARK.test(text)) {
      bullet = true;
      text = text.replace(LINE_MARK, "");
    } else {
      return { recommended, bullet, text: opened + text };
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
    // Its marks are read without bold; its text keeps the bold, for the panel to show.
    const line = plainLine(raw);
    const shown = raw.trim();
    if (line === "" || DEFINITION.test(line) || /^#+\s/.test(line)) continue;
    const current = found.at(-1)?.item;
    if (EFFECT_MARK.test(line)) {
      const effect = pieces(withoutMark(shown, EFFECT_MARK), first);
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
    const { recommended, bullet, text } = marksOf(shown);
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

/**
 * The line the panel puts first and the options, readings or short lines it shows, with every
 * option to say (`said`): one in a reply of options with its "→" line, whether or not there is room
 * to show it. A lead-in, a remark and a model's notes are none.
 */
function laidOut(
  items: readonly ReplyItem[],
  { shape, leadIn, streaming }: HelpLayout,
): { lead: ReplyItem[]; options: ReplyItem[]; said: ReplyItem[] } {
  const [first] = items;
  if (shape === "answer") {
    // A typed question's reply is options, laid out as a button's, or what answers it, all of it:
    // a sentence or two, or as many short lines as it asked for.
    if (items.some((item) => item.recommended || item.effect !== null)) {
      return laidOut(items, { shape: "options", leadIn, streaming });
    }
    return { lead: [], options: items.flatMap(apart), said: [] };
  }
  if (shape === "lines") {
    const bullets = items.filter((item) => item.bullet);
    const lead = leadIn && first && !first.bullet ? [first] : [];
    // While it is written, text before the first short line is a model's notes, taken back once it
    // records its Citations (#2526): the outline stays in its place instead.
    const rest = bullets.length > 0 ? bullets : streaming ? [] : items.slice(lead.length);
    return { lead, options: rest.slice(0, 3 - lead.length), said: [] };
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
  const after = items.slice(from).filter((item) => !lead.includes(item));
  const options = after.filter((item) => item.effect !== null || item === last).slice(0, 2);
  const said = shape === "options" ? after.filter((item) => item.effect !== null) : [];
  return { lead, options, said };
}

/** An item and the lines the reader took as its notes, each its own: sentences of an answer. */
const apart = (item: ReplyItem): ReplyItem[] => [
  { ...item, notes: [] },
  ...item.notes.map((note) => ({ ...item, recommended: false, lead: note, notes: [] })),
];

/** What the panel shows of `items`: the line put first, then the options, readings or short lines. */
function shown(items: readonly ReplyItem[], layout: HelpLayout) {
  const { lead, options, said } = laidOut(items, layout);
  return { lead, options: options.map((item) => ({ ...item, said: said.includes(item) })) };
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
 * say, shown or not, is read without a pair of quotation marks the model wrapped it in whole.
 * No marker is added or taken off, so each keeps its place. Reading the text read gives it again.
 */
export function helpReplyRead(markdown: string, layout: HelpLayout): HelpReplyRead {
  const lines = markdown.split("\n");
  const written = itemsOf(lines);
  const items = written.map(({ item }) => item);
  const { said } = laidOut(items, layout);
  const text = lines
    .map((line, index) =>
      written.some((each) => each.line === index && said.includes(each.item))
        ? optionRead(line)
        : line,
    )
    .join("\n");
  return { text, ...shown(readHelpReply(text), layout) };
}
