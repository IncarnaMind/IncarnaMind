/**
 * A sentence about a Document's file itself (#2458): when it was created or last modified, who its
 * author is, how many pages, slides or sheets it has, its size or its name. The check of such a
 * sentence finds each Document's file properties beside its Passages, as a source of their own it
 * can cite, and its result keeps to these rules:
 * - A property decides only a sentence that asks about that property. A date or an author does so
 *   only for a sentence about the file ("the file", "the PDF", its name), never one about what the
 *   Document's text is about, such as when it was signed or by whom.
 * - Only the file's own dates are shown, so this computer's, which copying or downloading a file
 *   changes, never decide. A sentence about a file that records no date of its own is Unsupported,
 *   with the line that says only this computer's date is known.
 * - The time a Document was added to IncarnaMind is never shown, so it never decides.
 * - A property that can't be read is left out, so it never backs a sentence.
 * Every other sentence is checked exactly as before, with nothing added.
 *
 * The properties reach the check as one Passage per Document, under a version of their own, so the
 * Citation check finds a quote of them in their text and never in the Document's.
 */
import { formatBytes } from "../../../shared/bytes";
import { formatDate } from "../../../shared/dates";
import { fileDates } from "../../../shared/fileProperties";
import { translate } from "../../../shared/i18n";
import { quoteInUnits } from "../../../shared/locations";
import {
  type Citation,
  type ClaimJudgment,
  type Document,
  type FilePropertyName,
  filePropertyNames,
} from "../../api";
import type { CitationSource } from "../../documents";
import type { PageText } from "../../documents/passages";
import type { WindowedPassage } from "../../documents/search";
import type {
  AtomicClaimCheckResult,
  ClaimCheckDependencies,
  ClaimCheckRequest,
} from "./claimCheck";

/** What a sentence names to be about the file itself, in English and Chinese. */
const THE_FILE =
  /\b(?:files?|documents?|pdfs?|spreadsheets?|workbooks?|decks?|presentations?|metadata)\b|\.(?:pdf|docx?|pptx?|xlsx?|csv|txt|md|rtf|html?)\b|文件|文档|电子表格|工作簿|演示文稿|幻灯片|元数据|PDF/iu;

/** The words that ask about each property. */
const ASKS: Record<FilePropertyName, RegExp> = {
  created: /\bcreat(?:ed|ion)\b|创建|新建/iu,
  modified:
    /\b(?:modif(?:ied|ication)|saved|edited|changed|updated|revised)\b|修改|保存|编辑|更新|改动/iu,
  author: /\bauthor(?:s|ed)?\b|\bwritten\s+by\b|\bcreated\s+by\b|\bcreator\b|作者|撰写|创建者|编写/iu,
  pages: /\bpages?\b|页/iu,
  // A deck's pages are its slides: "a 12-page deck", "共 12 页".
  slides: /\b(?:slides?|pages?)\b|幻灯片|页/iu,
  sheets: /\b(?:work)?sheets?\b|\btabs\b|工作表/iu,
  size: /\bsize\b|\b(?:bytes?|kilobytes?|megabytes?|gigabytes?)\b|\d\s*[KMG]B\b|大小|字节/iu,
  name: /\bfile\s*name\b|\bfilename\b|\bnamed\b|\bcalled\b|文件名|名为|叫做|命名为/iu,
};

/** Properties a sentence can rest on only when it is about the file: its text has dates, people and names too. */
const OF_THE_FILE_ONLY: ReadonlySet<FilePropertyName> = new Set([
  "created",
  "modified",
  "author",
  "size",
  "name",
]);

/**
 * The properties a claim asks about; empty for a claim about anything else. `sentence`: the whole
 * sentence a part of it is from, which may name the file outside the part.
 */
export function askedProperties(claim: string, sentence = claim): ReadonlySet<FilePropertyName> {
  const ofTheFile = THE_FILE.test(sentence);
  return new Set(
    filePropertyNames.filter(
      (property) => ASKS[property].test(claim) && (ofTheFile || !OF_THE_FILE_ONLY.has(property)),
    ),
  );
}

