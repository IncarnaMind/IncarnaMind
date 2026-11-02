/**
 * The Library's filters (#59): by year, by file format and by status, each
 * with how many Documents each option holds. Options of one filter are
 * either-or; different filters must all match. A filter is one entry in a
 * list (`LibraryFacet`), so another one (Tags, say, with several values per
 * Document) is one more entry. Pure: no store, no bridge, so the tests import it.
 */

import type { Document, DocumentKind, Tag } from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** One way to filter the Library's Documents, offered as a menu of options with counts. */
export interface LibraryFacet<T> {
  /** Its key in a `FilterSelection`. */
  id: string;
  /** Its name, on its button and as its menu's title. */
  title: MessageKey;
  /**
   * The options an item falls under: one each for year, format and status;
   * a filter such as Tags may give several, or none.
   */
  values(item: T): readonly string[];
  /** An option in words. */
  label(value: string, t: Translate): string;
  /** The order its options are listed in. */
  compare(a: string, b: string): number;
  /** An option's colour, shown as a dot before it (the Tags filter's); none by default. */
  colour?(value: string): string | null;
  /** Whether an option stands for what awaits the User's review: a hollow ring marks it. */
  review?(value: string): boolean;
}

/** The options chosen, by filter. A filter with none chosen is left out: it keeps everything. */
export type FilterSelection = Readonly<Record<string, readonly string[]>>;

/** An option in a filter's menu. */
export interface FacetOption {
  value: string;
  /**
   * How many Documents it holds among those the other filters keep: what
   * choosing it would add (or, chosen, does show).
   */
  count: number;
  selected: boolean;
}

/** Whether anything is chosen in any filter. */
export const isFiltering = (selection: FilterSelection): boolean =>
  Object.values(selection).some((values) => values.length > 0);

/** The selection with an option chosen, or taken away if it was; a filter left empty is dropped. */
export function toggleFilterValue(
  selection: FilterSelection,
  facetId: string,
  value: string,
): FilterSelection {
  const current = selection[facetId] ?? [];
  const values = current.includes(value)
    ? current.filter((each) => each !== value)
    : [...current, value];
  const { [facetId]: _dropped, ...rest } = selection;
  return values.length > 0 ? { ...rest, [facetId]: values } : rest;
}

/**
 * The items the filters keep, in their order, and each filter's options:
 * those any of the items falls under (so they don't come and go as other
 * filters change), and any chosen, in the filter's order. One pass over the
 * items, whatever their number.
 */
export function filterLibrary<T>(
  items: readonly T[],
  facets: readonly LibraryFacet<T>[],
  selection: FilterSelection,
): { shown: T[]; options: ReadonlyMap<string, FacetOption[]> } {
  const chosen = facets.map((facet) => new Set(selection[facet.id] ?? []));
  const counts = facets.map(() => new Map<string, number>());
  const shown: T[] = [];
  // Plain loops, with nothing made per item but its values: the Library runs this on
  // thousands of Documents each time one changes, as Organize goes through them (#156).
  const values: (readonly string[])[] = [];
  const matches: boolean[] = [];
  for (const item of items) {
    let misses = 0;
    for (let index = 0; index < facets.length; index++) {
      const each = (facets[index] as LibraryFacet<T>).values(item);
      const wanted = chosen[index] as Set<string>;
      const match = wanted.size === 0 || each.some((value) => wanted.has(value));
      values[index] = each;
      matches[index] = match;
      if (!match) misses++;
    }
    if (misses === 0) shown.push(item);
    for (let index = 0; index < facets.length; index++) {
      // Counted under this filter's options if every other filter keeps it.
      const others = misses - (matches[index] ? 0 : 1);
      const count = counts[index] as Map<string, number>;
      const each = values[index] as readonly string[];
      for (let at = 0; at < each.length; at++) {
        const value = each[at] as string;
        // An option an item falls under twice counts once.
        if (each.indexOf(value) !== at) continue;
        count.set(value, (count.get(value) ?? 0) + (others === 0 ? 1 : 0));
      }
    }
  }
  const options = new Map<string, FacetOption[]>();
  facets.forEach((facet, index) => {
    const count = counts[index] as Map<string, number>;
    const selected = chosen[index] as Set<string>;
    const values = [...new Set([...count.keys(), ...selected])].sort(facet.compare);
    options.set(
      facet.id,
      values.map((value) => ({
        value,
        count: count.get(value) ?? 0,
        selected: selected.has(value),
      })),
    );
  });
  return { shown, options };
}

// The Library's filters --------------------------------------------------------

/** The year option of Documents with no creation date. */
export const NO_DATE = "no-date";

/** A Document's year, from its creation date (its first four characters), or `NO_DATE`. */
export function documentYear({ creationDate }: Pick<Document, "creationDate">): string {
  const year = creationDate?.slice(0, 4) ?? "";
  return /^\d{4}$/.test(year) ? year : NO_DATE;
}

/**
 * A Document's status, as the status filter puts it. Its file comes first,
 * as on its sidebar row: "missing" or "unavailable" (`DocumentFileStatus`).
 * Otherwise its processing (`DocumentStatus`): "available" once it is ready,
 * "not-indexed" while it is queued or read (and, with embeddings on, waiting
 * for the embedding model or embedded), "failed", or "no-text" when the file
 * has no text to read.
 */
export type LibraryStatus =
  | "available"
  | "not-indexed"
  | "failed"
  | "no-text"
  | "missing"
  | "unavailable";

const STATUS_ORDER: readonly LibraryStatus[] = [
  "available",
  "not-indexed",
  "failed",
  "no-text",
  "missing",
  "unavailable",
];

