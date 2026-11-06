/**
 * A sentence about the Library itself (#2525): how many Documents it holds, in all or in a Folder,
 * their names and kinds, which share a name, its Folders, Tags and notes. No Document's text says
 * these, so a check that read only Passages called a true one Not found. The model decides that a
 * sentence is one: its search asks for the Library's facts, which come after the Passages as one
 * Passage of their own, the facts of what the check's scope sees, with Folder walls applied. Its
 * reply names the facts the sentence states on a Library line. The result keeps to these rules,
 * and fails closed:
 * - A quote is of a fact only when it is on that fact's one line.
 * - A fact decides only a sentence whose Library line names it, and a sentence whose line names
 *   one is Supported or Contradicted only with that fact's Citation: a Document's "22 files"
 *   never decides it.
 * - A verdict its reply's own Library line and Citations don't bear out is asked about once, and
 *   is Not checked if it still isn't: code never makes a verdict the model didn't give (#2313).
 * - A sentence whose line says the facts can't settle it ("covering business material", a
 *   reading of the names) is Not checked, with why: no check can change that.
 * - A fact's words are never a correction of the sentence's.
 * The result keeps a version of each fact it rests on, so a change to the Library puts the
 * sentence back to needs re-check. A check whose Run shows no facts is as it was.
 */
import { translate } from "../../../shared/i18n";
import {
  factKey,
  factValue,
  factVersion,
  LIBRARY_FACTS,
  SOURCE_KEY,
  sourceValue,
} from "../../../shared/libraryFacts";
import type { ScopeKind } from "../../../shared/searchScope";
import type {
  CheckedVersion,
  ClaimJudgment,
  DocumentKind,
  FigureCheckResult,
  LibraryFact,
  LibrarySource,
  SearchScope,
} from "../../api";
import type { CitationSource } from "../../documents";
import { hashBytes } from "../../documents/files";
import { keywordTerms } from "../../documents/keywords";
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
import {
  afterFigure,
  type CitationLike,
  lineQuoted,
  UNDECIDED,
  writtenAsSize,
} from "./fileProperties";
import { LIBRARY_LINE_FIELD, readVerdict, replyAcrossTurns } from "./prompt";

/** What a check's scope sees of the Library, Folder walls applied: the facts are made from it. */
export interface LibraryListing {
  source: LibrarySource;
  documents: readonly { name: string; kind: DocumentKind }[];
  /** The Folders it sees, each with how many of its Documents are in it or a Folder inside it. */
  folders: readonly { name: string; count: number }[];
  /** Its Documents in no Folder; null when the scope is one Folder, which has none. */
  unfiled: number | null;
  tags: readonly { name: string; count: number }[];
  /** The notes it sees, the one being checked left out, and the titles typed for them. */
  notes: { count: number; names: readonly string[] };
  /** The Folder, Tag or Document the note searches, by its kind: its name is always sent. */
  searches: { kind: ScopeKind; name: string } | null;
}

/**
 * A Linked folder's own Folder as the facts name it: one at a disk's root is named by its path,
 * and no path goes to a model (#2525).
 */
export const linkedFolderName = (folder: { name: string; relativePath: string }): string =>
  folder.relativePath === "" && /[\\/]/.test(folder.name) ? "a linked folder" : folder.name;

/** What a Run's searches ask of the Library's facts (`ClaimCheckDependencies`). */
export interface LibraryFactSearch {
  /** The facts' Passage a search adds to what it found: its names chosen by the sentence's words. */
  add(): WindowedPassage[];
  /** A search's result with what the model is told of the facts it shows. */
  told(result: SearchResultForModel): SearchResultForModel;
  /**
   * Asks once, of a reply after the facts were shown, for its Library line when it has none, or
   * for the line its verdict rests on when the facts its quotes cite (`recorded`) don't bear out
   * its Library line.
   */
  turnCheck(recorded: () => readonly { passageId: string; quote: string }[]): TurnCheck;
  /** The Run's last reply, which names the facts its sentence states. */
  replied(text: string): void;
}

