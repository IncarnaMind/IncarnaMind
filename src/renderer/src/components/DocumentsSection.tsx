import { type ChangeEvent, type KeyboardEvent, memo, type ReactNode, useMemo, useRef } from "react";
import type { Document, DocumentStatus, Tag } from "../../../core/api";
import { displayName, sourceOf } from "../../../shared/documentNames";
import type { MessageKey } from "../../../shared/i18n";
import { useDocumentPlace } from "../documentPlaces";
import { documentStatusText, isProcessing } from "../documentStatus";
import { useDraggedRef, useDragSource } from "../dragDrop";
import { useFirstOpen } from "../firstOpen";
import { useLanguage, useT } from "../i18n";
import { currentTabOf } from "../layoutSlice";
import { fileStatusLabel, formatCount } from "../linkedFolders";
import { useDayOne, useOwnDocuments, useOwnLinkedFolders } from "../ownDocuments";
import { usePeekKey } from "../peek";
import { scanningStatus } from "../scanStatus";
import {
  rowsIn,
  useSelectable,
  useSelectionFollowsShown,
  useSelectionOrder,
  useSeveralSelected,
} from "../selection";
import { moveFromMenu, rowDrag, useSidebarMove } from "../sidebarMoves";
import { useSortMenu } from "../sortMenu";
import { allExamples, isOwnDocument, useAppStore } from "../store";
import { chipsOf, tagIndex } from "../tagEditing";
import { isMoveToKey, moveThroughRows, TREE_ROW, useTreeItem } from "../treeKeys";
import { useRename } from "../useRename";
import { useTreeKeyboard } from "../useTreeKeyboard";
import { DocumentTagMenu } from "./DocumentTags";
import { ExampleRow } from "./ExampleRow";
import { InlineName } from "./InlineName";
import { LibraryFolders } from "./LibraryFolders";
import { LinkedFolderRows } from "./LinkedFolderRows";
import { LinkFolderDialog } from "./LinkFolderDialog";
import { DocumentLineIcon, MoreLineIcon } from "./lineIcons";
import { ObjectMenu, useObjectMenu } from "./ObjectMenu";
import { SidebarHome } from "./SidebarHome";
import { SidebarMoveTo } from "./SidebarMoveTo";
import { SidebarSearch } from "./SidebarSearch";
import { SidebarSection } from "./SidebarSection";
import { SidebarTags } from "./SidebarTags";
import {
  clearsActions,
  rowActionButtonClass,
  rowActionsClass,
  rowButtonClass,
  rowClass,
  rowIconClass,
  rowPadding,
} from "./sidebarRows";
import { TagMarks, TagNamesTip, tagNamesTipListProps } from "./TagMarks";

/** What the file picker offers. The core decides what it takes. */
const ACCEPTED_FILES = ".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.markdown";

/** A Document's status as its row's end shows it: nothing once it's ready. */
const shortStatusMessages: Record<DocumentStatus, MessageKey | null> = {
  queued: "documents.statusShort.queued",
  extracting: "documents.statusShort.extracting",
  "waiting-for-model": "documents.statusShort.waiting",
  embedding: "documents.statusShort.embedding",
  ready: null,
  failed: "documents.statusShort.failed",
  "no-text": "documents.statusShort.noText",
};

const NO_DOCUMENTS: readonly Document[] = [];

/**
 * The sidebar's tree, the same on every screen: Home, Search and the Library, then
 * the sections, each shown once it has something in it: the Folders, each
 * with its Minds and Documents, and Not in a Folder (see `LibraryFolders`),
 * the Linked folders (see `LinkedFolderRows`), and the Tags in
 * use (see `SidebarTags`). On a first open with nothing of the User's own,
 * the Library waits for their first Document. Each Document is one row: its
 * name, its Tags' colours (see `TagMarks`) and, while it's processed, if it
 * failed, or if its file is missing or can't be reached, its status at the
 * end. Its Tags are in its Tags menu, and the Tags dialog; its "More" menu
 * renames it, moves it, opens its file or shows it in its folder, and
 * deletes it. Clicking a Document opens it in the viewer. Documents and
 * Linked folders are added from the header's New menu, or dropped anywhere
 * on the window (see `FileDrop`).
 */