const FILE_NAME = /[^\s"“”'‘’()（）]+\.(?:pdf|docx?|pptx?|xlsx?|csv|txt|md|rtf|html?)\b/giu;

/** A sentence that names a file by its name with an extension is about that file only. */
const namesAnother = (claim: string, document: string): boolean => {
  const named = [...claim.matchAll(FILE_NAME)].map(([name]) => name.toLocaleLowerCase());
  return named.length > 0 && !named.some((name) => document.toLocaleLowerCase().endsWith(name));
};

/** The properties of one Document as the check shows them, and where each is in their text. */
interface PropertySource {
  documentId: string;
  documentName: string;
  contentHash: string;
  passage: WindowedPassage;
  unit: PageText;
  lines: { property: FilePropertyName; value: string; start: number; end: number }[];
  /** The file records no date of its own: this computer's is all that is known. */
  computer: { created: string | null; modified: string | null } | null;
}

const VERSION = "file-properties:";
const isProperties = (contentHash: unknown): contentHash is string =>
  typeof contentHash === "string" && contentHash.startsWith(VERSION);
const bytes = new Intl.NumberFormat("en-US");
const english = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);

/** How many slides or sheets were read, or pages a PDF has: null when it isn't known in full. */
function countOf(
  document: Document,
  units: () => readonly PageText[],
): { property: FilePropertyName; label: string; count: number } | null {
  if (document.kind === "pdf") {
    const count = document.pageCount;
    return count === null ? null : { property: "pages", label: "Pages", count };
  }
  if (document.kind === "pptx") {
    const count = units().filter((unit) => unit.kind === "slide").length;
    return count > 0 ? { property: "slides", label: "Slides", count } : null;
  }
  // A workbook with sheets it didn't read has more than it shows.
  if (document.kind === "xlsx" && document.unreadParts === null && !document.unreadPartsUnknown) {
    const count = new Set(units().map((unit) => unit.label?.sheet ?? "")).size;
    return count > 0 ? { property: "sheets", label: "Sheets", count } : null;
  }
  return null;
}

/** A Document's properties as a Passage of their own; null for one IncarnaMind keeps itself. */
function propertySource(
  document: Document,
  units: () => readonly PageText[],
): PropertySource | null {
  if (document.keptByApp) return null;
  const lines: PropertySource["lines"] = [];
  let text = `File properties of “${document.name}”: what the file records about itself, not what the Document says.`;
  const add = (label: string, written: string, property?: FilePropertyName, value = written) => {
    text += "\n";
    const start = text.length;
    text += `${label}: ${written}`;
    if (property) lines.push({ property, value, start, end: text.length });
  };
  add("File name", document.name, "name");
  const own = document.properties;
  if (own) {
    if (own.created) add("Created", `${own.created} (the file's own date)`, "created", own.created);
    if (own.modified) {
      add("Modified", `${own.modified} (the file's own date)`, "modified", own.modified);
    }
    if (!own.created && !own.modified) add("Dates", "the file records none of its own");
    if (own.author) add("Author", own.author, "author");
  }
  const counted = countOf(document, units);
  if (counted) add(counted.label, String(counted.count), counted.property);
  if (document.size > 0) {
    const written = `${bytes.format(document.size)} bytes (${formatBytes(document.size, english)})`;
    add("Size", written, "size", String(document.size));
  }
  const dates = fileDates(document);
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
  return {
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    passage,
    unit: { page: null, text },
    lines,
    computer:
      dates?.from === "computer" ? { created: dates.created, modified: dates.modified } : null,
  };
}

/** The property a quote of the source is of: the first of its lines the quote covers. */
function propertyQuoted(source: PropertySource, quote: string) {
  const ranges = quoteInUnits([source.unit], quote) ?? [];
  return (
    source.lines.find((line) =>
      ranges.some((range) => range.start < line.end && range.end > line.start),
    ) ?? null
  );
}

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The result with each Citation of a property source made a property Citation of its Document,
 * and each version of one its Document's own version.
 */