interface Line {
  fact: LibraryFact;
  start: number;
  end: number;
}

interface Shown {
  passage: WindowedPassage;
  unit: PageText;
  lines: Line[];
}

const VERSION = `${LIBRARY_FACTS}:`;

/** The fact kinds the Library line names, in the model's words. */
const NAMED: Readonly<Record<string, LibraryFact["kind"]>> = {
  documents: "documents",
  folder: "folder",
  unfiled: "unfiled",
  kind: "format",
  name: "name",
  shared: "shared",
  folders: "folders",
  tags: "tags",
  tag: "tag",
  notes: "notes",
  note: "note",
};

/** The most Document names one check is shown: a bound for a sentence whose words match very many. */
const MOST_NAMES = 200;

const english = (key: Parameters<typeof translate>[1]) => translate("en", key);
// Written as a sentence writes it, "2,000": a figure read from "2000" wouldn't be the same number.
const groupedNumbers = new Intl.NumberFormat("en-US");
const grouped = (count: number) => groupedNumbers.format(count);

export const LIBRARY_NOTE = [
  "The Library facts above are what IncarnaMind's Library lists for this check's scope, not what any Document says. They decide only a sentence about the Library itself: how many Documents it holds, in all or in a Folder, their names and kinds, which share a name, and its Folders, Tags and notes. A count they give that differs from the sentence's contradicts it. They never decide what a Document's text says. A description of the Library they can't settle, such as what its Documents are about or a reading of their names, can't be checked. Nor can which Folder a Document is in or which Tags it has, unless these facts are of that Folder or Tag, named on their first line: such a sentence is a description they can't settle.",
  'Cite the one line that decides it. After your Verdict line, add a line "Library: " and the facts the sentence states, from documents, folder, unfiled, kind, name, shared, folders, tags, tag, notes and note, separated by commas; "Library: description" for a description of the Library they can\'t settle; or "Library: none" when it is about what a Document says.',
].join("\n");

const LIBRARY_ASK =
  'Your reply has no Library line. Write your whole reply again, with a line after the Verdict line: "Library: " and the facts the sentence states (documents, folder, unfiled, kind, name, shared, folders, tags, tag, notes or note), "Library: description" for a description of the Library the facts can\'t settle, or "Library: none" when it is about what a Document says.';

const WORD_OF = Object.fromEntries(
  Object.entries(NAMED).map(([word, kind]) => [kind, word]),
) as Readonly<Record<LibraryFact["kind"], string>>;

const unstated = (words: readonly string[]) =>
  `Your Library line names ${words.join(", ")}, but no line of the Library facts you recorded with cite states ${words.length === 1 ? "it" : "them"}. Record with cite the one line of the Library facts that decides each, or give the Library line and Verdict the facts bear out; then write your whole reply again.`;

const DOCUMENT_ONLY =
  "Your search asked for the Library facts, yet your Verdict rests on a Document's text alone. If the sentence is about the Library, record with cite the line of the Library facts that decides it, or give the Verdict and Library line the facts bear out; then write your whole reply again.";

const NOT_ABOUT =
  "Your Library line says none, but you recorded a line of the Library facts, which decide only a sentence about the Library itself. Give the Library line the sentence calls for, and record what decides it; then write your whole reply again.";

/** What a reply's Library line says of its sentence; null when it has none that can be read. */
export type DeclaredLibrary =
  | { kind: "none" }
  | { kind: "description" }
  | { kind: "facts"; facts: ReadonlySet<LibraryFact["kind"]> };

export function declaredLibrary(reply: string): DeclaredLibrary | null {
  const line = reply
    .split("\n")
    .map((each) => LIBRARY_LINE_FIELD.exec(each.trim())?.[1])
    .findLast((each) => each !== undefined);
  if (line === undefined) return null;
  const words = line
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word !== "");
  if (words.includes("description")) return { kind: "description" };
  const facts = new Set(
    words.flatMap((word) => {
      const kind = NAMED[word];
      return kind ? [kind] : [];
    }),
  );
  if (words.includes("none")) return facts.size === 0 ? { kind: "none" } : null;
  return facts.size > 0 ? { kind: "facts", facts } : null;
}