export function DocumentsSection() {
  const t = useT();
  const language = useLanguage();
  const ownDocuments = useOwnDocuments();
  const ownLinkedFolders = useOwnLinkedFolders();
  const dayOne = useDayOne();
  const firstOpen = useFirstOpen();
  const hasOwnDocuments = useAppStore((state) =>
    state.documents.some((each) => isOwnDocument(each, allExamples(state))),
  );
  const quiet = firstOpen && !hasOwnDocuments;
  // The example folds to one row once the User has a Document of their own (#1944), and only while
  // its Mind is there for that row to open: its Documents and folder stay reachable without one.
  const exampleMindId = useAppStore((state) => {
    const id = state.examples?.mindId;
    return id !== null && id !== undefined && state.minds.some((each) => each.id === id)
      ? id
      : null;
  });
  const exampleFolders = useAppStore((state) =>
    allExamples(state)
      .flatMap((each) => (each.linkedFolderId ? [each.linkedFolderId] : []))
      .join(" "),
  );
  const foldExamples = hasOwnDocuments && exampleMindId !== null;
  const folded = useMemo(
    () => (foldExamples ? new Set(exampleFolders.split(" ").filter(Boolean)) : new Set<string>()),
    [foldExamples, exampleFolders],
  );
  const libraryOpen = useAppStore((state) => currentTabOf(state.layout)?.item.kind === "library");
  const documents = useAppStore((state) => state.documents);
  const shownDocuments = useMemo(
    () =>
      folded.size === 0
        ? documents
        : documents.filter((each) => !folded.has(each.linkedFolderId ?? "")),
    [documents, folded],
  );
  const addDocuments = useAppStore((state) => state.addDocuments);
  const picker = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const treeKeys = useTreeKeyboard(tree);
  // ⌘A and Shift-click reach the rows in view: every Folder, Mind and Document the tree draws.
  useSelectionOrder("sidebar", () => rowsIn(tree.current));
  useSelectionFollowsShown(tree);
  const tags = useAppStore((state) => state.tags);
  // Built once per change to the Tags, so each row only looks its own up.
  const tagsById = useMemo(() => tagIndex(tags), [tags]);

  /**
   * Each Document's row as last made, by depth, while the Tags stay the same
   * (#156). A list of thousands drawn again because one Document changed
   * hands React the same rows for the rest, which it passes over without
   * comparing them; only the row whose Document changed is made and drawn again.
   */
  const renderDocument = useMemo(() => {
    const made = new WeakMap<Document, Map<number, ReactNode>>();
    return (item: Document, depth: number): ReactNode => {
      let atDepth = made.get(item);
      if (!atDepth) {
        atDepth = new Map();
        made.set(item, atDepth);
      }
      let row = atDepth.get(depth);
      if (row === undefined) {
        row = <DocumentRow key={item.id} item={item} depth={depth} tagsById={tagsById} />;
        atDepth.set(depth, row);
      }
      return row;
    };
  }, [tagsById]);

  const addPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = ""; // so picking the same file again still counts as a change
    if (picked.length > 0) void addDocuments(picked);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ↑ and ↓ go on from the tree's first and last rows to Search and the Library.
    <div
      data-testid="documents-section"
      {...tagNamesTipListProps}
      onKeyDown={(event) => {
        if (!event.defaultPrevented) moveThroughRows(event);
      }}
    >
      {/* Files given straight to the page arrive here, as from the dialog: the smoke tests add them so. */}
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        data-testid="add-documents-input"
        className="hidden"
        onChange={addPicked}
      />
      <SidebarHome />
      <SidebarSearch />
      {!quiet && !dayOne && (
        <div className={rowClass(libraryOpen)}>
          <button
            type="button"
            {...TREE_ROW}
            data-testid="open-library"
            // ⌘-click (Ctrl-click) opens it to the side, as a Mind's row does.
            onClick={(event) =>
              useAppStore
                .getState()
                .openLibrary(undefined, { side: event.metaKey || event.ctrlKey })
            }
            className={`${rowButtonClass} ${clearsActions.menu}`}
          >
            <DocumentLineIcon kind="text" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("library.title")}</span>
            <span
              data-testid="library-row-count"
              className="min-w-[6ch] text-right text-[12px] tabular-nums text-ink-meta"
            >
              {formatCount(ownDocuments.length, language)}
            </span>
          </button>
          <div className={rowActionsClass}>
            <button
              type="button"
              data-testid="sidebar-sort"
              aria-label={t("sort.sidebar")}
              title={t("sort.sidebar")}
              onClick={(event) =>
                useSortMenu
                  .getState()
                  .show({ scope: "sidebar", withFolders: true, anchor: event.currentTarget })
              }
              className={rowActionButtonClass}
            >
              <MoreLineIcon className="size-4" />
            </button>
          </div>
        </div>
      )}
      <div ref={tree} data-testid="sidebar-sections" {...treeKeys}>
        <LibraryFolders
          documents={quiet ? NO_DOCUMENTS : shownDocuments}
          renderDocument={renderDocument}
          quiet={quiet}
          hideExamples={foldExamples}
          dayOne={dayOne}
        />
        {!quiet && ownLinkedFolders.length > 0 && (
          <SidebarSection testId="linked-folders-section" title={t("sidebar.linkedFolders")}>
            <LinkedFolderRows hideExamples={foldExamples} />
          </SidebarSection>
        )}
        {!quiet && <SidebarTags />}
        {foldExamples && exampleMindId && <ExampleRow mindId={exampleMindId} />}
      </div>
      <LinkFolderDialog />
      <TagNamesTip />
      <SidebarMoveTo />
    </div>
  );
}

