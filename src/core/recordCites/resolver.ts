import { joinUnits } from "../../shared/locations";
import type { RecordCiteChoice, RecordCiteChoices } from "../../shared/recordCiteChoices";
import { anchorsOf, cutUnit, parseCueTarget, type UnitText } from "../../shared/units";
import type { CitationLocation, RecordCiteResult } from "../api";
import type { ParsedRecordCite, RecordCiteParseResult } from "./parser";

export interface RecordCiteDocument {
  id: string;
  name: string;
  contentHash: string;
  /** A local path or other source detail that distinguishes duplicate names. */
  detail?: string;
  units: readonly UnitText[];
}

export type RecordCiteInput = RecordCiteParseResult & {
  from?: number;
  to?: number;
};

export interface RecordCiteResolution {
  location: CitationLocation;
  pageFrom?: number;
  pageTo?: number;
  passage: string;
  nearby?: RecordCiteResult["nearby"];
}

export type DepositionMapperResult =
  | {
      status: "found";
      location: Extract<CitationLocation, { kind: "page" }>;
      units: UnitText[];
    }
  | { status: "not-found" };

/** Accepts either a parsed printed Location or its saved physical resolution. */
export type ResolveDeposition = (
  units: readonly UnitText[],
  location: Extract<CitationLocation, { kind: "page" }>,
) => DepositionMapperResult;

export interface ResolveRecordCitesInput {
  cites: readonly RecordCiteInput[];
  documents: readonly RecordCiteDocument[];
  choices: RecordCiteChoices;
  resolveDeposition?: ResolveDeposition;
}

type ParsedInput = ParsedRecordCite & { from?: number; to?: number };
type PageLocation = Extract<CitationLocation, { kind: "page" }>;
type SectionLocation = Extract<CitationLocation, { kind: "section" }>;
type TimeLocation = Extract<CitationLocation, { kind: "time" }>;

interface DocumentMatch {
  document: RecordCiteDocument;
  resolution: RecordCiteResolution;
}

interface CiteOutcome {
  result: RecordCiteResult;
  resolved: DocumentMatch | null;
}

const WORD_ALIASES: Record<string, string> = {
  deposition: "dep",
  transcript: "tr",
  exhibit: "ex",
  declaration: "decl",
  complaint: "compl",
  plaintiff: "pl",
  docket: "dkt",
};

const normalize = (value: string) =>
  value
    .trim()
    .replace(/\.[a-z0-9]{1,10}$/i, "")
    .replace(/[.’]/g, (mark) => (mark === "’" ? "'" : ""))
    .replace(/\b(?:ecf|dkt)(?:\s+no)?\b/gi, "dkt")
    .replace(
      /\b(deposition|transcript|exhibit|declaration|complaint|plaintiff|docket)\b/gi,
      (word) => WORD_ALIASES[word.toLocaleLowerCase()] ?? word,
    )
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

export function recordCiteChoiceAlias(cite: ParsedRecordCite): string | null {
  if (cite.sourceAlias) return normalize(cite.sourceAlias);
  if (cite.kind === "time" && cite.location?.kind === "time") {
    return `time:${cite.location.from}:${cite.location.to}`;
  }
  return null;
}

const aliasMatches = (document: RecordCiteDocument, alias: string) => {
  const name = normalize(document.name);
  return name === alias || name.startsWith(`${alias} `);
};

const citeFields = (cite: RecordCiteInput) => ({
  raw: cite.raw,
  ...(cite.from !== undefined && { from: cite.from }),
  ...(cite.to !== undefined && { to: cite.to }),
});

const notFound = (cite: RecordCiteInput): RecordCiteResult => ({
  ...citeFields(cite),
  outcome: "not-found",
});

const choose = (
  cite: RecordCiteInput,
  documents: readonly RecordCiteDocument[],
): RecordCiteResult => ({
  ...citeFields(cite),
  outcome: "choose",
  candidates: documents.map(({ id, name, detail }) => ({ id, name, ...(detail && { detail }) })),
});

const resolved = (
  cite: RecordCiteInput,
  document: RecordCiteDocument,
  resolution: RecordCiteResolution,
): RecordCiteResult => ({
  ...citeFields(cite),
  outcome: "supported",
  documentId: document.id,
  documentName: document.name,
  contentHash: document.contentHash,
  ...resolution,
});

