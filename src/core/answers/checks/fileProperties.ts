/**
 * A sentence about a Document's file itself (#2458): when the file was created or last modified,
 * its author as the file records it, its page, slide or sheet count, its size or its file name.
 * The model decides that a sentence is one: its search asks for the file properties, which come
 * after the Passages as one Passage per Document, under a version of their own, so `cite` finds a
 * quote of them in their text and never in the Document's. Its reply names the properties the
 * sentence states on a Property line. The result keeps to these rules, and fails closed:
 * - A quote is of a property only when it is on that property's one line.
 * - A property decides only a sentence whose Property line names it, and a sentence whose line
 *   names one is Supported only with that property's Citation.
 * - This computer's dates decide nothing: a sentence about a date of a file that records none of
 *   its own is Unsupported, with the line that says only this computer's date is known.
 * - The time a Document was added to IncarnaMind is never shown, so it never decides.
 * - A property's words are never a correction of the sentence's.
 * A check whose Run shows no properties is as it was.
 */
import { formatBytes } from "../../../shared/bytes";
import { formatDate } from "../../../shared/dates";
import { fileNameOf } from "../../../shared/documentNames";
import { onThisClock } from "../../../shared/fileProperties";
import { translate } from "../../../shared/i18n";
import { quoteInUnits, type Translate } from "../../../shared/locations";
import {
  type ClaimJudgment,
  type ClaimVerdict,
  type Document,
  type FigureCheckResult,
  type FilePropertyName,
  filePropertyNames,
} from "../../api";
import type { CitationSource } from "../../documents";
import type { PageText } from "../../documents/passages";
import type { WindowedPassage } from "../../documents/search";
import { isRecord } from "../../errors";
import type { SearchResultForModel } from "../engine";
import { labelled } from "../judge";
import type { TurnCheck } from "../turnChecks";
import type {
  AtomicClaimCheckResult,
  ClaimCheckDependencies,
  ClaimCheckRequest,
} from "./claimCheck";
import { type FigureReplyItem, readFigureReply } from "./figureChecks";
import { PROPERTY, readVerdict, replyAcrossTurns } from "./prompt";

/**
 * What a Run's searches ask of the Documents' file properties (`ClaimCheckDependencies`). `search`
 * is the one search's own options, which tell its result from another's run at the same time.
 */
export interface FilePropertySearch {
  /**
   * The property Passage a search adds to `found`: of the one Document it names, else of the one
   * it could be about; none when it could be about several.
   */
  add(
    found: readonly WindowedPassage[],
    within: readonly string[] | undefined,
    search: object,
  ): WindowedPassage[];
  /** A search's result with what the model is told of the properties it shows, or why it shows none. */
  told(result: SearchResultForModel, search: object): SearchResultForModel;
  /** Asks once for the Property line, of a reply after properties were shown that has none. */
  turnCheck: TurnCheck;
  /** The Run's last reply, which names the properties its sentence states. */
  replied(text: string): void;
}

type DatedProperty = "created" | "modified";

interface Line<P extends string = FilePropertyName> {
  property: P;
  value: string;
  start: number;
  end: number;
}

interface Source {
  document: Document;
  passage: WindowedPassage;
  unit: PageText;
  lines: Line[];
  /** This computer's dates, shown only when the file records no date of its own. */
  computer: Line<DatedProperty>[];
}

const VERSION = "file-properties:";
export const isPropertyPassage = (passageId: unknown): boolean =>
  typeof passageId === "string" && passageId.startsWith(VERSION);

const MOST_NAMED = 8;

const english: Translate = (key, params) => translate("en", key, params);
const grouped = new Intl.NumberFormat("en-US");

export const PROPERTIES_NOTE = [
  "The file properties above are what the file records about itself, not what its Document says. They decide only a sentence about the file itself: when it was created or last modified, its author as the file records it, its page, slide or sheet count, its size or its file name. They never decide a sentence about what a Document's text says, such as the day a contract was signed or a name its text gives. This computer's dates decide nothing.",
  'Cite the one line that decides it. After your Verdict line, add a line "Property: " and the properties the sentence states, from created, modified, author, pages, slides, sheets, size and name, separated by commas, or "Property: none".',
].join("\n");