const englishSource = (source: LibrarySource): string => {
  switch (source.kind) {
    case "library":
      return "your Library";
    case "left-out":
      return `all Documents but ${source.folders === 1 ? "1 Folder" : `${source.folders} Folders`} this note's work may not use`;
    case "scope":
      return source.more === 0 ? `“${source.name}”` : `“${source.name}” and ${source.more} more`;
  }
};

/** A name on one line: a name may hold a line break that would read as another fact. */
const oneLine = (name: string) => name.replace(/[\s\p{Cc}]+/gu, " ").trim();

const countBy = <T>(values: readonly T[]) => {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

/** Every fact a listing gives, the names' lines in the order the Library sorts them. */
function factsOf(listing: LibraryListing): LibraryFact[] {
  const names = countBy(listing.documents.map((each) => oneLine(each.name)));
  const formats = countBy(listing.documents.map((each) => each.kind));
  return [
    { kind: "documents", count: listing.documents.length },
    ...listing.folders.map(
      ({ name, count }): LibraryFact => ({ kind: "folder", name: oneLine(name), count }),
    ),
    ...(listing.unfiled === null ? [] : [{ kind: "unfiled" as const, count: listing.unfiled }]),
    ...[...formats].map(([format, count]): LibraryFact => ({ kind: "format", format, count })),
    { kind: "folders", count: listing.folders.length },
    { kind: "tags", count: listing.tags.length },
    ...listing.tags.map(
      ({ name, count }): LibraryFact => ({ kind: "tag", name: oneLine(name), count }),
    ),
    { kind: "notes", count: listing.notes.count },
    ...listing.notes.names.map((name): LibraryFact => ({ kind: "note", name: oneLine(name) })),
    { kind: "shared", count: [...names.values()].filter((count) => count > 1).length },
    ...[...names]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]): LibraryFact => ({ kind: "name", name, count })),
  ];
}

function lineOf(fact: LibraryFact, listing: LibraryListing): string {
  switch (fact.kind) {
    case "documents":
      // No other line holds these words: a quote of the total is of its line alone.
      return `Documents in all: ${grouped(fact.count)}`;
    case "folder":
      return `Documents in the Folder “${fact.name}” and the Folders inside it: ${grouped(fact.count)}`;
    case "unfiled":
      return `Documents not in a Folder: ${grouped(fact.count)}`;
    case "format":
      return `${english(`library.format.${fact.format}`)} Documents: ${grouped(fact.count)}`;
    case "folders":
      return `Folders: ${grouped(fact.count)}`;
    case "tags":
      return `Tags on these Documents: ${grouped(fact.count)}`;
    case "tag":
      return `Documents tagged “${fact.name}”: ${grouped(fact.count)}`;
    case "notes":
      return `Notes besides this one: ${grouped(fact.count)}`;
    case "note":
      return `Note “${fact.name}”`;
    case "shared":
      return `Names more than one Document shares: ${grouped(fact.count)}`;
    case "name": {
      const kinds = listing.documents
        .filter((each) => oneLine(each.name) === fact.name)
        .map((each) => english(`library.format.${each.kind}`));
      return `Documents named “${fact.name}”: ${grouped(fact.count)} (${kinds.join(", ")})`;
    }
  }
}

/** The words of a text as the keyword search splits them, a file name's parts too ("report.pdf"). */
function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const term of keywordTerms(text)) {
    words.add(term);
    for (const part of term.split(/[^\p{L}\p{N}]+/u)) if (part !== "") words.add(part);
  }
  return words;
}

/**
 * The facts' text for the model and where each fact's line is in it. Every count is there, how
 * many names more than one Document shares among them. A name is there only when it shares a word
 * with `sentence`, the sentence under check, or is the Folder, Tag or Document the note searches
 * (`LibraryListing.searches`), with its count. The match is made here, before the request, so the
 * model never sees a name the sentence doesn't need. `MOST_NAMES` bounds the names.
 */
