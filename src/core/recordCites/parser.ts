import { parseClockTime } from "../../shared/clock";
import type { CitationLocation } from "../api";

export type RecordCiteKind =
  | "deposition"
  | "exhibit"
  | "docket"
  | "bates"
  | "paragraph"
  | "time"
  | "id"
  | "supra";

export interface BatesRange {
  prefix: string;
  from: string;
  to: string;
}

export interface ParsedRecordCite {
  status: "parsed";
  raw: string;
  kind: RecordCiteKind;
  sourceAlias: string | null;
  location: CitationLocation | null;
  bates: BatesRange | null;
  reference: "previous" | null;
}

export type RecordCiteParseFailureReason = "malformed" | "out-of-range" | "no-earlier-referent";

export interface RecordCiteParseFailure {
  status: "error";
  raw: string;
  reason: RecordCiteParseFailureReason;
}

export type RecordCiteParseResult = ParsedRecordCite | RecordCiteParseFailure;

export interface RecordCiteParseOptions {
  /** Whether the resolver has an earlier record item whose Document and Location are usable. */
  hasPrevious?: boolean;
}

export interface RecordCiteOccurrence {
  raw: string;
  /** UTF-16 offsets in the scanned text; `from` is inclusive and `to` exclusive. */
  from: number;
  to: number;
  result: RecordCiteParseResult;
  /** Zero-based index of the nearest preceding resolvable occurrence, for `Id.` and `supra`. */
  referent: number | null;
}

type Draft = Omit<ParsedRecordCite, "status" | "raw">;
type ReadShape = (
  match: RegExpExecArray,
  options: RecordCiteParseOptions,
) => Draft | RecordCiteParseFailureReason;

interface RecordCiteShape {
  pattern: RegExp;
  read: ReadShape;
  scanName?: (match: RegExpExecArray) => string;
}

const group = (match: RegExpExecArray, index: number) => match[index] ?? "";

const normalizeAlias = (source: string) =>
  source
    .trim()
    .replace(/[.’]/g, (mark) => (mark === "’" ? "'" : ""))
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

const positiveInteger = (written: string) => {
  const value = Number(written);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
};

const positiveRange = (fromWritten: string, toWritten = fromWritten) => {
  const from = positiveInteger(fromWritten);
  const to = positiveInteger(toWritten);
  if (from === null || to === null) return "out-of-range" as const;
  return from <= to ? { from, to } : ("out-of-range" as const);
};

const pageLocation = (from: number, to = from): CitationLocation => ({
  kind: "page",
  from,
  to,
});

const direct = (
  kind: RecordCiteKind,
  sourceAlias: string | null,
  location: CitationLocation | null,
): Draft => ({ kind, sourceAlias, location, bates: null, reference: null });

const previous = (
  kind: "id" | "supra",
  location: CitationLocation | null,
  options: RecordCiteParseOptions,
): Draft | RecordCiteParseFailureReason =>
  options.hasPrevious
    ? { kind, sourceAlias: null, location, bates: null, reference: "previous" }
    : "no-earlier-referent";

const readDeposition: ReadShape = (match) => {
  const fromPage = positiveInteger(group(match, 3));
  const fromLine = positiveInteger(group(match, 4));
  const toPage = group(match, 5) ? positiveInteger(group(match, 5)) : fromPage;
  const toLine = positiveInteger(group(match, 6));
  if (fromPage === null || fromLine === null || toPage === null || toLine === null) {
    return "out-of-range";
  }
  if (toPage < fromPage || (toPage === fromPage && toLine < fromLine)) return "out-of-range";
  const source = `${group(match, 1)}${group(match, 1) ? " " : ""}${group(match, 2)}`;
  return direct("deposition", normalizeAlias(source), {
    kind: "page",
    from: fromPage,
    to: toPage,
    printed: { from: group(match, 3), to: group(match, 5) || group(match, 3) },
    lines: { from: fromLine, to: toLine },
  });
};

const readExhibit: ReadShape = (match) => {
  const page = positiveInteger(group(match, 3));
  if (page === null) return "out-of-range";
  const source = `${group(match, 1)}${group(match, 1) ? " " : ""}Ex. ${group(match, 2)}`;
  return direct("exhibit", normalizeAlias(source), pageLocation(page));
};

const readDocket: ReadShape = (match) => {
  const page = positiveInteger(group(match, 3));
  if (page === null) return "out-of-range";
  return direct(
    "docket",
    normalizeAlias(`${group(match, 1)} ${group(match, 2)}`),
    pageLocation(page),
  );
};

const batesRange = (prefix: string, from: string, to: string): Draft | "out-of-range" => {
  const first = Number(from);
  const last = Number(to);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) {
    return "out-of-range";
  }
  return {
    kind: "bates",
    sourceAlias: normalizeAlias(prefix),
    location: null,
    bates: { prefix: prefix.toUpperCase(), from, to },
    reference: null,
  };
};

const readParagraph: ReadShape = (match) => {
  const paragraphs = positiveRange(group(match, 3), group(match, 4) || group(match, 3));
  if (paragraphs === "out-of-range") return paragraphs;
  return direct("paragraph", normalizeAlias(group(match, 1)), {
    kind: "section",
    heading: null,
    paragraphs,
  });
};

const readTime: ReadShape = (match) => {
  const start = parseClockTime(group(match, 1));
  const end = group(match, 2) ? parseClockTime(group(match, 2)) : start;
  if (start === null || end === null) return "out-of-range";
  return direct("time", null, {
    kind: "time",
    from: Math.min(start, end),
    to: Math.max(start, end),
  });
};

