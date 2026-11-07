/**
 * The Library's own facts as a check cites them (#2525): how a row names the fact that decided a
 * sentence, and how a check's result keeps, beside its Documents' versions, each fact it rests on,
 * so a change to the Library puts the sentence back to needs re-check. Shared by the core, which
 * writes them, and the renderer, which shows and compares them.
 */
import type {
  CheckedVersion,
  CitationAttributes,
  CitationLocation,
  DocumentKind,
  LibraryFact,
  LibrarySource,
  SearchScope,
} from "../core/api";
import { isRecord } from "../core/errors";
import type { Language } from "../core/language";
import type { Translate } from "./locations";
import { storedSearchScope } from "./searchScope";

type LibraryLocation = Extract<CitationLocation, { kind: "library" }>;

/** The Document id a Citation of the Library's facts carries: the facts are no Document's. */
export const LIBRARY_FACTS = "library-facts";

const VERSION = `${LIBRARY_FACTS}:`;

export const isLibraryCitation = (citation: Pick<CitationAttributes, "location">): boolean =>
  (citation.location as { kind?: unknown } | null)?.kind === "library";

const DOCUMENT_KINDS: Readonly<Record<DocumentKind, true>> = {
  pdf: true,
  text: true,
  markdown: true,
  docx: true,
  pptx: true,
  xlsx: true,
  csv: true,
  image: true,
  rtf: true,
  html: true,
  web: true,
  transcript: true,
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isName = (value: unknown): value is string => typeof value === "string" && value !== "";

/** A stored source of the facts, checked; null if it isn't one. */
export function parseLibrarySource(value: unknown): LibrarySource | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "library":
      return { kind: "library" };
    case "left-out":
      return isCount(value.folders) && value.folders > 0
        ? { kind: "left-out", folders: value.folders }
        : null;
    case "scope":
      return isName(value.name) && isCount(value.more)
        ? { kind: "scope", name: value.name, more: value.more }
        : null;
    default:
      return null;
  }
}

/** A stored fact, checked; null if it isn't one. */
export function parseLibraryFact(value: unknown): LibraryFact | null {
  if (!isRecord(value)) return null;
  const { kind, count, name } = value;
  switch (kind) {
    case "documents":
    case "shared":
    case "unfiled":
    case "folders":
    case "tags":
    case "notes":
      return isCount(count) ? { kind, count } : null;
    case "folder":
    case "name":
    case "tag":
      return isCount(count) && isName(name) ? { kind, name, count } : null;
    case "note":
      return isName(name) ? { kind, name } : null;
    case "format": {
      const { format } = value;
      return isCount(count) && typeof format === "string" && Object.hasOwn(DOCUMENT_KINDS, format)
        ? { kind, format: format as DocumentKind, count }
        : null;
    }
    default:
      return null;
  }
}

/** What names one fact across checks: a count of the same thing is the same fact. */
export function factKey(fact: LibraryFact): string {
  switch (fact.kind) {
    case "folder":
    case "name":
    case "tag":
    case "note":
      return `${fact.kind}\n${fact.name}`;
    case "format":
      return `format\n${fact.format}`;
    default:
      return fact.kind;
  }
}

/** What a fact says, as a version of it: its count, or that a named note is there. */
export const factValue = (fact: LibraryFact): string =>
  fact.kind === "note" ? "1" : String(fact.count);

/**
 * The version a check keeps of a fact it rests on, as the scope it searched (`searched`) sees it:
 * its id names the scope and the fact, its "content" is what the fact said.
 */
export const factVersion = (
  searched: SearchScope | null,
  key: string,
  value: string,
): CheckedVersion => ({
  documentId: `${VERSION}${JSON.stringify([searched, key])}`,
  contentHash: value,
});

/** The version of where the facts came from: a wall turned on changes it. */
export const SOURCE_KEY = "source";

export const sourceValue = (source: LibrarySource): string => JSON.stringify(source);