export function libraryText(
  listing: LibraryListing,
  sentence: string,
): { text: string; lines: Line[] } {
  const words = wordsOf(sentence);
  const matches = (name: string) => [...wordsOf(name)].some((word) => words.has(word));
  const searched = (kind: ScopeKind, name: string) =>
    listing.searches?.kind === kind && listing.searches.name === name;
  const sent = (fact: LibraryFact): boolean => {
    switch (fact.kind) {
      case "folder":
        return matches(fact.name) || searched("folder", fact.name);
      case "tag":
        return matches(fact.name) || searched("tag", fact.name);
      case "note":
        return matches(fact.name);
      case "name":
        return matches(fact.name) || searched("document", fact.name);
      default:
        return true;
    }
  };
  const all = factsOf(listing).filter(sent);
  const named = all.filter((fact) => fact.kind === "name");
  const listed = named.slice(0, MOST_NAMES);
  const facts = [...all.filter((fact) => fact.kind !== "name"), ...listed];
  let text = `Library facts of ${englishSource(listing.source)}: what IncarnaMind's Library lists for this check's scope, not what any Document says. Every count covers the whole scope; a name is listed only when it shares a word with the sentence or is what this check searches.`;
  const lines: Line[] = [];
  for (const fact of facts) {
    text += "\n";
    const start = text.length;
    text += lineOf(fact, listing);
    lines.push({ fact, start, end: text.length });
  }
  if (listed.length < named.length) {
    text += `\nNames not listed: ${grouped(named.length - listed.length)} more that share a word with the sentence.`;
  }
  return { text, lines };
}

const hashOf = (text: string) => hashBytes(new TextEncoder().encode(text));

/** A fingerprint of everything the listing gives: what an Unsupported sentence about it rests on. */
const LISTING_KEY = "listing";
const listingValue = (listing: LibraryListing) =>
  hashOf(
    JSON.stringify({
      source: listing.source,
      facts: factsOf(listing).map((fact) => [factKey(fact), factValue(fact)]),
    }),
  );

/**
 * What the Library gives now for the facts a Note's checks rest on, by each version's id: a fact
 * no longer there gives "0", so it differs from the count it had.
 */
export function libraryNow(listing: LibraryListing, keys: readonly string[]): Map<string, string> {
  const facts = new Map(factsOf(listing).map((fact) => [factKey(fact), factValue(fact)]));
  return new Map(
    keys.map((key) => [
      key,
      key === SOURCE_KEY
        ? sourceValue(listing.source)
        : key === LISTING_KEY
          ? listingValue(listing)
          : (facts.get(key) ?? "0"),
    ]),
  );
}

/** The fact a Citation of the facts decides; null for one that decides none; undefined: no such Citation. */
function factOf(citation: CitationLike | null | undefined): LibraryFact | null | undefined {
  if (!citation || citation.documentId !== LIBRARY_FACTS) return undefined;
  const { location } = citation;
  return citation.check === "found" && isRecord(location) && location.kind === "library"
    ? (location.fact as LibraryFact)
    : null;
}