/**
 * Said when a search for the properties could be about several files: each file has lines like the
 * others', so the model names the one its sentence is about and is shown that one's alone.
 */
const nameOne = (names: readonly string[]) =>
  `No file properties are shown: ${names.length > 1 ? `this sentence could be about ${names.map((name) => `“${name}”`).join(", ")}` : "they are shown for one Document at a time"}. Search again with properties and the Document the sentence is about in document.`;

const PROPERTY_LINE =
  'Your reply has no Property line. Write your whole reply again, with a line after the Verdict line: "Property: " and the properties the sentence states (created, modified, author, pages, slides, sheets, size or name), or "Property: none" when it is about what a Document says.';

/**
 * The properties a reply's Property line names: empty for "none", null when it has no such line or
 * the line can't be read.
 */
export function declaredProperties(reply: string): ReadonlySet<FilePropertyName> | null {
  const line = labelled(
    reply.split("\n").map((each) => each.trim()),
    PROPERTY,
  );
  if (line === undefined || line === null) return null;
  const words = line
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word !== "");
  const named = filePropertyNames.filter((name) => words.includes(name));
  if (words.includes("none")) return named.length === 0 ? new Set() : null;
  return named.length > 0 ? new Set(named) : null;
}

function countLine(
  document: Document,
  slides: number | null,
): { property: FilePropertyName; label: string; written: string; value: number } | null {
  if (document.kind === "pdf" && document.pageCount !== null && document.pageCount > 0) {
    const count = document.pageCount;
    return { property: "pages", label: "Pages", written: String(count), value: count };
  }
  // A deck read in full has one Unit for each of its slides, hidden ones too.
  if (document.kind === "pptx" && slides && !document.unreadParts && !document.unreadPartsUnknown) {
    return { property: "slides", label: "Slides", written: String(slides), value: slides };
  }
  const sheets = document.kind === "xlsx" ? document.properties?.sheets : null;
  if (sheets) {
    const hidden = sheets.hidden > 0 ? ` (${sheets.hidden} of them hidden)` : "";
    return {
      property: "sheets",
      label: "Sheets",
      written: `${sheets.count}${hidden}`,
      value: sheets.count,
    };
  }
  return null;
}

/** A name on one line: a file's name may hold a line break that would read as another property. */
const oneLine = (name: string) => name.replace(/[\s\p{Cc}]+/gu, " ").trim();

function dateLine(value: string): string {
  const clock = onThisClock(value);
  return clock
    ? `${value} (the file’s own date, written in UTC: ${clock} on this computer's clock)`
    : `${value} (the file’s own date)`;
}

