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
import { translate } from "../../../shared/i18n";
import { quoteInUnits, type Translate } from "../../../shared/locations";
import {
  type ClaimJudgment,
  type ClaimVerdict,
  type Document,
  type FilePropertyName,
  filePropertyNames,
} from "../../api";
import type { CitationSource } from "../../documents";
import type { PageText } from "../../documents/passages";
import type { WindowedPassage } from "../../documents/search";
import { isRecord } from "../../errors";
import type { SearchResultForModel } from "../engine";
import type { TurnCheck } from "../turnChecks";
import type {
  AtomicClaimCheckResult,
  ClaimCheckDependencies,
  ClaimCheckRequest,
} from "./claimCheck";
import { readVerdict, replyAcrossTurns } from "./prompt";

/** What a Run's searches ask of the Documents' file properties (`ClaimCheckDependencies`). */
export interface FilePropertySearch {
  /** The property Passages a search adds to `found`: of the Document it names, else of those it found. */
  add(found: readonly WindowedPassage[], within: readonly string[] | undefined): WindowedPassage[];
  /** A search's result with what the model is told of the properties it shows. */
  told(result: SearchResultForModel): SearchResultForModel;
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

/** One Document's file properties as the check shows them. */
interface Source {
  document: Document;
  passage: WindowedPassage;
  unit: PageText;
  lines: Line[];
  /** This computer's dates, shown only when the file records no date of its own. */
  computer: Line<DatedProperty>[];
}

const VERSION = "file-properties:";
const isPropertyPassage = (passageId: unknown): boolean =>
  typeof passageId === "string" && passageId.startsWith(VERSION);

/** Most Documents whose properties one search adds: those of its first Passages. */
const MOST_PER_SEARCH = 5;

/**
 * A scope this small shows every Document's properties: a sentence about "the file" names nothing
 * its text holds, so its words may find no Passage of it.
 */
const FEW_DOCUMENTS = 3;

const english: Translate = (key, params) => translate("en", key, params);
const grouped = new Intl.NumberFormat("en-US");

export const PROPERTIES_NOTE = [
  "The file properties above are what each file records about itself, not what its Document says. They decide only a sentence about the file itself: when it was created or last modified, its author as the file records it, its page, slide or sheet count, its size or its file name. They never decide a sentence about what a Document's text says, such as the day a contract was signed or a name its text gives. This computer's dates decide nothing.",
  'Cite the one line that decides it. After your Verdict line, add a line "Property: " and the properties the sentence states, from created, modified, author, pages, slides, sheets, size and name, separated by commas, or "Property: none".',
].join("\n");

const PROPERTY_LINE =
  'Your reply has no Property line. Write your whole reply again, with a line after the Verdict line: "Property: " and the properties the sentence states (created, modified, author, pages, slides, sheets, size or name), or "Property: none" when it is about what a Document says.';

/**
 * The properties a reply's Property line names: empty for "none", null when it has no such line or
 * the line can't be read.
 */
export function declaredProperties(reply: string): ReadonlySet<FilePropertyName> | null {
  const line = /^[\s*_-]*Property:\s*(.*)$/im.exec(reply)?.[1];
  if (line === undefined) return null;
  const words = line
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word !== "");
  const named = filePropertyNames.filter((name) => words.includes(name));
  if (words.includes("none")) return named.length === 0 ? new Set() : null;
  return named.length > 0 ? new Set(named) : null;
}

