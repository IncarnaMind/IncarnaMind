import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Document, LibraryGroup } from "../../../core/api";
import { focusComposer } from "../commands/assistant";
import { useComposer } from "../composer";
import { LIBRARY_DELETED } from "../deletedItems";
import { errorMessage, providerErrorText } from "../errors";
import { useFindSources } from "../findSources";
import { useLanguage, useT } from "../i18n";
import {
  type FilterSelection,
  filterLibrary,
  formatFacet,
  isFiltering,
  type LibraryFacet,
  statusFacet,
  tagFacet,
  toggleFilterValue,
  yearFacet,
} from "../libraryFilters";
import { useLibraryFolds } from "../libraryFolds";
import {
  folderFacet,
  NOT_IN_A_FOLDER,
  problemOf,
  problemText,
  RECENTLY_DELETED,
  searchMatches,
  sectionShows,
  sectionsOf,
} from "../libraryPage";
import { useTextSearch } from "../libraryTextSearch";
import { queryWords } from "../matcher";
import { isNotSorted, isSorted } from "../organizeOutcome";
import { useDeleted } from "../recentlyDeleted";
import { extendThroughRows, useSelection, useSelectionOrder } from "../selection";
import { DEFAULT_SORT, sorted } from "../sort";
import { sortOf, useSort } from "../sortChoices";
import { documentFields, folderFields } from "../sortFields";
import { useAppStore } from "../store";
import { hasNotSorted, waitingIds } from "../suggestionReview";
import { reviewIds, toReviewOf } from "../toReview";
import { moveThroughRows } from "../treeKeys";
import { useUnreadFiles } from "../unreadFiles";
import { FindSourcesPanel } from "./FindSourcesPanel";
import { LibrarySelectionBar } from "./LibrarySelection";
import { AutomaticOffNotice } from "./library/AutomaticOffNotice";
import { DeletedSection } from "./library/DeletedSection";
import { StarterFolders } from "./library/FolderForm";
import { LibraryBar } from "./library/LibraryBar";
import { LibraryEmpty } from "./library/LibraryEmpty";
import { LibraryHeader } from "./library/LibraryHeader";
import { LibrarySection } from "./library/LibrarySection";
import { ToReview } from "./library/ToReview";
import { useFittingColumns } from "./library/useFittingColumns";
import { useReviewFocus } from "./library/useReviewFocus";
import { ProblemLine } from "./ProblemLine";
import { ReferenceImportPanel } from "./ReferenceImportPanel";
import { UnreadFilesLine } from "./UnreadFilesLine";

const NO_GROUPS: readonly LibraryGroup[] = [];
const NO_DOCUMENTS: readonly Document[] = [];

const inReviewList = (target: EventTarget) =>
  target instanceof Element && target.closest("[data-review]") !== null;

/** The Library's one order for every section, remembered on this computer. */
const SORT_SCOPE = "library:all" as const;

/** What `openLibrary` asked for that is not a section to show. */
const FORMS = ["all", "starters"];

/**
 * The Library tab (#240): one page of every Document, grouped by Folder, as a
 * Notion page of toggles or Finder's list view. Its head holds the title,
 * Add Documents and the search; then the quiet bar (filters, sort, folding) or,
 * with two or more selected, the selection's bar; a problem in one line; one
 * section per Folder in the sidebar's order, then Not in a Folder; and
 * Recently deleted folded at the foot. A Folder opened from the sidebar brings
 * its section into view; the page still shows every Folder.
 */
