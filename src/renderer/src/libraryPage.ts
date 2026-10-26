/**
 * The Library page, grouped by Folder (#240): its sections, its search, its
 * problem line and its dates. Pure: no store, no bridge, so the tests import it.
 */

import type {
  Document,
  DocumentGroupAssignment,
  DocumentTextMatch,
  LibraryGroup,
  LinkedFolder,
  TextRange,
} from "../../core/api";
import type { Language } from "../../core/language";
import { formatShortDate } from "../../shared/dates";
import { displayName, fileNameOf } from "../../shared/documentNames";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { modelName } from "../../shared/modelName";
import { type LibraryFacet, type LibraryStatus, libraryStatus } from "./libraryFilters";
import { joinRanges, matchName } from "./matcher";
import { organizeStateOf } from "./organizeOutcome";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Not in a Folder's section, as a key beside the Folders' ids. */
export const NOT_IN_A_FOLDER = "not-in-a-folder";

/** The Recently deleted section at the page's foot. */
export const RECENTLY_DELETED = "recently-deleted";

/** How many Documents a section lists before "Show all N". */
export const FIRST_ROWS = 8;

export interface LibrarySection {
  /** The Folder's id, or `NOT_IN_A_FOLDER`. */
  key: string;
  folder: LibraryGroup | null;
  documents: Document[];
}

/**
 * Whether a section asked for is on the page once nothing narrows it: a
 * Folder that exists, Not in a Folder while it holds a Document, and
 * Recently deleted unless it is known to be empty (`deletedCount` null: not
 * read yet).
 */
export function sectionShows(
  key: string,
  documents: readonly Pick<Document, "id">[],
  folders: readonly Pick<LibraryGroup, "id">[],
  assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId">[],
  deletedCount: number | null,
): boolean {
  if (key === RECENTLY_DELETED) return deletedCount !== 0;
  const ids = new Set(folders.map((folder) => folder.id));
  if (key !== NOT_IN_A_FOLDER) return ids.has(key);
  const filed = new Set(
    assignments.flatMap((each) =>
      each.groupId !== null && ids.has(each.groupId) ? [each.documentId] : [],
    ),
  );
  return documents.some((doc) => !filed.has(doc.id));
}

/**
 * One section per Folder, in the order given, then Not in a Folder, each with
 * its Documents in the order given. A Document whose Folder isn't among them
 * is Not in a Folder. Every Folder shows, empty or not, unless the page is
 * narrowed, when a section with no match is left out; Not in a Folder shows
 * only while it holds something.
 */
export function sectionsOf(
  folders: readonly LibraryGroup[],
  documents: readonly Document[],
  folderOf: (documentId: string) => string | null,
  narrowing: boolean,
): LibrarySection[] {
  const byFolder = new Map<string, Document[]>(folders.map((folder) => [folder.id, []]));
  const loose: Document[] = [];
  for (const document of documents) {
    const list = byFolder.get(folderOf(document.id) ?? "");
    if (list) list.push(document);
    else loose.push(document);
  }
  const sections: LibrarySection[] = folders.map((folder) => ({
    key: folder.id,
    folder,
    documents: byFolder.get(folder.id) ?? [],
  }));
  sections.push({ key: NOT_IN_A_FOLDER, folder: null, documents: loose });
  return sections.filter(
    (section) => section.documents.length > 0 || (section.folder !== null && !narrowing),
  );
}

/** How many Documents each Folder holds, counted as the Library page lists them. */
export function folderCounts(
  folders: readonly LibraryGroup[],
  documents: readonly Document[],
  assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId">[],
): Map<string, number> {
  const folderOf = new Map(assignments.map((each) => [each.documentId, each.groupId]));
  return new Map(
    sectionsOf(folders, documents, (id) => folderOf.get(id) ?? null, false).flatMap((section) =>
      section.folder ? [[section.folder.id, section.documents.length] as const] : [],
    ),
  );
}

/** How a Document matches the Library's search. */
export interface SearchMatch {
  /** Where the words typed are in its shown name. */
  ranges: TextRange[];
  /** The Passage that holds them, if they were found inside it. */
  text: DocumentTextMatch | null;
}

/**
 * Where the words typed (`queryWords`) are in a Document's shown name, when
 * its name, file name, title or Tags hold every one of them, each word in any
 * of these; null when one is in none.
 */