/** How many of its slides or sheets a file has, or pages a PDF has, as a line; null when not known. */
function countLine(
  document: Document,
  slides: number | null,
): { property: FilePropertyName; label: string; written: string; value: number } | null {
  if (document.kind === "pdf" && document.pageCount !== null) {
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

/** A Document's properties as a Passage of their own; null for a file IncarnaMind keeps itself. */
function sourceOf(document: Document, slides: number | null): Source | null {
  if (document.keptByApp) return null;
  const lines: Line[] = [];
  const computer: Line<DatedProperty>[] = [];
  let text = `File properties of “${document.name}”: what the file records about itself, not what the Document says.`;
  const add = (written: string) => {
    text += "\n";
    const start = text.length;
    text += written;
    return { start, end: text.length };
  };
  const line = (property: FilePropertyName, label: string, written: string, value = written) =>
    lines.push({ property, value, ...add(`${label}: ${written}`) });
  line("name", "File name", fileNameOf(document.path));
  const own = document.properties;
  if (own === null) add("Dates and author: they couldn't be read from the file.");
  else {
    if (own.created) line("created", "Created", `${own.created} (the file’s own date)`, own.created);
    if (own.modified) {
      line("modified", "Modified", `${own.modified} (the file’s own date)`, own.modified);
    }
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
    const size = `${grouped.format(document.size)} bytes (${formatBytes(document.size, english)})`;
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
  };
  return { document, passage, unit: { page: null, text }, lines, computer };
}

/** The one line of `lines` a quote is on, or null when it is on none or on more than one. */
function lineQuoted<L extends Line<string>>(
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

const UNDECIDED = { reason: null, covered: null, uncovered: null };

/** Unsupported, as what backed it may not. */
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

interface CitationLike {
  passageId?: unknown;
  check?: unknown;
  location?: unknown;
}

/** The property a Citation of the properties decides; null for one that decides none; undefined: no such Citation. */
function propertyOf(citation: CitationLike | null | undefined): FilePropertyName | null | undefined {
  if (!citation || !isPropertyPassage(citation.passageId)) return undefined;
  const { location } = citation;
  return citation.check === "found" && isRecord(location) && location.kind === "properties"
    ? (location.property as FilePropertyName)
    : null;
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
  /** Computer lines a Citation quoted. */
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
    const made = document && !document.notCited ? sourceOf(document, slides) : null;
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
  let few: readonly string[] | null = null;
  const fewDocuments = () => {
    few ??= (() => {
      const searchable = deps.documents
        .searchableBySize(scope.documentIds)
        .filter((each) => inScope(each.id));
      return searchable.length <= FEW_DOCUMENTS ? searchable.map((each) => each.id) : [];
    })();
    return few;
  };
  const shown = new Set<string>();

  const search: FilePropertySearch = {
    add(found, within) {
      const wanted =
        within && within.length > 0
          ? within
          : [
              ...cited,
              ...[...new Set(found.map((passage) => passage.documentId))].slice(0, MOST_PER_SEARCH),
              ...fewDocuments(),
            ];
      return [...new Set(wanted)].flatMap((documentId) => {
        if (shown.has(documentId)) return [];
        const source = sourceFor(documentId);
        if (!source) return [];
        shown.add(documentId);
        return [source.passage];
      });
    },
    told(result) {
      const { coverage } = result;
      return {
        ...result,
        coverage: (fitted) => {
          const covered = coverage?.(fitted) ?? null;
          if (!fitted.includes("File properties of “")) return covered;
          return covered ? `${covered}\n\n${PROPERTIES_NOTE}` : PROPERTIES_NOTE;
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
      };
    },
    pageTexts: (documentId, contentHash, from, to) => {
      const source = sources.get(contentHash);
      return source && source.document.id === documentId
        ? [source.unit]
        : deps.documents.pageTexts(documentId, contentHash, from, to);
    },
  };

  /** A value of the result with each Citation of the properties made a property Citation of its Document. */
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
      return property !== null && declared !== null && declared.has(property);
    };
    let changed = false;
    const held = <J extends ClaimJudgment>(
      judgment: J,
      deciding: readonly (CitationLike | null | undefined)[],
      sentence = false,
    ): J => {
      if (judgment.verdict === "not-checked") return judgment;
      if (judgment.verdict === "unsupported") {
        const { quoted, ...why } = judgment.unsupported ?? { ...UNDECIDED };
        return {
          ...judgment,
          evidence: mayDecide(judgment.evidence) ? judgment.evidence : null,
          ...(judgment.unsupported && {
            unsupported: quoted && !mayDecide(quoted) ? why : judgment.unsupported,
          }),
        };
      }
      const correction = judgment.correction?.choices ?? [];
      const all = [judgment.evidence, ...deciding, ...correction.map((each) => each.evidence)];
      const properties = new Set(all.map(propertyOf).filter((each) => each));
      const unbackedProperty =
        sentence &&
        judgment.verdict === "supported" &&
        [...(declared ?? [])].some((property) => !properties.has(property));
      if (!all.every(mayDecide) || unbackedProperty) {
        changed = true;
        return unbacked(judgment as Decided) as J;
      }
      if (!correction.some((each) => propertyOf(each.evidence) !== undefined)) return judgment;
      const { correction: _correction, ...kept } = judgment;
      return kept as J;
    };
    const figures = result.figures?.map((figure) => ({
      ...figure,
      result: held(figure.result, [figure.source, figure.sourceInput?.citation]),
    }));
    const remainder = result.remainder ? held(result.remainder, []) : result.remainder;
    const coverage = result.coverage
      ? [
          ...result.coverage.members.flatMap((member) => member.evidence),
          ...result.coverage.domainEvidence,
        ]
      : [];
    let sentence = held(result, [...(result.checkedEvidence ?? []), ...coverage], true);
    // A sentence a figure or its other words no longer back is no longer Supported either.
    if (changed && sentence.verdict === "supported") sentence = unbacked(sentence);
    const judged: AtomicClaimCheckResult = {
      ...sentence,
      ...(figures && { figures }),
      ...(result.remainder !== undefined && { remainder }),
    };
    return withComputerDate(judged, declared);
  }

  /** An Unsupported sentence about a date of a file that records none of its own says so (#2458). */
  function withComputerDate(
    result: AtomicClaimCheckResult,
    declared: ReadonlySet<FilePropertyName> | null,
  ): AtomicClaimCheckResult {
    if (result.verdict !== "unsupported") return result;
    const asked = (property: DatedProperty) => declared === null || declared.has(property);
    const quoted = computerQuoted.filter(({ line }) => asked(line.property));
    const dated = (["modified", "created"] as const).filter((each) => declared?.has(each));
    const shownSources = [...sources.values()].filter((each) => shown.has(each.document.id));
    const known = dated.flatMap((property) =>
      shownSources.some((each) => each.lines.some((line) => line.property === property))
        ? []
        : shownSources.flatMap((source) =>
            source.computer.filter((line) => line.property === property),
          ),
    );
    const only = new Set(quoted.map(({ line }) => `${line.property}\n${line.value}`)).size === 1;
    const line = only ? quoted[0]?.line : known.length === 1 ? known[0] : undefined;
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
