/**
 * How a Citation shows: its badge state and the words for it. Pure, shared by
 * the editor and the tests.
 *
 * The badge says whether the quote was found on the cited page, never that the
 * sentence is verified: "found" means the quote is there, not that it supports
 * the claim.
 */
import type {
  CitationAttributes,
  CitationCheck,
  CitationCheckReason,
  CitationRecheck,
  Document,
  KeptCitationText,
  QuotedPiece,
  QuotedWords,
} from "../core/api";
import type { Language } from "../core/language";
import { formatDate } from "./dates";
import { displayName } from "./documentNames";
import type { MessageKey } from "./i18n";
import {
  citationLocation,
  englishPrintedLocation,
  formatLocation,
  isTranscriptLocation,
  readsIn,
  type Translate,
} from "./locations";
import { findQuote } from "./quoteMatch";

const CITATION_CHECKS: readonly CitationCheck[] = [
  "checking",
  "found",
  "not-found",
  "cant-check",
  "unsupported",
  "contradicted",
];

/** A Citation's attributes as a node holds them; what is missing or isn't the right type is left out. */
export function citationAttributesOf(node: Record<string, unknown>): Partial<CitationAttributes> {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const count = (value: unknown) => (typeof value === "number" ? value : null);
  const check = CITATION_CHECKS.find((each) => each === node.check);
  const verdict = text(node.verdict);
  return {
    passageId: text(node.passageId),
    documentId: text(node.documentId),
    documentName: text(node.documentName),
    contentHash: text(node.contentHash),
    pageFrom: count(node.pageFrom),
    pageTo: count(node.pageTo),
    location: citationLocation({
      pageFrom: count(node.pageFrom),
      pageTo: count(node.pageTo),
      location: node.location,
    }),
    quote: text(node.quote),
    ...(check && { check }),
    ...(verdict !== null && { verdict }),
  };
}

export interface CitationState {
  /** What the badge shows. */
  check: CitationCheck;
  /** Why it wasn't found, or can't be checked. */
  reason: CitationCheckReason | null;
  /** The Folder whose wall keeps this Citation's last result, when there is one. */
  keptInside?: string | null;
  /**
   * The live Document the Citation opens: its own, or one with the same
   * content added again after it was deleted. Null once the Document has
   * been deleted, or unlinked with its Linked folder.
   */
  documentId: string | null;
  /**
   * The Document changed after the Citation was made: its current version
   * isn't the one quoted. The check still stands for the version quoted,
   * whose text is kept; `recheckCitation` checks the current one, so the
   * card can say "the Document changed after this was cited" and offer it.
   */
  changedAfterCited: boolean;
}

/**
 * Whether the stored text a Citation's check read is kept, though its
 * Document was unlinked with its Linked folder: every Unit it cites, of the
 * version it quotes (or of any version, if it doesn't say). The viewer asks
 * too, to say why it can't show the Document.
 */
export function citedTextKept(
  attributes: Partial<
    Pick<CitationAttributes, "documentId" | "contentHash" | "pageFrom" | "pageTo">
  >,
  kept: readonly KeptCitationText[],
): boolean {
  const { documentId, contentHash, pageFrom, pageTo } = attributes;
  if (!documentId) return false;
  return kept.some((text) => {
    if (text.documentId !== documentId) return false;
    if (contentHash && text.contentHash !== contentHash) return false;
    // A whole TXT or Markdown file cited before Units: its one text.
    if (typeof pageFrom !== "number") return text.units.length > 0;
    const other = typeof pageTo === "number" ? pageTo : pageFrom;
    const [from, to] = [Math.min(pageFrom, other), Math.max(pageFrom, other)];
    // Units are numbered without gaps, and each is kept once.
    return text.units.filter((unit) => unit >= from && unit <= to).length === to - from + 1;
  });
}

/** What a Citation needs of a live Document: whether it is there, and the name to show for it. */
export type LiveDocument = Pick<Document, "id" | "contentHash"> &
  Partial<Pick<Document, "name" | "title">>;

