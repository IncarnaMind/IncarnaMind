/**
 * Call help's quote lines (#2847) replayed with no model, on saved presses: each reply read as the
 * panel reads it and drawn as the panel draws it (`src/shared/helpQuotes.ts`), from its text and its
 * Citations' records. `quoteLinesReplay.speed.ts` runs it and prints counts only; with a readers'
 * file named it also writes a hundred drawn lines for blind readers, with nothing in them that
 * tells which shape or rule made a line, and their key beside them (`<file>.key.json`).
 *
 * Each input file is a JSON list of presses (`SavedPress`). A record that holds its Passage's text
 * also has its quote looked for in it here, and a count says where that and the record differ. A
 * Transcript's place is given by its start alone, so "said within the other's time" reads as
 * "starting no earlier, in the same Passage". A plain moment's words count as found when they are
 * inside its Citation's quote or, where the record holds it, its Passage's text, the second counted
 * apart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { quoteCells } from "../../src/core/answers/quoteCells";
import {
  CITATION_CHECK_REASONS,
  type CitationCheck,
  type CitationCheckReason,
} from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { citationNumbers, helpParts, quoted } from "../../src/renderer/src/helpReply";
import { badgeMessage } from "../../src/shared/citations";
import { clockTime } from "../../src/shared/clock";
import {
  cellsText,
  comparedWords,
  type Moment,
  markersOf,
  momentOf,
  momentWords,
  type QuotedCitation,
  type QuoteLine,
  quoteLines,
} from "../../src/shared/helpQuotes";
import type { ReplyPiece } from "../../src/shared/helpReplyRead";
import { translate } from "../../src/shared/i18n";
import { HELP_SHAPE, isMeetingHelpKind, type MeetingHelpKind } from "../../src/shared/meetingHelp";

/** A Citation as a saved press records it. */
export interface SavedCitation {
  marker: number;
  quote: string;
  check: CitationCheck;
  checkReason?: CitationCheckReason;
  /** The name the sources row shows. */
  document?: string;
  /** Who made it: the cite call, the request, or the app for words quoted with no number. */
  from?: "model" | "request" | "app-unmarked";
  passage?: string;
  /** Its place as shown: for a Transcript, the start of the moment cited ("0:10"). */
  location?: string;
  passageText?: string;
  /** A record that holds less: whether its quote was found, and its sources row's name. */
  found?: boolean;
  place?: string;
}

export type PressOrder = "number-first" | "cite-first" | "no-cite";

export interface SavedPress {
  id: string;
  set: string;
  model?: string;
  language: Language;
  button: MeetingHelpKind;
  /** The reply's own text, its numbers as "[^n]", with no footnote lines. */
  text: string;
  /** Null for a record that tests the reader of shapes only. */
  citations: SavedCitation[] | null;
  /** Numbers the reply wrote with no Citation behind them. */
  unrecorded?: number[];
  order?: PressOrder | null;
}

/** A reading's moment line by the kind the panel draws it as; `plain` where nothing says which. */
export type MomentKind =
  | "plain-found"
  | "plain-replaced"
  | "plain"
  | "several"
  | "two-moments"
  | "general";

/** A quote line under a line of the reply, by what it shows. */
export type RowKind =
  | "word-for-word"
  | "cut-at-a-clause"
  | "cells-named"
  | "cells-as-quoted"
  | "not-found"
  | "cant-check";

export interface DrawnLine {
  press: SavedPress;
  shape: "options" | "lead-ins" | "readings" | "lines";
  /** The model's line as the panel shows it; null where a moment line takes its place. */
  written: string | null;
  /** What the panel draws under the line, or in its place, each as shown. */
  rows: string[];
  moment: MomentKind | null;
}

