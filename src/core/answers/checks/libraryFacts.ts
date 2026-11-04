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
 * - A sentence whose line says the facts can't settle it ("covering business material", a
 *   reading of the names) is Not checked, with why: no check can change that.
 * - A fact's words are never a correction of the sentence's.
 * The result keeps a version of each fact it rests on, so a change to the Library puts the
 * sentence back to needs re-check. A check whose Run shows no facts is as it was.
 */
import { createHash } from "node:crypto";
import { translate } from "../../../shared/i18n";
import {
  factKey,
  factValue,
  factVersion,
  LIBRARY_FACTS,
  SOURCE_KEY,
  sourceValue,
} from "../../../shared/libraryFacts";
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
import { type CitationLike, type Decided, lineQuoted, UNDECIDED, unbacked } from "./fileProperties";
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
  /** The notes it sees, the one being checked left out, and the names of those that have one. */
  notes: { count: number; names: readonly string[] };
}

/** What a Run's searches ask of the Library's facts (`ClaimCheckDependencies`). */
export interface LibraryFactSearch {
  /** The facts' Passage a search adds to what it found: its names chosen by the search's words. */
  add(query: string): WindowedPassage[];
  /** A search's result with what the model is told of the facts it shows. */
  told(result: SearchResultForModel): SearchResultForModel;
  /** Asks once for the Library line, of a reply after the facts were shown that has none. */
  turnCheck: TurnCheck;
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
  folders: "folders",
  tags: "tags",
  tag: "tag",
  notes: "notes",
  note: "note",
};

/** Lines of names past which only the names the search's words match are listed. */
const MOST_NAMES = 200;

const english = (key: Parameters<typeof translate>[1]) => translate("en", key);

export const LIBRARY_NOTE = [
  "The Library facts above are what IncarnaMind's Library lists for this check's scope, not what any Document says. They decide only a sentence about the Library itself: how many Documents it holds, in all or in a Folder, their names and kinds, which share a name, and its Folders, Tags and notes. A count they give that differs from the sentence's contradicts it. They never decide what a Document's text says. A description of the Library they can't settle, such as what its Documents are about or a reading of their names, can't be checked.",
  'Cite the one line that decides it. After your Verdict line, add a line "Library: " and the facts the sentence states, from documents, folder, unfiled, kind, name, folders, tags, tag, notes and note, separated by commas; "Library: description" for a description of the Library they can\'t settle; or "Library: none" when it is about what a Document says.',
].join("\n");

const LIBRARY_ASK =
  'Your reply has no Library line. Write your whole reply again, with a line after the Verdict line: "Library: " and the facts the sentence states (documents, folder, unfiled, kind, name, folders, tags, tag, notes or note), "Library: description" for a description of the Library the facts can\'t settle, or "Library: none" when it is about what a Document says.';

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
    ...[...names]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]): LibraryFact => ({ kind: "name", name, count })),
  ];
}

function lineOf(fact: LibraryFact, listing: LibraryListing): string {
  switch (fact.kind) {
    case "documents":
      return `Documents: ${fact.count}`;
    case "folder":
      return `Documents in the Folder “${fact.name}”: ${fact.count}`;
    case "unfiled":
      return `Documents not in a Folder: ${fact.count}`;
    case "format":
      return `${english(`library.format.${fact.format}`)} Documents: ${fact.count}`;
    case "folders":
      return `Folders: ${fact.count}`;
    case "tags":
      return `Tags on these Documents: ${fact.count}`;
    case "tag":
      return `Documents tagged “${fact.name}”: ${fact.count}`;
    case "notes":
      return `Notes besides this one: ${fact.count}`;
    case "note":
      return `Note “${fact.name}”`;
    case "name": {
      const kinds = listing.documents
        .filter((each) => oneLine(each.name) === fact.name)
        .map((each) => english(`library.format.${each.kind}`));
      return `Documents named “${fact.name}”: ${fact.count} (${kinds.join(", ")})`;
    }
  }
}

/**
 * The facts' text for the model and where each fact's line is in it. Past `MOST_NAMES` names, the
 * names that more than one Document shares and those the search's words match are listed, and the
 * text says how many more there are.
 */
