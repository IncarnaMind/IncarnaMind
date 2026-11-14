/**
 * A help reply as the panel that showed it being written draws it once it has ended (#3098): each
 * line as the User read it, so nothing above the reply's foot moves. A Citation the end added (for
 * words quoted with no number, or by the one request for the reply's Citations) takes a quote line
 * its line kept, where one is free; else its quote goes to the reply's foot, under its last line,
 * and its number to the end of its line, in room every line keeps there. A quote line kept for a
 * number the end gave no Citation stays, saying the quote wasn't found. A reply drawn anew (opened
 * again, in the assistant, after a restart) is drawn as everywhere, each quote under its own line:
 * nothing of this is stored.
 */
import type { AnswerStatus } from "../../core/api";
import {
  markersOf,
  momentOf,
  type QuotedCitation,
  type QuoteLine,
  quoteLines,
} from "../../shared/helpQuotes";
import type { ReplyItem, ReplyPiece } from "../../shared/helpReplyRead";
import { citationNumbers, quoted } from "./helpReply";

/** A reply as one draw of the panel reads it. */
export interface DrawnReply {
  items: readonly ReplyItem[];
  citationOf(marker: number): QuotedCitation | undefined;
  /** Whether a marker shows a number. */
  numbered(marker: number): boolean;
  status: AnswerStatus;
}

/** Where a line sits in its item: its lead, one of its notes, or its effect. */
export type LinePlace = "lead" | number | "effect";

/** Each line of an item, in order, as the panel draws it. */
export const itemLines = (
  item: ReplyItem,
): { place: LinePlace; pieces: readonly ReplyPiece[]; note: boolean }[] => [
  { place: "lead", pieces: item.said ? quoted(item.lead) : item.lead, note: false },
  ...item.notes.map((pieces, index) => ({ place: index, pieces, note: true })),
  ...(item.effect ? [{ place: "effect" as const, pieces: item.effect, note: false }] : []),
];

export const lineKey = (item: number, place: LinePlace) => `${item}:${place}`;

/** A line drawn as it was written, once its reply has ended. */
export interface EndedLine {
  /** The line as it was written. */
  pieces: readonly ReplyPiece[];
  /** The Citation each number it showed stands for now. */
  shown: ReadonlyMap<number, number>;
  /** Numbers it showed that stand for no Citation now, each kept as room: by marker, the number. */
  gone: ReadonlyMap<number, number>;
  /** The Citations the end added to the line, their numbers drawn at its end. */
  late: number[];
  /**
   * The rows it kept while it was written, each with its quote line, or null where its numbers
   * ended with no Citation: that row reads "Quote not found".
   */
  rows: (QuoteLine | null)[];
}

export interface EndedReply {
  lines: ReadonlyMap<string, EndedLine>;
  /** The end's quote lines that found no row kept for them, in the order of their lines. */
  foot: QuoteLine[];
  /** Each Citation's number: those the User saw first, in their order, then the end's. */
  numbers: Map<number, number>;
}

/** How far apart, in characters of its words, a number may move and still be the same number. */
const SAME_PLACE = 2;

/** Each marker a line carries, once, with where it stands in the line's words. */
function markersAt(pieces: readonly ReplyPiece[]): { marker: number; at: number }[] {
  const found: { marker: number; at: number }[] = [];
  let at = 0;
  for (const piece of pieces) {
    if (piece.kind === "text") at += piece.text.length;
    else if (piece.kind === "citation" && !found.some((each) => each.marker === piece.marker)) {
      found.push({ marker: piece.marker, at });
    }
  }
  return found;
}

const wordsOf = (pieces: readonly ReplyPiece[]) =>
  pieces
    .flatMap((piece) => (piece.kind === "text" ? [piece.text] : []))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * The line as written, once the reply ended. Each number it showed keeps its place: it stands for
 * the same Citation, or for the one the end put at the same place in its stead (a number the model
 * wrote that the end gave a Citation of its own), or for none.
 */