const fromMatches = (cite: RecordCiteInput, matches: readonly DocumentMatch[]): CiteOutcome => {
  const match = matches[0];
  if (matches.length === 1 && match) {
    return { result: resolved(cite, match.document, match.resolution), resolved: match };
  }
  return {
    result:
      matches.length > 1
        ? choose(
            cite,
            matches.map((match) => match.document),
          )
        : notFound(cite),
    resolved: null,
  };
};

const uniqueDocuments = (documents: readonly RecordCiteDocument[]) => {
  const ids = new Set<string>();
  return documents.filter((document) => {
    if (ids.has(document.id)) return false;
    ids.add(document.id);
    return true;
  });
};

const consecutivePages = (pages: readonly number[]) => {
  for (let index = 1; index < pages.length; index++) {
    const previous = pages[index - 1];
    const page = pages[index];
    if (previous === undefined || page === undefined || page !== previous + 1) return false;
  }
  return true;
};

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

const pageCount = (from: number, to: number, unitCount: number) =>
  Number.isSafeInteger(from) &&
  Number.isSafeInteger(to) &&
  from >= 1 &&
  to >= from &&
  to - from + 1 <= unitCount;

const resolveSavedPage = (
  document: RecordCiteDocument,
  location: PageLocation,
): RecordCiteResolution | null => {
  if (location.lines || !pageCount(location.from, location.to, document.units.length)) return null;
  const pages = Array.from(
    { length: location.to - location.from + 1 },
    (_, index) => location.from + index,
  );
  const units = pageUnits(document, pages);
  const first = units?.[0];
  const last = units?.at(-1);
  if (!units || !first || !last) return null;
  if (
    location.printed &&
    ((first.label?.printed ?? String(first.page)) !== location.printed.from ||
      (last.label?.printed ?? String(last.page)) !== location.printed.to)
  ) {
    return null;
  }
  return {
    location,
    pageFrom: location.from,
    pageTo: location.to,
    passage: wholePages(units),
  };
};

