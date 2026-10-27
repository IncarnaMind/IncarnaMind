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

type Draft = Omit<ParsedRecordCite, "status" | "raw">;
type ReadShape = (
  match: RegExpExecArray,
  options: RecordCiteParseOptions,
) => Draft | RecordCiteParseFailureReason;

interface RecordCiteShape {
  pattern: RegExp;
  read: ReadShape;
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
    pattern: /^([a-z]+)-(\d+)$/i,
    read: (match) => batesRange(group(match, 1), group(match, 2), group(match, 2)),
  },
  {
    pattern: /^([a-z]+) (\d+) *[-–—] *(\d+)$/i,
    read: (match) => batesRange(group(match, 1), group(match, 2), group(match, 3)),
  },
  {
    pattern: /^(compl\.?|.+? decl\.?) ¶(¶?) (\d+)(?: *[-–—] *(\d+))?$/i,
    read: readParagraph,
  },
  {
    pattern: /^(?:at )?(\d{1,2}(?::\d{2}){1,2})(?: *[-–—] *(\d{1,2}(?::\d{2}){1,2}))?$/i,
    read: readTime,
  },
  {
    pattern: /^id\.?(?: at (\d+))?$/i,
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