function libraryRun(
  listing: () => LibraryListing,
  searched: SearchScope | null,
  sentence: string,
  deps: ClaimCheckDependencies,
) {
  const shown = new Map<string, Shown>();
  let reply = "";
  const byPassage = (passageId: string) =>
    [...shown.values()].find((each) => each.passage.passageId === passageId);

  const search: LibraryFactSearch = {
    add() {
      const now = listing();
      const { text, lines } = libraryText(now, sentence);
      const hash = `${VERSION}${hashOf(text)}`;
      const known = shown.get(hash);
      if (known) return [known.passage];
      const passage: WindowedPassage = {
        passageId: hash,
        documentId: LIBRARY_FACTS,
        documentName: "Library facts",
        documentKind: "text",
        contentHash: hash,
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
      shown.set(hash, { passage, unit: { page: null, text }, lines });
      return [passage];
    },
    told(result) {
      const { coverage } = result;
      return {
        ...result,
        coverage: (fitted) => {
          const covered = coverage?.(fitted) ?? null;
          const note = fitted.includes("Library facts of ") ? LIBRARY_NOTE : null;
          return [covered, note].filter((each) => each !== null).join("\n\n") || null;
        },
      };
    },
    turnCheck: (recorded) => ({
      name: "library-facts",
      check(last, setAside = []) {
        if (shown.size === 0) return null;
        const text = replyAcrossTurns(last, setAside);
        const verdict = readVerdict(text)?.verdict;
        if (verdict === undefined) return null;
        const declared = declaredLibrary(text);
        if (declared === null) return { claims: [], note: LIBRARY_ASK };
        if (verdict === "unsupported" || declared.kind === "description") return null;
        const cited = new Set(
          recorded().flatMap(({ passageId, quote }) => {
            const source = byPassage(passageId);
            const line = source ? lineQuoted(source.unit, source.lines, quote) : null;
            return line ? [line.fact.kind] : [];
          }),
        );
        if (declared.kind === "none") {
          if (cited.size > 0) return { claims: [], note: NOT_ABOUT };
          return verdict === "supported" ? { claims: [], note: DOCUMENT_ONLY } : null;
        }
        const missing = [...declared.facts].filter((kind) => !cited.has(kind));
        const short =
          verdict === "supported" ? missing.length > 0 : missing.length === declared.facts.size;
        return short ? { claims: [], note: unstated(missing.map((kind) => WORD_OF[kind])) } : null;
      },
    }),
    replied(text) {
      reply = text;
    },
  };

  const documents: ClaimCheckDependencies["documents"] = {
    ...deps.documents,
    citationSource: (passageId): CitationSource | null => {
      const source = byPassage(passageId);
      if (!source) return deps.documents.citationSource(passageId);
      return {
        passageId,
        text: source.passage.text,
        pageFrom: null,
        pageTo: null,
        documentId: LIBRARY_FACTS,
        documentName: source.passage.documentName,
        documentKind: source.passage.documentKind,
        contentHash: source.passage.contentHash,
        documentDeleted: false,
        notCited: false,
        yourNoteAt: null,
      };
    },
    pageTexts: (documentId, contentHash, from, to) => {
      const source = shown.get(contentHash);
      return source && documentId === LIBRARY_FACTS
        ? [source.unit]
        : deps.documents.pageTexts(documentId, contentHash, from, to);
    },
  };

  /** Every Citation of the facts in a result, its quote placed on its fact's line, or not found. */
  function asFacts(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(asFacts);
    if (!isRecord(value)) return value;
    const mapped: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([name, each]) => [name, asFacts(each)]),
    );
    const hash = mapped.contentHash;
    const source = typeof hash === "string" ? shown.get(hash) : undefined;
    if (!source || typeof mapped.quote !== "string" || mapped.documentId !== LIBRARY_FACTS)
      return mapped;
    const line = lineQuoted(source.unit, source.lines, mapped.quote);
    return {
      ...mapped,
      pageFrom: null,
      pageTo: null,
      location: line ? { kind: "library", source: listing().source, fact: line.fact } : null,
      ...(!line && { check: "not-found", checkReason: "quote-not-on-pages" }),
    };
  }

  /** The versions a result keeps: its Documents', and each fact it rests on in place of the facts' text. */
  function versionsOf(
    versions: readonly CheckedVersion[],
    rests: readonly (CitationLike | null | undefined)[],
    unsupported: boolean,
  ): CheckedVersion[] {
    const keys = new Set(
      rests.flatMap((each) => {
        const fact = factOf(each);
        return fact ? [factKey(fact)] : [];
      }),
    );
    // Nothing the sentence says is listed: a change to anything listed could settle it.
    if (unsupported) keys.add(LISTING_KEY);
    const now = libraryNow(listing(), [...keys, SOURCE_KEY]);
    return [
      ...ownVersions(versions),
      ...(keys.size === 0 ? [] : [...now].map(([key, value]) => factVersion(searched, key, value))),
    ];
  }

  function settle(raw: AtomicClaimCheckResult): AtomicClaimCheckResult {
    if (shown.size === 0) return raw;
    const declared = declaredLibrary(reply);
    const result = asFacts(raw) as AtomicClaimCheckResult;
    const versions = ownVersions(result.versions);
    if (declared?.kind === "description")
      return notCheckedAll(result, versions, "library-unsettled");
    const facts = declared?.kind === "facts" ? declared.facts : null;
    const mayDecide = (citation: CitationLike | null | undefined) => {
      const fact = factOf(citation);
      if (fact === undefined) return true;
      return fact !== null && facts?.has(fact.kind) === true;
    };
    /** `judgment` held to the rules; null when its own Library line and Citations don't bear it out. */
    const held = <J extends ClaimJudgment>(
      judgment: J,
      deciding: readonly (CitationLike | null | undefined)[],
      sentence: boolean,
    ): J | null => {
      if (judgment.verdict === "not-checked") return judgment;
      if (judgment.verdict === "unsupported") {
        const why = judgment.unsupported;
        const { quoted, found: _found, ...said } = why ?? { ...UNDECIDED };
        const fromFact = !mayDecide(quoted) || !mayDecide(judgment.evidence);
        return {
          ...judgment,
          evidence: mayDecide(judgment.evidence) ? judgment.evidence : null,
          ...(why && fromFact && { unsupported: { ...said, covered: null, uncovered: null } }),
        };
      }
      const correction = judgment.correction?.choices ?? [];
      const all = [judgment.evidence, ...deciding, ...correction.map((each) => each.evidence)];
      const cited = new Set(all.flatMap((each) => factOf(each)?.kind ?? []));
      const decidedBy = factOf(judgment.evidence);
      // A Document's text that counts files ("22 files in the archive") never decides a sentence
      // about the Library, for or against.
      const unbackedFact =
        sentence &&
        facts !== null &&
        (judgment.verdict === "supported"
          ? [...facts].some((kind) => !cited.has(kind))
          : !decidedBy || !facts.has(decidedBy.kind));
      if (!all.every(mayDecide) || unbackedFact) return null;
      if (!correction.some((each) => factOf(each.evidence) !== undefined)) return judgment;
      const { correction: _correction, ...kept } = judgment;
      return kept as J;
    };
    // Each figure and the sentence's other words are held to these rules on their own Citations;
    // the sentence's own rule, below, sees every figure's Citation too.
    const evidenceOf = (judgment: ClaimJudgment | null | undefined) =>
      judgment && judgment.verdict !== "not-checked" ? judgment.evidence : null;
    // Its one ask is spent (`turnCheck`): a verdict its reply doesn't bear out is no verdict.
    const unread = () => notCheckedAll(result, versions, "malformed");
    const figures: FigureCheckResult[] = [];
    for (const figure of result.figures ?? []) {
      const checked = held(figure.result, [figure.source, figure.sourceInput?.citation], false);
      if (checked === null) return unread();
      // A count of things has no scale word, share, price or size: "22 thousand" or "22 GB" is
      // never "Documents in all: 22", nor the "0007" of "Ledger 0007" a count, for or against,
      // whatever the reply says.
      // A figure's source is a number in a Document's text, which the Note may cite or change the
      // figure to; a fact it was compared with is only its result's evidence.
      const fromFact = [figure.source, figure.sourceInput?.citation].some(
        (citation) => factOf(citation) !== undefined,
      );
      if (
        (checked.verdict === "supported" || checked.verdict === "contradicted") &&
        (factOf(checked.evidence) !== undefined || fromFact) &&
        !readsAsCount(figure)
      )
        return unread();
      const judged = { ...checked, versions: ownVersions(checked.versions) };
      figures.push(
        fromFact
          ? {
              ...figure,
              source: null,
              sourceInput: null,
              difference: null,
              roundedFrom: null,
              result: judged,
            }
          : { ...figure, result: judged },
      );
    }
    const heldRemainder = result.remainder ? held(result.remainder, [], false) : result.remainder;
    if (result.remainder && heldRemainder === null) return unread();
    const remainder = heldRemainder && {
      ...heldRemainder,
      versions: ownVersions(heldRemainder.versions),
    };
    const listed = [
      ...(result.checkedEvidence ?? []),
      ...(result.coverage?.members.flatMap((member) => member.evidence) ?? []),
      ...(result.coverage?.domainEvidence ?? []),
    ];
    const whole = held(result, listed, true);
    if (whole === null) return unread();
    const judged: AtomicClaimCheckResult = {
      ...whole,
      ...(result.figures && { figures }),
      ...(result.remainder !== undefined && { remainder }),
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
    const rests = [
      judged.verdict === "not-checked" ? null : judged.evidence,
      ...(judged.figures ?? []).map((figure) => evidenceOf(figure.result)),
      evidenceOf(judged.remainder),
    ];
    const restsOn = rests.flatMap((each) => {
      const fact = factOf(each);
      return fact ? [fact] : [];
    });
    // Shown the facts, a reply that still rests on a Document's text alone isn't borne out: its
    // one ask is spent, and a Document line describing the files never decides the Library.
    if (judged.verdict === "supported" && restsOn.length === 0) return unread();
    if (judged.verdict === "supported" && !countWordsHold(sentence, restsOn)) return unread();
    // A count it writes in words that the facts it cites give bears it out: no contradiction.
    if (judged.verdict === "contradicted" && countWordsAgree(sentence, restsOn)) return unread();
    const unsupported = facts !== null && judged.verdict === "unsupported";
    const kept = versionsOf(versions, rests, unsupported);
    // A sentence with figures is marked with its figures' versions: each keeps the facts too.
    const factVersions = kept.filter((each) => each.documentId.startsWith(VERSION));
    const withFacts = <J extends ClaimJudgment>(judgment: J): J => ({
      ...judgment,
      versions: [...judgment.versions, ...factVersions],
    });
    return {
      ...judged,
      versions: kept,
      ...(judged.figures && {
        figures: judged.figures.map((figure) => ({ ...figure, result: withFacts(figure.result) })),
      }),
      ...(judged.remainder && { remainder: withFacts(judged.remainder) }),
    };
  }

  return { search, documents, settle };
}

