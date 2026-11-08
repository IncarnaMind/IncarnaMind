import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Document, LibraryGroup } from "../../../core/api";
import { focusComposer } from "../commands/assistant";
import { useComposer } from "../composer";
import { LIBRARY_DELETED } from "../deletedItems";
import { errorMessage } from "../errors";
import { useFindSources } from "../findSources";
import { folderPathLabel } from "../folders";
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
  listedDocumentIds,
  NOT_IN_A_FOLDER,
  problemOf,
  problemText,
  RECENTLY_DELETED,
  searchMatches,
  sectionShows,
  sectionsOf,
  sourceFacet,
  treeCounts,
} from "../libraryPage";
import { useTextSearch } from "../libraryTextSearch";
import { queryWords } from "../matcher";
import { meetingHitsOf } from "../meetingTranscript";
import { organizeDocuments } from "../organizeDocuments";
import { organizeStateOf } from "../organizeOutcome";
import { openReview, useOrganizeReview } from "../organizeReview";
import {
  DAY_ONE_DOCUMENTS,
  ownsATag,
  useLibraryDocuments,
  useListedDocuments,
  useOwnDocuments,
} from "../ownDocuments";
import { useDeleted } from "../recentlyDeleted";
import { reviewProblemKind, reviewReason } from "../reviewProblems";
import { extendThroughRows, useSelection, useSelectionOrder } from "../selection";
import { DEFAULT_SORT, sorted } from "../sort";
import { sortOf, useSort } from "../sortChoices";
import { documentFields, folderFields } from "../sortFields";
import { useAppStore } from "../store";
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
import { MeetingHits } from "./library/MeetingHits";
import { OrganizeLines } from "./library/OrganizeLines";
import { OrganizeReviewPage } from "./library/OrganizeReviewPage";
import { useFittingColumns } from "./library/useFittingColumns";
import { ProblemLine } from "./ProblemLine";
import { ReferenceImportPanel } from "./ReferenceImportPanel";
import { UnreadFilesLine } from "./UnreadFilesLine";
import { useTaggingService } from "./useTaggingService";

const NO_GROUPS: readonly LibraryGroup[] = [];
const NO_DOCUMENTS: readonly Document[] = [];

/** The Library's one order for every section, remembered on this computer. */
const SORT_SCOPE = "library:all" as const;

/** What `openLibrary` asked for that is not a section to show. */
const FORMS = ["all", "starters"];