/**
 * A Document's row: its icon and name, its Tags' colours right after the
 * name (their names in its tooltip and description), and its status at the
 * end while it's processed, if it failed, or if its file is missing or can't
 * be reached (then muted too; clicking still opens what IncarnaMind kept of
 * it). The name gives way first; the row stays one 28px line. Pointed at, it
 * offers its Tags and a menu for the rest. It drags onto a Folder, a Tag or
 * the composer, with the rows selected with it, and moves by its menu or ⇧⌘M
 * too (see `SidebarMoveTo`). Memoised: a sidebar of thousands of Documents
 * draws again only the rows whose Document changed.
 */
const DocumentRow = memo(function DocumentRow({
  item,
  depth,
  tagsById,
}: {
  item: Document;
  depth: number;
  tagsById: ReadonlyMap<string, Tag>;
}) {
  const t = useT();
  const rename = useRename<HTMLButtonElement>(`sidebar-document:${item.id}`);
  const renameDocument = useAppStore((state) => state.renameDocument);
  const shownName = displayName(item);
  const place = useDocumentPlace(item.id);
  const source = sourceOf(item);
  const chips = chipsOf(item.tags, tagsById);
  const tagNames =
    chips.length > 0
      ? t("tags.marks", { names: chips.map(({ tag }) => tag.name).join(", ") })
      : undefined;
  const openDocument = useAppStore((state) => state.openDocument);
  const isOpen = useAppStore((state) => {
    const shown = currentTabOf(state.layout)?.item;
    return shown?.kind === "document" && shown.documentId === item.id;
  });
  const object = { kind: "document", id: item.id } as const;
  const objectMenu = useObjectMenu(object);
  const select = useSelectable(object, "sidebar", () => openDocument({ documentId: item.id }));
  const several = useSeveralSelected("sidebar");
  const peek = usePeekKey(item.id, "sidebar");
  const lit = select.selected;
  const moveToKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isMoveToKey(event)) return;
    event.preventDefault();
    useSidebarMove.getState().show(event.currentTarget, object);
  };
  const row = useRef<HTMLLIElement>(null);
  const muted = !lit && (isProcessing(item.status) || item.fileStatus !== "available");
  const treeItem = useTreeItem({ depth, selected: select.selected });
  const dragSource = useDragSource(() => rowDrag(object, "sidebar"));
  const dragged = useDraggedRef(object);

  return (
    <li
      data-testid="document-list-item"
      data-document-id={item.id}
      data-folder-id={item.folderId ?? ""}
      data-depth={depth}
      data-status={item.status}
      data-file-status={item.fileStatus}
      data-tagging={item.tagging}
      data-dragging={dragged || undefined}
      role="none"
      {...select.refProps}
      {...peek.rowProps}
      {...(rename.renaming ? {} : objectMenu.rowProps)}
      ref={row}
      className={rowClass(lit, muted ? "muted" : "item", several, dragged)}
    >
      {rename.renaming ? (
        <div
          className="flex h-full w-full min-w-0 items-center gap-2 pr-1"
          style={rowPadding(depth)}
        >
          <DocumentLineIcon kind={item.kind} className={rowIconClass(false)} />
          <InlineName
            value={item.name}
            label={t("documents.renameLabel", { name: item.name })}
            {...rename.field((name) => renameDocument(item.id, name))}
          />
        </div>
      ) : (
        // Opens the Document in the viewer, replacing whatever it showed.
        <button
          {...rename.nameProps}
          type="button"
          {...treeItem}
          data-testid="open-document"
          aria-current={isOpen ? "true" : undefined}
          aria-description={tagNames}
          title={[shownName === source ? shownName : `${shownName}\n${source}`, place, tagNames]
            .filter(Boolean)
            .join("\n")}
          // A click opens it, in a preview beside the Mind or in the group already showing a Document;
          // ⌘-click and Shift-click select (`useSelectable`).
          onClick={select.onClick}
          onKeyDown={(event) => {
            rename.nameProps.onKeyDown(event);
            moveToKey(event);
          }}
          {...dragSource}
          className={`${rowButtonClass} ${clearsActions.tagsAndMenu}`}
          style={rowPadding(depth)}
        >
          <DocumentLineIcon kind={item.kind} className={rowIconClass(lit)} />
          {/* Takes what the status leaves; in it, the name gives way before the colours. */}
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span data-testid="row-text" className="max-w-full shrink-0 truncate">
                {shownName}
              </span>
              {place && (
                <span data-testid="row-place" className="min-w-0 truncate text-ink-meta">
                  {place}
                </span>
              )}
            </span>
            <NotCitedLabel item={item} />
            <TagMarks
              chips={chips}
              reserved={item.tagging === "pending" || item.tagging === "tagging"}
            />
          </span>
          <DocumentStatusLabel item={item} />
        </button>
      )}
      {!rename.renaming && (
        <div className={rowActionsClass}>
          <DocumentTagMenu item={item} buttonClassName={rowActionButtonClass} tabIndex={-1} />
          <ObjectMenu
            target={object}
            label={t("documents.more", { name: item.name })}
            here={{
              "document.rename": rename.start,
              "document.moveTo": () => moveFromMenu(row.current, object),
            }}
            tabIndex={-1}
          />
        </div>
      )}
    </li>
  );
});