/** A list of Documents by ID and by content: the first in the list with each. */
interface DocumentIndex {
  byId: ReadonlyMap<string, LiveDocument>;
  byContent: ReadonlyMap<string, LiveDocument>;
}

/**
 * Each list of Documents indexed once, by the list: a Mind looks up a
 * Document for every Citation it shows, often, and a list is replaced, never
 * changed in place, when the Documents change.
 */
const indexes = new WeakMap<readonly LiveDocument[], DocumentIndex>();

function indexOf(documents: readonly LiveDocument[]): DocumentIndex {
  let index = indexes.get(documents);
  if (!index) {
    const byId = new Map<string, LiveDocument>();
    const byContent = new Map<string, LiveDocument>();
    for (const document of documents) {
      if (!byId.has(document.id)) byId.set(document.id, document);
      if (document.contentHash && !byContent.has(document.contentHash)) {
        byContent.set(document.contentHash, document);
      }
    }
    index = { byId, byContent };
    indexes.set(documents, index);
  }
  return index;
}

/** The live Document a Citation opens: its own, or one with the same content added again after it was deleted. */
export function liveDocumentOf(
  attributes: Partial<Pick<CitationAttributes, "documentId" | "contentHash">>,
  documents: readonly LiveDocument[],
): LiveDocument | undefined {
  const { byId, byContent } = indexOf(documents);
  const own = attributes.documentId ?? null;
  return (
    (own === null ? undefined : byId.get(own)) ??
    (attributes.contentHash ? byContent.get(attributes.contentHash) : undefined)
  );
}

type Named = Partial<Pick<CitationAttributes, "documentId" | "contentHash" | "documentName">>;

/**
 * The name a Citation shows for its Document: the Document's own name while it is here, so a
 * rename shows in every Citation of it, and the name stored when it was cited only when the
 * Document can't be found. The stored name is never rewritten.
 */
export function shownDocumentName(
  attributes: Named,
  documents: readonly LiveDocument[] | null,
): string | null {
  const live = documents ? liveDocumentOf(attributes, documents) : undefined;
  return live?.name === undefined
    ? (attributes.documentName ?? null)
    : displayName({ name: live.name, title: live.title });
}

/** The attributes with `shownDocumentName` for the name: the same object when it is the stored one. */
export function withShownName<T extends Named>(
  attributes: T,
  documents: readonly LiveDocument[] | null,
): T {
  const name = shownDocumentName(attributes, documents);
  return name === (attributes.documentName ?? null)
    ? attributes
    : { ...attributes, documentName: name };
}

/**
 * The badge state of a Citation, given the User's live Documents (null while
 * they are loading) and the text kept of Documents unlinked with their Linked
 * folder. The check result stored when the Answer finished stands, unless the
 * Document has been deleted since: then it "can't be checked". A Document
 * unlinked with its folder keeps the text its Citations cite, so their check
 * stands too.
 */
export function citationState(
  attributes: Partial<CitationAttributes>,
  documents: readonly LiveDocument[] | null,
  kept: readonly KeptCitationText[] = [],
  keptInside: string | null = null,
): CitationState {
  const check = attributes.check ?? "checking";
  const reason = attributes.checkReason ?? null;
  const own = attributes.documentId ?? null;
  if (documents === null) return { check, reason, documentId: own, changedAfterCited: false };
  const live = liveDocumentOf(attributes, documents);
  const changedAfterCited =
    live !== undefined &&
    typeof attributes.contentHash === "string" &&
    attributes.contentHash !== "" &&
    live.contentHash !== attributes.contentHash;
  if (check === "checking") {
    return { check, reason: null, documentId: live?.id ?? own, changedAfterCited: false };
  }
  if (keptInside) {
    return {
      check,
      reason: "kept-inside",
      documentId: live?.id ?? own,
      changedAfterCited: false,
      keptInside,
    };
  }
  if (!live && citedTextKept(attributes, kept)) {
    return { check, reason, documentId: null, changedAfterCited: false };
  }
  if (!live) {
    return { check: "cant-check", reason: "document-removed", documentId: null, changedAfterCited };
  }
  return { check, reason, documentId: live.id, changedAfterCited };
}

