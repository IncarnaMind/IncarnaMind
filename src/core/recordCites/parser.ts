import { citedCases } from "../../shared/caseCitations";
import { parseClockTime } from "../../shared/clock";
import { CURRENCY_ISO_CODES } from "../../shared/figures";
import type { CitationLocation } from "../api";
import { recordCiteAlias } from "./alias";

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
  /** "previous": an `Id.` or `supra`, read on the record item it refers back to. */
  reference: "previous" | null;
}

export type RecordCiteParseFailureReason = "malformed" | "out-of-range";

export interface RecordCiteParseFailure {
  status: "error";
  raw: string;
  reason: RecordCiteParseFailureReason;
  /** The shape it was read as, when one matched. */
  kind?: RecordCiteKind;
}

export type RecordCiteParseResult = ParsedRecordCite | RecordCiteParseFailure;

export interface RecordCiteOccurrence {
  raw: string;
  /** UTF-16 offsets in the scanned text; `from` is inclusive and `to` exclusive. */
  from: number;
  to: number;
  result: RecordCiteParseResult;
}

/**
 * A record cite, or another authority's citation, which ends an `Id.` chain: a court decision,
 * a statute, a regulation or rule, a Restatement, a `supra` naming no record item, or an inline
 * node such as a Citation chip.
 */
export type RecordCiteToken =
  | ({ kind: "cite" } & RecordCiteOccurrence)
  | { kind: "authority"; from: number; to: number };

type Draft = Omit<ParsedRecordCite, "status" | "raw">;
type Read = Draft | RecordCiteParseFailureReason;

interface RecordCiteShape {
  kind: RecordCiteKind;
  /** The shape from its own keyword on. */
  body: string;
  flags: string;
  /** Whether words before it name its source, and what stands between them and the keyword. */
  name?: { required: boolean; lead: string };
  /** Reads the body's groups, from 1, and the source's name. */
  read(match: Groups, name: string): Read;
}

type Groups = readonly (string | undefined)[];

const group = (match: Groups, index: number) => match[index] ?? "";

const positiveInteger = (written: string) => {
  const value = Number(written);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
};

const positiveRange = (fromWritten: string, toWritten: string) => {
  const from = positiveInteger(fromWritten);
  const to = positiveInteger(toWritten || fromWritten);
  if (from === null || to === null || to < from) return "out-of-range" as const;
  return { from, to };
};

type Located = CitationLocation | "out-of-range";

const pageRange = (fromWritten: string, toWritten: string): Located => {
  const pages = positiveRange(fromWritten, toWritten);
  return pages === "out-of-range" ? pages : { kind: "page", from: pages.from, to: pages.to };
};

const paragraphRange = (fromWritten: string, toWritten: string): Located => {
  const paragraphs = positiveRange(fromWritten, toWritten);
  return paragraphs === "out-of-range"
    ? paragraphs
    : { kind: "section", heading: null, paragraphs };
};

/** Printed pages and lines: "45:3", "45:3–12" and "45:24–46:2"; a single line ends where it starts. */
const linesRange = (
  fromPageWritten: string,
  fromLineWritten: string,
  toPageWritten: string,
  toLineWritten: string,
): Located => {
  const fromPage = positiveInteger(fromPageWritten);
  const fromLine = positiveInteger(fromLineWritten);
  const toPage = toPageWritten ? positiveInteger(toPageWritten) : fromPage;
  const toLine = toLineWritten ? positiveInteger(toLineWritten) : fromLine;
  if (fromPage === null || fromLine === null || toPage === null || toLine === null) {
    return "out-of-range";
  }
  if (toPage < fromPage || (toPage === fromPage && toLine < fromLine)) return "out-of-range";
  return {
    kind: "page",
    from: fromPage,
    to: toPage,
    printed: { from: fromPageWritten, to: toPageWritten || fromPageWritten },
    lines: { from: fromLine, to: toLine },
  };
};

const direct = (kind: RecordCiteKind, sourceAlias: string | null, location: Located): Read =>
  location === "out-of-range"
    ? location
    : { kind, sourceAlias, location, bates: null, reference: null };

const earlier = (
  kind: "id" | "supra",
  location: Located | null,
  sourceAlias: string | null = null,
): Read =>
  location === "out-of-range"
    ? location
    : { kind, sourceAlias, location, bates: null, reference: "previous" };

const SIGNAL =
  /^(?:see|also|cf|accord|compare|contra|quoting|citing|and|or|but|then|e\.g|i\.e)[.,]*$/i;
