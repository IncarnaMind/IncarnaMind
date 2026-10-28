/**
 * Citation Locations (ADR-0011): where in a Document a Citation points, in
 * the unit its readers use, and its short label: "p. 4", "slide 4",
 * "Revenue, rows 12–14", "§ 2.1 Sensitivity", "lines 120–134", and in a
 * Transcript the time its quote starts, "14:26". Pure, shared
 * by the core (the check, the prompt, exports) and the renderer (the
 * Citation card, the viewer's mark).
 *
 * A Location is worked out from the Units a Citation names and where in
 * them its quote was found: for blocks of rows or lines, the rows or lines
 * the quote covers; for sections, the heading the quote sits under, and for
 * a quote of a Word comment, the comment's author too ("§ 2 Costs, comment
 * by Reviewer", #76).
 */
import type { CitationAttributes, CitationLocation } from "../core/api";
import { clockTime, parseClockTime } from "./clock";
import { type MessageKey, type MessageParams, translate } from "./i18n";
import { findQuote, type MatchOptions, type TextRange } from "./quoteMatch";
import { speakerName } from "./speakers";
import {
  anchorsOf,
  isPrintedName,
  lineAt,
  parseCellRef,
  parseCueTarget,
  type UnitText,
} from "./units";

/** "12" or "12–14". */
const span = (from: number | string, to: number | string) =>
  to !== from ? `${from}–${to}` : `${from}`;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/** A time in a Transcript, in ms from its start. */
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function parsePrinted(value: unknown): { from: string; to: string } | null {
  if (typeof value !== "object" || value === null || !("from" in value) || !("to" in value)) {
    return null;
  }
  const { from, to } = value;
  return isPrintedName(from) && isPrintedName(to) ? { from, to } : null;
}

function parsePrintedLines(value: unknown): { from: number; to: number } | null {
  if (typeof value !== "object" || value === null || !("from" in value) || !("to" in value)) {
    return null;
  }
  const { from, to } = value;
  return isCount(from) && isCount(to) ? { from, to } : null;
}