function asProperties(
  value: unknown,
  sources: ReadonlyMap<string, PropertySource>,
  key?: string,
): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((each) => asProperties(each, sources));
    if (key !== "versions") return mapped;
    const seen = new Set<string>();
    return mapped.filter((each) => {
      const id = isRecordObject(each) ? `${each.documentId}\n${each.contentHash}` : "";
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  if (!isRecordObject(value)) return value;
  const mapped = Object.fromEntries(
    Object.entries(value).map(([name, each]) => [name, asProperties(each, sources, name)]),
  );
  if (!isProperties(mapped.contentHash)) return mapped;
  const source = sources.get(mapped.contentHash);
  if (!source) return mapped;
  if (typeof mapped.quote !== "string") return { ...mapped, contentHash: source.contentHash };
  const line = propertyQuoted(source, mapped.quote);
  return {
    ...mapped,
    contentHash: source.contentHash,
    pageFrom: null,
    pageTo: null,
    location: line ? { kind: "properties", property: line.property, value: line.value } : null,
    // A quote of the source's heading alone names no property: it backs nothing.
    ...(!line && { check: "not-found", checkReason: "quote-not-on-pages" }),
  };
}

const propertyOf = (citation: Citation | null | undefined) =>
  citation?.location?.kind === "properties" ? citation.location : null;

/** Whether a property Citation may decide this sentence; true for a Citation of text. */
const mayDecide = (
  citation: Citation | null | undefined,
  claim: string,
  asked: ReadonlySet<FilePropertyName>,
): boolean => {
  const property = propertyOf(citation);
  if (!citation || property === null) return true;
  return (
    citation.check === "found" &&
    asked.has(property.property) &&
    !namesAnother(claim, citation.documentName)
  );
};

const UNDECIDED = { reason: null, covered: null, uncovered: null };

type Decided = Extract<ClaimJudgment, { verdict: "supported" | "unsupported" | "contradicted" }>;

/** Unsupported, as nothing but a property it may not rest on backs it. */
function unbacked(judgment: Decided): Decided {
  const { correction: _correction, ...rest } = judgment;
  return {
    ...rest,
    verdict: "unsupported",
    evidence: null,
    says: null,
    unsupported: UNDECIDED,
    calculation: null,
  };
}

/**
 * A judgment held to the rules: one a property decided that it may not decide is Unsupported; an
 * Unsupported one keeps no such property as the nearest line; and a property's words are never a
 * correction of the sentence's, being the file's and not the Document's.
 */
function heldTo(
  judgment: ClaimJudgment,
  deciding: readonly (Citation | null | undefined)[],
  claim: string,
  asked: ReadonlySet<FilePropertyName>,
): { judgment: ClaimJudgment; changed: boolean } {
  if (judgment.verdict === "not-checked") return { judgment, changed: false };
  const holds = deciding.every((citation) => mayDecide(citation, claim, asked));
  if (judgment.verdict === "unsupported") {
    return {
      judgment: holds || !propertyOf(judgment.evidence) ? judgment : { ...judgment, evidence: null },
      changed: false,
    };
  }
  if (!holds) return { judgment: unbacked(judgment), changed: true };
  const fromProperty = judgment.correction?.choices.some((choice) =>
    propertyOf(choice.evidence as Citation),
  );
  if (!fromProperty) return { judgment, changed: false };
  const { correction: _correction, ...kept } = judgment;
  return { judgment: kept, changed: false };
}

/**
 * The sentence's result held to the rules above, figure by figure and for the rest of its words:
 * a property decides only what it may, and a sentence about the dates of a file that records none
 * says that only this computer's date is known.
 */
function settled(
  result: AtomicClaimCheckResult,
  claim: string,
  asked: ReadonlySet<FilePropertyName>,
  shown: readonly PropertySource[],
  language: Parameters<typeof translate>[0],
): AtomicClaimCheckResult {
  let downgraded = false;
  const hold = (judgment: ClaimJudgment, ...deciding: (Citation | null | undefined)[]) => {
    const held = heldTo(judgment, deciding, claim, asked);
    downgraded ||= held.changed;
    return held.judgment;
  };
  const evidenceOf = (judgment: ClaimJudgment) =>
    judgment.verdict === "not-checked" ? null : judgment.evidence;
  const figures = result.figures?.map((figure) => ({
    ...figure,
    result: hold(
      figure.result,
      evidenceOf(figure.result),
      figure.sourceInput?.citation,
      figure.source,
    ),
  }));
  const remainder = result.remainder ? hold(result.remainder, evidenceOf(result.remainder)) : null;
  let sentence = hold(result, evidenceOf(result));
  // A sentence a figure or its other words no longer back is no longer Supported either.
  if (downgraded && sentence.verdict === "supported") sentence = unbacked(sentence);
  const judged: AtomicClaimCheckResult = {
    ...result,
    ...sentence,
    ...(figures && { figures }),
    ...(result.remainder !== undefined && { remainder: result.remainder && remainder }),
  };
  return withComputerDate(judged, asked, shown, language);
}

/** An Unsupported sentence about a file's dates that only this computer knows says so (#2458). */
function withComputerDate(
  result: AtomicClaimCheckResult,
  asked: ReadonlySet<FilePropertyName>,
  shown: readonly PropertySource[],
  language: Parameters<typeof translate>[0],
): AtomicClaimCheckResult {
  if (result.verdict !== "unsupported") return result;
  const which = asked.has("modified") ? "modified" : asked.has("created") ? "created" : null;
  if (which === null) return result;
  // Only when one Document was in question, and it records none of its own.
  const own = shown.filter((source) => source.lines.some((line) => line.property === which));
  const computer = shown.filter((source) => source.computer?.[which]);
  const date = computer[0]?.computer?.[which];
  if (own.length > 0 || computer.length !== 1 || !date) return result;
  return {
    ...result,
    evidence: null,
    unsupported: {
      reason: translate(language, "claim.properties.computerOnly", {
        date: formatDate(date, language),
      }),
      covered: null,
      uncovered: null,
      found: true,
    },
  };
}

/** Most Documents whose properties one search adds: those of its best Passages. */
const MOST_PER_SEARCH = 5;

/**
 * A scope this small has its every Document's properties from the first search on: a sentence
 * about "the file" names nothing its text holds, so its words may find no Passage of it.
 */
const FEW_DOCUMENTS = 3;

/**
 * A check whose sentence asks about a file's properties finds them beside its Passages; any other
 * check is `create(deps)` as it is.
 */
export function withFileProperties(
  deps: ClaimCheckDependencies,
  create: (
    deps: ClaimCheckDependencies,
  ) => (request: ClaimCheckRequest) => Promise<AtomicClaimCheckResult>,
): (request: ClaimCheckRequest) => Promise<AtomicClaimCheckResult> {
  const plain = create(deps);
  return async (request) => {
    const asked = askedProperties(request.claim, request.originalClaim ?? request.claim);
    const getMany = deps.documents.getMany;
    if (asked.size === 0 || !getMany) return plain(request);
    const { scope } = request;
    const inScope = (documentId: string) =>
      !scope.excluded.has(documentId) &&
      (scope.documentIds === null || scope.documentIds.includes(documentId));
    // A sentence that cites a Document is about that Document's file.
    const cited = [
      ...new Set(
        (request.cited ?? []).flatMap(({ passageId }) => {
          const source = passageId ? deps.documents.citationSource(passageId) : null;
          return source && !source.documentDeleted && !source.notCited && inScope(source.documentId)
            ? [source.documentId]
            : [];
        }),
      ),
    ];
    const sources = new Map<string, PropertySource>();
    const byPassage = new Map<string, PropertySource>();
    const sourceFor = (documentId: string): PropertySource | null => {
      const known = [...sources.values()].find((each) => each.documentId === documentId);
      if (known) return known;
      const [document] = getMany([documentId]);
      if (!document || document.notCited) return null;
      const made = propertySource(document, () =>
        deps.documents.pageTexts(document.id, document.contentHash, null, null),
      );
      if (!made) return null;
      sources.set(made.passage.contentHash, made);
      byPassage.set(made.passage.passageId, made);
      return made;
    };
    const searchable = deps.documents
      .searchableBySize(scope.documentIds)
      .filter((each) => inScope(each.id));
    const few = searchable.length <= FEW_DOCUMENTS ? searchable.map((each) => each.id) : [];
    const shown = new Set<string>();
    const withProperties: ClaimCheckDependencies = {
      ...deps,
      evidence: {
        async search(query, searched, signal) {
          const found = await deps.evidence.search(query, searched, signal);
          const reachable = (documentId: string) =>
            inScope(documentId) &&
            (searched.documentIds === null || searched.documentIds.includes(documentId));
          const documents =
            cited.length > 0
              ? cited.filter(reachable)
              : [
                  ...new Set([
                    ...few.filter(reachable),
                    ...[...new Set(found.passages.map((passage) => passage.documentId))].slice(
                      0,
                      MOST_PER_SEARCH,
                    ),
                  ]),
                ];
          const added = documents.flatMap((documentId) => {
            if (shown.has(documentId)) return [];
            const source = sourceFor(documentId);
            if (!source) return [];
            shown.add(documentId);
            return [source.passage];
          });
          return added.length === 0 ? found : { ...found, passages: [...found.passages, ...added] };
        },
      },
      documents: {
        ...deps.documents,
        citationSource: (passageId): CitationSource | null => {
          const source = byPassage.get(passageId);
          if (!source) return deps.documents.citationSource(passageId);
          return {
            passageId,
            text: source.passage.text,
            pageFrom: null,
            pageTo: null,
            documentId: source.documentId,
            documentName: source.documentName,
            documentKind: source.passage.documentKind,
            contentHash: source.passage.contentHash,
            documentDeleted: false,
            notCited: false,
          };
        },
        pageTexts: (documentId, contentHash, from, to) => {
          const source = sources.get(contentHash);
          return source && source.documentId === documentId
            ? [source.unit]
            : deps.documents.pageTexts(documentId, contentHash, from, to);
        },
      },
    };
    const result = await create(withProperties)(request);
    const shownSources = [...sources.values()].filter((source) => shown.has(source.documentId));
    return settled(
      asProperties(result, sources) as AtomicClaimCheckResult,
      request.originalClaim ?? request.claim,
      asked,
      shownSources,
      deps.language(),
    );
  };
}