export function nameMatchOf(
  document: Document,
  words: readonly string[],
  tagNames: ReadonlyMap<string, string>,
): TextRange[] | null {
  const name = displayName(document);
  const others = [
    document.name,
    document.title ?? "",
    ...document.tags.map((link) => tagNames.get(link.tagId) ?? ""),
  ];
  const ranges: TextRange[] = [];
  for (const word of words) {
    const inName = matchName([word], name);
    if (inName) ranges.push(...inName.ranges);
    else if (!others.some((text) => matchName([word], text))) return null;
  }
  return joinRanges(ranges);
}

/**
 * The line a Document was found by, started a few characters before the first
 * words found (at a word's start where words are spaced), so a narrow row
 * still shows them; "…" where it is cut.
 */
export function foundLine(
  found: Pick<DocumentTextMatch, "excerpt" | "highlights">,
  before = 16,
): { text: string; ranges: TextRange[] } {
  const first = found.highlights[0]?.start ?? 0;
  if (first <= before + 1) return { text: found.excerpt, ranges: found.highlights };
  let cut = first - before;
  const space = found.excerpt.slice(cut, first).search(/\s/);
  if (space !== -1) cut += space + 1;
  const code = found.excerpt.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  const shift = 1 - cut;
  return {
    text: `…${found.excerpt.slice(cut)}`,
    ranges: found.highlights.map((range) => ({
      start: range.start + shift,
      end: range.end + shift,
    })),
  };
}

/**
 * The Documents a search finds, by id: those whose names or Tags hold the
 * words, and those the core found them inside (`inside`, by Document id; null
 * until it answers), with the Passage only when the shown name holds none of
 * the words. Null when nothing is typed.
 */
export function searchMatches(
  documents: readonly Document[],
  words: readonly string[],
  tagNames: ReadonlyMap<string, string>,
  inside: ReadonlyMap<string, DocumentTextMatch> | null,
): Map<string, SearchMatch> | null {
  if (words.length === 0) return null;
  const matches = new Map<string, SearchMatch>();
  for (const document of documents) {
    const ranges = nameMatchOf(document, words, tagNames);
    const text = ranges?.length ? null : (inside?.get(document.id) ?? null);
    if (ranges || text) matches.set(document.id, { ranges: ranges ?? [], text });
  }
  return matches;
}

/** What can be wrong with a Document that the problem line announces, in the order it names them. */
const PROBLEMS = ["no-text", "failed", "missing", "unavailable"] as const;
export type ProblemKind = (typeof PROBLEMS)[number];

export interface LibraryProblem {
  /** One kind, or "mixed" when the Documents have different ones. */
  kind: ProblemKind | "mixed";
  count: number;
  /** The status filter's options that show them. */
  statuses: LibraryStatus[];
}

/** The one line the page says about Documents it can't use, or null when there are none. */
export function problemOf(documents: readonly Document[]): LibraryProblem | null {
  const counts = new Map<ProblemKind, number>();
  for (const document of documents) {
    const status = libraryStatus(document);
    const kind = PROBLEMS.find((each) => each === status);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const kinds = PROBLEMS.filter((kind) => counts.has(kind));
  const [only] = kinds;
  if (!only) return null;
  const count = kinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0);
  return { kind: kinds.length === 1 ? only : "mixed", count, statuses: kinds };
}

const PROBLEM_WORDS: Record<LibraryProblem["kind"], { one: MessageKey; many: MessageKey }> = {
  "no-text": { one: "library.problem.noText.one", many: "library.problem.noText" },
  failed: { one: "library.problem.failed.one", many: "library.problem.failed" },
  missing: { one: "library.problem.missing.one", many: "library.problem.missing" },
  unavailable: { one: "library.problem.unavailable.one", many: "library.problem.unavailable" },
  mixed: { one: "library.problem.mixed", many: "library.problem.mixed" },
};

/** The problem in words, in the singular or the plural. */
export function problemText(problem: LibraryProblem, t: Translate): string {
  const words = PROBLEM_WORDS[problem.kind];
  return t(problem.count === 1 ? words.one : words.many, { count: problem.count });
}

/** When a Document was added, as its row says it: "9 Oct" this year, "9 Oct 2025" before. */
export const addedLabel = (iso: string, now: Date, language: Language): string =>
  formatShortDate(iso, language, { now });