export function libraryText(
  listing: LibraryListing,
  query: string,
): { text: string; lines: Line[] } {
  const all = factsOf(listing);
  const named = all.filter((fact): fact is LibraryFact & { kind: "name" } => fact.kind === "name");
  // A short Latin word ("of", "is") would match most names; two Han characters name something.
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => [...word].length >= 3 || /\p{Script=Han}{2}/u.test(word));
  const asked = (fact: LibraryFact & { kind: "name" }) =>
    words.some((word) => fact.name.toLowerCase().includes(word));
  const listed =
    named.length <= MOST_NAMES
      ? named
      : [
          ...named.filter((fact) => fact.count > 1),
          ...named.filter((fact) => fact.count === 1 && asked(fact)),
        ].slice(0, MOST_NAMES);
  const facts = [...all.filter((fact) => fact.kind !== "name"), ...listed];
  let text = `Library facts of ${englishSource(listing.source)}: what IncarnaMind's Library lists for this check's scope, not what any Document says.`;
  const lines: Line[] = [];
  for (const fact of facts) {
    text += "\n";
    const start = text.length;
    text += lineOf(fact, listing);
    lines.push({ fact, start, end: text.length });
  }
  if (listed.length < named.length) {
    text += `\nNames not listed: ${named.length - listed.length} more. Search again with a Document's name in the query to see its line.`;
  }
  return { text, lines };
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

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
  deps: ClaimCheckDependencies,
) {
  const shown = new Map<string, Shown>();
  let reply = "";

  const search: LibraryFactSearch = {
    add(query) {
      const now = listing();
      const { text, lines } = libraryText(now, query);
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
    turnCheck: {
      name: "library-facts",
      check(last, setAside = []) {
        if (shown.size === 0) return null;
        const text = replyAcrossTurns(last, setAside);
        if (readVerdict(text) === null || declaredLibrary(text) !== null) return null;
        return { claims: [], note: LIBRARY_ASK };
      },
    },
    replied(text) {
      reply = text;
    },
  };

  const byPassage = (passageId: string) =>
    [...shown.values()].find((each) => each.passage.passageId === passageId);

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
      ...versions.filter((each) => each.documentId !== LIBRARY_FACTS),
      ...(keys.size === 0 ? [] : [...now].map(([key, value]) => factVersion(searched, key, value))),
    ];
  }

  function settle(raw: AtomicClaimCheckResult): AtomicClaimCheckResult {
    if (shown.size === 0) return raw;
    const declared = declaredLibrary(reply);
    const result = asFacts(raw) as AtomicClaimCheckResult;
    const versions = result.versions.filter((each) => each.documentId !== LIBRARY_FACTS);
    if (declared?.kind === "description") return unsettled(result, versions);
    const facts = declared?.kind === "facts" ? declared.facts : null;
    const mayDecide = (citation: CitationLike | null | undefined) => {
      const fact = factOf(citation);
      if (fact === undefined) return true;
      return fact !== null && facts?.has(fact.kind) === true;
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
      if (!all.every(mayDecide) || unbackedFact) return unbacked(judgment as Decided) as J;
      if (!correction.some((each) => factOf(each.evidence) !== undefined)) return judgment;
      const { correction: _correction, ...kept } = judgment;
      return kept as J;
    };
    // A sentence with figures is decided by its figures and its other words, each held to these
    // rules on its own Citations; together they cite each fact its Library line names, or none of
    // them decides it.
    const evidenceOf = (judgment: ClaimJudgment | null | undefined) =>
      judgment && judgment.verdict !== "not-checked" ? judgment.evidence : null;
    const backed = new Set(
      [
        ...(result.figures ?? []).flatMap((figure) => [
          evidenceOf(figure.result),
          figure.source,
          figure.sourceInput?.citation,
        ]),
        evidenceOf(result.remainder),
      ].flatMap((each) => factOf(each)?.kind ?? []),
    );
    const partsUnbacked = facts !== null && [...facts].some((kind) => !backed.has(kind));
    const heldPart = <J extends ClaimJudgment>(
      judgment: J,
      deciding: readonly (CitationLike | null | undefined)[],
    ): J => {
      const judged = held(judgment, deciding, false);
      return partsUnbacked && (judged.verdict === "supported" || judged.verdict === "contradicted")
        ? (unbacked(judged as Decided) as J)
        : judged;
    };
    const figures = result.figures?.map((figure): FigureCheckResult => {
      const judged = heldPart(figure.result, [figure.source, figure.sourceInput?.citation]);
      // A figure's source is a number in a Document's text, which the Note may cite or change the
      // figure to; a fact it was compared with is only its result's evidence.
      const fromFact = [figure.source, figure.sourceInput?.citation].some(
        (citation) => factOf(citation) !== undefined,
      );
      return fromFact
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
    const unsupported = facts !== null && judged.verdict === "unsupported";
    return { ...judged, versions: versionsOf(versions, rests, unsupported) };
  }

  return { search, documents, settle };
}

/** A sentence the facts can't settle: Not checked, with why, its figures and its other words too. */
function unsettled(
  result: AtomicClaimCheckResult,
  versions: CheckedVersion[],
): AtomicClaimCheckResult {
  const reason = {
    verdict: "not-checked" as const,
    reason: "library-unsettled" as const,
    detail: null,
  };
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
        result: { ...reason, versions: figure.result.versions, excluded: figure.result.excluded },
      })),
    }),
    ...(result.remainder !== undefined && {
      remainder: result.remainder && {
        ...reason,
        versions: result.remainder.versions,
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
    const run = libraryRun(listing, searched, deps);
    const result = await create({
      ...deps,
      documents: run.documents,
      libraryFacts: run.search,
    })(request);
    return run.settle(result);
  };
}