/** Where a Citation's quote stands in its Document's current version. */
export type QuoteStanding = "found" | "moved" | "gone";

/**
 * How a Citation's quote stands in the version `recheck` read: at the
 * Location it cites, at another one, or no longer there. Null while the
 * version isn't checked, and when it can't be checked.
 */
export function quoteStanding(
  cited: Partial<Pick<CitationAttributes, "pageFrom" | "pageTo" | "location">>,
  recheck: CitationRecheck | null,
): QuoteStanding | null {
  if (recheck === null || recheck.check === "cant-check") return null;
  if (recheck.check !== "found") return "gone";
  const from = cited.pageFrom ?? null;
  const to = cited.pageTo ?? from;
  const now = recheck.pageFrom;
  if (now !== from || (recheck.pageTo ?? now) !== to) return "moved";
  // The same Units, but a sheet's rows or a Word section's paragraphs can narrow to
  // another place inside them, which the Citation's own label names.
  if (cited.location && recheck.location) {
    return englishPrintedLocation(cited.location) === englishPrintedLocation(recheck.location)
      ? "found"
      : "moved";
  }
  return "found";
}

/**
 * When a Document's current version was made: a web page's fetch of that
 * version, else its file's last change, else when it was indexed.
 */
export function versionMoment(
  document: Pick<Document, "modifiedAt" | "updatedAt" | "contentHash"> & {
    web: {
      fetchedAt: string;
      versions: readonly { contentHash: string; fetchedAt: string }[];
    } | null;
  },
): string | null {
  const web = document.web;
  const fetched =
    web?.versions.find((each) => each.contentHash === document.contentHash)?.fetchedAt ??
    web?.fetchedAt;
  return fetched ?? document.modifiedAt ?? document.updatedAt;
}

/**
 * The day a saved web page was fetched again, for the notice that says what the viewer shows
 * instead of the page cited; null for any other Document.
 */
export function fetchedAgainOn(
  document: Parameters<typeof versionMoment>[0] | undefined,
  language: Language,
): string | null {
  if (!document?.web) return null;
  const moment = versionMoment(document);
  return moment ? formatDate(moment, language) : null;
}

/**
 * "This Document changed on 12 October 2026" in a language: when the version
 * the Citation now opens was made. Null while the Document is unchanged.
 */
export function changedOnMessage(
  changed: boolean,
  moment: string | null,
  language: Language,
  t: Translate,
): string | null {
  return changed && moment
    ? t("citation.changed.on", { date: formatDate(moment, language) })
    : null;
}

/**
 * What a Citation's card and the viewer say once its Document changed after it was cited, and, for
 * a file, the line that says on what day: a saved web page's notice has its day in it already.
 */
export function changedSourceLines(
  changedAfterCited: boolean,
  cited: Partial<Pick<CitationAttributes, "pageFrom" | "pageTo" | "location">>,
  recheck: CitationRecheck | "failed" | null,
  document: Parameters<typeof versionMoment>[0] | undefined,
  language: Language,
  t: Translate,
): { note: ChangedSource | null; on: string | null } {
  const note = changedSourceNote(
    changedAfterCited,
    cited,
    recheck,
    t,
    fetchedAgainOn(document, language),
  );
  const on = document?.web
    ? null
    : changedOnMessage(changedAfterCited, document ? versionMoment(document) : null, language, t);
  return { note, on };
}

/** What a Citation's card and the viewer say once its Document changed after it was cited. */
export interface ChangedSource {
  notice: string;
  /** How the quote stands in the new version; null while that is looked for, and when it can't be. */
  quote: string | null;
}

/**
 * What a Citation's card and its viewer say when its Document changed after
 * it was cited: that it changed, and where its quote stands in the new
 * version once it is looked for. Null only while the Document is unchanged.
 */