function sourceOf(document: Document, slides: number | null): Source | null {
  if (document.keptByApp) return null;
  const lines: Line[] = [];
  const computer: Line<DatedProperty>[] = [];
  let text = `File properties of “${oneLine(document.name)}”: what the file records about itself, not what the Document says.`;
  const add = (written: string) => {
    text += "\n";
    const start = text.length;
    text += written;
    return { start, end: text.length };
  };
  const line = (property: FilePropertyName, label: string, written: string, value = written) =>
    lines.push({ property, value, ...add(`${label}: ${written}`) });
  line("name", "File name", oneLine(fileNameOf(document.path)));
  const own = document.properties;
  if (own === null) add("Dates and author: they couldn't be read from the file.");
  else {
    if (own.created) line("created", "Created", dateLine(own.created), own.created);
    if (own.modified) line("modified", "Modified", dateLine(own.modified), own.modified);
    if (own.author) line("author", "Author", own.author);
    if (!own.created && !own.modified) {
      add("Dates: the file records none of its own.");
      const dates: [DatedProperty, string, string | null][] = [
        ["created", "Created", document.fileCreatedAt],
        ["modified", "Modified", document.modifiedAt],
      ];
      for (const [property, label, value] of dates) {
        if (value === null) continue;
        const shown = `${label} on this computer: ${value}, which copying or downloading a file changes, so it decides nothing`;
        computer.push({ property, value, ...add(shown) });
      }
    }
  }
  const counted = countLine(document, slides);
  if (counted) line(counted.property, counted.label, counted.written, String(counted.value));
  if (document.size > 0) {
    // Windows counts a megabyte as 1,048,576 bytes, macOS as 1,000,000: "4 MB" may be either.
    const size = `${grouped.format(document.size)} bytes (${formatBytes(document.size, english)}, or ${formatBytes(document.size, english, 1024)} counting 1,024 bytes to a KB)`;
    line("size", "Size", size, String(document.size));
  }
  const passage: WindowedPassage = {
    passageId: `${VERSION}${document.id}`,
    documentId: document.id,
    documentName: document.name,
    documentKind: document.kind,
    contentHash: `${VERSION}${document.contentHash}`,
    pageFrom: null,
    pageTo: null,
    position: 0,
    text,
    seq: 0,
    windowFrom: 0,
    windowTo: 0,
    // Last in a result, it would be the first a small window cuts: the model asked for it.
    rank: -1,
  };
  return { document, passage, unit: { page: null, text }, lines, computer };
}

/** The one line of `lines` a quote is on, or null when it is on none or on more than one. */
export function lineQuoted<L extends { start: number; end: number }>(
  unit: PageText,
  lines: readonly L[],
  quote: string,
): L | null {
  const ranges = quoteInUnits([unit], quote) ?? [];
  if (ranges.length === 0) return null;
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  return lines.find((line) => start >= line.start && end <= line.end) ?? null;
}

type Decided = Extract<ClaimJudgment, { verdict: ClaimVerdict }>;

export const UNDECIDED = { reason: null, covered: null, uncovered: null };

function unbacked<J extends Decided>(judgment: J): J {
  const { correction: _correction, ...rest } = judgment;
  return {
    ...rest,
    verdict: "unsupported",
    evidence: null,
    says: null,
    unsupported: UNDECIDED,
    calculation: null,
  } as J;
}

export interface CitationLike {
  passageId?: unknown;
  documentId?: unknown;
  check?: unknown;
  location?: unknown;
}

/** The property a Citation of the properties decides; null for one that decides none; undefined: no such Citation. */
function propertyOf(
  citation: CitationLike | null | undefined,
): FilePropertyName | null | undefined {
  if (!citation || !isPropertyPassage(citation.passageId)) return undefined;
  const { location } = citation;
  return citation.check === "found" && isRecord(location) && location.kind === "properties"
    ? (location.property as FilePropertyName)
    : null;
}

// A kilobyte, megabyte or gigabyte may be counted either way (Windows counts 1,024 bytes to a
// KB), so a size in one agrees when either count does; "KiB" and its kin count only 1,024.
const SIZE_UNITS: readonly (readonly [RegExp, readonly number[]])[] = [
  [/^(?:(?:[Bb]ytes?|B)(?![A-Za-z])|字节)/u, [1]],
  [/^(?:(?:[Kk]B|[Kk]ilobytes?)(?![A-Za-z])|千字节)/u, [1e3, 2 ** 10]],
  [/^(?:(?:MB|mb|[Mm]egabytes?)(?![A-Za-z])|兆字节)/u, [1e6, 2 ** 20]],
  [/^(?:GB|gb|[Gg]igabytes?)(?![A-Za-z])/u, [1e9, 2 ** 30]],
  [/^KiB(?![A-Za-z])/u, [2 ** 10]],
  [/^MiB(?![A-Za-z])/u, [2 ** 20]],
  [/^GiB(?![A-Za-z])/u, [2 ** 30]],
];

