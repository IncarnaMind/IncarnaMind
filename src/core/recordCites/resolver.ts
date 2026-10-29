import { joinUnits } from "../../shared/locations";
import type { RecordCiteChoice } from "../../shared/recordCiteChoices";
import { anchorsOf, cutUnit, parseCueTarget, type UnitText } from "../../shared/units";
import type { CitationLocation, RecordCiteResult } from "../api";
import { recordCiteAliasMatches } from "./alias";
import type { ParsedRecordCite, RecordCiteParseResult } from "./parser";

export interface RecordCiteDocument {
  id: string;
  name: string;
  contentHash: string;
  /** Read only when the Document's name is the cite's, or it holds the cite's Bates number. */
  readonly units: readonly UnitText[];
}

export type ResolvableRecordCiteResult = Omit<RecordCiteResult, "outcome"> & {
  outcome: RecordCiteResult["outcome"] | "found";
  nearbyCandidates?: NonNullable<RecordCiteResult["nearby"]>[];
};

export type RecordCiteInput = RecordCiteParseResult & {
  from?: number;
  to?: number;
  /** An `Id.`'s or `supra`'s record item, by its index in the same list (see `linkRecordCites`). */
  referent?: number | null;
};

export interface RecordCiteResolution {
  location: CitationLocation;
  pageFrom?: number;
  pageTo?: number;
  passage: string;
  nearby?: RecordCiteResult["nearby"];
  nearbyCandidates?: NonNullable<RecordCiteResult["nearby"]>[];
}

export type DepositionMapperResult =
  | {
      status: "found";
      location: Extract<CitationLocation, { kind: "page" }>;
      units: UnitText[];
    }
  | { status: "not-found" };

/** Maps a deposition's printed pages and lines to the physical Units that hold them. */
export interface DepositionMapper {
  resolve(
    units: readonly UnitText[],
    location: Extract<CitationLocation, { kind: "page" }>,
  ): DepositionMapperResult;
  /** The last printed line of a printed page, when its lines are numbered without a gap. */
  lastLine(units: readonly UnitText[], page: number): number | null;
}

export interface ResolveRecordCitesInput {
  cites: readonly RecordCiteInput[];
  documents: readonly RecordCiteDocument[];
  /** The Note's source choices, by canonical alias. */
  choices: Readonly<Record<string, RecordCiteChoice>>;
  deposition?: DepositionMapper;
  /** The Documents that may hold a Bates number, from the keyword index; every one when absent. */
  batesHolders?(prefix: string, identifier: string): ReadonlySet<string>;
  /** How many cites, at the end, are the sentence's own; the others are only what they refer to. */
  own?: number;
}

type ParsedInput = ParsedRecordCite & { from?: number; to?: number };
type PageLocation = Extract<CitationLocation, { kind: "page" }>;
type SectionLocation = Extract<CitationLocation, { kind: "section" }>;
type TimeLocation = Extract<CitationLocation, { kind: "time" }>;
type Nearby = NonNullable<RecordCiteResult["nearby"]>;

interface DocumentMatch {
  document: RecordCiteDocument;
  resolution: RecordCiteResolution;
}

interface CiteOutcome {
  result: ResolvableRecordCiteResult;
  resolved: DocumentMatch | null;
}

/** The key a cite's source choice is kept under: its source's alias, or its Bates range. */
export function recordCiteChoiceAlias(cite: ParsedRecordCite): string | null {
  if (cite.bates) return `bates:${cite.bates.prefix}:${cite.bates.from}:${cite.bates.to}`;
  return cite.sourceAlias;
}

const citeFields = (cite: RecordCiteInput) => ({
  raw: cite.raw,
  ...(cite.from !== undefined && { from: cite.from }),
  ...(cite.to !== undefined && { to: cite.to }),
});

const notFound = (cite: RecordCiteInput): CiteOutcome => ({
  result: { ...citeFields(cite), outcome: "not-found" },
  resolved: null,
});

const choose = (cite: RecordCiteInput, documents: readonly RecordCiteDocument[]): CiteOutcome =>
  documents.length === 0
    ? notFound(cite)
    : {
        result: {
          ...citeFields(cite),
          outcome: "choose",
          candidates: documents.map(({ id, name }) => ({ id, name })),
        },
        resolved: null,
      };

const found = (cite: RecordCiteInput, match: DocumentMatch): CiteOutcome => ({
  result: {
    ...citeFields(cite),
    outcome: "found",
    documentId: match.document.id,
    documentName: match.document.name,
    contentHash: match.document.contentHash,
    ...match.resolution,
  },
  resolved: match,
});