/**
 * The versions a result keeps of what it read, the facts' text left out: a window that sees no
 * Document of that id would take it for one deleted. The facts it rests on are kept apart.
 */
const ownVersions = (versions: readonly CheckedVersion[]): CheckedVersion[] =>
  versions.filter((each) => each.documentId !== LIBRARY_FACTS);

/** What a count of the Library counts, written after its figure: "22 uploaded Documents", "7 个文档". */
const COUNT_NOUN =
  /^(?:[\p{L}-]+\s+){0,2}(?:documents?|files?|notes?|folders?|tags?|items?|cop(?:y|ies)|records?|entr(?:y|ies)|names?|times|workbooks?|spreadsheets?)(?![\p{L}])|^(?:个|份|篇|项|条|次|本|件)/iu;

/**
 * Whether a figure reads as a count of things, which a Library count may decide: no scale word,
 * and after it nothing or a count noun, never a unit ("11 TB", "22 GB", "5 km").
 */
function readsAsCount(figure: FigureCheckResult): boolean {
  const { reading } = figure;
  if (reading.scale !== 1 || writtenAsSize(figure)) return false;
  if (reading.unit.kind === "other") return COUNT_NOUN.test(reading.unit.word);
  if (reading.unit.kind !== "plain") return false;
  const after = afterFigure(figure)?.trimStart();
  return after !== undefined && (!/^\p{L}/u.test(after) || COUNT_NOUN.test(after));
}