export function LibraryPane() {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((state) => state.documents);
  const snapshot = useAppStore((state) => state.library);
  const tags = useAppStore((state) => state.tags);
  const tagFilter = useAppStore(useShallow((state) => state.tagFilter));
  const request = useAppStore((state) => state.libraryFilter);
  const findingSources = useFindSources((state) => state.open);
  const [search, setSearch] = useState("");
  /** The format, year, status and Folder filters' choices; the Tags filter is the store's, shared with the sidebar. */
  const [facetFilter, setFacetFilter] = useState<FilterSelection>({});
  const field = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useFittingColumns(page);

  const groups = snapshot?.groups ?? NO_GROUPS;
  const assignments = useMemo(
    () => new Map(snapshot?.assignments.map((item) => [item.documentId, item])),
    [snapshot?.assignments],
  );
  const folderOf = useCallback(
    (documentId: string) => assignments.get(documentId)?.groupId ?? null,
    [assignments],
  );
  const sidebarSort = useSort(sortOf("sidebar"));
  const folders = useMemo(
    () => sorted(groups, sidebarSort, folderFields, language),
    [groups, sidebarSort, language],
  );
  const facets = useMemo<LibraryFacet<Document>[]>(
    () => [tagFacet(tags), formatFacet, yearFacet, statusFacet, folderFacet(folders, folderOf)],
    [tags, folders, folderOf],
  );
  const selection = useMemo<FilterSelection>(
    () => (tagFilter.length ? { ...facetFilter, tag: tagFilter } : facetFilter),
    [facetFilter, tagFilter],
  );
  const words = useMemo(() => queryWords(search), [search]);
  const inside = useTextSearch(search);
  const matches = useMemo(
    () =>
      searchMatches(
        documents,
        words,
        new Map(tags.map((tag) => [tag.id, tag.name])),
        inside.matches,
      ),
    [documents, words, tags, inside.matches],
  );
  const found = useMemo(
    () => (matches ? documents.filter((doc) => matches.has(doc.id)) : documents),
    [documents, matches],
  );
  const { shown: filtered, options } = useMemo(
    () => filterLibrary<Document>(found, facets, selection),
    [found, facets, selection],
  );
  const chosenSort = useSort(sortOf(SORT_SCOPE));
  const ordered = useMemo(
    () => sorted(filtered, chosenSort, documentFields(t), language),
    [filtered, chosenSort, t, language],
  );
  const narrowing = words.length > 0 || isFiltering(selection);
  const sections = useMemo(
    () => sectionsOf(folders, ordered, folderOf, narrowing),
    [folders, ordered, folderOf, narrowing],
  );
  const folded = useLibraryFolds((state) => state.folded);
  const reviewOpen = useLibraryFolds((state) => state.reviewOpen);
  const notSortedOf = useCallback(
    (documentId: string) => {
      const item = assignments.get(documentId);
      if (!isNotSorted(item)) return null;
      const said = item?.error ? providerErrorText(item.error, t) : "";
      return said || t("library.notSorted.noReason");
    },
    [assignments, t],
  );
  const unsortedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of snapshot?.assignments ?? []) if (isNotSorted(item)) ids.add(item.documentId);
    return ids;
  }, [snapshot?.assignments]);
  const notSorted = useMemo(
    () =>
      unsortedIds.size === 0 ? NO_DOCUMENTS : ordered.filter((doc) => unsortedIds.has(doc.id)),
    [ordered, unsortedIds],
  );
  const { notSortedCount, allSorted } = useMemo(() => {
    let count = 0;
    let sorted = documents.length > 0;
    for (const doc of documents) {
      const item = assignments.get(doc.id);
      if (isNotSorted(item)) count++;
      if (!isSorted(item, doc.tagging)) sorted = false;
    }
    return { notSortedCount: count, allSorted: sorted && count === 0 };
  }, [documents, assignments]);
  const review = useMemo(
    () => toReviewOf(ordered, folders, snapshot?.assignments ?? []),
    [ordered, folders, snapshot?.assignments],
  );
  const reviewing = !narrowing && (review.count > 0 || notSorted.length > 0);
  useEffect(() => {
    useLibraryFolds.getState().setReviewShown(reviewing);
    return () => useLibraryFolds.getState().setReviewShown(false);
  }, [reviewing]);
  const reviewList = useMemo(
    () =>
      reviewing && reviewOpen ? [...reviewIds(review), ...notSorted.map((doc) => doc.id)] : [],
    [review, reviewing, reviewOpen, notSorted],
  );
  const shownIds = useMemo(
    () =>
      sections.flatMap((section) =>
        folded.has(section.key) ? [] : section.documents.map((doc) => doc.id),
      ),
    [sections, folded],
  );
  // ⌘A and Shift-click reach every row in an open section, drawn or not; in To review, its own.
  const inReview = useRef(false);
  useSelectionOrder("library", () =>
    (inReview.current && reviewList.length > 0 ? reviewList : shownIds).map((id) => ({
      kind: "document",
      id,
    })),
  );
  // What is selected stays in view: a search, a filter or a fold that hides it, or a deletion, drops it.
  useEffect(() => {
    const held = useSelection.getState();
    if (held.surface !== "library") return;
    const visible = new Set([...shownIds, ...reviewList]);
    held.keepOnly((ref) => visible.has(ref.id));
  }, [shownIds, reviewList]);
  useReviewFocus(grid, reviewList.join());
  const selectingMany = useSelection(
    (state) => state.surface === "library" && state.items.length > 1,
  );

  const suggestedOf = useCallback(
    (documentId: string) => {
      const item = assignments.get(documentId);
      if (!item?.suggested || item.groupId === null) return null;
      return groups.find((group) => group.id === item.groupId)?.name ?? null;
    },
    [assignments, groups],
  );
  const problem = useMemo(() => problemOf(documents), [documents]);
  // Files in the Linked folders that aren't Documents because their format isn't read yet (#740).
  const unreadFormats = useUnreadFiles(null).filter((file) => file.reason === "format");

  // A Folder, Not in a Folder or Recently deleted asked for (from the sidebar, a menu or ⌘K): its section opens and comes into view.
  useEffect(() => {
    if (request === "review") {
      setSearch("");
      setFacetFilter({});
      useAppStore.getState().setTagFilter([]);
      if (waitingIds().length > 0 || hasNotSorted()) useLibraryFolds.getState().showReview();
      useAppStore.setState({ libraryFilter: "all" });
      return;
    }
    if (FORMS.includes(request)) return;
    const key =
      request === LIBRARY_DELETED
        ? RECENTLY_DELETED
        : request === "unsorted"
          ? NOT_IN_A_FOLDER
          : request;
    setSearch("");
    setFacetFilter({});
    const { documents, library, setTagFilter } = useAppStore.getState();
    setTagFilter([]);
    const shows = sectionShows(
      key,
      documents,
      library?.groups ?? [],
      library?.assignments ?? [],
      useDeleted.getState().items?.length ?? null,
    );
    // A section that isn't there would be scrolled to whenever it appeared later.
    if (shows) useLibraryFolds.getState().reveal(key);
    useAppStore.setState({ libraryFilter: "all" });
  }, [request]);

  const sectionKeys = sections.map((section) => section.key);
  const allFolded = sectionKeys.length > 0 && sectionKeys.every((key) => folded.has(key));
  const clearNarrowing = () => {
    setSearch("");
    setFacetFilter({});
    useAppStore.getState().setTagFilter([]);
  };
  const nothingMatches = narrowing && sections.length === 0 && !inside.waiting;
  const query = search.trim();
  /** Nothing in the Library matches what was typed: ask the assistant about it instead (#763). */
  const askAbout =
    nothingMatches && query !== ""
      ? () => {
          focusComposer();
          useComposer.getState().requestAsk(query);
        }
      : undefined;
  const clearAction = {
    label: t("library.noMatch.clear"),
    testId: "library-clear-narrowing",
    onClick: clearNarrowing,
  };
  const closeForm = () => useAppStore.getState().openLibrary();

  return (
    <section
      data-testid="library"
      data-surface="library"
      role="tabpanel"
      id="mind-tabpanel"
      aria-labelledby="library-tab"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sheet text-ui text-ink"
    >
      <div ref={page} className="group/page @container/page min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1084px] pt-5 pr-8 pb-24 pl-11 @max-[680px]/page:pr-4 @max-[680px]/page:pl-9">
          <LibraryHeader
            count={documents.length}
            notSorted={notSortedCount}
            sorted={allSorted}
            onReview={() => useAppStore.getState().openLibrary("review")}
            search={search}
            onSearch={setSearch}
            onEnter={askAbout}
            onDown={() =>
              // The first Document found, as Finder's first result; the first head when none is open.
              (
                grid.current?.querySelector<HTMLElement>("[data-document-id] [data-row-main]") ??
                grid.current?.querySelector<HTMLElement>("[data-tree-row]")
              )?.focus()
            }
            field={field}
          />
          {findingSources && <FindSourcesPanel />}
          <ReferenceImportPanel />
          {request === "starters" && <StarterFolders close={closeForm} />}
          {!snapshot ? (
            <p role="status" className="mt-6 text-[13px] text-ink-meta">
              {t("library.loading")}
            </p>
          ) : documents.length === 0 ? (
            <LibraryEmpty />
          ) : (
            <>
              {selectingMany ? (
                <LibrarySelectionBar shownIds={shownIds} />
              ) : (
                <LibraryBar
                  facets={facets}
                  options={options}
                  selection={selection}
                  onToggle={(facetId, value) => {
                    if (facetId === "tag") useAppStore.getState().toggleTagFilter(value);
                    else setFacetFilter((current) => toggleFilterValue(current, facetId, value));
                  }}
                  onRemove={(facetId) => {
                    if (facetId === "tag") useAppStore.getState().setTagFilter([]);
                    else setFacetFilter(({ [facetId]: _removed, ...rest }) => rest);
                  }}
                  sort={chosenSort ?? DEFAULT_SORT}
                  sortScope={SORT_SCOPE}
                  allFolded={allFolded}
                  onFoldAll={() => useLibraryFolds.getState().setAll(sectionKeys, allFolded)}
                />
              )}
              <AutomaticOffNotice />
              {problem && (
                <ProblemLine
                  role="status"
                  testId="library-problem"
                  className="mt-1"
                  action={{
                    label: t("library.problem.show"),
                    testId: "library-problem-show",
                    onClick: () =>
                      setFacetFilter((current) => ({ ...current, status: problem.statuses })),
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="mr-2 mb-px inline-block size-1.5 rounded-full bg-attention align-middle"
                  />
                  {problemText(problem, t)}
                </ProblemLine>
              )}
              <UnreadFilesLine files={unreadFormats} testId="library-unread" className="mt-1" />
              {/* biome-ignore lint/a11y/useSemanticElements: sections of rows laid out as columns, not a table. */}
              <div
                ref={grid}
                role="grid"
                aria-multiselectable="true"
                aria-label={t("library.sections")}
                // Where the pointer or the focus went last says which list a Shift-click ranges over.
                onPointerDownCapture={(event) => {
                  inReview.current = inReviewList(event.target);
                }}
                onFocusCapture={(event) => {
                  inReview.current = inReviewList(event.target);
                }}
                onKeyDown={(event) => {
                  if (moveThroughRows(event) || extendThroughRows(event, "library")) return;
                  // ↑ on the first row goes back to the search, as ↓ came from it.
                  const plain =
                    !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
                  if (
                    event.key === "ArrowUp" &&
                    plain &&
                    event.target === grid.current?.querySelector("[data-tree-row]")
                  ) {
                    event.preventDefault();
                    field.current?.focus();
                  }
                }}
              >
                {reviewing && (
                  <ToReview
                    review={review}
                    notSorted={notSorted}
                    suggestedIn={suggestedOf}
                    notSortedOf={notSortedOf}
                  />
                )}
                {sections.map((section) => (
                  <LibrarySection
                    key={section.key}
                    section={section}
                    narrowing={narrowing}
                    matches={matches}
                    suggestedOf={suggestedOf}
                    notSortedOf={notSortedOf}
                  />
                ))}
              </div>
              {inside.failure && (
                <ProblemLine
                  role="alert"
                  testId="library-inside-failed"
                  className="mt-4"
                  action={{
                    label: t("library.inside.retry"),
                    testId: "library-inside-retry",
                    onClick: inside.retry,
                  }}
                >
                  {t("library.inside.failed", { reason: errorMessage(inside.failure.error, t) })}
                </ProblemLine>
              )}
              {nothingMatches && (
                <ProblemLine
                  role="status"
                  testId="library-no-match"
                  className="mt-6"
                  action={
                    askAbout
                      ? {
                          label: t("palette.ask", { text: query }),
                          testId: "library-ask",
                          onClick: askAbout,
                        }
                      : clearAction
                  }
                  also={askAbout ? clearAction : undefined}
                >
                  {t("library.noMatch")}
                </ProblemLine>
              )}
            </>
          )}
          {!narrowing && <DeletedSection />}
        </div>
      </div>
    </section>
  );
}