const isPage = (page: number | null): page is number =>
  page !== null && Number.isInteger(page) && page >= 1;

const consecutive = (pages: readonly number[]) =>
  pages.every((page, index) => index === 0 || page === (pages[index - 1] ?? 0) + 1);

const pageUnits = (document: RecordCiteDocument, pages: readonly number[]) => {
  const units = pages.map((page) => {
    const matches = document.units.filter(
      (unit) => (unit.kind ?? "page") === "page" && unit.page === page,
    );
    return matches.length === 1 ? matches[0] : null;
  });
  return units.every((unit): unit is UnitText => unit !== null) ? units : null;
};

const wholePages = (units: readonly UnitText[]) =>
  units.map((unit) => cutUnit(unit, 0, unit.text.length).text).join("\n");

const printedOf = (unit: UnitText) => unit.label?.printed ?? String(unit.page);

/** Pages by the numbers they print, else by their place in the file; each printed number once. */
const resolvePage = (
  document: RecordCiteDocument,
  requested: PageLocation,
): RecordCiteResolution | null => {
  const count = requested.to - requested.from + 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > document.units.length) return null;
  const matches = Array.from({ length: count }, (_, index) => {
    const label = String(requested.from + index);
    const units = document.units.filter(
      (unit) =>
        (unit.kind ?? "page") === "page" &&
        (unit.label?.printed === undefined
          ? unit.page === Number(label)
          : unit.label.printed === label),
    );
    return units.length === 1 ? units[0] : null;
  });
  if (!matches.every((unit): unit is UnitText => unit !== null)) return null;
  const pages = matches.map((unit) => unit.page);
  if (!pages.every(isPage) || !consecutive(pages)) return null;
  const first = matches[0];
  const last = matches.at(-1);
  const pageFrom = pages[0];
  const pageTo = pages.at(-1);
  if (!first || !last || pageFrom === undefined || pageTo === undefined) return null;
  return {
    location: {
      kind: "page",
      from: pageFrom,
      to: pageTo,
      printed: { from: printedOf(first), to: printedOf(last) },
    },
    pageFrom,
    pageTo,
    passage: wholePages(matches),
  };
};

const mapDeposition = (
  document: RecordCiteDocument,
  location: PageLocation,
  deposition: DepositionMapper | undefined,
): RecordCiteResolution | null => {
  const mapped = deposition?.resolve(document.units, location);
  if (!mapped || mapped.status === "not-found" || mapped.units.length === 0) return null;
  const pages = mapped.units.map((unit) => unit.page);
  if (!pages.every(isPage)) return null;
  const pageFrom = pages[0];
  const pageTo = pages.at(-1);
  if (pageFrom === undefined || pageTo === undefined) return null;
  if (mapped.location.from !== pageFrom || mapped.location.to !== pageTo) return null;
  return { location: mapped.location, pageFrom, pageTo, passage: wholePages(mapped.units) };
};

const asNearby = (resolution: RecordCiteResolution | null): Nearby | null => {
  if (!resolution) return null;
  const { location, pageFrom, pageTo, passage } = resolution;
  return pageFrom !== undefined && pageTo !== undefined
    ? { location, pageFrom, pageTo, passage }
    : null;
};

/** How many lines before and after a deposition cite are offered when it doesn't back the claim. */
const NEARBY_LINES = 10;

/** The lines just after a deposition cite and just before it, a page break on either side included. */
function nearbyLines(
  document: RecordCiteDocument,
  location: PageLocation,
  deposition: DepositionMapper,
): Nearby[] {
  const firstPage = Number(location.printed?.from);
  const lastPage = Number(location.printed?.to);
  const lines = location.lines;
  if (!lines || !Number.isSafeInteger(firstPage) || !Number.isSafeInteger(lastPage)) return [];
  const at = (page: number, from: number, to: number) =>
    page >= 1 && from >= 1 && to >= from
      ? asNearby(
          mapDeposition(
            document,
            {
              kind: "page",
              from: location.from,
              to: location.to,
              printed: { from: String(page), to: String(page) },
              lines: { from, to },
            },
            deposition,
          ),
        )
      : null;
  const pageStart = (page: number) => {
    const last = deposition.lastLine(document.units, page);
    return last === null ? null : at(page, 1, Math.min(NEARBY_LINES, last));
  };
  const pageEnd = (page: number) => {
    const last = deposition.lastLine(document.units, page);
    return last === null ? null : at(page, Math.max(1, last - NEARBY_LINES + 1), last);
  };
  const lastOnPage = deposition.lastLine(document.units, lastPage);
  const after =
    lastOnPage === null
      ? null
      : lines.to < lastOnPage
        ? at(lastPage, lines.to + 1, Math.min(lastOnPage, lines.to + NEARBY_LINES))
        : pageStart(lastPage + 1);
  const before =
    lines.from > 1
      ? at(firstPage, Math.max(1, lines.from - NEARBY_LINES), lines.from - 1)
      : pageEnd(firstPage - 1);
  return [after, before].filter((each): each is Nearby => each !== null);
}