export function libraryStatus({
  fileStatus,
  status,
}: Pick<Document, "fileStatus" | "status">): LibraryStatus {
  if (fileStatus !== "available") return fileStatus;
  if (status === "ready") return "available";
  if (status === "failed" || status === "no-text") return status;
  return "not-indexed";
}

const FORMAT_ORDER: readonly DocumentKind[] = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "markdown",
  "text",
  "image",
  "rtf",
  "html",
  "web",
  "transcript",
];

const byOrder =
  (order: readonly string[]) =>
  (a: string, b: string): number =>
    order.indexOf(a) - order.indexOf(b);

export const FORMAT_LABELS: Record<DocumentKind, MessageKey> = {
  pdf: "library.format.pdf",
  docx: "library.format.docx",
  pptx: "library.format.pptx",
  xlsx: "library.format.xlsx",
  csv: "library.format.csv",
  markdown: "library.format.markdown",
  text: "library.format.text",
  image: "library.format.image",
  rtf: "library.format.rtf",
  html: "library.format.html",
  web: "library.format.web",
  transcript: "library.format.transcript",
};

const STATUS_LABELS: Record<LibraryStatus, MessageKey> = {
  available: "library.status.available",
  "not-indexed": "library.status.notIndexed",
  failed: "library.status.failed",
  "no-text": "library.status.noText",
  missing: "library.status.missing",
  unavailable: "library.status.unavailable",
};

type LibraryDocument = Pick<Document, "kind" | "creationDate" | "status" | "fileStatus">;

/** By year: newest first, then the Documents without a date. */
export const yearFacet: LibraryFacet<LibraryDocument> = {
  id: "year",
  title: "library.filter.year",
  values: (item) => [documentYear(item)],
  label: (value, t) => (value === NO_DATE ? t("library.filter.noDate") : value),
  compare: (a, b) => (a === NO_DATE ? 1 : b === NO_DATE ? -1 : b.localeCompare(a)),
};

/** By file format: PDF, then Office's, then plain text. */
export const formatFacet: LibraryFacet<LibraryDocument> = {
  id: "format",
  title: "library.filter.format",
  values: (item) => [item.kind],
  label: (value, t) => {
    const key = FORMAT_LABELS[value as DocumentKind];
    return key ? t(key) : value;
  },
  compare: byOrder(FORMAT_ORDER),
};

/** By status (see `LibraryStatus`). */
export const statusFacet: LibraryFacet<LibraryDocument> = {
  id: "status",
  title: "library.filter.status",
  values: (item) => [libraryStatus(item)],
  label: (value, t) => {
    const key = STATUS_LABELS[value as LibraryStatus];
    return key ? t(key) : value;
  },
  compare: byOrder(STATUS_ORDER),
};

/** The filters the Library offers, in the order its filter bar shows them. */
export const documentFacets: readonly LibraryFacet<LibraryDocument>[] = [
  yearFacet,
  formatFacet,
  statusFacet,
];

// Tags -------------------------------------------------------------------------

/**
 * The Tags filter's option for Documents with a Tag that automatic tagging
 * wasn't sure of: it is applied, marked "needs review" until the User
 * confirms or removes it. Never a Tag's id, which is a UUID.
 */
export const NEEDS_REVIEW = "needs-review";

type TaggedDocument = Pick<Document, "tags">;

/** The Tags filter's options for a Document: its Tags, and `NEEDS_REVIEW` if one awaits review. */
export function tagValues({ tags }: TaggedDocument): string[] {
  const values = tags.map((link) => link.tagId);
  return tags.some((link) => link.needsReview) ? [NEEDS_REVIEW, ...values] : values;
}

/**
 * Each Tags filter option's Documents, in their order: a Tag's id, and
 * `NEEDS_REVIEW` for those with a Tag awaiting review. An option no Document
 * falls under isn't in it. One pass over the Documents (the sidebar's Tags view).
 */
export function documentsByTag<T extends TaggedDocument>(items: readonly T[]): Map<string, T[]> {
  const byTag = new Map<string, T[]>();
  for (const item of items) {
    for (const value of new Set(tagValues(item))) {
      const list = byTag.get(value);
      if (list) list.push(item);
      else byTag.set(value, [item]);
    }
  }
  return byTag;
}

/**
 * Whether a Document passes a Tag filter: any chosen option (either-or, like
 * every filter's options). Nothing chosen keeps everything.
 */
export const matchesTags = (item: TaggedDocument, chosen: readonly string[]): boolean =>
  chosen.length === 0 || tagValues(item).some((value) => chosen.includes(value));

/**
 * By Tag, named as the User named it: "Needs review" first, then the Tags in
 * name order. A Document with several Tags falls under each.
 */
export function tagFacet(
  tags: readonly (Pick<Tag, "id" | "name"> & Partial<Pick<Tag, "colour">>)[],
): LibraryFacet<TaggedDocument> {
  const names = new Map(tags.map((tag) => [tag.id, tag.name]));
  const colours = new Map(tags.map((tag) => [tag.id, tag.colour ?? null]));
  return {
    id: "tag",
    title: "tags.title",
    values: tagValues,
    label: (value, t) =>
      value === NEEDS_REVIEW ? t("tags.filter.review") : (names.get(value) ?? value),
    compare: (a, b) =>
      a === NEEDS_REVIEW
        ? -1
        : b === NEEDS_REVIEW
          ? 1
          : (names.get(a) ?? a).localeCompare(names.get(b) ?? b, undefined, {
              sensitivity: "base",
            }),
    colour: (value) => colours.get(value) ?? null,
    review: (value) => value === NEEDS_REVIEW,
  };
}