/** What a Linked folder's row asks for: its Documents, by Source location (#1507). */
const SOURCE_REQUEST = /^source:(.+)$/;

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
  const libraryDocuments = useLibraryDocuments();
  const snapshot = useAppStore((state) => state.library);
  const tags = useAppStore((state) => state.tags);
  const linkedFolders = useAppStore((state) => state.linkedFolders);
  const tagFilter = useAppStore(useShallow((state) => state.tagFilter));
  const request = useAppStore((state) => state.libraryFilter);
  const reviewTarget = useAppStore((state) => state.reviewTarget);
  const findingSources = useFindSources((state) => state.open);
  const [search, setSearch] = useState("");
  /** The format, year, status and Folder filters' choices; the Tags filter is the store's, shared with the sidebar. */
  const [facetFilter, setFacetFilter] = useState<FilterSelection>({});
  // The Folder the Library shows is the one its own Folder filter narrows to; clearing it shows
  // everything, so no Folder is in front (#2529).
  const folderFilter = facetFilter.folder?.length === 1 ? (facetFilter.folder[0] ?? null) : null;
  const narrowedTo = useRef<string | null>(null);
  useEffect(() => {
    if (folderFilter !== null) useAppStore.setState({ libraryFolderId: folderFilter });
    else if (narrowedTo.current !== null) useAppStore.setState({ libraryFolderId: null });
    narrowedTo.current = folderFilter;
  }, [folderFilter]);
  // A source's view lists that source's Documents even when they are the examples': the examples
  // leave the Library once the User has a Document of their own, but their Linked folder's row
  // stays the way back to them (#1944).
  const everyDocument = useListedDocuments();
  const allDocuments = useAppStore((state) => state.documents);
  const minds = useAppStore((state) => state.minds);
  const documents = facetFilter.source?.length ? everyDocument : libraryDocuments;
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
  // Tags are named only once a Document of the User's own carries one (#1942), then they are a filter.
  const tagsShown = useAppStore(ownsATag);
  const sourceFacetOf = useMemo(() => sourceFacet(linkedFolders), [linkedFolders]);
  const facets = useMemo<LibraryFacet<Document>[]>(
    () => [
      ...(tagsShown ? [tagFacet(tags)] : []),
      formatFacet,
      yearFacet,
      statusFacet,
      folderFacet(folders, folderOf),
      sourceFacetOf,
    ],
    [tags, tagsShown, folders, folderOf, sourceFacetOf],
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
  // A source's view counts that source's Documents before the search and the other filters, so
  // its header holds while they narrow the rows; the page otherwise counts the Library's own, as
  // the sidebar does (#1944).
  const sourceCount = useMemo(
    () =>
      facetFilter.source?.length
        ? filterLibrary<Document>(documents, [sourceFacetOf], { source: facetFilter.source }).shown
            .length
        : 0,
    [documents, sourceFacetOf, facetFilter.source],
  );
  const headerCount = facetFilter.source?.length ? sourceCount : libraryDocuments.length;
  const narrowing = words.length > 0 || isFiltering(selection);
  const sections = useMemo(
    () => sectionsOf(folders, ordered, folderOf, narrowing),
    [folders, ordered, folderOf, narrowing],
  );
  // Each Folder's own Documents, in the page's order, and how many it holds with its sub-Folders.
  const byFolder = useMemo(() => {
    const map = new Map<string, Document[]>();
    for (const doc of ordered) {
      const id = folderOf(doc.id);
      if (id === null) continue;
      const list = map.get(id);
      if (list) list.push(doc);
      else map.set(id, [doc]);
    }
    return map;
  }, [ordered, folderOf]);
  const documentsOf = useCallback(
    (folderId: string) => byFolder.get(folderId) ?? NO_DOCUMENTS,
    [byFolder],
  );
  const counts = useMemo(
    () =>
      treeCounts(
        folders,
        ordered.flatMap((doc) => {
          const id = folderOf(doc.id);
          return id === null ? [] : [{ folderId: id }];
        }),
      ),
    [folders, ordered, folderOf],
  );
  const pathOf = useCallback(
    (documentId: string) => {
      const id = folderOf(documentId);
      return id === null ? null : folderPathLabel(folders, id);
    },
    [folders, folderOf],
  );
  const folded = useLibraryFolds((state) => state.folded);
  const states = useMemo(() => {
    const held = new Map((snapshot?.assignments ?? []).map((item) => [item.documentId, item]));
    return new Map(documents.map((doc) => [doc.id, organizeStateOf(doc, held.get(doc.id))]));
  }, [documents, snapshot?.assignments]);
  const anyFailed = useMemo(
    () => [...states.values()].some((state) => state.run === "failed"),
    [states],
  );
  // Only a failure's line names the service Organize sends to, so the route is read then alone.
  const organizeService = useTaggingService("classification", anyFailed);
  const organizeServiceName =
    organizeService.route.where === "cloud" ? organizeService.route.service.name : null;
  const unsortedIds = useMemo(
    () => new Set([...states].flatMap(([id, state]) => (state.place === "notSorted" ? [id] : []))),
    [states],
  );
  const reasonOf = useCallback(
    (documentId: string) => {
      const said = assignments.get(documentId)?.error;
      return reviewReason(said ? reviewProblemKind(said.kind) : "other", organizeServiceName, t);
    },
    [assignments, t, organizeServiceName],
  );
  const notSortedOf = useCallback(
    (documentId: string) => (unsortedIds.has(documentId) ? reasonOf(documentId) : null),
    [unsortedIds, reasonOf],
  );
  const sortFailedOf = useCallback(
    (documentId: string) => {
      const state = states.get(documentId);
      return state?.run === "failed" && !state.manual && state.place !== "notSorted"
        ? reasonOf(documentId)
        : null;
    },
    [states, reasonOf],
  );
  const allSorted = useMemo(
    () => documents.length > 0 && documents.every((doc) => states.get(doc.id)?.place === "sorted"),
    [documents, states],
  );
  // 8 or more loose Documents of the User's own and no Folder yet, and nothing waiting to be
  // confirmed: Organize is the page's one primary action (#1942, #1569). The example's own
  // Documents are not counted: they are never sorted.
  const ownDocuments = useOwnDocuments();
  const looseOwn = useMemo(
    () => ownDocuments.filter((document) => folderOf(document.id) === null).length,
    [ownDocuments, folderOf],
  );
  const running = useOrganizeReview((state) => state.run !== null);
  const reviewOpen = useOrganizeReview((state) => state.open);
  const waiting = useOrganizeReview((state) => state.count) ?? snapshot?.reviewCount ?? 0;
  const sortIntoFolders =
    folders.length === 0 && looseOwn >= DAY_ONE_DOCUMENTS && !narrowing && waiting === 0
      ? () => organizeDocuments(null).catch(useAppStore.getState().reportError)
      : null;
  const subOpen = useLibraryFolds((state) => state.subOpen);
  const shownIds = useMemo(
    () =>
      listedDocumentIds({
        sections,
        folders,
        documentsOf,
        folded,
        subOpen,
        narrowing,
      }),
    [sections, folders, documentsOf, folded, subOpen, narrowing],
  );
  // ⌘A and Shift-click reach every row in an open section, drawn or not.
  useSelectionOrder("library", () => shownIds.map((id) => ({ kind: "document", id })));
  // What is selected stays in view: a search, a filter or a fold that hides it, or a deletion, drops it.
  useEffect(() => {
    const held = useSelection.getState();
    if (held.surface !== "library") return;
    const visible = new Set(shownIds);
    held.keepOnly((ref) => visible.has(ref.id));
  }, [shownIds]);
  // The row may hide behind the search, a filter or a folded section: clear what hides it before
  // the reveal looks, which gives up after 120 frames (#2308).
  useEffect(() => {
    if (reviewTarget === null) return;
    useAppStore.setState({ reviewTarget: null });
    useOrganizeReview.setState({ open: false });
    setSearch("");
    setFacetFilter((current) => (isFiltering(current) ? {} : current));
    if (useAppStore.getState().tagFilter.length > 0) useAppStore.getState().setTagFilter([]);
    const folds = useLibraryFolds.getState();
    const folderId = folderOf(reviewTarget);
    if (folderId === null) {
      folds.setOpen(NOT_IN_A_FOLDER, true);
      folds.showAll(NOT_IN_A_FOLDER);
    } else {
      const chain: string[] = [];
      const seen = new Set<string>();
      let at: string | null = folderId;
      while (at !== null && !seen.has(at)) {
        const folder = folders.find((each) => each.id === at);
        if (!folder) break;
        seen.add(at);
        chain.unshift(at);
        at = folder.parentId;
      }
      const [top] = chain;
      if (top !== undefined) {
        folds.setOpen(top, true);
        folds.showAll(top);
      }
      for (const each of chain) {
        folds.setSubOpen(each, true);
        folds.showAll(each);
      }
    }
    const id = reviewTarget;
    const within = `[data-document-id="${CSS.escape(id)}"]`;
    let frames = 0;
    const reveal = () => {
      const row = page.current?.querySelector<HTMLElement>(within);
      if (row) {
        row.scrollIntoView({ block: "center" });
        useSelection.getState().choose("library", { kind: "document", id });
        row.querySelector<HTMLElement>("[data-row-main]")?.focus({ preventScroll: true });
        return;
      }
      if (frames++ < 120) requestAnimationFrame(reveal);
    };
    requestAnimationFrame(reveal);
  }, [reviewTarget, folders, folderOf]);
  const selectingMany = useSelection(
    (state) => state.surface === "library" && state.items.length > 1,
  );

  const problem = useMemo(() => problemOf(documents), [documents]);
  // Files in the Linked folders that aren't Documents because their format isn't read yet (#740).
  const unreadFormats = useUnreadFiles(null).filter((file) => file.reason === "format");

  // A Folder, Not in a Folder or Recently deleted asked for (from the sidebar, a menu or ⌘K): its section opens and comes into view.
  useEffect(() => {
    if (request === "review") {
      useAppStore.setState({ libraryFilter: "all" });
      openReview();
      return;
    }
    if (FORMS.includes(request)) return;
    useOrganizeReview.setState({ open: false });
    const linkedFolderId = SOURCE_REQUEST.exec(request)?.[1];
    if (linkedFolderId) {
      setSearch("");
      setFacetFilter({ source: [linkedFolderId] });
      useAppStore.getState().setTagFilter([]);
      useAppStore.setState({ libraryFilter: "all" });
      return;
    }
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
    if (shows) {
      const groupsNow = library?.groups ?? [];
      const parentOf = (id: string) => groupsNow.find((group) => group.id === id)?.parentId ?? null;
      if (key !== NOT_IN_A_FOLDER && parentOf(key) !== null) {
        useLibraryFolds.getState().revealFolder(key, parentOf);
      } else {
        useLibraryFolds.getState().reveal(key);
      }
    }
    useAppStore.setState({ libraryFilter: "all" });
  }, [request]);

  const sectionKeys = sections.map((section) => section.key);
  const allFolded = sectionKeys.length > 0 && sectionKeys.every((key) => folded.has(key));
  const clearNarrowing = () => {
    setSearch("");
    setFacetFilter({});
    useAppStore.getState().setTagFilter([]);
  };
  const meetingHits = meetingHitsOf(inside.matches, allDocuments, minds);
  const emptyLibrary = documents.length === 0 && meetingHits.length === 0;
  const nothingMatches =
    narrowing && sections.length === 0 && !inside.waiting && meetingHits.length === 0;
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
        {reviewOpen ? (
          <div className="mx-auto w-full max-w-[880px] px-8 pb-24 @max-[680px]/page:px-4">
            <OrganizeReviewPage />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1084px] pt-5 pr-8 pb-24 pl-11 @max-[680px]/page:pr-4 @max-[680px]/page:pl-9">
            <LibraryHeader
              count={headerCount}
              sorted={allSorted && waiting === 0}
              organizeCount={looseOwn}
              onSortIntoFolders={sortIntoFolders}
              sorting={running}
              canAdd={snapshot !== null && !emptyLibrary}
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
              // A Library of meetings alone still finds them by their words.
              meetingHits.length > 0 ? (
                <MeetingHits matches={inside.matches} />
              ) : (
                <LibraryEmpty />
              )
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
                <OrganizeLines />
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
                  {sections.map((section) => (
                    <LibrarySection
                      key={section.key}
                      section={section}
                      narrowing={narrowing}
                      matches={matches}
                      folders={folders}
                      counts={counts}
                      documentsOf={documentsOf}
                      pathOf={pathOf}
                      notSortedOf={notSortedOf}
                      sortFailedOf={sortFailedOf}
                    />
                  ))}
                </div>
                <MeetingHits matches={inside.matches} />
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
        )}
      </div>
    </section>
  );
}