export function changedSourceNote(
  changed: boolean,
  cited: Partial<Pick<CitationAttributes, "pageFrom" | "pageTo" | "location">>,
  recheck: CitationRecheck | "failed" | null,
  t: Translate,
  fetchedAgain: string | null = null,
): ChangedSource | null {
  if (!changed) return null;
  // A saved page was fetched again: the viewer shows the new copy, and the one cited is kept.
  const notice =
    fetchedAgain === null
      ? t("citation.changedAfterCited")
      : t("citation.changedAfterCited.web", { date: fetchedAgain });
  if (recheck === "failed" || recheck === null) return { notice, quote: null };
  const standing = quoteStanding(cited, recheck);
  if (standing === "found") return { notice, quote: t("citation.changed.still") };
  if (standing === "gone") return { notice, quote: t("citation.changed.gone") };
  if (standing === null) return { notice, quote: null };
  const where = recheck.location ? formatLocation(recheck.location, t) : null;
  return {
    notice,
    quote: where
      ? t("citation.changed.moved", { location: where })
      : t("citation.changed.moved.anywhere"),
  };
}

/**
 * Whether a Citation needs re-check (#99; ADR-0017's amendment): its Document changed after it
 * was cited, and its quote isn't at its place in the current version, as `recheck` found it
 * ("failed" when it couldn't be looked for), unless the User chose to keep citing the old
 * version over that one. Quiet until the current version is looked at.
 */
export function needsRecheck(
  state: Pick<CitationState, "changedAfterCited">,
  attributes: Partial<Pick<CitationAttributes, "pageFrom" | "pageTo" | "location" | "keptOver">>,
  recheck: CitationRecheck | "failed" | null,
): boolean {
  if (!state.changedAfterCited || recheck === null) return false;
  if (recheck === "failed") return true;
  if (attributes.keptOver && attributes.keptOver === recheck.contentHash) return false;
  return quoteStanding(attributes, recheck) !== "found";
}

/**
 * What Update the sentence… makes a Citation (#99): the words now at its place in its Document's
 * current version when they changed, or its quote where it is now when it moved, checked there.
 * Null when the current version holds nothing to cite in its place.
 */
export function newVersionCitation(
  attributes: Partial<Pick<CitationAttributes, "pageFrom" | "pageTo" | "location" | "quote">>,
  recheck: CitationRecheck | "failed" | null,
): Partial<CitationAttributes> | null {
  if (recheck === null || recheck === "failed" || recheck.contentHash === null) return null;
  const now =
    recheck.changed?.now ??
    (quoteStanding(attributes, recheck) === "moved"
      ? { ...recheck, quote: attributes.quote ?? "" }
      : null);
  if (!now || now.contentHash === null) return null;
  return {
    passageId: now.passageId,
    contentHash: now.contentHash,
    pageFrom: now.pageFrom,
    pageTo: now.pageTo,
    location: now.location,
    quote: now.quote,
    check: now.check,
    checkReason: now.checkReason,
    quotedWords: null,
    verdict: null,
    keptOver: null,
  };
}

/**
 * A Citation's short Location label in a language ("p. 3", "slide 4",
 * "Revenue, rows 12–14", "§ 2.1 Sensitivity", "lines 120–134"); null for a
 * whole TXT or Markdown file cited before Locations.
 */
export function citedLocation(
  attributes: Partial<CitationAttributes>,
  t: Translate,
): string | null {
  const location = citationLocation(attributes);
  return location ? formatLocation(location, t) : null;
}

/**
 * Where a Citation points, as "Document, Location". A sheet that shares its
 * Document's name is left out of the Location, so the name isn't said twice.
 */