function endedLine(
  writtenPieces: readonly ReplyPiece[],
  endedPieces: readonly ReplyPiece[],
  written: DrawnReply & { numbers: ReadonlyMap<number, number> },
  ended: DrawnReply,
): { line: EndedLine; foot: QuoteLine[] } {
  const before = markersAt(writtenPieces).filter(({ marker }) => written.numbers.has(marker));
  const after = markersAt(endedPieces).filter(({ marker }) => ended.numbered(marker));
  const shown = new Map<number, number>();
  const gone = new Map<number, number>();
  const taken = new Set<number>();
  for (const { marker } of before) {
    if (!after.some((each) => each.marker === marker)) continue;
    shown.set(marker, marker);
    taken.add(marker);
  }
  for (const { marker, at } of before) {
    if (shown.has(marker)) continue;
    const instead = after.find(
      (each) =>
        !taken.has(each.marker) &&
        !before.some((was) => was.marker === each.marker) &&
        Math.abs(each.at - at) <= SAME_PLACE,
    );
    if (instead) {
      shown.set(marker, instead.marker);
      taken.add(instead.marker);
    } else {
      gone.set(marker, written.numbers.get(marker) ?? 0);
    }
  }
  const late = after.flatMap(({ marker }) => (taken.has(marker) ? [] : [marker]));
  const lines = (markers: readonly number[]) =>
    quoteLines(markers, ended.citationOf, ended.status, ended.numbered);
  // Each row kept while written draws its own numbers' quotes, so two quotes the end first finds
  // one inside the other keep their rows; a row whose numbers all stand for no Citation is free.
  const foot: QuoteLine[] = [];
  const rows = quoteLines(
    before.map(({ marker }) => marker),
    written.citationOf,
    written.status,
    (marker) => written.numbers.has(marker),
  ).map((row): QuoteLine | null => {
    const markers = [...row.markers, ...row.more].flatMap((marker) => shown.get(marker) ?? []);
    const [first, ...more] = lines(markers);
    foot.push(...more);
    return first ?? null;
  });
  // The end's own quotes take the free rows, in order, then go to the foot: none joins a row
  // drawn, whose words may fill it. A free row left reads "Quote not found".
  const added = lines(late);
  const filled = rows.map((row) => row ?? added.shift() ?? null);
  return {
    line: { pieces: writtenPieces, shown, gone, late, rows: filled },
    foot: [...foot, ...added],
  };
}

/**
 * The reply `ended` as the panel that drew it as `written` draws it: each line whose words are as
 * written keeps its rows. A reading's moment, or the line a reading was still writing, is drawn as
 * everywhere, as is any line the end wrote anew.
 */
export function replyAtEnd(
  written: DrawnReply,
  ended: DrawnReply,
  { reading, open }: { reading: boolean; open: string | null },
): EndedReply {
  const lines = new Map<string, EndedLine>();
  const foot: QuoteLine[] = [];
  const order: { key: string; drawn: readonly number[] }[] = [];
  const shownWritten = { ...written, numbers: citationNumbers(written.items, written.numbered) };
  ended.items.forEach((item, index) => {
    const before = written.items[index];
    const writtenLines = before ? itemLines(before) : [];
    for (const { place, pieces, note } of itemLines(item)) {
      const key = lineKey(index, place);
      const was = writtenLines.find((each) => each.place === place);
      const readingLine = reading && (note || (place === "lead" && !item.said));
      const moment =
        readingLine && (open === key || (was !== undefined && momentOf(was.pieces) !== null));
      if (!was || moment || wordsOf(was.pieces) !== wordsOf(pieces)) {
        order.push({ key, drawn: markersOf([pieces]) });
        continue;
      }
      const ends = endedLine(was.pieces, pieces, shownWritten, ended);
      lines.set(key, ends.line);
      foot.push(...ends.foot);
      order.push({ key, drawn: [...ends.line.shown.values()] });
    }
  });
  const numbers = new Map<number, number>();
  const number = (marker: number) => {
    if (!numbers.has(marker) && ended.numbered(marker)) numbers.set(marker, numbers.size + 1);
  };
  for (const { drawn } of order) drawn.forEach(number);
  for (const { key } of order) lines.get(key)?.late.forEach(number);
  return { lines, foot, numbers };
}
