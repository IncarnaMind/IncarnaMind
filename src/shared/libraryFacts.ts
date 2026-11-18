/**
 * The Library's own facts as a check cited them (#2525): how a row names the fact that decided a
 * sentence, and how a stored check's result keeps, beside its Documents' versions, each fact it
 * rests on. Checks no longer read the Library's facts, so such a mark needs a re-check.
 */
import type {
  CheckWorking,
  CitationAttributes,
  CitationLocation,
  DocumentKind,
  LibraryFact,
  LibrarySource,
  SearchScope,
} from "../core/api";
import { isRecord } from "../core/errors";
import type { Language } from "../core/language";
import { listOf } from "./i18n/join";
import type { Translate } from "./locations";
import { storedSearchScope } from "./searchScope";

type LibraryLocation = Extract<CitationLocation, { kind: "library" }>;

/** The Document id a Citation of the Library's facts carries: the facts are no Document's. */
export const LIBRARY_FACTS = "library-facts";

const VERSION = `${LIBRARY_FACTS}:`;

export const isLibraryCitation = (citation: Pick<CitationAttributes, "location">): boolean =>
  (citation.location as { kind?: unknown } | null)?.kind === "library";

export const DOCUMENT_KINDS: Readonly<Record<DocumentKind, true>> = {
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

/** What a check's working counted of the Library: "Your Library: 22 Documents and 3 Folders". */
export const listsRow = (
  { source, lists }: NonNullable<CheckWorking["library"]>,
  t: Translate,
  language: Language,
): string =>
  t("claim.library.row", {
    source: sourceWords(source, t, language),
    fact: listOf(
      lists.map(({ list, count }) => factWords({ kind: list, count }, t, language)),
      language,
    ),
  });

/** A check's row for the fact that decided its sentence: "Your Library: 22 Documents". */
export const libraryRow = (location: LibraryLocation, t: Translate, language: Language): string =>
  t("claim.library.row", {
    source: sourceWords(location.source, t, language),
    fact: factWords(location.fact, t, language),
  });
