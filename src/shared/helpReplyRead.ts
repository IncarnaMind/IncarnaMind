/**
 * A call-help reply, read line by line as its panel lays it out (the shape
 * src/core/answers/meetingHelp.ts asks for): options or readings, the recommended first after "★",
 * each followed by "→" and what it leads to; or up to three short lines. It reads a part still
 * streaming.
 *
 * It is also what an option is, for every reader (#2925): the panel shows an option to say in
 * quotation marks of its own, so a pair the model wrapped the whole option in comes off, and the
 * core keeps the reply as read here once it ends. Its check, the assistant, Check again, a pinned
 * reply and the note it is added to then all read the words the panel shows. A Citation marker on an
 * option's or a reading's "→" line, or on a reading's first line, comes off too (#2847): those lines
 * are the reply's own, so no Document's words can back them. Nothing else comes off: such a line
 * that puts words in quotation marks the quote check reads (./quotedSpans), a reading's first line
 * that is only its quoted moment, a reading's moment of the call and a short-lines reply, a "→" line
 * in it included, are read as written, in their quotation marks.
 */
import type { AnswerStatus } from "../core/api";
import { MARKER, withoutMarkerRuns } from "./answerSentences";
import { FIGURE_MARKER } from "./figureMarkers";
import { type FactLineRole, factLinesText } from "./helpFactLines";
import {
  type CallHelpForm,
  EFFECT_MARK,
  HELP_SHAPE,
  type HelpShape,
  helpFormOf,
  LINE_MARK,
  type MeetingHelpKind,
  plainLine,
  RECOMMENDED_MARK,
} from "./meetingHelp";
import { holdsQuote } from "./quotedSpans";

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
  /** Lines between it and its "→": a reading's moment of the transcript, or an option's facts. */
  notes: ReplyPiece[][];
  /** Lines between it and its "→" that are the reply's own, where its facts stand apart (#2847). */
  own: ReplyPiece[][];
  /** What it leads to; null before its "→" line. */
  effect: ReplyPiece[] | null;
  /** Its fact and own lines written after its "→" line, where its facts stand apart (#2847). */
  after: ReplyPiece[][];
}

/**
 * What a line of a reply is: an option's line to say, a reading's first line, a short line, a fact
 * an option or reading rests on, the reply's own line, a "→" line, the line put first, or none of
 * these (a blank line, a heading, a remark or a model's notes).
 */
export type HelpLineKind =
  | "say"
  | "reading"
  | "short"
  | "fact"
  | "own"
  | "effect"
  | "lead-in"
  | "other";

/**
 * How a reply is laid out: its button's shape, a line put first, whether it is still written, and
 * the form it was asked in when that isn't today's.
 */
export interface HelpLayout {
  shape: HelpShape;
  leadIn: boolean;
  streaming: boolean;
  /** Whether the reply has ended, stopped included; unset, once it is no longer `streaming`. */
  ended?: boolean;
  form?: CallHelpForm;
  /**
   * In the form whose facts stand apart, a recorded Document Citation's quote by marker, so one
   * left on a line to say or a "→" line shows as a fact line of its own (#2847).
   */
  quoteOf?: (marker: number) => string | null;
}

/**
 * How a button's reply is laid out: "Am I leading them?" puts its answer first, and a reply asked
 * while the live text was behind puts that line first. One stopped while it was written is read as it was
 * then: what came before its first option is still a model's notes (#2526).
 */
export const helpLayout = (
  kind: MeetingHelpKind,
  { status, textBehind, form }: { status: AnswerStatus; textBehind: boolean; form?: CallHelpForm },
): HelpLayout => {
  const read = helpFormOf(kind, form);
  return {
    shape: HELP_SHAPE[kind],
    leadIn: kind === "leading" || textBehind,
    streaming: status === "streaming" || status === "stopped",
    ended: status !== "streaming",
    ...(read && { form: read }),
  };
};

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

/**
 * An item and the lines it is on: its lead's (none for a "→" line alone), its notes', its own lines',
 * its "→" line's and the lines after it.
 */
interface Placed {
  item: ReplyItem;
  line: number | null;
  notes: number[];
  own: number[];
  effect: number | null;
  after: number[];
}

const itemOf = (
  lead: ReplyPiece[],
  { recommended, bullet }: { recommended: boolean; bullet: boolean },
  effect: ReplyPiece[] | null = null,
): ReplyItem => ({ recommended, bullet, said: false, lead, notes: [], own: [], effect, after: [] });
const UNMARKED = { recommended: false, bullet: false };

const placedOf = (item: ReplyItem, line: number | null, effect: number | null = null): Placed => ({
  item,
  line,
  notes: [],
  own: [],
  effect,
  after: [],
});

const cites = (line: readonly ReplyPiece[]) => line.some((piece) => piece.kind === "citation");