export function NotCitedLabel({ item }: { item: Pick<Document, "notCited"> }) {
  const t = useT();
  if (!item.notCited) return null;
  return (
    <span
      data-testid="document-not-cited"
      title={t("evidence.notCited.hint")}
      className="shrink-0 text-label font-semibold text-ink-meta"
    >
      {t("evidence.notCited.label")}
    </span>
  );
}

/**
 * The status at a row's end: "Missing" or "Unavailable" when its file isn't
 * where it was (that comes first: it's what the User can act on), "38%"
 * while it's embedded, "Failed" if it failed, nothing once it's ready. Its
 * full words (and a failure's message) are its tooltip, and what a screen
 * reader reads.
 */
export function DocumentStatusLabel({ item }: { item: Document }) {
  const t = useT();
  const language = useLanguage();
  const fileState = fileStatusLabel(item.fileStatus);
  if (fileState) {
    return (
      <span
        data-testid="document-status"
        data-file-status={item.fileStatus}
        title={t(fileState.full)}
        className="min-w-0 shrink truncate text-label font-semibold text-ink-meta"
      >
        <span aria-hidden="true">{t(fileState.short)}</span>
        <span className="sr-only">{t(fileState.full)}</span>
      </span>
    );
  }
  // Its scanned pages being read, or some that couldn't be (#397).
  const scanning = item.status === "extracting" && item.scan ? scanningStatus(item.scan, t) : null;
  const unread = item.status === "failed" && item.failure?.reason === "pages-unread";
  const full = documentStatusText(item, t, language, scanning?.full ?? null);
  const percent = Math.floor((item.progress ?? 0) * 100);
  const shortKey = unread ? "documents.statusShort.pagesUnread" : shortStatusMessages[item.status];
  const short = shortKey && (scanning?.short ?? t(shortKey, { percent }));
  const title = item.failure?.message ? `${full}\n${item.failure.message}` : full;
  if (!short) {
    return (
      <span data-testid="document-status" className="sr-only">
        {full}
      </span>
    );
  }
  return (
    <span
      data-testid="document-status"
      title={title}
      className="flex shrink-0 items-center gap-1.5 text-label font-semibold text-ink-meta"
    >
      {item.status === "failed" && !unread && (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
      )}
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{full}</span>
    </span>
  );
}