const resolvePage = (
  document: RecordCiteDocument,
  requested: PageLocation,
): RecordCiteResolution | null => {
  if (!pageCount(requested.from, requested.to, document.units.length)) return null;
  const labels = Array.from({ length: requested.to - requested.from + 1 }, (_, index) =>
    String(requested.from + index),
  );
  const matches = labels.map((label) => {
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
  if (
    !pages.every((page): page is number => page !== null && Number.isInteger(page) && page >= 1)
  ) {
    return null;
  }
  if (!consecutivePages(pages)) return null;
  const units = pageUnits(document, pages);
  const pageFrom = pages[0];
  const pageTo = pages.at(-1);
  const printedFrom = labels[0];
  const printedTo = labels.at(-1);
  if (!units || pageFrom === undefined || pageTo === undefined || !printedFrom || !printedTo) {
    return null;
  }
  return {
    location: {
      kind: "page",
      from: pageFrom,
      to: pageTo,
      printed: { from: printedFrom, to: printedTo },
    },
    pageFrom,
    pageTo,
    passage: wholePages(units),
  };
};

const mapDeposition = (
  document: RecordCiteDocument,
  location: PageLocation,
  resolveDeposition: ResolveDeposition | undefined,
): RecordCiteResolution | null => {
  const mapped = resolveDeposition?.(document.units, location);
  if (!mapped || mapped.status === "not-found" || mapped.units.length === 0) return null;
  const pages = mapped.units.map((unit) => unit.page);
  if (
    !pages.every((page): page is number => page !== null && Number.isInteger(page) && page >= 1)
  ) {
    return null;
  }
  const pageFrom = pages[0];
  const pageTo = pages.at(-1);
  if (
    pageFrom === undefined ||
    pageTo === undefined ||
    mapped.location.from !== pageFrom ||
    mapped.location.to !== pageTo
  ) {
    return null;
  }
  return {
    location: mapped.location,
    pageFrom,
    pageTo,
    passage: wholePages(mapped.units),
  };
};

type Nearby = NonNullable<RecordCiteResult["nearby"]>;

const asNearby = (resolution: RecordCiteResolution): Nearby | undefined => {
  const { location, pageFrom, pageTo, passage } = resolution;
  return pageFrom !== undefined && pageTo !== undefined
    ? { location, pageFrom, pageTo, passage }
    : undefined;
};

const nearbyDeposition = (
  document: RecordCiteDocument,
  location: PageLocation,
  resolveDeposition: ResolveDeposition | undefined,
): Nearby | undefined => {
  const page = Number(location.printed?.to);
  const lastLine = location.lines?.to;
  if (!Number.isSafeInteger(page) || page < 1 || lastLine === undefined) return undefined;
  for (const [candidatePage, firstLine] of [
    [page, lastLine + 1],
    [page + 1, 1],
  ] as const) {
    for (let count = 10; count >= 1; count--) {
      const mapped = mapDeposition(
        document,
        {
          kind: "page",
          from: location.from,
          to: location.to,
          printed: { from: String(candidatePage), to: String(candidatePage) },
          lines: { from: firstLine, to: firstLine + count - 1 },
        },
        resolveDeposition,
      );
      const nearby = mapped ? asNearby(mapped) : undefined;
      if (nearby) return nearby;
    }
  }
  return undefined;
};

const withNearby = (
  document: RecordCiteDocument,
  resolution: RecordCiteResolution,
  resolveDeposition: ResolveDeposition | undefined,
): RecordCiteResolution => {
  const nearby =
    resolution.location.kind === "page" && resolution.location.lines
      ? nearbyDeposition(document, resolution.location, resolveDeposition)
      : undefined;
  if (nearby && !sameExactLocation(nearby.location, resolution.location)) {
    return { ...resolution, nearby };
  }
  if (resolution.pageTo === undefined) return resolution;
  const [unit] = pageUnits(document, [resolution.pageTo + 1]) ?? [];
  if (!unit || unit.page === null) return resolution;
  const printed = unit.label?.printed ?? String(unit.page);
  return {
    ...resolution,
    nearby: {
      location: {
        kind: "page",
        from: unit.page,
        to: unit.page,
        printed: { from: printed, to: printed },
      },
      pageFrom: unit.page,
      pageTo: unit.page,
      passage: wholePages([unit]),
    },
  };
};

const resolveTime = (
  document: RecordCiteDocument,
  requested: TimeLocation,
): RecordCiteResolution | null => {
  if (
    !Number.isSafeInteger(requested.from) ||
    !Number.isSafeInteger(requested.to) ||
    requested.from < 0 ||
    requested.to < requested.from
  ) {
    return null;
  }
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

const resolveParagraph = (
  document: RecordCiteDocument,
  requested: SectionLocation,
): RecordCiteResolution | null => {
  const paragraphs = requested.paragraphs;
  if (
    !paragraphs ||
    !Number.isSafeInteger(paragraphs.from) ||
    !Number.isSafeInteger(paragraphs.to) ||
    paragraphs.from < 1 ||
    paragraphs.to < paragraphs.from
  ) {
    return null;
  }
  const joined = joinUnits(document.units);
  const labels = printedParagraphs(joined.text);
  const count = paragraphs.to - paragraphs.from + 1;
  if (count > labels.length) return null;
  const wanted = Array.from({ length: count }, (_, index) =>
    labels.filter((label) => label.number === paragraphs.from + index),
  );
  if (wanted.some((matches) => matches.length !== 1)) return null;
  const selected = wanted.flatMap((matches) => (matches[0] ? [matches[0]] : []));
  if (selected.length !== count) return null;
  for (let index = 1; index < selected.length; index++) {
    const previous = selected[index - 1];
    const label = selected[index];
    if (!previous || !label || label.start <= previous.start) return null;
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
    `(?:^|[^a-z0-9])${escapePattern(prefix)}[\\t -]?${identifier}(?![a-z0-9])`,
    "i",
  );
  return (
    pattern.test(unit.text) ||
    (unit.label?.printed !== undefined && pattern.test(unit.label.printed))
  );
};

const resolveBates = (
  document: RecordCiteDocument,
  range: { prefix: string; from: string; to: string },
): RecordCiteResolution | null => {
  const first = Number(range.from);
  const last = Number(range.to);
  const count = last - first + 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || count < 1) return null;
  if (count > document.units.length) return null;
  const identifiers = Array.from({ length: count }, (_, index) =>
    String(first + index).padStart(range.from.length, "0"),
  );
  const matches = identifiers.map((identifier) => {
    const units = document.units.filter(
      (unit) => (unit.kind ?? "page") === "page" && hasBates(unit, range.prefix, identifier),
    );
    return units.length === 1 ? units[0] : null;
  });
  if (!matches.every((unit): unit is UnitText => unit !== null)) return null;
  const pages = matches.map((unit) => unit.page);
  if (
    !pages.every((page): page is number => page !== null && Number.isInteger(page) && page >= 1)
  ) {
    return null;
  }
  if (!consecutivePages(pages)) return null;
  const units = pageUnits(document, pages);
  const pageFrom = pages[0];
  const pageTo = pages.at(-1);
  const firstUnit = matches[0];
  const lastUnit = matches.at(-1);
  if (!units || pageFrom === undefined || pageTo === undefined || !firstUnit || !lastUnit) {
    return null;
  }
  const printedFrom = firstUnit.label?.printed ?? `${range.prefix} ${range.from}`;
  const printedTo = lastUnit.label?.printed ?? `${range.prefix} ${range.to}`;
  return {
    location: {
      kind: "page",
      from: pageFrom,
      to: pageTo,
      printed: { from: printedFrom, to: printedTo },
    },
    pageFrom,
    pageTo,
    passage: wholePages(units),
  };
};

const sameRange = (
  a: { from: number; to: number } | undefined,
  b: { from: number; to: number } | undefined,
) => a === b || (a?.from === b?.from && a?.to === b?.to && a !== undefined && b !== undefined);

const sameExactLocation = (a: CitationLocation, b: CitationLocation): boolean => {
  if (a.kind !== b.kind) return false;
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
    return (
      a.heading === b.heading &&
      a.start === b.start &&
      a.notes === b.notes &&
      a.figure === b.figure &&
      sameRange(a.paragraphs, b.paragraphs)
    );
  }
  return false;
};

const matchesRequest = (cite: ParsedInput, saved: CitationLocation): boolean => {
  const requested = cite.location;
  if (!requested || cite.kind === "bates" || requested.kind !== saved.kind) return false;
  if (requested.kind === "page" && saved.kind === "page") {
    return (
      (saved.printed?.from ?? String(saved.from)) ===
        (requested.printed?.from ?? String(requested.from)) &&
      (saved.printed?.to ?? String(saved.to)) === (requested.printed?.to ?? String(requested.to)) &&
      sameRange(saved.lines, requested.lines)
    );
  }
  if (requested.kind === "section" && saved.kind === "section") {
    return sameRange(saved.paragraphs, requested.paragraphs);
  }
  if (requested.kind === "time" && saved.kind === "time") {
    return saved.from === requested.from && saved.to === requested.to;
  }
  return false;
};

const resolveSavedLocation = (
  document: RecordCiteDocument,
  location: CitationLocation,
  resolveDeposition: ResolveDeposition | undefined,
): RecordCiteResolution | null => {
  const finish = (resolution: RecordCiteResolution | null) =>
    resolution ? withNearby(document, resolution, resolveDeposition) : null;
  if (location.kind === "page") {
    if (!location.lines) return finish(resolveSavedPage(document, location));
    const resolution = mapDeposition(document, location, resolveDeposition);
    return resolution && sameExactLocation(resolution.location, location)
      ? finish(resolution)
      : null;
  }
  if (location.kind === "section") return finish(resolveParagraph(document, location));
  if (location.kind === "time") {
    const resolution = resolveTime(document, location);
    return resolution && sameExactLocation(resolution.location, location)
      ? finish(resolution)
      : null;
  }
  return null;
};

const resolveRequested = (
  cite: ParsedInput,
  document: RecordCiteDocument,
  resolveDeposition: ResolveDeposition | undefined,
): RecordCiteResolution | null => {
  const finish = (resolution: RecordCiteResolution | null) =>
    resolution ? withNearby(document, resolution, resolveDeposition) : null;
  if (cite.kind === "deposition" && cite.location?.kind === "page") {
    return finish(mapDeposition(document, cite.location, resolveDeposition));
  }
  if ((cite.kind === "exhibit" || cite.kind === "docket") && cite.location?.kind === "page") {
    return finish(resolvePage(document, cite.location));
  }
  if (cite.kind === "bates" && cite.bates) {
    return finish(resolveBates(document, cite.bates));
  }
  if (cite.kind === "paragraph" && cite.location?.kind === "section") {
    return finish(resolveParagraph(document, cite.location));
  }
  if (cite.kind === "time" && cite.location?.kind === "time") {
    return finish(resolveTime(document, cite.location));
  }
  return null;
};

const choiceFor = (choices: RecordCiteChoices, alias: string) => {
  const matches = Object.entries(choices.choices).filter(([key]) => normalize(key) === alias);
  if (matches.length === 0) return undefined;
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
};

const chosenDocument = (documents: readonly RecordCiteDocument[], id: string) => {
  const matches = documents.filter((document) => document.id === id);
  return matches.length === 1 ? matches[0] : undefined;
};

const sourceCandidates = (cite: ParsedInput, documents: readonly RecordCiteDocument[]) => {
  if (cite.kind === "bates" || cite.kind === "time") return documents;
  if (!cite.sourceAlias) return [];
  const alias = normalize(cite.sourceAlias);
  return documents.filter((document) => aliasMatches(document, alias));
};

const matchingDocuments = (
  cite: ParsedInput,
  documents: readonly RecordCiteDocument[],
  resolveDeposition: ResolveDeposition | undefined,
) =>
  documents.flatMap((document) => {
    const resolution = resolveRequested(cite, document, resolveDeposition);
    return resolution ? [{ document, resolution }] : [];
  });

const resolveDirect = (
  cite: ParsedInput,
  documents: readonly RecordCiteDocument[],
  choices: RecordCiteChoices,
  resolveDeposition: ResolveDeposition | undefined,
): CiteOutcome => {
  const alias = recordCiteChoiceAlias(cite);
  const saved = alias === null ? undefined : choiceFor(choices, alias);
  const candidates = sourceCandidates(cite, documents);
  if (saved !== undefined) {
    const document = saved ? chosenDocument(documents, saved.documentId) : undefined;
    const savedResolution =
      saved && document ? resolveSavedLocation(document, saved.location, resolveDeposition) : null;
    if (!saved || !document || !savedResolution) {
      const possible = matchingDocuments(cite, candidates, resolveDeposition).map(
        (match) => match.document,
      );
      return {
        result: possible.length === 0 ? notFound(cite) : choose(cite, uniqueDocuments(possible)),
        resolved: null,
      };
    }
    const savedMatch = { document, resolution: savedResolution };
    if (matchesRequest(cite, saved.location)) return fromMatches(cite, [savedMatch]);
    const resolution = resolveRequested(cite, document, resolveDeposition);
    return resolution
      ? fromMatches(cite, [{ document, resolution }])
      : { result: notFound(cite), resolved: null };
  }
  return fromMatches(cite, matchingDocuments(cite, candidates, resolveDeposition));
};

const restorePrevious = (
  documents: readonly RecordCiteDocument[],
  choice: RecordCiteChoice | null,
  resolveDeposition: ResolveDeposition | undefined,
): DocumentMatch | null => {
  if (!choice) return null;
  const document = chosenDocument(documents, choice.documentId);
  if (!document) return null;
  const resolution = resolveSavedLocation(document, choice.location, resolveDeposition);
  return resolution ? { document, resolution } : null;
};

/** Resolves a candidate already chosen by stable Document id, without matching its name again. */
export function resolveChosenRecordCite(
  cite: RecordCiteInput,
  document: RecordCiteDocument,
  resolveDeposition?: ResolveDeposition,
): RecordCiteResult {
  if (cite.status === "error" || cite.reference) return notFound(cite);
  const resolution = resolveRequested(cite, document, resolveDeposition);
  return resolution ? resolved(cite, document, resolution) : notFound(cite);
}

/**
 * Resolves record-cite identity and exact text only. A resolved cite is marked "supported";
 * the claim checker remains responsible for supported/partly support decisions.
 */
export function resolveRecordCites({
  cites,
  documents,
  choices,
  resolveDeposition,
}: ResolveRecordCitesInput): RecordCiteResult[] {
  const results: RecordCiteResult[] = [];
  let previous = restorePrevious(documents, choices.previous, resolveDeposition);
  for (const cite of cites) {
    let outcome: CiteOutcome;
    if (cite.status === "error") {
      outcome = { result: notFound(cite), resolved: null };
    } else if (cite.reference === "previous") {
      if (!previous) {
        outcome = { result: notFound(cite), resolved: null };
      } else if (cite.kind === "id" && cite.location?.kind === "page") {
        const resolution =
          previous.resolution.location.kind === "page" && previous.resolution.location.lines
            ? mapDeposition(
                previous.document,
                {
                  ...cite.location,
                  printed: {
                    from: cite.location.printed?.from ?? String(cite.location.from),
                    to: cite.location.printed?.to ?? String(cite.location.to),
                  },
                },
                resolveDeposition,
              )
            : resolvePage(previous.document, cite.location);
        outcome = resolution
          ? fromMatches(cite, [
              {
                document: previous.document,
                resolution: withNearby(previous.document, resolution, resolveDeposition),
              },
            ])
          : { result: notFound(cite), resolved: null };
      } else {
        outcome = fromMatches(cite, [previous]);
      }
    } else {
      outcome = resolveDirect(cite, documents, choices, resolveDeposition);
    }
    results.push(outcome.result);
    previous = outcome.resolved;
  }
  return results;
}