export interface ReplayCounts {
  presses: Record<string, number>;
  /** Lines that carry a number, or are a reading's moment, by shape. */
  lines: Record<string, number>;
  /** Of them, lines none of whose numbers has a Citation behind it: no quote line, no source. */
  linesWithNoCitation: number;
  rows: Record<RowKind, number>;
  moments: Record<MomentKind, number>;
  /** A time or a quotation with no number on a reading's line: press id and line. */
  unplaced: { id: string; line: number }[];
  /** Plain moments whose words are in the Passage's text but not inside the Citation's quote. */
  plainFoundOutsideQuote: number;
  /** Moment lines the app draws from a Citation whose record has no time: drawn without one. */
  momentsWithNoTime: number;
  /** Where a bar doesn't hold, counted: each must be 0. */
  checkBesideUnfoundWords: number;
  quoteNotAsGiven: number;
  plainWordsChangedWithCheck: number;
  /** Lines whose words show twice, in the model's line and in a quote line, by kind of line. */
  sameWordsTwice: Record<string, number>;
  /** Lines where a join frees a room no other quote takes, by the press's order. */
  joinClosesRoom: Record<string, number>;
  unrecordedNumbers: number;
  /** Records whose quote the Passage text here holds or not otherwise than the record says. */
  quoteCheckDiffers: number;
}

export const emptyCounts = (): ReplayCounts => ({
  presses: {},
  lines: {},
  linesWithNoCitation: 0,
  rows: {
    "word-for-word": 0,
    "cut-at-a-clause": 0,
    "cells-named": 0,
    "cells-as-quoted": 0,
    "not-found": 0,
    "cant-check": 0,
  },
  moments: {
    "plain-found": 0,
    "plain-replaced": 0,
    plain: 0,
    several: 0,
    "two-moments": 0,
    general: 0,
  },
  unplaced: [],
  plainFoundOutsideQuote: 0,
  momentsWithNoTime: 0,
  checkBesideUnfoundWords: 0,
  quoteNotAsGiven: 0,
  plainWordsChangedWithCheck: 0,
  sameWordsTwice: {},
  joinClosesRoom: {},
  unrecordedNumbers: 0,
  quoteCheckDiffers: 0,
});

const add = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** A Transcript's start as shown ("1:02:03", "0:10"), in milliseconds; null for another place. */
function startOf(location: string | undefined): number | null {
  const parts = TIME.exec(location?.trim() ?? "");
  if (!parts) return null;
  const [, first = "0", second = "0", third] = parts;
  const seconds =
    third === undefined
      ? Number(first) * 60 + Number(second)
      : Number(first) * 3600 + Number(second) * 60 + Number(third);
  return seconds * 1000;
}

const quoteFound = (citation: SavedCitation): boolean =>
  citation.found ?? (citation.check !== "not-found" && citation.check !== "cant-check");

/** A record as the quote lines read it; a record of fewer fields is found or not by `found`. */
function quotedOf(citation: SavedCitation): QuotedCitation {
  const start = startOf(citation.location);
  const short = citation.found !== undefined;
  // The record holds its Passage's text alone, so only a table written in it is read for cells.
  const cells =
    citation.passageText === undefined
      ? null
      : quoteCells(citation.quote, [
          { page: 1, kind: "section", text: citation.passageText, label: null },
        ]);
  return {
    marker: citation.marker,
    documentId: citation.document ?? citation.place ?? "",
    // A Citation the app made for words quoted with no number has no Passage: it joins nothing.
    passageId: citation.passage ?? `unmarked-${citation.marker}`,
    location: start === null ? null : { kind: "time", from: start, to: Number.MAX_SAFE_INTEGER },
    quote: citation.quote,
    check: short ? (citation.found ? "found" : "not-found") : citation.check,
    checkReason: short ? null : (citation.checkReason ?? null),
    ...(cells && { cells }),
  };
}

const inside = (part: string, whole: string) =>
  comparedWords(part).length > 0 && comparedWords(whole).includes(comparedWords(part));