/**
 * Each reply's item and the lines it is on. `firstOf` gives the place of a line's first marker among
 * the reply's markers as it was written, where a line read may hold fewer; unset, as `lines` hold
 * them. With `ownApart`, a line between an item and its "→" that cites nothing is the reply's own.
 */
function itemsOf(
  lines: readonly string[],
  firstOf?: (index: number) => number,
  ownApart = false,
): Placed[] {
  const found: Placed[] = [];
  let cited = 0;
  for (const [index, raw] of lines.entries()) {
    const first = firstOf?.(index) ?? cited;
    cited += raw.match(MARKER)?.length ?? 0;
    const line = plainLine(raw);
    if (line === "" || DEFINITION.test(line) || /^#+\s/.test(line)) continue;
    const current = found.at(-1);
    if (EFFECT_MARK.test(line)) {
      const effect = pieces(line.replace(EFFECT_MARK, ""), first);
      if (current && current.item.effect === null) {
        current.item.effect = effect;
        current.effect = index;
      } else {
        found.push(placedOf(itemOf([], UNMARKED, effect), null, index));
      }
      continue;
    }
    const { recommended, bullet, text } = marksOf(line);
    const open = current && current.item.effect === null && current.item.lead.length > 0;
    if (!recommended && !bullet && current && open) {
      const note = pieces(text, first);
      const own = ownApart && !cites(note);
      (own ? current.item.own : current.item.notes).push(note);
      (own ? current.own : current.notes).push(index);
      continue;
    }
    found.push(placedOf(itemOf(pieces(text, first), { recommended, bullet }), index));
  }
  return oneStar(found);
}

/** One recommendation: a second star a model adds is dropped. */
function oneStar(found: Placed[]): Placed[] {
  const star = found.find(({ item }) => item.recommended)?.item;
  for (const { item } of found) if (item !== star) item.recommended = false;
  return found;
}

/**
 * An options reply's items in the form whose facts stand apart, from what each line read is
 * (`roles`, ./helpFactLines): the fact lines before its first option and its closing line belong to
 * no item. `firstOf` gives the place of a line's first marker, as for `itemsOf`.
 */
function itemsOfRoles(
  lines: readonly string[],
  roles: readonly FactLineRole[],
  firstOf: (index: number) => number,
): { placed: Placed[]; opening: number[]; closing: number[] } {
  const placed: Placed[] = [];
  const opening: number[] = [];
  const closing: number[] = [];
  for (const [index, raw] of lines.entries()) {
    const role = roles[index] ?? "other";
    const text = plainLine(raw);
    const current = placed.at(-1);
    if (role === "other") continue;
    if (role === "opening") opening.push(index);
    else if (role === "closing") closing.push(index);
    else if (role === "say" || role === "lead-in") {
      const { recommended, bullet, text: words } = marksOf(text);
      placed.push(placedOf(itemOf(pieces(words, firstOf(index)), { recommended, bullet }), index));
    } else if (role === "effect") {
      const effect = pieces(text.replace(EFFECT_MARK, ""), firstOf(index));
      if (current && current.item.effect === null && current.item.lead.length > 0) {
        current.item.effect = effect;
        current.effect = index;
      } else {
        placed.push(placedOf(itemOf([], UNMARKED, effect), null, index));
      }
    } else if (current) {
      const line = pieces(text, firstOf(index));
      if (role === "after") {
        current.item.after.push(line);
        current.after.push(index);
      } else {
        const own = !cites(line);
        (own ? current.item.own : current.item.notes).push(line);
        (own ? current.own : current.notes).push(index);
      }
    }
  }
  return { placed: oneStar(placed), opening, closing };
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

/**
 * What the panel shows of `items`: the line put first, then the options, readings or short lines.
 * Where an option's facts stand apart, it shows every fact line it has (#2847): the model writes at
 * most two, and a Document's Citation on its line to say adds one, never hidden.
 */
function shown(items: readonly ReplyItem[], layout: HelpLayout) {
  const { lead, options, said } = laidOut(items, layout);
  return {
    lead,
    options: options.map((item) => ({ ...item, said: said.includes(item) })),
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
  /** What each line of `text` is. */
  kinds: HelpLineKind[];
  /** The line the panel puts first. */
  lead: ReplyItem[];
  /** The options, readings or short lines the panel shows. */
  options: ReplyItem[];
  /** Fact lines written before the first option, which belong to no option (#2847). */
  opening: ReplyPiece[][];
  /** The reply's own lines after its last option, its closing line (#2847). */
  closing: ReplyPiece[][];
}

/** A reading's line that is only its moment of the call: its time, its quotation and its markers. */
function onlyMoment(line: string): boolean {
  const rest = plainLine(line)
    .replace(RECOMMENDED_MARK, "")
    .replace(LINE_MARK, "")
    .replace(MARKER, "")
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "")
    .trim();
  return PAIRS.some(
    ([open = "", close = ""]) =>
      rest.length > 2 &&
      rest.startsWith(open) &&
      rest.endsWith(close) &&
      !rest.slice(1, -1).includes(close),
  );
}

/**
 * A reading's first line, which is the reply's own reading of what they said, unless the reading is
 * only its moment: a line that is nothing but its quoted moment, and no moment of its own below it.
 */
const readingItself = (item: ReplyItem, line: string) => item.notes.length > 0 || !onlyMoment(line);

/** What each of `count` lines is, from the items read off them. */
function kindsOf(
  count: number,
  placed: readonly Placed[],
  layout: HelpLayout,
  { lead, options, said }: ReturnType<typeof laidOut>,
): HelpLineKind[] {
  const kinds: HelpLineKind[] = Array.from({ length: count }, () => "other");
  for (const { item, line, notes, own, effect, after } of placed) {
    for (const at of notes) kinds[at] = "fact";
    for (const at of own) kinds[at] = "own";
    for (const [index, at] of after.entries()) {
      kinds[at] = cites(item.after[index] ?? []) ? "fact" : "own";
    }
    if (effect !== null) kinds[effect] = "effect";
    if (line === null) continue;
    if (lead.includes(item)) kinds[line] = "lead-in";
    else if (layout.shape === "options" && (options.includes(item) || said.includes(item)))
      kinds[line] = "say";
    else if (layout.shape === "readings" && options.includes(item)) kinds[line] = "reading";
    else if (layout.shape === "lines" && options.includes(item))
      kinds[line] = layout.form !== "fact lines" ? "short" : cites(item.lead) ? "fact" : "own";
  }
  return kinds;
}

/**
 * A reply as its panel shows it and its check reads it, in its button's `layout`: each option to
 * say, shown or not, is read without a pair of quotation marks the model wrapped it in whole, and an
 * option's or a reading's "→" line and a reading's first line without their Citation markers. In the
 * form whose facts stand apart, the marks of its lines come off too, and so do the markers on a line
 * to say and an own line (helpFactLines.ts). Every other marker is kept, and the items give each the
 * place it has as `markdown` was written, which is where a reply kept before this was read had its
 * check's verdicts. Reading the text read gives it again.
 */
export function helpReplyRead(markdown: string, layout: HelpLayout): HelpReplyRead {
  const lines = markdown.split("\n");
  const written = itemsOf(lines);
  const { said } = laidOut(
    written.map(({ item }) => item),
    layout,
  );
  const { shape } = layout;
  const read =
    layout.form === "fact lines" && shape !== "readings"
      ? factLinesText(
          lines,
          { ...layout, shape, ended: layout.ended ?? !layout.streaming },
          optionRead,
        )
      : {
          lines: lines.map((line, index) => {
            const lead = written.find((each) => each.line === index)?.item;
            // A short-lines reply is asked for no "→" line, so what a model writes on one is read as
            // written; so is a line that quotes, whose quote the quote check reads only beside its marker.
            const own =
              layout.form !== "as before" &&
              !holdsQuote(line) &&
              ((shape !== "lines" && EFFECT_MARK.test(plainLine(line))) ||
                (shape === "readings" && lead !== undefined && readingItself(lead, line)));
            const words = lead && said.includes(lead) ? optionRead(line) : line;
            return own ? withoutMarkerRuns(words) : words;
          }),
          origin: lines.map((_, index) => index),
          roles: [],
          offset: lines.map(() => 0),
        };
  const firstPlaces: number[] = [];
  let seen = 0;
  for (const line of lines) {
    firstPlaces.push(seen);
    seen += line.match(MARKER)?.length ?? 0;
  }
  const firstOf = (index: number) =>
    (firstPlaces[read.origin[index] ?? 0] ?? 0) + (read.offset[index] ?? 0);
  const { placed, opening, closing } =
    read.roles.length > 0
      ? itemsOfRoles(read.lines, read.roles, firstOf)
      : {
          placed: itemsOf(read.lines, firstOf, layout.form === "fact lines"),
          opening: [],
          closing: [],
        };
  const items = placed.map(({ item }) => item);
  const kinds = kindsOf(read.lines.length, placed, layout, laidOut(items, layout));
  const piecesAt = (index: number) => pieces(plainLine(read.lines[index] ?? ""), firstOf(index));
  for (const at of opening) kinds[at] = cites(piecesAt(at)) ? "fact" : "own";
  for (const at of closing) kinds[at] = "own";
  return {
    text: read.lines.join("\n"),
    kinds,
    ...shown(items, layout),
    opening: opening.map(piecesAt),
    closing: closing.map(piecesAt),
  };
}