export function citationSource(
  attributes: Partial<CitationAttributes>,
  t: Translate,
): { name: string; where: string | null; text: string } {
  const name = attributes.documentName ?? "";
  const location = citationLocation(attributes);
  if (!location) return { name, where: null, text: name };
  const sameName = (sheet: string) =>
    sheet.toLowerCase() === name.toLowerCase().replace(/\.[^.]+$/, "") ||
    sheet.toLowerCase() === name.toLowerCase();
  const shown =
    location.kind === "rows" && location.sheet !== null && sameName(location.sheet)
      ? { ...location, sheet: null }
      : location;
  const where = formatLocation(shown, t);
  return { name, where, text: t("citation.where", { document: name, location: where }) };
}

/** A Citation as plain text, e.g. "[Attention Is All You Need, p. 3]", for copying as text. */
export function citationReference(attributes: Partial<CitationAttributes>): string {
  const name = attributes.documentName;
  if (!name) return "";
  const location = citationLocation(attributes);
  return location ? `[${name}, ${englishPrintedLocation(location)}]` : `[${name}]`;
}

/** How a Citation's place reads in a sentence, and the parameters its message takes. */
function placeOf(
  attributes: Partial<CitationAttributes>,
  t: Translate,
): { where: "document" | "transcript" | "in" | "on"; params: Record<string, string> } {
  const location = citationLocation(attributes);
  if (location === null) {
    return { where: "document", params: { document: attributes.documentName ?? "" } };
  }
  const params = { location: formatLocation(location, t, false) };
  // A Transcript's is labelled so, so its check isn't taken for a page's.
  if (isTranscriptLocation(location)) return { where: "transcript", params };
  return { where: readsIn(location) ? "in" : "on", params };
}

/** The message key and parameters of a Citation's badge, its Location worded with `t`. */
export function badgeMessage(
  state: CitationState,
  attributes: Partial<CitationAttributes>,
  t: Translate,
): { key: MessageKey; params?: Record<string, string> } {
  const { where, params } = placeOf(attributes, t);
  if (state.reason === "kept-inside") {
    return { key: "citation.badge.keptInside", params: { folder: state.keptInside ?? "" } };
  }
  switch (state.check) {
    case "checking":
      return { key: "citation.badge.checking" };
    case "found":
      return { key: `citation.badge.found.${where}`, params };
    case "not-found":
      return { key: `citation.badge.notFound.${where}`, params };
    case "cant-check":
      return { key: "citation.badge.cantCheck" };
    case "unsupported":
      return { key: "citation.badge.unsupported" };
    case "contradicted":
      return { key: "citation.badge.contradicted" };
  }
}

/** The label over the Document's words nearest the words an Answer put in quotation marks (#483). */
export function closestWordsMessage(
  attributes: Partial<CitationAttributes>,
  t: Translate,
): { key: MessageKey; params: Record<string, string> } {
  const { where, params } = placeOf(attributes, t);
  return { key: `citation.closest.${where}`, params };
}

const isPieces = (value: unknown): value is QuotedPiece[] =>
  Array.isArray(value) &&
  value.every(
    (piece) =>
      typeof piece === "object" &&
      piece !== null &&
      typeof (piece as QuotedPiece).text === "string" &&
      typeof (piece as QuotedPiece).found === "boolean",
  );

/** The quoted words a Citation stores (#483), checked; null if it has none. */
export function parseQuotedWords(value: unknown): QuotedWords | null {
  if (typeof value === "string") {
    try {
      return parseQuotedWords(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const { answer, closest } = value as Record<string, unknown>;
  if (!isPieces(answer) || answer.length === 0) return null;
  return { answer, closest: isPieces(closest) && closest.length > 0 ? closest : null };
}

/**
 * Whether the words the Answer put in quotation marks are in `text` too, as the
 * Citation check looks for them: the pieces joined as the sentence wrote them,
 * not each anywhere on its own. A Citation that asked for none counts as
 * found, so only a Citation with such words can fail this.
 */
export function quotedWordsFoundIn(text: string, value: unknown): boolean {
  const quoted = parseQuotedWords(value);
  if (quoted === null) return true;
  return findQuote(text, quoted.answer.map((piece) => piece.text).join("")) !== null;
}