const WORD_COUNTS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  once: 1,
  twice: 2,
  thrice: 3,
};
const HAN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const COUNT_WORD =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|once|twice|thrice)\b|([零一两二三四五六七八九十]+)\s*(?:个|份|篇|项|条|次|本|件)/giu;

/** A Chinese numeral below a hundred: "十一" is 11, "二十" is 20, "两" is 2; null for another. */
function hanCount(numeral: string): number | null {
  const [tens, units, ...rest] = numeral.split("十");
  if (rest.length > 0) return null;
  if (units === undefined) return numeral.length === 1 ? (HAN_DIGITS[numeral] ?? null) : null;
  const ten = tens === "" ? 1 : (HAN_DIGITS[tens ?? ""] ?? null);
  const one = units === "" ? 0 : (HAN_DIGITS[units] ?? null);
  return ten === null || one === null ? null : ten * 10 + one;
}

/** The counts a sentence writes in words ("twelve Documents", "appears twice", "两份"). */
const countWords = (sentence: string): number[] =>
  [...sentence.matchAll(COUNT_WORD)].flatMap((match) => {
    const value = match[1] ? WORD_COUNTS[match[1].toLowerCase()] : hanCount(match[2] ?? "");
    return value === undefined || value === null ? [] : [value];
  });

const countsOf = (facts: readonly LibraryFact[]) =>
  facts.flatMap((fact) => (fact.kind === "note" ? [] : [fact.count]));