/**
 * The words after a figure in its context, its own sentence (a table cell's under its headings):
 * its reading counts from the paragraph's start, not the context's, so it is found by its
 * characters; undefined when they are there more than once, or not at all.
 */
export function afterFigure(figure: FigureCheckResult): string | undefined {
  const { chars } = figure.reading;
  const escaped = chars.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = [
    ...(figure.context ?? "").matchAll(new RegExp(`(?<![\\d.,])${escaped}(?!\\d)`, "gu")),
  ];
  const [one] = found;
  return found.length === 1 && one
    ? (figure.context ?? "").slice(one.index + chars.length)
    : undefined;
}

/** Whether the sentence writes a size unit after the figure ("22 GB"), which no count of things states. */
export function writtenAsSize(figure: FigureCheckResult): boolean {
  const after = afterFigure(figure)?.trimStart();
  return after !== undefined && SIZE_UNITS.some(([unit]) => unit.test(after));
}

/**
 * Whether a size figure states `bytes`, in the unit its sentence writes after it: "1.2 MB" at its
 * shown precision, "under 2 MB" as its relation says. Null when the sentence names no size unit
 * there, which no byte count can settle.
 */
export function sizeAgrees(
  figure: FigureCheckResult,
  bytes: number,
  relation: FigureReplyItem["relation"],
): boolean | null {
  const { reading } = figure;
  const after = afterFigure(figure)?.trimStart();
  const per = after === undefined ? undefined : SIZE_UNITS.find(([unit]) => unit.test(after))?.[1];
  if (!per) return null;
  // A figure's value counts its scale word in ("1.2 thousand" is 1,200); its decimals don't.
  const shown = (value: number) => Number((value / reading.scale).toFixed(reading.decimals));
  return per.some((each) => {
    const counted = bytes / each;
    if (reading.rangeTo !== null) return counted >= reading.value && counted <= reading.rangeTo;
    if (relation === "at most") return counted <= reading.value;
    if (relation === "at least") return counted >= reading.value;
    return shown(counted) === shown(reading.value);
  });
}

/**
 * The file properties of the Documents a check Run's searches show, kept for the Run: what its
 * Citations of them quote, and how its result is held to the rules above.
 */