/** A line of the reply as the panel shows it: its numbers in place of its markers. */
function written(pieces: readonly ReplyPiece[], numbers: ReadonlyMap<number, number>): string {
  return pieces
    .map((piece) =>
      piece.kind === "text"
        ? piece.text
        : piece.kind === "citation"
          ? ` ${numbers.get(piece.marker) ?? ""}`
          : "",
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const textOf = (pieces: readonly ReplyPiece[]) =>
  pieces.map((piece) => (piece.kind === "text" ? piece.text : "")).join("");

const MOMENT_START = /^\s*(?:\d{1,2}:\d{2}|[“"「『«])/u;
const OPENING = /[“"「『«]/gu;
const A_TIME = /\d{1,2}:\d{2}/g;
/** Words a line puts in quotation marks. */
const QUOTED = /[“"「『«]([^”"」』»]+)[”"」』»]/gu;

/** A reading's note line by what it holds: a moment of one kind, or null for another line. */
function momentKind(
  pieces: readonly ReplyPiece[],
): Moment | "two-moments" | "general" | "unplaced" | null {
  const text = textOf(pieces);
  if (!MOMENT_START.test(text)) return null;
  const moment = momentOf(pieces);
  if (moment) return moment;
  if (markersOf([pieces]).length === 0) return "unplaced";
  const quotations = text.match(OPENING)?.length ?? 0;
  const times = text.match(A_TIME)?.length ?? 0;
  return quotations >= 2 && (times >= 2 || /[/;；]/u.test(text)) ? "two-moments" : "general";
}

const rowKind = (line: QuoteLine): RowKind =>
  line.state === "not-found"
    ? "not-found"
    : line.state === "cant-check"
      ? "cant-check"
      : line.cells
        ? line.cells.some((cell) => cell.name !== null)
          ? "cells-named"
          : "cells-as-quoted"
        : line.cut
          ? "cut-at-a-clause"
          : "word-for-word";

/** A Document's line marks, which a quote line leaves out (`fittedQuote`). */
const LINE_MARKS = /^(?:[-*+•]\s+|\d{1,3}[.)]\s+|#{1,6}\s+|>\s*)+/u;

/** Every line of one press that carries a number, drawn as the panel draws it once it ends. */
export function drawPress(press: SavedPress, counts: ReplayCounts): DrawnLine[] {
  add(counts.presses, press.set);
  const kind = press.button;
  const { lead, options } = helpParts({ text: press.text, status: "done" }, kind);
  const items = [...lead, ...options];
  const records = press.citations ?? [];
  const recordOf = (marker: number) => records.find((each) => each.marker === marker);
  const cited = (marker: number) => recordOf(marker) !== undefined;
  const numbers = citationNumbers(items, cited);
  const citationOf = (marker: number) => {
    const record = recordOf(marker);
    return record && quotedOf(record);
  };
  const numbered = (marker: number) => numbers.has(marker);
  const shownNumbers = (markers: readonly number[]) =>
    markers.flatMap((marker) => {
      const number = numbers.get(marker);
      return number === undefined ? [] : [String(number)];
    });
  const drawn: DrawnLine[] = [];

  /** A quote line as `HelpQuotes.tsx` draws it, with the time of a moment drawn by the app. */
  const row = (line: QuoteLine, moment: boolean): string => {
    const record = recordOf(line.drawn);
    const marks = [
      ...shownNumbers(line.markers),
      ...(line.state === "found" ? ["✓"] : []),
      ...shownNumbers(line.more),
    ];
    if (line.state === "found" && record && !quoteFound(record)) counts.checkBesideUnfoundWords++;
    if (line.state === "found" && record) {
      const given = record.quote.trim().replace(LINE_MARKS, "");
      const shown = line.cut ? (line.quote ?? "").replace(/…$/u, "") : (line.quote ?? "");
      const asGiven = line.cells
        ? line.cells.every((cell) => given.includes(cell.value))
        : line.cut
          ? given.startsWith(shown)
          : shown === given;
      if (!asGiven) counts.quoteNotAsGiven++;
    }
    const start = moment ? startOf(record?.location) : null;
    if (moment && start === null) counts.momentsWithNoTime++;
    if (line.state === "found") {
      const time = start === null ? "" : `${clockTime(start)} `;
      const words = line.cells ? cellsText(line.cells) : `“${line.quote ?? ""}”`;
      return [`${time}${words}`, ...marks].join(" ");
    }
    const at = startOf(record?.location);
    const { key, params } = badgeMessage(
      { check: line.state === "cant-check" ? "cant-check" : "not-found", reason: null },
      {
        documentName: record?.document ?? record?.place ?? "",
        location: at === null ? null : { kind: "time", from: at, to: at },
      },
      (message, values) => translate(press.language, message, values),
    );
    return [translate(press.language, key, params), ...marks].join(" ");
  };

  const general = (
    pieces: readonly ReplyPiece[],
    shape: DrawnLine["shape"],
    moment: MomentKind | null,
  ) => {
    const markers = markersOf([pieces]);
    const lines = quoteLines(markers, citationOf, "done", numbered);
    if (lines.length < Math.min(2, markers.filter(cited).length)) {
      add(counts.joinClosesRoom, press.order ?? "unknown");
    }
    for (const line of lines) counts.rows[rowKind(line)]++;
    const text = written(pieces, numbers);
    const saidInLine = [...textOf(pieces).matchAll(QUOTED)].map((match) => match[1] ?? "");
    const twice = lines.some((line) => {
      const quote = (line.quote ?? "").replace(/…$/u, "");
      return (
        line.state === "found" &&
        comparedWords(quote).length >= 6 &&
        (inside(quote, text) || saidInLine.some((words) => inside(words, quote)))
      );
    });
    if (twice) add(counts.sameWordsTwice, moment ?? shape);
    drawn.push({
      press,
      shape,
      written: text,
      rows: lines.map((line) => row(line, false)),
      moment,
    });
  };

  const fromCitations = (markers: readonly number[], moment: MomentKind) => {
    const lines = quoteLines(markers, citationOf, "done", numbered);
    for (const line of lines) counts.rows[rowKind(line)]++;
    drawn.push({
      press,
      shape: "readings",
      written: null,
      rows: lines.map((line) => row(line, true)),
      moment,
    });
  };

  const plain = (pieces: readonly ReplyPiece[], moment: Extract<Moment, { kind: "plain" }>) => {
    const record = recordOf(moment.marker);
    if (!record) {
      counts.moments.plain++;
      return;
    }
    const inQuote = inside(moment.words, record.quote);
    const inPlace =
      !inQuote && record.passageText !== undefined && inside(moment.words, record.passageText);
    if (!inQuote && !inPlace) {
      counts.moments["plain-replaced"]++;
      fromCitations([moment.marker], "plain-replaced");
      return;
    }
    counts.moments["plain-found"]++;
    if (inPlace) counts.plainFoundOutsideQuote++;
    const start = startOf(record.location);
    const time = start === null ? null : clockTime(start);
    // Its words as they show while its ✓ waits, and once it has joined: the panel draws both alike.
    const waiting = momentWords(textOf(pieces), time);
    const checked = momentWords(textOf(pieces), time);
    if (waiting !== checked) counts.plainWordsChangedWithCheck++;
    drawn.push({
      press,
      shape: "readings",
      written: null,
      rows: [[checked, ...shownNumbers([moment.marker]), "✓"].join(" ")],
      moment: "plain-found",
    });
  };

  let index = 0;
  for (const item of items) {
    const shape: DrawnLine["shape"] = lead.includes(item) ? "lead-ins" : HELP_SHAPE[kind];
    const lines = [
      { pieces: item.said ? quoted(item.lead) : item.lead, note: false },
      ...item.notes.map((pieces) => ({ pieces, note: true })),
      ...(item.effect ? [{ pieces: item.effect, note: false }] : []),
    ];
    for (const { pieces, note } of lines) {
      const line = index++;
      const moment = shape === "readings" && note ? momentKind(pieces) : null;
      if (moment === null && markersOf([pieces]).length === 0) continue;
      add(counts.lines, shape);
      if (moment === "unplaced") {
        counts.unplaced.push({ id: press.id, line });
        continue;
      }
      if (moment !== null && typeof moment === "object" && moment.kind === "plain") {
        if (press.citations === null) counts.moments.plain++;
        else plain(pieces, moment);
        continue;
      }
      if (moment !== null && typeof moment === "object") {
        counts.moments.several++;
        if (press.citations !== null) fromCitations(moment.markers, "several");
        continue;
      }
      if (moment !== null) counts.moments[moment]++;
      if (press.citations === null) continue;
      if (!markersOf([pieces]).some(cited)) {
        counts.linesWithNoCitation++;
        continue;
      }
      general(pieces, shape, moment);
    }
  }
  counts.unrecordedNumbers += press.unrecorded?.length ?? 0;
  for (const record of records) {
    if (record.passageText === undefined || record.from === "app-unmarked") continue;
    if (inside(record.quote, record.passageText) !== quoteFound(record)) counts.quoteCheckDiffers++;
  }
  return drawn;
}

/** Every press drawn, and the counts of what was drawn. */
export function replay(presses: readonly SavedPress[]): {
  counts: ReplayCounts;
  drawn: DrawnLine[];
} {
  const counts = emptyCounts();
  const drawn = presses.flatMap((press) => drawPress(press, counts));
  return { counts, drawn };
}

/** A number from a string, the same for the same string: the readers' lines' order. */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/**
 * The readers' file: up to `size` drawn lines, in an order that tells nothing of their kind, each
 * as the panel shows it; and its key, which says which press and kind each one is.
 */
export function readersFile(
  drawn: readonly DrawnLine[],
  size = 100,
): { text: string; key: object[] } {
  const chosen = drawn
    .map((line, index) => ({ line, order: hashOf(`${line.press.id}:${index}`) }))
    .filter(({ line }) => line.rows.length > 0)
    .sort((a, b) => a.order - b.order)
    .slice(0, size)
    .map(({ line }) => line);
  const text = chosen
    .map((line, index) =>
      [`## ${index + 1}`, "", ...(line.written ? [line.written] : []), ...line.rows, ""].join("\n"),
    )
    .join("\n");
  const key = chosen.map((line, index) => ({
    line: index + 1,
    id: line.press.id,
    set: line.press.set,
    button: line.press.button,
    language: line.press.language,
    shape: line.shape,
    moment: line.moment,
  }));
  return { text: `# Drawn lines\n\n${text}`, key };
}

const CHECKS: readonly CitationCheck[] = [
  "checking",
  "found",
  "not-found",
  "cant-check",
  "not-checked",
  "unsupported",
  "contradicted",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCheck = (value: unknown): value is CitationCheck => CHECKS.some((each) => each === value);
const isReason = (value: unknown): value is CitationCheckReason =>
  CITATION_CHECK_REASONS.some((each) => each === value);

function citationIn(value: unknown, where: string): SavedCitation {
  if (!isRecord(value) || typeof value.marker !== "number" || typeof value.quote !== "string") {
    throw new Error(`${where}: a Citation needs its marker and quote.`);
  }
  if (!isCheck(value.check)) throw new Error(`${where}: Citation ${value.marker} has no check.`);
  const citation: SavedCitation = { marker: value.marker, quote: value.quote, check: value.check };
  if (isReason(value.checkReason)) citation.checkReason = value.checkReason;
  const { from, document, passage, location, passageText, found, place } = value;
  if (from === "model" || from === "request" || from === "app-unmarked") citation.from = from;
  if (typeof document === "string") citation.document = document;
  if (typeof passage === "string") citation.passage = passage;
  if (typeof location === "string") citation.location = location;
  if (typeof passageText === "string") citation.passageText = passageText;
  if (typeof found === "boolean") citation.found = found;
  if (typeof place === "string") citation.place = place;
  return citation;
}

/** The presses a file holds, each checked for what the replay reads. */
export function pressesIn(value: unknown, file = "input"): SavedPress[] {
  if (!Array.isArray(value)) throw new Error(`${file}: expected a list of presses.`);
  return value.map((each, index): SavedPress => {
    const where = `${file}, press ${index + 1}`;
    if (!isRecord(each)) throw new Error(`${where}: not an object.`);
    const { id, set, language, button, text, citations, unrecorded, order, model } = each;
    if (typeof id !== "string" || typeof set !== "string" || typeof text !== "string") {
      throw new Error(`${where}: needs its id, set and text.`);
    }
    if (language !== "en" && language !== "zh-CN") throw new Error(`${where}: unknown language.`);
    if (!isMeetingHelpKind(button)) throw new Error(`${where}: unknown button.`);
    if (citations !== null && !Array.isArray(citations)) {
      throw new Error(`${where}: citations must be a list or null.`);
    }
    return {
      id,
      set,
      language,
      button,
      text,
      citations: citations === null ? null : citations.map((one) => citationIn(one, where)),
      ...(typeof model === "string" && { model }),
      ...(Array.isArray(unrecorded) && {
        unrecorded: unrecorded.filter((number) => typeof number === "number"),
      }),
      order:
        order === "number-first" || order === "cite-first" || order === "no-cite" ? order : null,
    };
  });
}

/** The replay of the files named: its counts, and with `readers`, the readers' file and its key. */
export function replayFiles(files: readonly string[], readers: string | null): ReplayCounts {
  if (files.length === 0) throw new Error("Name at least one file of saved presses.");
  const presses = files.flatMap((file) => pressesIn(JSON.parse(readFileSync(file, "utf8")), file));
  const { counts, drawn } = replay(presses);
  if (readers) {
    const { text, key } = readersFile(drawn);
    writeFileSync(readers, text);
    writeFileSync(`${readers}.key.json`, JSON.stringify(key, null, 2));
  }
  return counts;
}