/**
 * A sentence that writes its count in words holds only when a fact it rests on gives that count,
 * digits in it or not: a Document's name holds digits ("Ledger 0007") that count nothing.
 */
function countWordsHold(sentence: string, facts: readonly LibraryFact[]): boolean {
  const counts = countsOf(facts);
  const said = countWords(sentence);
  return counts.length === 0 || said.length === 0 || said.some((value) => counts.includes(value));
}

/** Whether every count a sentence writes in words is one the facts it rests on give. */
function countWordsAgree(sentence: string, facts: readonly LibraryFact[]): boolean {
  const counts = countsOf(facts);
  const said = countWords(sentence);
  return counts.length > 0 && said.length > 0 && said.every((value) => counts.includes(value));
}

/** Not checked for `why`, its figures and its other words too. */
function notCheckedAll(
  result: AtomicClaimCheckResult,
  versions: CheckedVersion[],
  why: "library-unsettled" | "malformed",
): AtomicClaimCheckResult {
  const reason = { verdict: "not-checked" as const, reason: why, detail: null };
  return {
    ...reason,
    versions,
    excluded: result.excluded,
    ...(result.figures && {
      figures: result.figures.map((figure) => ({
        ...figure,
        source: null,
        sourceInput: null,
        difference: null,
        roundedFrom: null,
        result: {
          ...reason,
          versions: ownVersions(figure.result.versions),
          excluded: figure.result.excluded,
        },
      })),
    }),
    ...(result.remainder !== undefined && {
      remainder: result.remainder && {
        ...reason,
        versions: ownVersions(result.remainder.versions),
        excluded: result.remainder.excluded,
      },
    }),
  };
}

/**
 * A check whose Run may show the Library's facts: `create(deps)` with what its searches need for
 * them, its result held to the rules above. Only a check that says what it searched (a Note's) is
 * offered them, and never a whole read's window, whose every search is that window.
 */
export function withLibraryFacts(
  deps: ClaimCheckDependencies,
  create: (
    deps: ClaimCheckDependencies,
  ) => (request: ClaimCheckRequest) => Promise<AtomicClaimCheckResult>,
): (request: ClaimCheckRequest) => Promise<AtomicClaimCheckResult> {
  const plain = create(deps);
  const { libraryListing } = deps;
  if (!libraryListing) return plain;
  return async (request) => {
    const { searched } = request;
    if (request.window || searched === undefined) return plain(request);
    let known: LibraryListing | undefined;
    const listing = () => {
      known ??= libraryListing(request.mindId ?? null, searched);
      return known;
    };
    const run = libraryRun(listing, searched, request.claim, deps);
    const result = await create({
      ...deps,
      documents: run.documents,
      libraryFacts: run.search,
    })(request);
    return run.settle(result);
  };
}