/** The physical pages on either side of what a cite reads. */
function nearbyPages(document: RecordCiteDocument, resolution: RecordCiteResolution): Nearby[] {
  return [
    [resolution.pageTo, 1],
    [resolution.pageFrom, -1],
  ].flatMap(([page, step]) => {
    if (page === undefined || step === undefined) return [];
    const [unit] = pageUnits(document, [page + step]) ?? [];
    if (!unit || unit.page === null) return [];
    const printed = printedOf(unit);
    return [
      {
        location: {
          kind: "page" as const,
          from: unit.page,
          to: unit.page,
          printed: { from: printed, to: printed },
        },
        pageFrom: unit.page,
        pageTo: unit.page,
        passage: wholePages([unit]),
      },
    ];
  });
}

const withNearby = (
  match: DocumentMatch,
  deposition: DepositionMapper | undefined,
): DocumentMatch => {
  const { document, resolution } = match;
  const lines =
    resolution.location.kind === "page" && resolution.location.lines && deposition
      ? nearbyLines(document, resolution.location, deposition)
      : [];
  const candidates = (lines.length > 0 ? lines : nearbyPages(document, resolution)).filter(
    (candidate, index, all) =>
      !sameExactLocation(candidate.location, resolution.location) &&
      all.findIndex((each) => sameExactLocation(each.location, candidate.location)) === index,
  );
  return candidates.length === 0
    ? match
    : {
        document,
        resolution: { ...resolution, nearby: candidates[0], nearbyCandidates: candidates },
      };
};

const resolveTime = (
  document: RecordCiteDocument,
  requested: TimeLocation,
): RecordCiteResolution | null => {
  if (requested.from < 0 || requested.to < requested.from) return null;
  const cues = document.units.flatMap((unit) => {
    if (unit.kind !== "cues") return [];
    return anchorsOf(unit).flatMap((anchor, index) => {
      const time = parseCueTarget(anchor.target);
      return time && time.startMs <= time.endMs ? [{ unit, anchor, index, ...time }] : [];
    });
  });
  const selected = cues.filter((cue) =>
    requested.from === requested.to
      ? cue.startMs <= requested.from && requested.from < cue.endMs
      : cue.startMs < requested.to && cue.endMs > requested.from,
  );
  const first = selected[0];
  if (!first) return null;
  const speaker = first.unit.label?.speakers?.[first.index];
  return {
    location: {
      kind: "time",
      from: first.startMs,
      to: Math.max(...selected.map((cue) => cue.endMs)),
      ...(speaker ? { speaker } : {}),
    },
    passage: selected
      .map((cue) => cutUnit(cue.unit, cue.anchor.start, cue.anchor.end).text)
      .join("\n"),
  };
};

interface PrintedParagraph {
  number: number;
  start: number;
}

const printedParagraphs = (text: string): PrintedParagraph[] => {
  const labels: PrintedParagraph[] = [];
  const pattern = /^[ \t]*(?:¶[ \t]*(\d+)|(\d+)\.)(?=[ \t]|$)/gm;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const number = Number(match[1] ?? match[2]);
    if (Number.isSafeInteger(number)) labels.push({ number, start: match.index });
  }
  return labels;
};

const passageSpan = (
  units: readonly UnitText[],
  starts: readonly number[],
  start: number,
  end: number,
) => {
  const parts = units.flatMap((unit, index) => {
    const offset = starts[index];
    if (offset === undefined) return [];
    const from = Math.max(start, offset) - offset;
    const to = Math.min(end, offset + unit.text.length) - offset;
    return from < to ? [{ unit, text: cutUnit(unit, from, to).text }] : [];
  });
  const pages = parts.flatMap(({ unit }) =>
    (unit.kind ?? "page") === "page" && unit.page !== null ? [unit.page] : [],
  );
  const pageFrom = pages[0];
  const pageTo = pages.at(-1);
  return {
    ...(pages.length === parts.length && pageFrom !== undefined && pageTo !== undefined
      ? { pageFrom, pageTo }
      : {}),
    passage: parts.map((part) => part.text).join("\n"),
  };
};