function propertyRun(deps: ClaimCheckDependencies, request: ClaimCheckRequest) {
  const getMany = deps.documents.getMany;
  const { scope } = request;
  const inScope = (documentId: string) =>
    !scope.excluded.has(documentId) &&
    (scope.documentIds === null || scope.documentIds.includes(documentId));
  const sources = new Map<string, Source>();
  const byPassage = new Map<string, Source>();
  const unavailable = new Set<string>();
  const computerQuoted: { source: Source; line: Line<DatedProperty> }[] = [];
  let reply = "";

  const sourceFor = (documentId: string): Source | null => {
    const known = byPassage.get(`${VERSION}${documentId}`);
    if (known) return known;
    if (unavailable.has(documentId) || !getMany || !inScope(documentId)) return null;
    const [document] = getMany([documentId]);
    const slides =
      document?.kind === "pptx"
        ? (deps.documents.unitCounts([document.id]).get(document.id) ?? null)
        : null;
    const made = document ? sourceOf(document, slides) : null;
    if (!made) {
      unavailable.add(documentId);
      return null;
    }
    sources.set(made.passage.contentHash, made);
    byPassage.set(made.passage.passageId, made);
    return made;
  };

  const cited = (request.cited ?? []).flatMap(({ passageId }) => {
    const source = passageId ? deps.documents.citationSource(passageId) : null;
    return source && !source.documentDeleted ? [source.documentId] : [];
  });
  // A sentence citing a Document is about that Document's file, whichever file the model read.
  const isAbout = (documentId: unknown) =>
    cited.length === 0 || (typeof documentId === "string" && cited.includes(documentId));
  let searchable: readonly { id: string; name: string }[] | null = null;
  const inScopeSearchable = () => {
    // The scope's Documents already leave out those it may not use.
    searchable ??= deps.documents.searchableBySize(scope.documentIds);
    return searchable;
  };
  const shown = new Set<string>();
  const several = new WeakMap<object, readonly string[]>();

  const search: FilePropertySearch = {
    add(found, within, asked) {
      const only = inScopeSearchable().length === 1 ? [inScopeSearchable()[0]?.id ?? ""] : [];
      const named = within && within.length > 0;
      const wanted = named ? within : cited.length > 0 ? cited : only;
      const sources = [...new Set(wanted)].flatMap((documentId) => sourceFor(documentId) ?? []);
      const [source] = sources;
      if (source && sources.length === 1) {
        shown.add(source.document.id);
        return [source.passage];
      }
      if (!named) {
        const names =
          sources.length > 1
            ? sources.map((each) => each.document.name)
            : [
                ...found.map((passage) => passage.documentName),
                ...(inScopeSearchable().length <= MOST_NAMED
                  ? inScopeSearchable().map((each) => each.name)
                  : []),
              ];
        several.set(asked, [...new Set(names)].slice(0, MOST_NAMED));
      }
      return [];
    },
    told(result, asked) {
      const { coverage } = result;
      const names = several.get(asked);
      return {
        ...result,
        coverage: (fitted) => {
          const covered = coverage?.(fitted) ?? null;
          const note = fitted.includes("File properties of “")
            ? PROPERTIES_NOTE
            : names
              ? nameOne(names)
              : null;
          return [covered, note].filter((each) => each !== null).join("\n\n") || null;
        },
      };
    },
    turnCheck: {
      name: "file-properties",
      check(last, setAside = []) {
        if (shown.size === 0) return null;
        const text = replyAcrossTurns(last, setAside);
        if (readVerdict(text) === null || declaredProperties(text) !== null) return null;
        return { claims: [], note: PROPERTY_LINE };
      },
    },
    replied(text) {
      reply = text;
    },
  };

  const documents: ClaimCheckDependencies["documents"] = {
    ...deps.documents,
    citationSource: (passageId): CitationSource | null => {
      const source = byPassage.get(passageId);
      if (!source) return deps.documents.citationSource(passageId);
      return {
        passageId,
        text: source.passage.text,
        pageFrom: null,
        pageTo: null,
        documentId: source.document.id,
        documentName: source.document.name,
        documentKind: source.document.kind,
        contentHash: source.passage.contentHash,
        documentDeleted: false,
        notCited: false,
        yourNoteAt: null,
      };
    },
    pageTexts: (documentId, contentHash, from, to) => {
      const source = sources.get(contentHash);
      return source && source.document.id === documentId
        ? [source.unit]
        : deps.documents.pageTexts(documentId, contentHash, from, to);
    },
  };

  function asProperties(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) {
      const mapped = value.map((each) => asProperties(each));
      if (key !== "versions") return mapped;
      const seen = new Set<string>();
      return mapped.filter((each) => {
        const id = isRecord(each) ? `${each.documentId}\n${each.contentHash}` : "";
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    if (!isRecord(value)) return value;
    const mapped: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([name, each]) => [name, asProperties(each, name)]),
    );
    const hash = mapped.contentHash;
    const source = typeof hash === "string" ? sources.get(hash) : undefined;
    if (!source) return mapped;
    const own = { ...mapped, contentHash: source.document.contentHash };
    if (typeof mapped.quote !== "string") return own;
    const line = lineQuoted(source.unit, source.lines, mapped.quote);
    const onComputer = line ? null : lineQuoted(source.unit, source.computer, mapped.quote);
    if (onComputer) computerQuoted.push({ source, line: onComputer });
    return {
      ...own,
      pageFrom: null,
      pageTo: null,
      location: line ? { kind: "properties", property: line.property, value: line.value } : null,
      ...(!line && { check: "not-found", checkReason: "quote-not-on-pages" }),
    };
  }

  function settle(raw: AtomicClaimCheckResult): AtomicClaimCheckResult {
    if (shown.size === 0) return raw;
    const declared = declaredProperties(reply);
    const result = asProperties(raw) as AtomicClaimCheckResult;
    const mayDecide = (citation: CitationLike | null | undefined) => {
      const property = propertyOf(citation);
      if (property === undefined) return true;
      return property !== null && declared?.has(property) === true && isAbout(citation?.documentId);
    };
    const held = <J extends ClaimJudgment>(
      judgment: J,
      deciding: readonly (CitationLike | null | undefined)[],
      sentence: boolean,
    ): J => {
      if (judgment.verdict === "not-checked") return judgment;
      if (judgment.verdict === "unsupported") {
        const why = judgment.unsupported;
        const { quoted, found: _found, ...said } = why ?? { ...UNDECIDED };
        // The part a property covers is no part of a sentence that isn't about it.
        const fromProperty = !mayDecide(quoted) || !mayDecide(judgment.evidence);
        return {
          ...judgment,
          evidence: mayDecide(judgment.evidence) ? judgment.evidence : null,
          ...(why && fromProperty && { unsupported: { ...said, covered: null, uncovered: null } }),
        };
      }
      const correction = judgment.correction?.choices ?? [];
      const all = [judgment.evidence, ...deciding, ...correction.map((each) => each.evidence)];
      const properties = new Set(all.map(propertyOf).filter((each) => each));
      const decidedBy = propertyOf(judgment.evidence);
      // Text that looks like a property ("Author: …" in the body, a footer's date) never decides
      // a sentence about one, for or against.
      const unbackedProperty =
        sentence &&
        declared !== null &&
        declared.size > 0 &&
        (judgment.verdict === "supported"
          ? [...declared].some((property) => !properties.has(property))
          : !decidedBy || !declared.has(decidedBy));
      if (!all.every(mayDecide) || unbackedProperty) return unbacked(judgment as Decided) as J;
      if (!correction.some((each) => propertyOf(each.evidence) !== undefined)) return judgment;
      const { correction: _correction, ...kept } = judgment;
      return kept as J;
    };
    // A sentence with figures is decided by its figures and its other words, each held to these
    // rules on its own Citations; together they back each property its Property line names, as a
    // sentence without figures does, or none of them decides it.
    const evidenceOf = (judgment: ClaimJudgment | null | undefined) =>
      judgment && judgment.verdict !== "not-checked" ? judgment.evidence : null;
    const backed = new Set(
      [
        ...(result.figures ?? []).map((figure) => evidenceOf(figure.result)),
        evidenceOf(result.remainder),
      ].map(propertyOf),
    );
    const partsUnbacked =
      declared !== null && [...declared].some((property) => !backed.has(property));
    const heldPart = <J extends ClaimJudgment>(
      judgment: J,
      deciding: readonly (CitationLike | null | undefined)[],
    ): J => {
      const judged = held(judgment, deciding, false);
      return partsUnbacked && (judged.verdict === "supported" || judged.verdict === "contradicted")
        ? (unbacked(judged as Decided) as J)
        : judged;
    };
    const items = new Map(
      (readFigureReply(reply, request.figures ?? [], request.claim)?.items ?? []).map((item) => [
        item.id,
        item,
      ]),
    );
    // The size line writes its byte count first: a figure in KB or MB is compared with it here, in
    // the figure's own unit, never as two plain numbers. A size that agrees is Supported only when
    // the model called the figure so: one it found to say something else is never Supported.
    const sized = (figure: FigureCheckResult, judged: ClaimJudgment): ClaimJudgment => {
      if (judged.verdict !== "supported" && judged.verdict !== "contradicted") return judged;
      const location = judged.evidence?.location;
      if (location?.kind !== "properties" || location.property !== "size") return judged;
      const item = items.get(figure.id);
      const agrees = sizeAgrees(figure, Number(location.value), item?.relation ?? "equals");
      if (agrees === null || (agrees && item?.verdict !== "supported")) return unbacked(judged);
      return { ...judged, verdict: agrees ? "supported" : "contradicted" };
    };
    const figures = result.figures?.map((figure) => {
      const judged = sized(
        figure,
        heldPart(figure.result, [figure.source, figure.sourceInput?.citation]),
      );
      // A figure's source is a number in a Document's text, which the Note may cite or change the
      // figure to; a property it was compared with is only its result's evidence.
      const fromProperty = [figure.source, figure.sourceInput?.citation].some(
        (citation) => propertyOf(citation) !== undefined,
      );
      return fromProperty
        ? {
            ...figure,
            source: null,
            sourceInput: null,
            difference: null,
            roundedFrom: null,
            result: judged,
          }
        : { ...figure, result: judged };
    });
    const remainder = result.remainder && heldPart(result.remainder, []);
    const listed = [
      ...(result.checkedEvidence ?? []),
      ...(result.coverage?.members.flatMap((member) => member.evidence) ?? []),
      ...(result.coverage?.domainEvidence ?? []),
    ];
    const judged: AtomicClaimCheckResult = {
      ...held(result, listed, true),
      ...(figures && { figures }),
      ...(result.remainder !== undefined && { remainder }),
      // What a part's row lists: never a property its sentence isn't about.
      ...(result.checkedEvidence && { checkedEvidence: result.checkedEvidence.filter(mayDecide) }),
      ...(result.coverage && {
        coverage: {
          ...result.coverage,
          members: result.coverage.members.map((member) => ({
            ...member,
            evidence: member.evidence.filter(mayDecide),
          })),
          domainEvidence: result.coverage.domainEvidence.filter(mayDecide),
        },
      }),
    };
    return withComputerDate(judged, declared);
  }

  function withComputerDate(
    result: AtomicClaimCheckResult,
    declared: ReadonlySet<FilePropertyName> | null,
  ): AtomicClaimCheckResult {
    if (result.verdict !== "unsupported") return result;
    const asked = (property: DatedProperty) => declared === null || declared.has(property);
    const quoted = computerQuoted.filter(
      ({ source, line }) => asked(line.property) && isAbout(source.document.id),
    );
    const dated = (["modified", "created"] as const).filter((each) => declared?.has(each));
    // Only when the Run was shown one Document's: its date is the one the sentence is about.
    const shownSources = [...sources.values()].filter((each) => shown.has(each.document.id));
    const [one] = shownSources;
    const known =
      one && shownSources.length === 1 && isAbout(one.document.id)
        ? dated.flatMap((property) => one.computer.filter((line) => line.property === property))
        : [];
    const only = new Set(quoted.map(({ line }) => `${line.property}\n${line.value}`)).size === 1;
    const line = only ? quoted[0]?.line : known[0];
    if (!line) return result;
    const language = deps.language();
    return {
      ...result,
      evidence: null,
      unsupported: {
        reason: translate(language, "claim.properties.computerOnly", {
          date: formatDate(line.value, language),
        }),
        covered: null,
        uncovered: null,
        found: true,
      },
    };
  }

  return { search, documents, settle };
}

/**
 * A check whose Run may show the Documents' file properties: `create(deps)` with what its searches
 * need for them, its result held to the rules above. Not in a whole read's window, whose every
 * search is that window.
 */
export function withFileProperties(
  deps: ClaimCheckDependencies,
  create: (
    deps: ClaimCheckDependencies,
  ) => (request: ClaimCheckRequest) => Promise<AtomicClaimCheckResult>,
): (request: ClaimCheckRequest) => Promise<AtomicClaimCheckResult> {
  const plain = create(deps);
  if (!deps.documents.getMany) return plain;
  return async (request) => {
    if (request.window) return plain(request);
    const run = propertyRun(deps, request);
    const result = await create({
      ...deps,
      documents: run.documents,
      fileProperties: run.search,
    })(request);
    return run.settle(result);
  };
}