/** Where Organize is with a Document, in a word, for Get info. */
export function organizeState(
  document: Pick<Document, "tagging"> | undefined,
  assignment: DocumentGroupAssignment | undefined,
): MessageKey {
  const state = organizeStateOf(document, assignment);
  if (state.run === "working") return "library.working";
  if (state.manual) return "library.manual";
  if (state.run === "waiting" || state.run === "failed") return "library.needsAttention";
  if (state.suggested) return "library.suggested";
  if (state.run === "done" || state.run === "stopped") return "library.saved";
  return "library.notClassified";
}

/** Which model Organize used and what it read: "tev1:4b · Text", with why it took a smaller one. */
export function organizeModel(
  model: NonNullable<DocumentGroupAssignment["model"]>,
  t: Translate,
): string {
  const route =
    model.reason === "slow"
      ? "library.route.slow"
      : model.reason === "memory"
        ? "library.route.memory"
        : model.reason === "unavailable"
          ? "library.route.unavailable"
          : null;
  return [
    modelName(model.id),
    t(model.images ? "library.usedPages" : "library.usedText"),
    route && t(route),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The Source location option for the Documents added on their own (CONTEXT.md: Other Documents). */
export const OTHER_DOCUMENTS = "other";

/** What the Library asks for to show one Linked folder's Documents: its row's click (#1507). */
export const sourceRequest = (linkedFolderId: string) => `source:${linkedFolderId}`;

function sourceNames(
  linkedFolders: readonly Pick<LinkedFolder, "id" | "path">[],
): Map<string, string> {
  const names = new Map<string, string>();
  const byName = new Map<string, Pick<LinkedFolder, "id" | "path">[]>();
  for (const linked of linkedFolders) {
    const name = fileNameOf(linked.path);
    const group = byName.get(name);
    if (group) group.push(linked);
    else byName.set(name, [linked]);
  }
  const foldersOf = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(0, -1);
  for (const [name, group] of byName) {
    const only = group[0];
    if (group.length === 1 && only) {
      names.set(only.id, name);
      continue;
    }
    const places = group.map((linked) => foldersOf(linked.path));
    let deepest = 0;
    for (const place of places) deepest = Math.max(deepest, place.length);
    const label = (place: string[], upTo: number) => place.slice(-upTo).join(" / ");
    let depth = 1;
    while (
      depth < deepest &&
      new Set(places.map((place) => label(place, depth))).size < group.length
    )
      depth++;
    group.forEach((linked, at) => {
      const place = label(places[at] ?? [], depth);
      names.set(linked.id, place ? `${place} / ${name}` : name);
    });
  }
  return names;
}

/** By Source location (#1507): each Linked folder, by its folder's name, then Other Documents. */
export function sourceFacet(
  linkedFolders: readonly Pick<LinkedFolder, "id" | "path">[],
): LibraryFacet<Document> {
  const names = sourceNames(linkedFolders);
  const order = [...linkedFolders.map((linked) => linked.id), OTHER_DOCUMENTS];
  return {
    id: "source",
    title: "library.filter.source",
    values: (document) => [
      document.linkedFolderId !== null && names.has(document.linkedFolderId)
        ? document.linkedFolderId
        : OTHER_DOCUMENTS,
    ],
    label: (value, t) =>
      value === OTHER_DOCUMENTS ? t("info.from.own") : (names.get(value) ?? value),
    compare: (a, b) => order.indexOf(a) - order.indexOf(b),
  };
}

/** By Folder: the Folders in the order given, then Not in a Folder. */
export function folderFacet(
  folders: readonly Pick<LibraryGroup, "id" | "name">[],
  folderOf: (documentId: string) => string | null,
): LibraryFacet<Document> {
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  const order = [...folders.map((folder) => folder.id), NOT_IN_A_FOLDER];
  return {
    id: "folder",
    title: "library.filter.folder",
    values: (document) => {
      const id = folderOf(document.id);
      return [id !== null && names.has(id) ? id : NOT_IN_A_FOLDER];
    },
    label: (value, t) =>
      value === NOT_IN_A_FOLDER ? t("library.unsorted") : (names.get(value) ?? value),
    compare: (a, b) => order.indexOf(a) - order.indexOf(b),
  };
}
