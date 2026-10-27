/**
 * The sources a Mind's Citations name (#102), for copying with footnotes and for the
 * Bibliography: a Citation's source as a footnote reads it, and each cited Document once with
 * the Locations cited. A web page's source carries its title, its site's name, its address and
 * the day the quoted version was fetched, as "accessed". Pure, shared by the editor and the core.
 */
import type { CitationAttributes, Document } from "../core/api";
import type { Language } from "../core/language";
import { citationState, citedLocation, shownDocumentName } from "./citations";
import { titleWithoutSite } from "./documentNames";
import { translate } from "./i18n";
import type { Translate } from "./locations";

/** What a source needs of a live Document: whether a Citation still has one, its name and its web page. */
export type SourceDocument = Pick<Document, "id" | "contentHash"> &
  Partial<Pick<Document, "name" | "title" | "web">>;

export interface SourceContext {
  language: Language;
  /** The live Documents, or null while they load. */
  documents: readonly SourceDocument[] | null;
}

/** A web page as it is cited. */
export interface WebSource {
  site: string;
  address: string;
  /** The days the quoted versions were fetched, in the language's own form, earliest first. */
  accessed: string[];
}

/** A cited Document, once, with where in it the Mind cites. */
export interface Source {
  /** The live Document's id, else its name, as it was when cited. */
  key: string;
  /** The live Document, or null once it is deleted. */
  documentId: string | null;
  name: string;
  /** The Locations cited, each once, in the order they are first cited. */
  locations: string[];
  web: WebSource | null;
}

const translator =
  (language: Language): Translate =>
  (key, params) =>
    translate(language, key, params);

/** The day a web page's version was fetched, as the interface language writes a date. */
function dayOf(at: string, language: Language): string {
  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(at));
}

type Cited = Partial<CitationAttributes>;

/** The live Document a Citation opens: its own, or one with the same content; null once deleted. */
const liveIdOf = (attributes: Cited, documents: readonly SourceDocument[]) =>
  citationState({ ...attributes, check: "found" }, documents).documentId;

/** The live web page a Citation quotes, and the day its quoted version was fetched. */
function webOf(attributes: Cited, context: SourceContext) {
  if (!context.documents) return null;
  const id = liveIdOf(attributes, context.documents);
  const web = context.documents.find((each) => each.id === id)?.web;
  if (!web) return null;
  const version = web.versions.find((each) => each.contentHash === attributes.contentHash);
  return { web, fetchedAt: version?.fetchedAt ?? null };
}

const nameOf = (attributes: Cited, context: SourceContext, t: Translate) =>
  shownDocumentName(attributes, context.documents) || t("export.unnamedDocument");

/** A web page's own words for its source, the site named after the title it doesn't end with. */
function webParts(name: string, web: { site: string }): string[] {
  const parts = [titleWithoutSite(name, web.site)];
  if (web.site && web.site !== name) parts.push(web.site);
  return parts;
}

/**
 * A Citation's source as its footnote reads it: "Aldermoor MSA, p. 14", or a web page's
 * "Tea, The Open Encyclopedia, § History, ¶ 3, https://tea.example/history, accessed 3 October 2026".
 * `link` is the page's address, for a format that makes it a link.
 */
/** A Citation's Document as it is named now, and where in it, apart, for a link beside its place. */
export function sourceParts(
  attributes: Cited,
  context: SourceContext,
): { name: string; location: string | null } {
  const t = translator(context.language);
  return { name: nameOf(attributes, context, t), location: citedLocation(attributes, t) };
}

export function sourceText(
  attributes: Cited,
  context: SourceContext,
): { text: string; link: string | null } {
  const t = translator(context.language);
  const { name, location } = sourceParts(attributes, context);
  const found = webOf(attributes, context);
  if (!found) {
    return {
      text: location
        ? t("export.citation.location", { document: name, location })
        : t("export.citation.document", { document: name }),
      link: null,
    };
  }
  const { web, fetchedAt } = found;
  const parts = webParts(name, { site: web.siteName });
  if (location) parts.push(location);
  parts.push(web.address);
  if (fetchedAt)
    parts.push(t("citedSource.accessed", { date: dayOf(fetchedAt, context.language) }));
  return { text: parts.join(t("citedSource.separator")), link: web.address };
}

/** What a Citation's Document is listed under: the live Document's id, else its name. */
export function sourceKeyOf(attributes: Cited, context: SourceContext): string {
  const live = context.documents ? liveIdOf(attributes, context.documents) : null;
  return live ?? `name:${nameOf(attributes, context, translator(context.language))}`;
}

/**
 * The Documents the Citations cite, each once, with the Locations cited: by name (numbers in
 * names sort as numbers), or `order: "cited"`, in the order they are first cited. A Citation of
 * a deleted Document is listed by the name it was cited with.
 */
export function sourcesOf(
  citations: readonly Cited[],
  context: SourceContext,
  order: "name" | "cited" = "name",
): Source[] {
  const t = translator(context.language);
  const found = new Map<string, Source & { fetched: Set<string> }>();
  for (const attributes of citations) {
    const live = context.documents ? liveIdOf(attributes, context.documents) : null;
    const name = nameOf(attributes, context, t);
    const key = live ?? `name:${name}`;
    let source = found.get(key);
    if (!source) {
      const web = webOf(attributes, context)?.web;
      source = {
        key,
        documentId: live,
        name,
        locations: [],
        web: web ? { site: web.siteName, address: web.address, accessed: [] } : null,
        fetched: new Set(),
      };
      found.set(key, source);
    }
    const location = citedLocation(attributes, t);
    if (location && !source.locations.includes(location)) source.locations.push(location);
    const fetchedAt = webOf(attributes, context)?.fetchedAt;
    if (fetchedAt) source.fetched.add(fetchedAt);
  }
  const collator = new Intl.Collator(["en", "zh-CN"], { sensitivity: "base", numeric: true });
  const sources = [...found.values()].map(({ fetched, ...source }) => {
    if (source.web) {
      source.web.accessed = [...fetched].sort().map((at) => dayOf(at, context.language));
    }
    return source;
  });
  return order === "cited" ? sources : sources.sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * A source as a Bibliography entry: the Document's name, or a web page's title, site, address
 * and accessed day, then where it is cited ("Cited: p. 14; § 3").
 */
export function sourceEntry(source: Source, language: Language): string {
  const t = translator(language);
  const parts = source.web ? webParts(source.name, source.web) : [source.name];
  if (source.web) {
    parts.push(source.web.address);
    if (source.web.accessed.length > 0) {
      parts.push(
        t("citedSource.accessed", { date: source.web.accessed.join(t("citedSource.list")) }),
      );
    }
  }
  const entry = parts.join(t("citedSource.separator"));
  return source.locations.length > 0
    ? t("citedSource.cited", { entry, locations: source.locations.join(t("citedSource.list")) })
    : entry;
}