/** Numbered paragraphs ("¶ 14", "14."), each number once and in order, read to the next one. */
const resolveParagraph = (
  document: RecordCiteDocument,
  requested: SectionLocation,
): RecordCiteResolution | null => {
  const paragraphs = requested.paragraphs;
  if (!paragraphs || paragraphs.from < 1 || paragraphs.to < paragraphs.from) return null;
  const joined = joinUnits(document.units);
  const labels = printedParagraphs(joined.text);
  const count = paragraphs.to - paragraphs.from + 1;
  if (count > labels.length) return null;
  const selected: PrintedParagraph[] = [];
  for (let index = 0; index < count; index++) {
    const matches = labels.filter((label) => label.number === paragraphs.from + index);
    const label = matches[0];
    if (matches.length !== 1 || !label) return null;
    if (selected.length > 0 && label.start <= (selected.at(-1)?.start ?? 0)) return null;
    selected.push(label);
  }
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  const next = labels.find((label) => label.start > last.start);
  let end = next?.start ?? joined.text.length;
  if (joined.text[end - 1] === "\n") end--;
  if (joined.text[end - 1] === "\r") end--;
  return { location: requested, ...passageSpan(document.units, joined.starts, first.start, end) };
};

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasBates = (unit: UnitText, prefix: string, identifier: string) => {
  const pattern = new RegExp(
    `(?:^|[^a-z0-9])${escapePattern(prefix)}[\\t _-]?${identifier}(?![a-z0-9])`,
    "i",
  );
  return (
    pattern.test(unit.text) ||
    (unit.label?.printed !== undefined && pattern.test(unit.label.printed))
  );
};

/** One page for each Bates number of the range, in order, with no other page between them. */
const resolveBates = (
  document: RecordCiteDocument,
  range: { prefix: string; from: string; to: string },
): RecordCiteResolution | null => {
  const start = Number(range.from);
  const count = Number(range.to) - start + 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > document.units.length) return null;
  const identifiers = Array.from({ length: count }, (_, index) =>
    String(start + index).padStart(range.from.length, "0"),
  );
  const matches = identifiers.map((identifier) => {
    const units = document.units.filter(
      (unit) => (unit.kind ?? "page") === "page" && hasBates(unit, range.prefix, identifier),
    );
    return units.length === 1 ? units[0] : null;
  });
  if (!matches.every((unit): unit is UnitText => unit !== null)) return null;
  const pages = matches.map((unit) => unit.page);
  if (!pages.every(isPage) || !consecutive(pages)) return null;
  const first = matches[0];
  const last = matches.at(-1);
  const pageFrom = pages[0];
  const pageTo = pages.at(-1);
  if (!first || !last || pageFrom === undefined || pageTo === undefined) return null;
  return {
    location: {
      kind: "page",
      from: pageFrom,
      to: pageTo,
      printed: {
        from: first.label?.printed ?? `${range.prefix} ${range.from}`,
        to: last.label?.printed ?? `${range.prefix} ${range.to}`,
      },
    },
    pageFrom,
    pageTo,
    passage: wholePages(matches),
  };
};

const sameRange = (
  a: { from: number; to: number } | undefined,
  b: { from: number; to: number } | undefined,
) => (a === undefined ? b === undefined : b !== undefined && a.from === b.from && a.to === b.to);

const sameExactLocation = (a: CitationLocation, b: CitationLocation): boolean => {
  if (a.kind === "page" && b.kind === "page") {
    return (
      a.from === b.from &&
      a.to === b.to &&
      a.printed?.from === b.printed?.from &&
      a.printed?.to === b.printed?.to &&
      sameRange(a.lines, b.lines)
    );
  }
  if (a.kind === "time" && b.kind === "time") {
    return a.from === b.from && a.to === b.to && a.speaker === b.speaker;
  }
  if (a.kind === "section" && b.kind === "section") {
    return a.heading === b.heading && sameRange(a.paragraphs, b.paragraphs);
  }
  return false;
};