const SHAPES: readonly RecordCiteShape[] = [
  {
    pattern: /^(?:(.+?) )?(dep\.?(?: tr\.?)?) (\d+) *: *(\d+)(?: *[-–—] *(?:(\d+) *: *)?(\d+))?$/i,
    read: readDeposition,
    scanName: (match) => group(match, 1),
  },
  {
    pattern: /^(?:(pl\.['’]s) )?ex\.? (\d+),? (?:at|p\.?) (\d+)$/i,
    read: readExhibit,
  },
  {
    pattern: /^(ecf no\.?|dkt\.?) (\d+),? (?:at|p\.?) (\d+)$/i,
    read: readDocket,
  },
  {
    pattern: /^([A-Z]+)-(\d{4,})$/,
    read: (match) => batesRange(group(match, 1), group(match, 2), group(match, 2)),
  },
  {
    pattern: /^([A-Z]+) (\d{4,}) *[-–—] *(\d{4,})$/,
    read: (match) => batesRange(group(match, 1), group(match, 2), group(match, 3)),
  },
  {
    pattern: /^(compl\.?|.+? decl\.?) ¶(¶?) (\d+)(?: *[-–—] *(\d+))?$/i,
    read: readParagraph,
    scanName: (match) => group(match, 1).replace(/ decl\.?$/i, ""),
  },
  {
    pattern: /^(?:at )?(\d{1,2}(?::\d{2}){1,2})(?: *[-–—] *(\d{1,2}(?::\d{2}){1,2}))?$/i,
    read: readTime,
  },
  {
    pattern: /^[Ii]d\.(?: at (\d+))?$/,
    read: (match, options) => {
      const page = group(match, 1) ? positiveInteger(group(match, 1)) : null;
      if (group(match, 1) && page === null) return "out-of-range";
      return previous("id", page === null ? null : pageLocation(page), options);
    },
  },
  {
    pattern: /^supra\.?$/i,
    read: (_match, options) => previous("supra", null, options),
  },
];

/**
 * Reads one record cite without resolving its source; failures are values, never exceptions.
 * The resolver maps a deposition's printed page labels to its physical PDF Units.
 */
export function parseRecordCite(
  raw: string,
  options: RecordCiteParseOptions = {},
): RecordCiteParseResult {
  const text = raw.trim().replace(/\s+/g, " ");
  for (const shape of SHAPES) {
    const match = shape.pattern.exec(text);
    if (!match) continue;
    const result = shape.read(match, options);
    if (typeof result === "string") return { status: "error", raw, reason: result };
    return { status: "parsed", raw, ...result };
  }
  return { status: "error", raw, reason: "malformed" };
}

interface Candidate {
  from: number;
  to: number;
  shape: number;
}

const nameSuffix = (name: string) => {
  const capitalized = /\p{Lu}[\p{L}\p{M}'’-]*\.?(?: +\p{Lu}[\p{L}\p{M}'’-]*\.?)*$/u.exec(name)?.[0];
  if (!capitalized) return /[\p{L}\p{M}][\p{L}\p{M}'’-]*\.?$/u.exec(name)?.[0] ?? name;
  const words = capitalized.split(" ");
  let first = 0;
  while (
    first < words.length &&
    /^(?:see|also|cf|accord|compare|quoting|citing|and|or|but|then|e\.g)\.?$/i.test(
      words[first] ?? "",
    )
  ) {
    first++;
  }
  return words.slice(first).join(" ");
};

const insideWord = (text: string, from: number, to: number) =>
  /[\p{L}\p{N}_]$/u.test(text.slice(0, from)) || /^[\p{L}\p{N}_]/u.test(text.slice(to));

export interface ScanRecordCiteOptions {
  /** Whether an earlier resolvable record item exists in the Note, before this text. */
  hasPrevious?: boolean;
}

/** Finds citations in reading order, retaining duplicates and their exact UTF-16 ranges. */
export function scanRecordCites(
  text: string,
  options: ScanRecordCiteOptions = {},
): RecordCiteOccurrence[] {
  const candidates: Candidate[] = [];
  for (const [shapeIndex, shape] of SHAPES.entries()) {
    const source = shape.pattern.source.replace(/^\^/, "").replace(/\$$/, "");
    const flags = shape.pattern.flags.includes("g")
      ? shape.pattern.flags
      : `${shape.pattern.flags}g`;
    const pattern = new RegExp(source, flags);
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const name = shape.scanName?.(match) ?? "";
      const leading = name.length - nameSuffix(name).length;
      const start = match.index + leading;
      const space = /^ +/.exec(text.slice(start, match.index + match[0].length))?.[0].length ?? 0;
      const from = start + space;
      const to = match.index + match[0].length;
      if (!insideWord(text, from, to)) candidates.push({ from, to, shape: shapeIndex });
    }
  }
  candidates.sort((a, b) => a.from - b.from || b.to - a.to || a.shape - b.shape);

  const occurrences: RecordCiteOccurrence[] = [];
  let occupiedTo = -1;
  let lastResolvable: number | null = options.hasPrevious ? -1 : null;
  for (const candidate of candidates) {
    if (candidate.from < occupiedTo) continue;
    const raw = text.slice(candidate.from, candidate.to);
    const result = parseRecordCite(raw, { hasPrevious: lastResolvable !== null });
    const referent =
      result.status === "parsed" && result.reference === "previous" ? lastResolvable : null;
    occurrences.push({ raw, from: candidate.from, to: candidate.to, result, referent });
    occupiedTo = candidate.to;
    if (result.status === "parsed") lastResolvable = occurrences.length - 1;
  }
  return occurrences;
}