/** A stored Location, checked; null if it isn't one. */
export function parseLocation(value: unknown): CitationLocation | null {
  if (typeof value === "string") {
    try {
      return parseLocation(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const location = value as Record<string, unknown>;
  const { kind, from, to } = location;
  switch (kind) {
    case "page": {
      if (!isCount(from) || !isCount(to) || to < from) return null;
      const printed = parsePrinted(location.printed);
      const lines = parsePrintedLines(location.lines);
      return {
        kind,
        from,
        to,
        ...(printed ? { printed } : {}),
        ...(lines ? { lines } : {}),
      };
    }
    case "slide":
    case "lines":
      return isCount(from) && isCount(to) && to >= from ? { kind, from, to } : null;
    case "time": {
      if (!isTime(from) || !isTime(to) || to < from) return null;
      const speaker = typeof location.speaker === "string" ? location.speaker.trim() : "";
      return speaker ? { kind, from, to, speaker } : { kind, from, to };
    }
    case "rows":
      if (!isCount(from) || !isCount(to) || to < from) return null;
      return {
        kind,
        sheet: typeof location.sheet === "string" ? location.sheet : null,
        from,
        to,
      };
    case "section": {
      const comment = location.comment;
      const author =
        typeof comment === "object" && comment !== null
          ? (comment as Record<string, unknown>).author
          : undefined;
      const paragraphs =
        typeof location.paragraphs === "object" && location.paragraphs !== null
          ? (location.paragraphs as Record<string, unknown>)
          : null;
      return {
        kind,
        heading: typeof location.heading === "string" ? location.heading : null,
        ...(location.start === true ? { start: true } : {}),
        ...(location.notes === true ? { notes: true } : {}),
        ...(author !== undefined
          ? { comment: { author: typeof author === "string" && author ? author : null } }
          : {}),
        ...(paragraphs &&
        isCount(paragraphs.from) &&
        isCount(paragraphs.to) &&
        paragraphs.to >= paragraphs.from
          ? { paragraphs: { from: paragraphs.from, to: paragraphs.to } }
          : {}),
        ...(isCount(location.figure) ? { figure: location.figure } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Whether a Location names a place. A section does when it has a heading,
 * is the start of a Document that has headings, or is its notes, a paragraph,
 * a figure or a comment; the text of a Document with no headings is no
 * place, and "§ Start" on every Citation of one points nowhere.
 */
export function saysWhere(location: CitationLocation): boolean {
  if (location.kind !== "section") return true;
  return Boolean(
    location.heading ||
      location.start ||
      location.notes ||
      location.paragraphs ||
      location.figure ||
      location.comment,
  );
}

/**
 * A Citation's Location: the one stored with it, or for a Citation from
 * before Locations, its pages (null for a whole TXT or Markdown file, and
 * for a Document with no headings where no paragraph is known).
 */
export function citationLocation(
  attributes: Partial<Pick<CitationAttributes, "pageFrom" | "pageTo">> & { location?: unknown },
): CitationLocation | null {
  const stored = parseLocation(attributes.location);
  if (stored) return saysWhere(stored) ? stored : null;
  const { pageFrom, pageTo } = attributes;
  if (!isCount(pageFrom)) return null;
  return {
    kind: "page",
    from: pageFrom,
    to: isCount(pageTo) && pageTo >= pageFrom ? pageTo : pageFrom,
  };
}

/** Words a Location in a language: `t` is the renderer's `t` or the core's `translate`. */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * A Location's short label, e.g. "slide 4" or "Revenue, rows 12–14", and in a
 * Transcript "Me · 12:03": who said it, then the time, unless `speaker` is false.
 * A section that names no place (see `saysWhere`) has none: its label is "".
 */
export function formatLocation(location: CitationLocation, t: Translate, speaker = true): string {
  switch (location.kind) {
    case "page": {
      const { from, to } = location.printed ?? location;
      if (location.lines && from !== to) {
        return t("location.pageLines.across", {
          fromPage: from,
          fromLine: location.lines.from,
          toPage: to,
          toLine: location.lines.to,
        });
      }
      const page = t("location.page", { range: span(from, to) });
      return location.lines
        ? `${page} · ${t(location.lines.to !== location.lines.from ? "location.lines.other" : "location.lines.one", { range: span(location.lines.from, location.lines.to) })}`
        : page;
    }
    case "slide":
      return t(location.to !== location.from ? "location.slide.other" : "location.slide.one", {
        range: span(location.from, location.to),
      });
    case "rows": {
      const range = span(location.from, location.to);
      const plural = location.to !== location.from;
      return location.sheet
        ? t(plural ? "location.sheetRows.other" : "location.sheetRows.one", {
            sheet: location.sheet,
            range,
          })
        : t(plural ? "location.rows.other" : "location.rows.one", { range });
    }
    case "lines":
      return t(location.to !== location.from ? "location.lines.other" : "location.lines.one", {
        range: span(location.from, location.to),
      });
    case "time":
      return speaker && location.speaker
        ? t("location.time.speaker", {
            speaker: speakerName(location.speaker, t),
            time: clockTime(location.from),
          })
        : clockTime(location.from);
    case "section": {
      const section = location.notes
        ? t("location.section.notes")
        : location.heading
          ? t("location.section", { heading: location.heading })
          : location.start
            ? t("location.section.start")
            : null;
      const after = (inSection: MessageKey, alone: MessageKey, params: MessageParams) =>
        section === null ? t(alone, params) : t(inSection, { ...params, section });
      const { paragraphs, comment } = location;
      if (location.figure) {
        return after("location.section.figure", "location.figure", { number: location.figure });
      }
      if (paragraphs) {
        return after(
          paragraphs.to !== paragraphs.from
            ? "location.section.paragraph.other"
            : "location.section.paragraph.one",
          "location.paragraph",
          { range: span(paragraphs.from, paragraphs.to) },
        );
      }
      if (!comment) return section ?? "";
      return comment.author
        ? after("location.section.comment", "location.comment", { author: comment.author })
        : after("location.section.comment.anonymous", "location.comment.anonymous", {});
    }
  }
}

/** "p. 68 · page 69 of the PDF" for a page that calls itself something other than its number in the PDF; null otherwise. */
export function formatLocationWithPdf(location: CitationLocation, t: Translate): string | null {
  if (location.kind !== "page" || !location.printed) return null;
  return t(
    location.to !== location.from ? "location.page.withPdf.other" : "location.page.withPdf.one",
    {
      printed: formatLocation(location, t),
      range: span(location.from, location.to),
    },
  );
}

const english: Translate = (key, params) => translate("en", key, params);

/** A PDF page by its number in the PDF, which is how a model cites it. */
export const englishLocation = (location: CitationLocation, speaker = true): string =>
  formatLocation(
    location.kind === "page"
      ? {
          kind: "page",
          from: location.from,
          to: location.to,
          ...(location.lines ? { lines: location.lines } : {}),
          ...(location.lines && location.printed ? { printed: location.printed } : {}),
        }
      : location,
    english,
    speaker,
  );

/** The English label of a place, for a prompt: null where there is none to name. */
export const englishPlace = (location: CitationLocation | null): string | null =>
  location && saysWhere(location) ? englishLocation(location) : null;

/** A Citation copied as text names the page the Document prints. */
export const englishPrintedLocation = (location: CitationLocation): string =>
  formatLocation(location, english);

/** The kinds of Location the card's "Open …" button names: the page, the slide, the section… */
export const openKind = (location: CitationLocation | null) =>
  location === null ? "document" : location.kind;

/** A Citation of a Transcript, whose Location is a time: checked against the Transcript's text, not a page. */
export const isTranscriptLocation = (location: CitationLocation | null) =>
  location?.kind === "time";

/** Whether a label reads "in …" (a section, a range of rows) rather than "on …" (a page, a slide, lines). */
export const readsIn = (location: CitationLocation) =>
  location.kind === "section" || location.kind === "rows";

/** The whole of one Unit as a Location: what the prompt marks each Unit with. */
export function unitLocation(unit: UnitText): CitationLocation | null {
  const number = unit.page;
  const label = unit.label ?? null;
  switch (unit.kind ?? "page") {
    case "page":
    case "slide":
      return number === null
        ? null
        : ({ kind: unit.kind ?? "page", from: number, to: number } as CitationLocation);
    case "rows":
      return isCount(label?.from) && isCount(label?.to)
        ? { kind: "rows", sheet: label?.sheet ?? null, from: label.from, to: label.to }
        : null;
    case "lines":
      return isCount(label?.from) && isCount(label?.to)
        ? { kind: "lines", from: label.from, to: label.to }
        : null;
    case "cues":
      return isTime(label?.from) && isTime(label?.to)
        ? { kind: "time", from: label.from, to: label.to }
        : null;
    case "section":
      return {
        kind: "section",
        heading: label?.path?.at(-1) ?? null,
        ...(label?.beforeHeading ? { start: true } : {}),
        ...(label?.notes ? { notes: true } : {}),
      };
    default:
      return null;
  }
}

/**
 * Where a quote is in the text of Units (see `joinUnits`), matched as the
 * Citation check matches it, number formatting normalised in sheets' rows,
 * and in slides when the quote isn't found as it is (see `numbersIn`; and
 * lost f-ligatures forgiven with `lostLigatures`, of their Document); null
 * if it isn't there.
 */
export function quoteInUnits(
  units: readonly UnitText[],
  quote: string,
  options: Pick<MatchOptions, "lostLigatures" | "unique"> = {},
): TextRange[] | null {
  const { text } = joinUnits(units);
  if (!quote || text.trim() === "") return null;
  return findQuote(text, quote, { ...options, numbers: numbersIn(units) });
}

/**
 * How number formatting is matched in Units: normalised in sheets' rows; in
 * slides, whose charts are stored as the values the file caches and drawn in
 * its number formats, only when a quote isn't found as it is (#76).
 */
export function numbersIn(units: readonly Pick<UnitText, "kind">[]): MatchOptions["numbers"] {
  if (units.some((unit) => unit.kind === "rows")) return true;
  return units.some((unit) => unit.kind === "slide") ? "if-needed" : false;
}

/**
 * The anchors (cells, paragraphs…) a quote covers in Units, by Unit: where it
 * was found (`ranges`, in their joined text) mapped through each Unit's anchors.
 */
export function anchorsCovered(
  units: readonly UnitText[],
  ranges: readonly TextRange[],
): { unit: UnitText; target: string }[] {
  const { starts } = joinUnits(units);
  const covered: { unit: UnitText; target: string }[] = [];
  for (const part of partsByUnit(units, starts, ranges)) {
    const unit = units[part.unit] as UnitText;
    for (const anchor of anchorsOf(unit)) {
      if (anchor.start < part.end && anchor.end > part.start) {
        covered.push({ unit, target: anchor.target });
      }
    }
  }
  return covered;
}

/** The text of cited Units as the check reads it, joined by line breaks, with where each starts. */
export function joinUnits(units: readonly UnitText[]): { text: string; starts: number[] } {
  let text = "";
  const starts: number[] = [];
  units.forEach((unit, index) => {
    if (index > 0) text += "\n";
    starts.push(text.length);
    text += unit.text;
  });
  return { text, starts };
}

/** A span of the joined text, cut into the part inside each Unit (offsets relative to it). */
function partsByUnit(
  units: readonly UnitText[],
  starts: readonly number[],
  ranges: readonly TextRange[],
): { unit: number; start: number; end: number }[] {
  const parts: { unit: number; start: number; end: number }[] = [];
  for (const range of ranges) {
    units.forEach((unit, index) => {
      const offset = starts[index] as number;
      const start = Math.max(range.start, offset) - offset;
      const end = Math.min(range.end, offset + unit.text.length) - offset;
      if (start < end) parts.push({ unit: index, start, end });
    });
  }
  return parts;
}

/**
 * The Word comment a section's text has at `offset`, by its author (see
 * `UnitLabel.comments`); null when the offset is in the section's own text.
 */
function commentAt(unit: UnitText, offset: number): { author: string | null } | null {
  for (const anchor of anchorsOf(unit)) {
    if (anchor.start > offset || offset >= anchor.end || !anchor.target.startsWith("comment")) {
      continue;
    }
    const comment = unit.label?.comments?.find((each) => each.target === anchor.target);
    return { author: comment?.author ?? null };
  }
  return null;
}

// A Word file with no headings has no place but its paragraphs.
function numbersParagraphs({ label }: UnitText): boolean {
  if (label?.paragraphs) return true;
  return label?.path?.length === 0 && !label.beforeHeading && !label.notes;
}

/**
 * The paragraphs of a section a quote covers (see `numbersParagraphs`): in the parts of the
 * section the quote starts in. Null where paragraphs aren't numbered, or none is covered.
 */
function paragraphsCovered(
  units: readonly UnitText[],
  parts: readonly { unit: number; start: number; end: number }[],
  where: UnitText,
): { from: number; to: number } | null {
  if (!numbersParagraphs(where)) return null;
  const path = JSON.stringify(where.label?.path ?? []);
  const numbers: number[] = [];
  for (const part of parts) {
    const unit = units[part.unit] as UnitText;
    if (!numbersParagraphs(unit) || JSON.stringify(unit.label?.path ?? []) !== path) continue;
    for (const anchor of anchorsOf(unit)) {
      const number = /^p(\d+)$/.exec(anchor.target)?.[1];
      if (number && anchor.start < part.end && anchor.end > part.start)
        numbers.push(Number(number));
    }
  }
  return numbers.length > 0 ? { from: Math.min(...numbers), to: Math.max(...numbers) } : null;
}

/** The picture a quote starts in, as its anchor numbers it ("figure2", "figure2.line3"); null in text. */
function figureAt(where: UnitText, offset: number): number | null {
  for (const anchor of anchorsOf(where)) {
    const number = /^figure(\d+)$/.exec(anchor.target)?.[1];
    if (number && anchor.start <= offset && offset < anchor.end) return Number(number);
  }
  return null;
}

function printedNames(first: UnitText, last: UnitText): { from: string; to: string } | null {
  const from = first.label?.printed;
  const to = last.label?.printed;
  if (!isPrintedName(from) || !isPrintedName(to)) return null;
  return from === String(first.page) && to === String(last.page) ? null : { from, to };
}

/** A request for a narrower range than the Units cited: rows or lines the model named. */
export interface RowsOrLines {
  from: number;
  to: number;
}

/**
 * The Location of cited Units (consecutive, of one kind): with `ranges`
 * (where the quote was found in their joined text, see `joinUnits`), narrowed
 * to what the quote covers; otherwise to `requested`, or the Units' own span.
 * Null for a whole TXT or Markdown file stored before Units.
 */
export function locationOf(
  units: readonly UnitText[],
  ranges: readonly TextRange[] | null,
  requested: RowsOrLines | null = null,
): CitationLocation | null {
  const first = units[0];
  const last = units.at(-1);
  if (!first || !last) return null;
  const kind = first.kind ?? "page";
  const { starts } = joinUnits(units);
  const parts = ranges ? partsByUnit(units, starts, ranges) : [];
  const clamp = (whole: RowsOrLines): RowsOrLines => {
    if (!requested) return whole;
    const from = Math.max(whole.from, requested.from);
    const to = Math.min(whole.to, requested.to);
    return from <= to ? { from, to } : whole;
  };
  switch (kind) {
    case "slide":
      return first.page === null || last.page === null
        ? null
        : { kind, from: first.page, to: last.page };
    case "page": {
      if (first.page === null || last.page === null) return null;
      const printed = printedNames(first, last);
      return { kind, from: first.page, to: last.page, ...(printed && { printed }) };
    }
    case "text":
      return null;
    case "section": {
      const where = units[parts[0]?.unit ?? 0] ?? first;
      const section = unitLocation(where);
      if (section?.kind !== "section") return section;
      const comment = parts[0] ? commentAt(where, parts[0].start) : null;
      if (comment) return { ...section, comment };
      const figure = parts[0] ? figureAt(where, parts[0].start) : null;
      if (figure) return { ...section, figure };
      const paragraphs = paragraphsCovered(units, parts, where);
      return paragraphs ? { ...section, paragraphs } : section;
    }
    case "rows": {
      const whole = { from: first.label?.from ?? 1, to: last.label?.to ?? first.label?.to ?? 1 };
      let rows: number[] = [];
      const headerRows: number[] = [];
      for (const part of parts) {
        const unit = units[part.unit] as UnitText;
        const headerRow = unit.label?.header ? unit.label.rows?.[0] : undefined;
        for (const anchor of anchorsOf(unit)) {
          if (anchor.start >= part.end || anchor.end <= part.start) continue;
          const row = parseCellRef(anchor.target)?.row;
          if (row === undefined) continue;
          (row === headerRow ? headerRows : rows).push(row);
        }
      }
      if (rows.length === 0) rows = headerRows;
      const range =
        rows.length > 0 ? { from: Math.min(...rows), to: Math.max(...rows) } : clamp(whole);
      return { kind: "rows", sheet: first.label?.sheet ?? null, ...range };
    }
    case "cues": {
      const times: { startMs: number; endMs: number }[] = [];
      let speaker: string | null = null;
      for (const part of parts) {
        const unit = units[part.unit] as UnitText;
        for (const [index, anchor] of anchorsOf(unit).entries()) {
          const cue = parseCueTarget(anchor.target);
          if (cue && anchor.start < part.end && anchor.end > part.start) {
            if (times.length === 0) speaker = unit.label?.speakers?.[index] ?? null;
            times.push(cue);
          }
        }
      }
      const head = times[0];
      if (head) {
        return {
          kind: "time",
          from: head.startMs,
          to: Math.max(...times.map((cue) => cue.endMs)),
          ...(speaker && { speaker }),
        };
      }
      const whole = { from: first.label?.from ?? 0, to: last.label?.to ?? first.label?.to ?? 0 };
      return requested
        ? { kind: "time", from: requested.from, to: Math.max(requested.from, requested.to) }
        : { kind: "time", ...whole };
    }
    case "lines": {
      const whole = { from: first.label?.from ?? 1, to: last.label?.to ?? first.label?.to ?? 1 };
      const head = parts[0];
      const tail = parts.at(-1);
      if (!head || !tail) return { kind: "lines", ...clamp(whole) };
      const startUnit = units[head.unit] as UnitText;
      const endUnit = units[tail.unit] as UnitText;
      return {
        kind: "lines",
        from: lineAt(startUnit.text, startUnit.label ?? null, head.start),
        to: lineAt(endUnit.text, endUnit.label ?? null, tail.end - 1),
      };
    }
  }
}

/** A Location as the model may give it in a Citation record, read loosely. */
export type RequestedLocation =
  | { kind: "page" | "slide" | "lines"; from: number; to: number }
  | { kind: "rows"; sheet: string | null; from: number; to: number }
  | { kind: "section"; heading: string }
  /** A time in a Transcript, "14:26" or "14:26–15:02", in ms. */
  | { kind: "time"; from: number; to: number };

/**
 * What a comment's Location adds after its section, as its label words it in
 * English or Chinese (", comment by Reviewer", "，王丽华 的批注"): the
 * section alone names the Unit (#76).
 */
const A_COMMENT = /\s*(?:[,，;(]\s*(?:a\s+)?comment(?:\s+by\b.*)?|[,，]\s*[^,，]*批注)\)?$/iu;

/** What a web page's Location adds after its section: ", ¶ 3", "，第 3 段" (#261), ", figure 2", "，图 2". */
const A_PARAGRAPH =
  /\s*[,，;]?\s*(?:¶{1,2}\s*\d+(?:\s*[-–—]\s*\d+)?|第\s*\d+(?:\s*[-–—]\s*\d+)?\s*段|(?:figure|fig\.?)\s*\d+|图\s*\d+)$/iu;

const RANGE = String.raw`(\d{1,7})(?:\s*(?:-|–|—|to|and)\s*(\d{1,7}))?`;
const range = (from: string | undefined, to: string | undefined) => {
  const a = Number(from);
  const b = to === undefined ? a : Number(to);
  return { from: Math.min(a, b), to: Math.max(a, b) };
};

/**
 * Reads a Location written as its label ("slide 4", "Revenue, rows 12–14",
 * "§ 2.1 Sensitivity", "lines 120–134", "p. 4", "14:26"), or as a cell range
 * ("Revenue!A12:F14"). Null if it can't be read.
 */
export function parseRequestedLocation(input: string): RequestedLocation | null {
  let text = input
    .trim()
    .replace(/^[[("'“]+|[\]"'”.]+$/g, "")
    .trim();
  // A closing parenthesis that closes one inside is the label's own: "§ 240.10b-5(b)".
  const count = (mark: string) => text.split(mark).length - 1;
  while (text.endsWith(")") && count(")") > count("(")) {
    text = text
      .slice(0, -1)
      .replace(/[\]"'”.]+$/, "")
      .trim();
  }
  if (!text) return null;
  const times =
    /^(?:at\s+)?(\d{1,2}(?::\d{2}){1,2})(?:\s*[-–—]\s*(\d{1,2}(?::\d{2}){1,2}))?$/i.exec(text);
  if (times) {
    const from = parseClockTime(times[1] as string);
    const to = times[2] === undefined ? from : parseClockTime(times[2]);
    if (from !== null && to !== null) {
      return { kind: "time", from: Math.min(from, to), to: Math.max(from, to) };
    }
  }
  let match = new RegExp(String.raw`^(?:pp?\.?|pages?)\s*${RANGE}$`, "i").exec(text);
  if (match) return { kind: "page", ...range(match[1], match[2]) };
  match = new RegExp(
    String.raw`^slides?\s*${RANGE}(?:\s*[(,]?\s*(?:speaker\s+)?notes\)?)?$`,
    "i",
  ).exec(text);
  if (match) return { kind: "slide", ...range(match[1], match[2]) };
  match = new RegExp(String.raw`^lines?\s*${RANGE}$`, "i").exec(text);
  if (match) return { kind: "lines", ...range(match[1], match[2]) };
  match = new RegExp(String.raw`^(?:(.+?)\s*[,:;!]\s*)?rows?\s*${RANGE}$`, "i").exec(text);
  if (match) return { kind: "rows", sheet: match[1]?.trim() || null, ...range(match[2], match[3]) };
  match = /^(?:'?(.+?)'?!)?\$?[A-Z]{1,3}\$?(\d{1,7})(?::\$?[A-Z]{1,3}\$?(\d{1,7}))?$/i.exec(text);
  if (match) return { kind: "rows", sheet: match[1]?.trim() || null, ...range(match[2], match[3]) };
  match = /^(?:§+|sections?\b|heading\b)\s*(.+)$/i.exec(text);
  const heading = match?.[1]?.replace(A_PARAGRAPH, "").replace(A_COMMENT, "").trim();
  if (heading) return { kind: "section", heading };
  return null;
}

const simplify = (text: string) =>
  text.toLowerCase().replace(/[§›>]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Whether a section Unit is the one a heading names: its heading, its path, or
 * its number ("2.1"). `loose` reads a trailing "(2)" as a second section of
 * that name rather than as part of the heading.
 */
function sectionMatches(unit: UnitText, heading: string, loose = true): boolean {
  const named = simplify(heading);
  const wanted = loose ? named.replace(/\s*\(\d+\)$/, "") : named;
  const path = unit.label?.path ?? [];
  if (unit.label?.notes) return /^(notes|footnotes|endnotes)$/.test(wanted);
  if (path.length === 0) return /^(start|beginning|introduction)$/.test(wanted);
  const own = simplify(path.at(-1) as string);
  if (own === wanted || simplify(path.join(" ")) === wanted) return true;
  // "2.1", for a heading numbered "2.1 Sensitivity".
  return /^[\d.]+$/.test(wanted) && own.startsWith(`${wanted} `);
}

/**
 * The Units (their numbers) of `units`, a Passage's, that a requested
 * Location names; null if none does. Pages and slides name their numbers
 * outright, so they can lie outside the Passage (and the check says so).
 */
export function resolveRequested(
  requested: RequestedLocation,
  units: readonly UnitText[],
): { from: number; to: number } | null {
  const kind = units[0]?.kind ?? "page";
  if (requested.kind === "page" || requested.kind === "slide") {
    // A deck's "page 4" is its slide 4; pages mean nothing in the other kinds.
    return kind === "page" || kind === "slide" ? { from: requested.from, to: requested.to } : null;
  }
  // A provision's heading ends in its own "(1)": "§ 243.100(a)(1)" is that paragraph, not "243.100(a)".
  const exactly =
    requested.kind === "section" &&
    units.some((unit) => unit.kind === "section" && sectionMatches(unit, requested.heading, false));
  const named = (unit: UnitText): boolean => {
    if (requested.kind === "section") {
      return unit.kind === "section" && sectionMatches(unit, requested.heading, !exactly);
    }
    if (requested.kind === "time") {
      if (unit.kind !== "cues") return false;
      // A time is a moment: the block it falls in, or, between two, the one it starts.
      return (
        requested.from <= (unit.label?.to ?? 0) && requested.to >= (unit.label?.from ?? 0) - 1000
      );
    }
    if (unit.kind !== requested.kind) return false;
    const label = unit.label ?? null;
    if (requested.kind === "rows" && requested.sheet && label?.sheet) {
      if (simplify(label.sheet) !== simplify(requested.sheet)) return false;
    }
    return requested.from <= (label?.to ?? 0) && requested.to >= (label?.from ?? 0);
  };
  const numbers: number[] = [];
  for (const unit of units) if (unit.page !== null && named(unit)) numbers.push(unit.page);
  if (numbers.length === 0) return null;
  return { from: Math.min(...numbers), to: Math.max(...numbers) };
}