/** A Location read on a Document already known: a direct cite's, or a short form's on its referent's. */
const resolveOn = (
  document: RecordCiteDocument,
  location: CitationLocation,
  deposition: DepositionMapper | undefined,
  { transcript }: { transcript: boolean },
): RecordCiteResolution | null => {
  if (location.kind === "page") {
    return location.lines || transcript
      ? mapDeposition(
          document,
          {
            ...location,
            printed: location.printed ?? {
              from: String(location.from),
              to: String(location.to),
            },
          },
          deposition,
        )
      : resolvePage(document, location);
  }
  if (location.kind === "section") return resolveParagraph(document, location);
  if (location.kind === "time") return resolveTime(document, location);
  return null;
};

const resolveRequested = (
  cite: ParsedInput,
  document: RecordCiteDocument,
  deposition: DepositionMapper | undefined,
): RecordCiteResolution | null => {
  if (cite.kind === "bates") return cite.bates ? resolveBates(document, cite.bates) : null;
  return cite.location
    ? resolveOn(document, cite.location, deposition, { transcript: cite.kind === "deposition" })
    : null;
};

function sourceCandidates(
  cite: ParsedInput,
  documents: readonly RecordCiteDocument[],
  batesHolders: ResolveRecordCitesInput["batesHolders"],
): readonly RecordCiteDocument[] {
  if (cite.kind === "bates" && cite.bates) {
    if (!batesHolders) return documents;
    const { prefix } = cite.bates;
    const first = batesHolders(prefix, cite.bates.from);
    const last = batesHolders(prefix, cite.bates.to);
    return documents.filter((document) => first.has(document.id) && last.has(document.id));
  }
  const alias = cite.sourceAlias;
  return alias ? documents.filter((document) => recordCiteAliasMatches(document.name, alias)) : [];
}

const resolveDirect = (
  cite: ParsedInput,
  { documents, choices, deposition, batesHolders }: ResolveRecordCitesInput,
): CiteOutcome => {
  const possible = sourceCandidates(cite, documents, batesHolders).flatMap((document) => {
    const resolution = resolveRequested(cite, document, deposition);
    return resolution ? [{ document, resolution }] : [];
  });
  const alias = recordCiteChoiceAlias(cite);
  const saved = alias === null ? undefined : choices[alias];
  if (saved) {
    const chosen = documents.find((document) => document.id === saved.documentId);
    // The User's answer no longer stands once its Document is gone or has changed: ask again.
    if (!chosen || chosen.contentHash !== saved.contentHash) {
      return choose(
        cite,
        possible.map((match) => match.document),
      );
    }
    const match = possible.find((each) => each.document.id === chosen.id);
    if (match) return found(cite, match);
  }
  const only = possible[0];
  if (possible.length === 1 && only) return found(cite, only);
  return choose(
    cite,
    possible.map((match) => match.document),
  );
};

const resolveShortForm = (
  cite: ParsedInput,
  referent: DocumentMatch | null,
  deposition: DepositionMapper | undefined,
): CiteOutcome => {
  if (!referent) return notFound(cite);
  if (!cite.location) return found(cite, referent);
  const { location } = referent.resolution;
  const resolution = resolveOn(referent.document, cite.location, deposition, {
    transcript: location.kind === "page" && location.lines !== undefined,
  });
  return resolution ? found(cite, { document: referent.document, resolution }) : notFound(cite);
};

/** Resolves a candidate the User chose by its stable Document id, without matching its name again. */
export function resolveChosenRecordCite(
  cite: RecordCiteInput,
  document: RecordCiteDocument,
  deposition?: DepositionMapper,
): ResolvableRecordCiteResult {
  if (cite.status === "error" || cite.reference) return notFound(cite).result;
  const resolution = resolveRequested(cite, document, deposition);
  return resolution
    ? found(cite, withNearby({ document, resolution }, deposition)).result
    : notFound(cite).result;
}

/**
 * Resolves each record cite's Document and exact text, in order, an `Id.` or `supra` on its
 * referent's. A resolved cite is "found": the check decides whether it backs the claim.
 */
export function resolveRecordCites(input: ResolveRecordCitesInput): ResolvableRecordCiteResult[] {
  const matches: (DocumentMatch | null)[] = [];
  const firstOwn = input.cites.length - (input.own ?? input.cites.length);
  return input.cites.map((cite, index) => {
    const outcome =
      cite.status === "error"
        ? notFound(cite)
        : cite.reference === "previous"
          ? resolveShortForm(
              cite,
              typeof cite.referent === "number" ? (matches[cite.referent] ?? null) : null,
              input.deposition,
            )
          : resolveDirect(cite, input);
    matches.push(outcome.resolved);
    return outcome.resolved && index >= firstOwn
      ? found(cite, withNearby(outcome.resolved, input.deposition)).result
      : outcome.result;
  });
}