const CAPITALIZED = /^\p{Lu}[\p{L}\p{M}\p{N}'’&-]*$/u;
const INITIAL = /^\p{Lu}\.$/u;
const DOTTED_POSSESSIVE = /^\p{L}+\.['’]s?$/u;
const ABBREVIATION =
  /^(?:am|supp|sec|corr|rev|mr|mrs|ms|dr|pl|pls|def|defs|resp|pet|app|opp|mot|br|mem|aff|jt|hr['’]g|prelim|inj|summ|dep|decl|compl|tr|ex)\.$/i;
/** Ends a name ("Acme Inc. Dep."), and as often a sentence ("paid by Acme Inc. Smith Dep."). */
const SUFFIX = /^(?:inc|co|corp|ltd|jr|sr)\.$/i;
const PARTY_POSSESSIVE =
  /^(?:plaintiffs?|defendants?|petitioners?|respondents?|appellants?|appellees?|government|gov['’]t)['’]s?$/i;
const NUMBERED = /^(?:ex|exh|exhibit|no|dkt)\.?$/i;

/** Words a sentence starts with, capitalized there, that never name a source. */
const NOT_A_NAME =
  /^(?:the|a|an|this|that|these|those|his|her|its|our|their|my|your|in|on|at|for|of|to|from|with|by|as|and|or|but|if|when|while)$/i;

const NUMBER = /^\d+[A-Za-z]?$/;

const isNameWord = (word: string, before: string | undefined, after: string | undefined) =>
  (CAPITALIZED.test(word) && !NOT_A_NAME.test(word)) ||
  INITIAL.test(word) ||
  DOTTED_POSSESSIVE.test(word) ||
  ABBREVIATION.test(word) ||
  PARTY_POSSESSIVE.test(word) ||
  (SUFFIX.test(word) && after === undefined) ||
  (/^no\.$/i.test(word) && after !== undefined && NUMBER.test(after)) ||
  (NUMBER.test(word) && before !== undefined && NUMBERED.test(before));

const NAME_TOKEN = /[^\s(（[【「『“"‘;；,，、:：\uFFFC]+/gu;
const NAME_BOUNDARY = /[(（[【「『“"‘;；,，、:：\uFFFC][^(（[【「『“"‘;；,，、:：\uFFFC]*$/u;
/** How far before its keyword a source's name may start. */
const NAME_REACH = 120;

/**
 * The words at the end of a text that name a source, and where they start: capitalized words,
 * initials, a party's possessive and the abbreviations of record names. A word that ends a
 * sentence ("Agreement.") isn't one, so a name never reaches into the sentence before; nor is a
 * leading signal ("See").
 */
function nameAtEnd(text: string): { name: string; at: number } {
  const boundary = NAME_BOUNDARY.exec(text)?.index ?? -1;
  const words = [...text.matchAll(NAME_TOKEN)].filter((word) => word.index > boundary);
  let first = words.length;
  while (
    first > 0 &&
    isNameWord(words[first - 1]?.[0] ?? "", words[first - 2]?.[0], words[first]?.[0])
  )
    first--;
  while (first < words.length && SIGNAL.test(words[first]?.[0] ?? "")) first++;
  const start = words[first];
  if (!start) return { name: "", at: text.length };
  return {
    name: words
      .slice(first)
      .map((word) => word[0])
      .join(" "),
    at: start.index,
  };
}

const aliasOf = (...parts: string[]) => recordCiteAlias(parts.filter(Boolean).join(" "));

const batesRange = (prefix: string, from: string, to: string): Read => {
  const first = Number(from);
  const last = Number(to);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) {
    return "out-of-range";
  }
  return {
    kind: "bates",
    sourceAlias: recordCiteAlias(prefix),
    location: null,
    bates: { prefix: prefix.toUpperCase(), from, to },
    reference: null,
  };
};

const DASH = "\\s*[-–—]\\s*";
const PAGES = `(?:at|pp?\\.?) (\\d+)(?:${DASH}(\\d+))?`;
const LINES = `(\\d+) *: *(\\d+)(?:${DASH}(?:(\\d+) *: *)?(\\d+))?`;
const PARAGRAPHS = `¶¶? ?(\\d+)(?:${DASH}(\\d+))?`;
const CLOCK = "\\d{1,2}(?::\\d{2}){1,2}";
// A Bates number has a leading zero or five digits, so "GDP 2019–2020" and "ISO-9001" aren't one.
const BATES_NUMBER = "(?:0\\d{3,}|\\d{5,})";
const NOT_BATES = `(?!(?:${CURRENCY_ISO_CODES}|FY|CY|ISO)\\b)`;
const SPACE = { required: false, lead: " " };

const SHAPES: readonly RecordCiteShape[] = [
  {
    kind: "deposition",
    body: `(?:dep\\.?|deposition)(?: (?:tr\\.?|transcript))? ${LINES}`,
    flags: "i",
    name: SPACE,
    read: (match, name) =>
      direct(
        "deposition",
        aliasOf(name, "dep"),
        linesRange(group(match, 1), group(match, 2), group(match, 3), group(match, 4)),
      ),
  },
  {
    kind: "exhibit",
    body: `(?:ex\\.?|exh\\.?|exhibit) (\\d+[A-Za-z]?|[A-Z]{1,2}\\d*),? ${PAGES}`,
    flags: "i",
    name: SPACE,
    read: (match, name) =>
      direct(
        "exhibit",
        aliasOf(name, "ex", group(match, 1)),
        pageRange(group(match, 2), group(match, 3)),
      ),
  },
  {
    kind: "docket",
    body: `(?:ecf(?: no\\.?)?|dkt\\.?(?: no\\.?)?|docket no\\.?) (\\d+),? ${PAGES}`,
    flags: "i",
    read: (match) =>
      direct(
        "docket",
        aliasOf("dkt", group(match, 1)),
        pageRange(group(match, 2), group(match, 3)),
      ),
  },
  {
    kind: "bates",
    body: `${NOT_BATES}([A-Z]{2,})[-_ ]?(${BATES_NUMBER})${DASH}(?:\\1[-_ ]?)?(${BATES_NUMBER})`,
    flags: "",
    read: (match) => batesRange(group(match, 1), group(match, 2), group(match, 3)),
  },
  {
    kind: "bates",
    body: `${NOT_BATES}([A-Z]{2,})(?:[-_](${BATES_NUMBER})|(0\\d{3,}))`,
    flags: "",
    read: (match) => {
      const identifier = group(match, 2) || group(match, 3);
      return batesRange(group(match, 1), identifier, identifier);
    },
  },
  {
    kind: "paragraph",
    body: `(compl\\.?|complaint|decl\\.?|declaration|aff\\.?|affidavit) ${PARAGRAPHS}`,
    flags: "i",
    name: SPACE,
    read: (match, name) =>
      direct(
        "paragraph",
        aliasOf(name, group(match, 1)),
        paragraphRange(group(match, 2), group(match, 3)),
      ),
  },
  {
    kind: "time",
    body: `(?:tr\\.?|transcript) at (${CLOCK})(?:${DASH}(${CLOCK}))?`,
    flags: "i",
    name: { required: true, lead: " " },
    read: (match, name) => {
      const start = parseClockTime(group(match, 1));
      const end = group(match, 2) ? parseClockTime(group(match, 2)) : start;
      if (start === null || end === null || end < start) return "out-of-range";
      return direct("time", aliasOf(name), { kind: "time", from: start, to: end });
    },
  },
  {
    kind: "id",
    body: `[Ii]d\\.(?: at (?:${LINES}|(\\d+)(?:${DASH}(\\d+))?)|,? ${PARAGRAPHS})?`,
    flags: "",
    read: (match) =>
      group(match, 1)
        ? earlier(
            "id",
            linesRange(group(match, 1), group(match, 2), group(match, 3), group(match, 4)),
          )
        : group(match, 5)
          ? earlier("id", pageRange(group(match, 5), group(match, 6)))
          : group(match, 7)
            ? earlier("id", paragraphRange(group(match, 7), group(match, 8)))
            : earlier("id", null),
  },
  {
    kind: "supra",
    body: `supra(?:,? (?:at|pp?\\.?) (?:${LINES}|(\\d+)(?:${DASH}(\\d+))?)|,? ${PARAGRAPHS})?`,
    flags: "i",
    name: { required: true, lead: ",? " },
    read: (match, name) =>
      earlier(
        "supra",
        group(match, 1)
          ? linesRange(group(match, 1), group(match, 2), group(match, 3), group(match, 4))
          : group(match, 5)
            ? pageRange(group(match, 5), group(match, 6))
            : group(match, 7)
              ? paragraphRange(group(match, 7), group(match, 8))
              : null,
        aliasOf(name),
      ),
  },
];

const anchored = SHAPES.map(
  (shape) =>
    new RegExp(
      `^${shape.name ? `(?:(.+?)${shape.name.lead})${shape.name.required ? "" : "?"}` : ""}(?:${shape.body})$`,
      shape.flags,
    ),
);
const scanning = SHAPES.map((shape) => new RegExp(shape.body, `${shape.flags}g`));
const leads = SHAPES.map((shape) => (shape.name ? new RegExp(`${shape.name.lead}$`) : null));

/** Full-width digits, colon and hyphen ("４５：３－４") as ASCII, each one UTF-16 unit, so offsets hold. */
const halfWidth = (text: string) =>
  text.replace(/[\uFF0D\uFF10-\uFF1A]/g, (char) =>
    String.fromCharCode((char.codePointAt(0) ?? 0) - 0xfee0),
  );

// A name that says it is a record item's ("Smith Decl., supra"), unlike a decision's or an article's ("Smith, supra").
const RECORD_NAME = /\b(?:dep|decl|ex|compl|dkt|aff|tr)\b/;

/**
 * Reads one record cite without resolving its source; failures are values, never exceptions.
 * The resolver maps a deposition's printed page labels to its physical PDF Units.
 */
export function parseRecordCite(raw: string): RecordCiteParseResult {
  const text = halfWidth(raw.trim().replace(/\s+/g, " "));
  for (const [index, shape] of SHAPES.entries()) {
    const match = anchored[index]?.exec(text);
    if (!match) continue;
    const name = shape.name ? nameAtEnd(group(match, 1)) : null;
    if (shape.name?.required && !name?.name) continue;
    // A named shape's name is group 1, so its body's groups follow it.
    const body = shape.name ? [match[0], ...match.slice(2)] : match;
    const result = shape.read(body, name?.name ?? "");
    if (typeof result === "string")
      return { status: "error", raw, reason: result, kind: shape.kind };
    return { status: "parsed", raw, ...result };
  }
  return { status: "error", raw, reason: "malformed" };
}

// Chinese runs straight on into a cite ("见Ex. 7 at 3"), so only a Latin letter or a digit joins one.
const insideWord = (text: string, from: number, to: number) =>
  /[\p{Script=Latin}\p{N}_]$/u.test(text.slice(0, from)) ||
  /^[\p{Script=Latin}\p{N}_]/u.test(text.slice(to));

/**
 * A cite that goes on past what its shape reads ("Ex. 7 at 3, 5", "PL-000123–125", "Smith Dep.,
 * supra note 3, at 46", "Id. § 4") isn't read in part.
 */
const CONTINUES =
  /^(?:\s*[-–—:]\s*\d|,\s*[\d¶§]|\s*[-–—]\s*(?:$|[).,;])|\s*§|,?\s*(?:note|n\.)\s*\d|,?\s*at\s+\d)/i;

/** Another authority than the record or a court decision: a statute, a regulation, a rule, a Restatement, an inline node. */
const AUTHORITY = /§|\uFFFC|\b(?:U\.S\.C|C\.F\.R|Fed\. R|U\.S\. Const|Restatement|Stat\.|Rule \d)/g;

const INLINE_NODE = "\uFFFC";
const SENTENCE_END = /[.!?](?=\s)|[。！？]/;

/**
 * Whether an inline node at `at` follows a record cite in its own sentence: a Citation chip
 * there cites what the cite names ("ECF No. 41 at 3 states it ￼."), not another authority.
 */
function citesSameSentence(text: string, tokens: readonly RecordCiteToken[], at: number): boolean {
  const before = tokens.findLast((token) => token.kind === "cite" && token.to <= at);
  return before !== undefined && !SENTENCE_END.test(text.slice(before.to, at));
}

const DEPOSITION = SHAPES.findIndex((shape) => shape.kind === "deposition");
const ID = SHAPES.findIndex((shape) => shape.kind === "id");
const SUPRA = SHAPES.findIndex((shape) => shape.kind === "supra");
/** Where an `Id.` starts a cite: a text's or sentence's start, after a bracket, a stop or a signal ("user id." isn't one). */
const ID_BEFORE =
  /(?:^|[(（[;；,，.。:：]|\b(?:see|also|cf\.?|accord|but|e\.g\.,?|compare|and|contra))\s*$/i;
/** A further page and lines of the same deposition: "Smith Dep. 45:3–12, 47:1–4". */
const MORE_LINES = new RegExp(`^[,;] *${LINES}`);

interface Candidate {
  from: number;
  to: number;
  shape: number;
  /** False for a `supra` whose name isn't a record item's: another authority's short form. */
  record: boolean;
}

function candidatesIn(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [index, shape] of SHAPES.entries()) {
    const pattern = scanning[index];
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const end = match.index + match[0].length;
      let from = match.index;
      let named = "";
      const before = text.slice(Math.max(0, match.index - NAME_REACH), match.index);
      const lead = leads[index]?.exec(before);
      if (shape.name && lead) {
        const words = before.slice(0, lead.index);
        const name = nameAtEnd(words);
        if (name.name) {
          from = match.index - before.length + name.at;
          named = name.name;
        }
      }
      if (shape.name?.required && from === match.index) continue;
      if (index === ID && !ID_BEFORE.test(text.slice(Math.max(0, from - NAME_REACH), from)))
        continue;
      const record = index !== SUPRA || RECORD_NAME.test(recordCiteAlias(named));
      if (!insideWord(text, from, end)) candidates.push({ from, to: end, shape: index, record });
    }
  }
  return candidates.sort((a, b) => a.from - b.from || b.to - a.to || a.shape - b.shape);
}

/** A candidate's cites as written in `text`, read in `scanned`: the same text with `halfWidth`'s digits. */
function readCandidate(
  text: string,
  scanned: string,
  candidate: Candidate,
): RecordCiteOccurrence[] {
  const raw = text.slice(candidate.from, candidate.to);
  const head: RecordCiteOccurrence = {
    raw,
    from: candidate.from,
    to: candidate.to,
    result: parseRecordCite(raw),
  };
  const occurrences = [head];
  let to = candidate.to;
  if (candidate.shape === DEPOSITION && head.result.status === "parsed") {
    const { sourceAlias } = head.result;
    for (
      let more = MORE_LINES.exec(scanned.slice(to));
      more;
      more = MORE_LINES.exec(scanned.slice(to))
    ) {
      const from = to + more[0].length - more[0].replace(/^[,;] */, "").length;
      to += more[0].length;
      const location = linesRange(group(more, 1), group(more, 2), group(more, 3), group(more, 4));
      const written = text.slice(from, to);
      occurrences.push({
        raw: written,
        from,
        to,
        result:
          location === "out-of-range"
            ? { status: "error", raw: written, reason: location }
            : {
                status: "parsed",
                raw: written,
                kind: "deposition",
                sourceAlias,
                location,
                bates: null,
                reference: null,
              },
      });
    }
  }
  const last = occurrences.at(-1);
  if (last && CONTINUES.test(scanned.slice(to))) {
    const { kind } = last.result;
    last.result = { status: "error", raw: last.raw, reason: "malformed", ...(kind && { kind }) };
  }
  return occurrences;
}

/** The record cites and other authorities' citations in a text, in reading order, none overlapping. */
export function recordCiteTokens(text: string): RecordCiteToken[] {
  const scanned = halfWidth(text);
  const cases = citedCases(text);
  const cites: RecordCiteToken[] = [];
  let occupiedTo = -1;
  for (const candidate of candidatesIn(scanned)) {
    if (candidate.from < occupiedTo) continue;
    if (cases.some((each) => candidate.from < each.to && candidate.to > each.from)) continue;
    if (!candidate.record) {
      cites.push({ kind: "authority", from: candidate.from, to: candidate.to });
      occupiedTo = candidate.to;
      continue;
    }
    const occurrences = readCandidate(text, scanned, candidate);
    occupiedTo = occurrences.at(-1)?.to ?? candidate.to;
    cites.push(...occurrences.map((occurrence) => ({ kind: "cite" as const, ...occurrence })));
  }
  const others = [...scanned.matchAll(AUTHORITY)]
    .filter((match) => match[0] !== INLINE_NODE || !citesSameSentence(scanned, cites, match.index))
    .map((match) => ({ from: match.index, to: match.index + match[0].length }));
  const authorities = [...cases, ...others]
    .filter(({ from, to }) => !cites.some((cite) => from < cite.to && to > cite.from))
    .map(({ from, to }) => ({ kind: "authority" as const, from, to }));
  return [...cites, ...authorities].sort((a, b) => a.from - b.from);
}

/** Where record cites are in a text, so a sentence break never falls inside one. */
export const recordCiteSpans = (text: string): { from: number; to: number }[] =>
  candidatesIn(halfWidth(text)).map(({ from, to }) => ({ from, to }));