/** The scope and fact a version of the Library keeps; null for a Document's version. */
export function readLibraryVersion(
  documentId: string,
): { searched: SearchScope | null; key: string } | null {
  if (!documentId.startsWith(VERSION)) return null;
  try {
    const parsed: unknown = JSON.parse(documentId.slice(VERSION.length));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== "string") return null;
    const [scope, key] = parsed as [unknown, string];
    const searched = scope === null ? null : storedSearchScope(scope);
    return scope !== null && searched === null ? null : { searched, key };
  } catch {
    return null;
  }
}

/** The scope chip's words for where the facts came from: "Your Library", "“Client A”". */
export function sourceWords(source: LibrarySource, t: Translate, language: Language): string {
  const count = (value: number) => new Intl.NumberFormat(language).format(value);
  switch (source.kind) {
    case "library":
      return t("claim.library.source.library");
    case "left-out":
      return source.folders === 1
        ? t("composer.scope.leftOut.one")
        : t("composer.scope.leftOut", { count: count(source.folders) });
    case "scope":
      return source.more === 0
        ? t("claim.library.source.scope", { name: source.name })
        : t("claim.library.source.scope.more", {
            name: source.name,
            count: count(source.more),
            total: count(source.more + 1),
          });
  }
}

/** A fact in the Library's own words: "22 Documents", "2 Documents named “Kestrel plan”". */
export function factWords(fact: LibraryFact, t: Translate, language: Language): string {
  const count = (value: number) => new Intl.NumberFormat(language).format(value);
  if (fact.kind === "note") return t("claim.library.note", { name: fact.name });
  const one = fact.count === 1;
  switch (fact.kind) {
    case "documents":
      return one
        ? t("claim.library.documents.one")
        : t("claim.library.documents", { count: count(fact.count) });
    case "folder":
      return one
        ? t("claim.library.folder.one", { folder: fact.name })
        : t("claim.library.folder", { folder: fact.name, count: count(fact.count) });
    case "unfiled":
      return one
        ? t("claim.library.unfiled.one")
        : t("claim.library.unfiled", { count: count(fact.count) });
    case "format": {
      const value = t(`library.format.${fact.format}`);
      return one
        ? t("library.filter.option.one", { value })
        : t("library.filter.option", { value, count: count(fact.count) });
    }
    case "name":
      return one
        ? t("claim.library.name.one", { name: fact.name })
        : t("claim.library.name", { name: fact.name, count: count(fact.count) });
    case "shared":
      return one
        ? t("claim.library.shared.one")
        : t("claim.library.shared", { count: count(fact.count) });
    case "folders":
      return one
        ? t("claim.library.folders.one")
        : t("claim.library.folders", { count: count(fact.count) });
    case "tags":
      return one
        ? t("claim.library.tags.one")
        : t("claim.library.tags", { count: count(fact.count) });
    case "tag":
      return one
        ? t("claim.library.tag.one", { tag: fact.name })
        : t("claim.library.tag", { tag: fact.name, count: count(fact.count) });
    case "notes":
      return one
        ? t("claim.library.notes.one")
        : t("claim.library.notes", { count: count(fact.count) });
  }
}

/** A check's row for the fact that decided its sentence: "Your Library: 22 Documents". */
export const libraryRow = (location: LibraryLocation, t: Translate, language: Language): string =>
  t("claim.library.row", {
    source: sourceWords(location.source, t, language),
    fact: factWords(location.fact, t, language),
  });

/** The ids of every Library fact version a stored check keeps, in its parts and figures too. */
export function libraryVersionIds(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const each of value) libraryVersionIds(each, into);
  } else if (isRecord(value)) {
    const { documentId } = value;
    if (typeof documentId === "string" && readLibraryVersion(documentId)) into.add(documentId);
    for (const each of Object.values(value)) libraryVersionIds(each, into);
  }
  return into;
}
