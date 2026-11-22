import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import type { Canvas, Document, LibraryGroup, Mind } from "../../../core/api";
import { exampleLinkedIds, unboundLinkedFolders, useBoundPlace } from "../boundFolders";
import { sidebarHandle } from "../commands/handles";
import { shortcutLabel } from "../commands/keymap";
import { commands } from "../commands/registry";
import { useDraggedRef, useDragSource, useDropTarget } from "../dragDrop";
import { useFolderContents } from "../folderContents";
import { folderRowDrag, folderTarget, folderTopTarget, useDraggedOutOfFolder } from "../folderDrag";
import { buildFolderTree, type FolderNode, folderPathLabel } from "../folders";
import { useLanguage, useT } from "../i18n";
import { currentMindIdOf, currentTabOf } from "../layoutSlice";
import { treeCounts } from "../libraryPage";
import { indexingShare, linkedFolderRowState, rowStateLabel } from "../linkedFolders";
import { isListedDocument } from "../meetingTranscript";
import { DAY_ONE_DOCUMENTS, useExampleDocuments } from "../ownDocuments";
import { useRequests } from "../requests";
import { useSelectable, useSeveralSelected } from "../selection";
import { FIRST_DOCUMENTS, moreDocumentsToShow } from "../sidebarList";
import { useSidebarMove } from "../sidebarMoves";
import { sorted } from "../sort";
import { type SortScope, sortOf, useSort } from "../sortChoices";
import { canvasFields, documentFields, mindFields } from "../sortFields";
import { allExamples, exampleMindIds, isOwnDocument, useAppStore } from "../store";
import { foldKeys, isMoveToKey, useTreeItem } from "../treeKeys";
import { useRename } from "../useRename";
import { BoundMark } from "./BoundMark";
import { CanvasRow } from "./CanvasRow";
import { ExamplesMenu } from "./ExamplesMenu";
import { InlineName } from "./InlineName";
import { UnboundLinkedFolderRows } from "./LinkedFolderRows";
import {
  ChevronDownLineIcon,
  ChevronRightLineIcon,
  FolderLineIcon,
  LockLineIcon,
  PlusLineIcon,
} from "./lineIcons";
import { MindRow } from "./MindRow";
import { ObjectMenu, useObjectMenu } from "./ObjectMenu";
import { SidebarSection } from "./SidebarSection";
import {
  clearsActions,
  dropAfterClass,
  dropBeforeClass,
  dropIntoClass,
  rowActionButtonClass,
  rowActionsClass,
  rowButtonClass,
  rowClass,
  rowIconClass,
  rowPadding,
} from "./sidebarRows";

/** Not in a Folder's key among the lists that show more. */
const NOT_IN_A_FOLDER = "not-in-a-folder";

const NO_DOCUMENTS: readonly Document[] = [];
const NO_MINDS: readonly Mind[] = [];
const NO_CANVASES: readonly Canvas[] = [];

const FOLDS_KEY = "incarnamind.sidebar.folders";

/** As long as the wash's animation lasts (`[data-just-linked]` in styles.css). */
const LINKED_WASH_MS = 1600;

interface Folds {
  /** The Folders shown open; the rest are closed. */
  open: ReadonlySet<string>;
  tagsFolded: boolean;
  /** How many Documents each lists, past the first few, by key. Forgotten at a restart. */
  shown: Readonly<Record<string, number>>;
  toggle(folderId: string): void;
  /** Opens a Folder (e.g. the open Mind's), if it isn't. */
  reveal(folderId: string): void;
  /** Opens the Folders this one is inside, so its row shows, and then it. */
  revealPath(folderId: string, parentOf: (id: string) => string | null): void;
  toggleTags(): void;
  showMore(key: string, count: number): void;
}

function readFolds(): { open: string[]; tagsFolded: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "null") as {
      open?: unknown;
      tagsFolded?: unknown;
    } | null;
    return {
      open: Array.isArray(value?.open) ? value.open.filter((id) => typeof id === "string") : [],
      tagsFolded: value?.tagsFolded === true,
    };
  } catch {
    return { open: [], tagsFolded: false };
  }
}

function saveFolds(folds: Pick<Folds, "open" | "tagsFolded">): void {
  try {
    localStorage.setItem(
      FOLDS_KEY,
      JSON.stringify({ open: [...folds.open], tagsFolded: folds.tagsFolded }),
    );
  } catch {
    // Not remembered, then: they start closed next time.
  }
}

/** Which Folders are open in the sidebar, and whether Tags is folded, remembered on this computer. */
export const useFolds = create<Folds>()((set, get) => {
  const initial = readFolds();
  const change = (next: Partial<Folds>) => {
    set(next);
    saveFolds(get());
  };
  return {
    open: new Set(initial.open),
    tagsFolded: initial.tagsFolded,
    shown: {},
    toggle(folderId) {
      const open = new Set(get().open);
      if (!open.delete(folderId)) open.add(folderId);
      change({ open });
    },
    reveal(folderId) {
      if (get().open.has(folderId)) return;
      change({ open: new Set([...get().open, folderId]) });
    },
    revealPath(folderId, parentOf) {
      const open = new Set(get().open);
      const seen = new Set<string>();
      let parent = parentOf(folderId);
      while (parent !== null && !seen.has(parent)) {
        seen.add(parent);
        open.add(parent);
        parent = parentOf(parent);
      }
      open.add(folderId);
      change({ open });
    },
    toggleTags() {
      change({ tagsFolded: !get().tagsFolded });
    },
    showMore(key, count) {
      set((state) => ({ shown: { ...state.shown, [key]: (state.shown[key] ?? 0) + count } }));
    },
  };
});

/**
 * The sidebar's Folders and Not in a Folder (DESIGN.md, "One tree"): each
 * Folder lists its Minds, its Canvases, then its Documents (the first few, then
 * "Show N more Documents"), and opens and closes in place: the main area stays as it
 * is. Until the User has a Folder, their loose Notes and Documents are two
 * lists, Notes and Documents, each counting its rows, as on day one (#2290).
 * Once one exists, Not in a Folder holds them together, Notes first, and says
 * on hover what a Mind there searches. Each section shows only with something
 * in it, but Not in a Folder also shows while something is dragged out of a
 * Folder, to take the drop.
 * Minds and Documents drag onto a Folder, or onto Not in a Folder's heading
 * to leave theirs (see `folderTarget`); a Folder renames in place
 * (double-click or F2, as in Finder) and has its menu (⋯ or a right-click).
 * The keys that walk the tree, → and ← among them, are `useTreeKeyboard`'s.
 */
export function LibraryFolders({
  documents,
  renderDocument,
  quiet = false,
  hideExamples = false,
}: {
  /** The Documents to show, already filtered by Tag. */
  documents: readonly Document[];
  renderDocument(document: Document, depth: number): ReactNode;
  quiet?: boolean;
  /** Leaves the example Minds out, once the examples are folded to one row (#1944). */
  hideExamples?: boolean;
}) {
  const t = useT();
  const openMindFolder = useAppStore(
    (state) =>
      state.minds.find((mind) => mind.id === currentMindIdOf(state.layout))?.folderId ?? null,
  );
  const openMindId = useAppStore((state) => currentMindIdOf(state.layout));

  // The open Mind's Folder opens, so its row is in sight: when it opens, or moves there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another Mind of the same Folder opened reveals it again.
  useEffect(() => {
    if (openMindFolder) useFolds.getState().reveal(openMindFolder);
  }, [openMindId, openMindFolder]);

  const { orderedGroups, documentsByFolder, mindsByFolder, canvasesByFolder } = useFolderContents(
    documents,
    { hideExamples },
  );
  const parentOf = useMemo(() => {
    const parents = new Map(orderedGroups.map((folder) => [folder.id, folder.parentId]));
    return (id: string) => parents.get(id) ?? null;
  }, [orderedGroups]);
  // How many Documents, Minds and Canvases each Folder holds, those in its sub-Folders too (its
  // row's count).
  const counts = useMemo(
    () =>
      treeCounts(orderedGroups, [
        ...orderedGroups.flatMap((folder) =>
          (documentsByFolder.get(folder.id) ?? NO_DOCUMENTS).map(() => ({ folderId: folder.id })),
        ),
        ...orderedGroups.flatMap((folder) =>
          (mindsByFolder.get(folder.id) ?? NO_MINDS).map(() => ({ folderId: folder.id })),
        ),
        ...orderedGroups.flatMap((folder) =>
          (canvasesByFolder.get(folder.id) ?? NO_CANVASES).map(() => ({ folderId: folder.id })),
        ),
      ]),
    [orderedGroups, documentsByFolder, mindsByFolder, canvasesByFolder],
  );
  const tree = useMemo(() => buildFolderTree(orderedGroups), [orderedGroups]);
  const paths = useMemo(
    () =>
      new Map(
        orderedGroups.map((folder) => [folder.id, folderPathLabel(orderedGroups, folder.id)]),
      ),
    [orderedGroups],
  );
  const topLevelDrop = useDropTarget("sidebar-folders-top", folderTopTarget());

  // The open Mind's Folder opens, so its row is in sight: when it opens, or moves there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another Mind of the same Folder opened reveals it again.
  useEffect(() => {
    if (openMindFolder) useFolds.getState().revealPath(openMindFolder, parentOf);
  }, [openMindId, openMindFolder, parentOf]);

  // A Folder just made inside another opens what it is in, so its row, and its name field, show.
  const nameFolder = useRequests((state) => state.nameFolder);
  useEffect(() => {
    if (nameFolder) useFolds.getState().revealPath(nameFolder, parentOf);
  }, [nameFolder, parentOf]);

  const draggingOut = useDraggedOutOfFolder();
  const looseMinds = mindsByFolder.get(null) ?? NO_MINDS;
  const looseCanvases = canvasesByFolder.get(null) ?? NO_CANVASES;
  const looseDocuments = documentsByFolder.get(null) ?? NO_DOCUMENTS;
  const newFolderLabel = t("sidebar.newFolderKeys", { keys: shortcutLabel("folder.new") });
  const exampleIds = useAppStore(exampleLinkedIds);
  const turnedOff = useAppStore(
    (state) => unboundLinkedFolders(state, new Set(exampleIds.split(" "))).length > 0,
  );

  return (
    <div data-testid="library-folders">
      {(orderedGroups.length > 0 || turnedOff) && (
        <SidebarSection
          testId="folders-section"
          title={t("library.groups")}
          headingTestId="folders-title"
          drop={topLevelDrop}
          actions={
            <button
              type="button"
              data-testid="folders-add"
              aria-label={newFolderLabel}
              title={newFolderLabel}
              onClick={() =>
                void commands.run("folder.new").catch(useAppStore.getState().reportError)
              }
              className={rowActionButtonClass}
            >
              <PlusLineIcon className="size-4" />
            </button>
          }
        >
          <ul role="none">
            {tree.map((node) => (
              <FolderGroup
                key={node.folder.id}
                node={node}
                mindsByFolder={mindsByFolder}
                canvasesByFolder={canvasesByFolder}
                documentsByFolder={documentsByFolder}
                counts={counts}
                paths={paths}
                parentOf={parentOf}
                renderDocument={renderDocument}
              />
            ))}
          </ul>
          <UnboundLinkedFolderRows />
        </SidebarSection>
      )}
      {(looseMinds.length > 0 ||
        looseCanvases.length > 0 ||
        looseDocuments.length > 0 ||
        draggingOut) && (
        <NotInAFolder
          minds={looseMinds}
          canvases={looseCanvases}
          documents={looseDocuments}
          renderDocument={renderDocument}
          quiet={quiet}
          draggingOut={draggingOut}
          hasFolders={orderedGroups.length > 0}
        />
      )}
    </div>
  );
}

type ContentRow =
  | { kind: "mind"; item: Mind }
  | { kind: "canvas"; item: Canvas }
  | { kind: "document"; item: Document };

/**
 * A Folder's or Not in a Folder's contents: its sub-Folders, then its Minds, Canvases and
 * Documents.
 */
export function Contents({
  listKey,
  scope,
  depth,
  subfolders,
  minds,
  canvases = NO_CANVASES,
  documents,
  renderDocument,
}: {
  listKey: string;
  /** Whose sort it follows: its Folder's, or the sidebar's for Not in a Folder. */
  scope: SortScope;
  depth: number;
  /** The Folders inside it, when it has any: they come first, as on the Library page. */
  subfolders?: ReactNode;
  minds: readonly Mind[];
  canvases?: readonly Canvas[];
  documents: readonly Document[];
  renderDocument(document: Document, depth: number): ReactNode;
}) {
  const t = useT();
  const language = useLanguage();
  const sort = useSort(sortOf(scope));
  const extra = useFolds((state) => state.shown[listKey] ?? 0);
  const listed = FIRST_DOCUMENTS + extra;
  const rows = useMemo(() => {
    const ofDocument = documentFields(t);
    const fields = (row: ContentRow) =>
      row.kind === "mind"
        ? mindFields(row.item)
        : row.kind === "canvas"
          ? canvasFields(row.item)
          : ofDocument(row.item);
    const mindRows = minds.map((item): ContentRow => ({ kind: "mind", item }));
    const canvasRows = canvases.map((item): ContentRow => ({ kind: "canvas", item }));
    const documentRows = documents.map((item): ContentRow => ({ kind: "document", item }));
    if (sort?.foldersFirst === false) {
      return sorted([...mindRows, ...canvasRows, ...documentRows], sort, fields, language);
    }
    // Folders first, or no choice: the Minds, the Canvases, then the Documents, each in its order.
    return [
      ...sorted(mindRows, sort, fields, language),
      ...sorted(canvasRows, sort, fields, language),
      ...sorted(documentRows, sort, fields, language),
    ];
  }, [minds, canvases, documents, sort, language, t]);
  const more = moreDocumentsToShow(extra, documents.length - listed);
  const showMoreItem = useTreeItem({ depth });
  if (!subfolders && minds.length === 0 && canvases.length === 0 && documents.length === 0) {
    return null;
  }
  let documentsListed = 0;
  return (
    <ul role="none">
      {subfolders}
      {rows.map((row) => {
        if (row.kind === "mind") return <MindRow key={row.item.id} mind={row.item} depth={depth} />;
        if (row.kind === "canvas") {
          return <CanvasRow key={row.item.id} canvas={row.item} depth={depth} />;
        }
        documentsListed += 1;
        return documentsListed <= listed ? renderDocument(row.item, depth) : null;
      })}
      {more > 0 && (
        <li role="none" className="flex h-7 items-center">
          <button
            type="button"
            {...showMoreItem}
            data-testid="show-more-documents"
            onClick={() => useFolds.getState().showMore(listKey, more)}
            // Its text on the rows' text edge at this depth.
            style={{ marginLeft: rowPadding(depth).paddingLeft + 24 }}
            className="rounded-sm text-[12px] leading-4 text-ink-meta hover:text-ink hover:underline"
          >
            {more === 1 ? t("sidebar.showMore.one") : t("sidebar.showMore", { count: more })}
          </button>
        </li>
      )}
    </ul>
  );
}

/** What a Folder's row needs to show its place, its count and what is inside it. */
interface FolderGroupProps {
  node: FolderNode<LibraryGroup>;
  mindsByFolder: ReadonlyMap<string | null, readonly Mind[]>;
  canvasesByFolder: ReadonlyMap<string | null, readonly Canvas[]>;
  documentsByFolder: ReadonlyMap<string | null, readonly Document[]>;
  /** How many Documents, Minds and Canvases each Folder holds, its sub-Folders too. */
  counts: ReadonlyMap<string, number>;
  /** Each Folder's place, "Thesis › Chapter 2", for its tooltip while it is inside another Folder. */
  paths: ReadonlyMap<string, string>;
  parentOf: (id: string) => string | null;
  renderDocument(document: Document, depth: number): ReactNode;
}

/**
 * A Folder's row and, while open, what is in it: the Folders inside it, then
 * its Minds and Documents. Clicking (or Enter, or Space) opens and closes it
 * in place; ⌘-click and Shift-click select it; double-click or F2 renames it.
 * Its row takes a drop, and opens when a drag rests on it folded, as in
 * Finder. A Folder dragged onto it goes inside when it is dropped on the row's
 * middle, and beside it near an edge (#246).
 */
function FolderGroup({
  node,
  mindsByFolder,
  canvasesByFolder,
  documentsByFolder,
  counts,
  paths,
  parentOf,
  renderDocument,
}: FolderGroupProps) {
  const { folder, depth, children } = node;
  const path = paths.get(folder.id) ?? folder.name;
  const expanded = useFolds((state) => state.open.has(folder.id));
  const shownInLibrary = useAppStore(
    (state) =>
      currentTabOf(state.layout)?.item.kind === "library" && state.libraryFolderId === folder.id,
  );
  const toggle = () => useFolds.getState().toggle(folder.id);
  const row = useRef<HTMLDivElement>(null);
  const drop = useDropTarget(
    `sidebar-folder:${folder.id}`,
    folderTarget(folder.id, () => row.current?.getBoundingClientRect() ?? null),
    expanded ? undefined : () => useFolds.getState().reveal(folder.id),
  );
  const object = { kind: "folder", id: folder.id } as const;
  const select = useSelectable(object, "sidebar", toggle);
  const several = useSeveralSelected("sidebar");
  const lit = select.selected || shownInLibrary;
  const dragSource = useDragSource(() => folderRowDrag(folder, "sidebar"));
  const dragged = useDraggedRef(object);
  // The first click of a double-click folds or unfolds it: back as it was before renaming.
  const rename = useRename<HTMLButtonElement>(`folder:${folder.id}`, toggle);
  // A Folder just made opens its name field here, once; that first name is part of making it.
  const asked = useRequests((state) => state.nameFolder === folder.id);
  const firstName = useRef(false);
  const startRename = rename.start;
  useEffect(() => {
    if (!asked) return;
    firstName.current = true;
    useFolds.getState().reveal(folder.id);
    startRename();
    useRequests.getState().clear("nameFolder");
  }, [asked, folder.id, startRename]);
  const field = rename.field((name) => {
    const first = firstName.current;
    firstName.current = false;
    const { nameNewFolder, renameFolder } = useAppStore.getState();
    return first ? nameNewFolder(folder.id, name) : renameFolder(folder.id, name);
  });
  const t = useT();
  const language = useLanguage();
  const objectMenu = useObjectMenu(object);
  const treeItem = useTreeItem({ depth, expanded, selected: lit });
  const bound = useBoundPlace(folder.id);
  const linkedId = bound?.linked.id ?? null;
  const hasFiles = useAppStore((state) =>
    state.documents.some((each) => each.linkedFolderId === linkedId && isListedDocument(each)),
  );
  const diskState = bound ? linkedFolderRowState(bound.linked, hasFiles) : null;
  const status = diskState ? rowStateLabel(diskState, t, language) : null;
  const progress = diskState ? indexingShare(diskState) : null;
  const justLinked = useRequests((state) => linkedId !== null && state.showLinked === linkedId);
  // Its row, once it shows: open, in sight, washed for a moment, then as any other (#763, #3613).
  useEffect(() => {
    if (!justLinked) return;
    if (sidebarHandle.current?.hidden) sidebarHandle.current.toggle();
    useFolds.getState().reveal(folder.id);
    row.current?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => useRequests.getState().clear("showLinked"), LINKED_WASH_MS);
    return () => clearTimeout(timer);
  }, [justLinked, folder.id]);
  const fold = foldKeys(expanded, toggle);
  const Chevron = expanded ? ChevronDownLineIcon : ChevronRightLineIcon;
  const count = counts.get(folder.id) ?? 0;
  const place =
    drop.over?.place === "before"
      ? dropBeforeClass
      : drop.over?.place === "after"
        ? dropAfterClass
        : drop.over
          ? dropIntoClass
          : "";
  const inside =
    expanded && children.length > 0
      ? children.map((child) => (
          <FolderGroup
            key={child.folder.id}
            node={child}
            mindsByFolder={mindsByFolder}
            canvasesByFolder={canvasesByFolder}
            documentsByFolder={documentsByFolder}
            counts={counts}
            paths={paths}
            parentOf={parentOf}
            renderDocument={renderDocument}
          />
        ))
      : null;

  return (
    <li
      role="none"
      data-testid="library-folder"
      data-folder-id={folder.id}
      data-depth={depth}
      data-count={documentsByFolder.get(folder.id)?.length ?? 0}
      data-minds={mindsByFolder.get(folder.id)?.length ?? 0}
      data-expanded={expanded}
      data-drop-target={drop.over ? "true" : undefined}
      data-dragging={dragged || undefined}
      {...select.refProps}
    >
      <div
        ref={row}
        {...(rename.renaming ? {} : objectMenu.rowProps)}
        {...(rename.renaming ? {} : dragSource)}
        {...drop.props}
        {...(justLinked && { "data-just-linked": "true" })}
        data-state={diskState?.kind}
        className={`${rowClass(lit, diskState?.kind === "unavailable" ? "muted" : "app", several && select.selected, dragged)} ${place} @container`}
      >
        {rename.renaming ? (
          <span
            className="flex h-full w-full min-w-0 items-center gap-2 pr-1 pl-2"
            style={rowPadding(depth)}
          >
            <FolderLineIcon className={rowIconClass(lit)} />
            <InlineName
              value={folder.name}
              label={t("folder.renameLabel", { name: folder.name })}
              testId="folder-rename-field"
              {...field}
              onCancel={() => {
                firstName.current = false;
                field.onCancel();
              }}
            />
          </span>
        ) : (
          <button
            {...rename.nameProps}
            type="button"
            {...treeItem}
            data-testid="folder-row"
            aria-current={shownInLibrary ? "page" : undefined}
            title={[path, bound?.path, folder.description].filter(Boolean).join("\n")}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) select.onClick(event);
              // A plain click only opens or closes it: the Mind the User is in stays the one lit.
              // The second click of a double-click renames instead.
              else if (event.detail <= 1) toggle();
            }}
            onKeyDown={(event) => {
              rename.nameProps.onKeyDown(event);
              fold(event);
              if (isMoveToKey(event)) {
                event.preventDefault();
                useSidebarMove.getState().show(row.current, object);
              }
            }}
            className={`${rowButtonClass} ${clearsActions.menu}`}
            style={rowPadding(depth)}
          >
            <FolderLineIcon className={rowIconClass(lit)} />
            <span data-testid="row-text" className="min-w-0 flex-1 truncate">
              {folder.name}
            </span>
            {bound && <BoundMark path={bound.path} />}
            {folder.keepInside === true && (
              <span
                data-testid="folder-wall"
                role="img"
                aria-label={t("folder.wall.title")}
                title={t("folder.wall.title")}
                className="flex shrink-0"
              >
                <LockLineIcon className="size-3.5 text-ink-meta" />
              </span>
            )}
            {status ? (
              <span
                data-testid="folder-status"
                data-state={diskState?.kind}
                title={status.full}
                className="min-w-0 shrink truncate text-label font-semibold text-ink-meta"
              >
                <span aria-hidden="true" className="@max-[13rem]:hidden">
                  {status.short}
                </span>
                <span aria-hidden="true" className="hidden @max-[13rem]:inline">
                  {status.compact}
                </span>
                <span className="sr-only">{status.full}</span>
              </span>
            ) : (
              <span
                data-testid="browse-count"
                className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-ink-meta actions-shown:hidden"
              >
                {count}
              </span>
            )}
            <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-ink-meta" />
          </button>
        )}
        {progress !== null && (
          <span
            aria-hidden="true"
            data-testid="folder-progress"
            className="pointer-events-none absolute right-2 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-rule"
            style={{ left: rowPadding(depth).paddingLeft + 24 }}
          >
            <span
              className={`block h-full rounded-full transition-[width] duration-180 ease-in-out motion-reduce:transition-none ${
                diskState?.kind === "paused" ? "bg-ink-placeholder" : "bg-accent"
              }`}
              style={{ width: `${Math.round(progress * 1000) / 10}%` }}
            />
          </span>
        )}
        {!rename.renaming && (
          <div className={rowActionsClass}>
            <ObjectMenu
              target={object}
              label={t("folder.more", { name: folder.name })}
              tabIndex={-1}
              here={{
                "folder.rename": rename.start,
                "folder.moveTo": () =>
                  requestAnimationFrame(() =>
                    useSidebarMove
                      .getState()
                      .show(
                        row.current?.querySelector<HTMLElement>("[data-object-menu]") ?? null,
                        object,
                      ),
                  ),
              }}
            />
          </div>
        )}
      </div>
      {expanded && (
        <Contents
          listKey={folder.id}
          scope={`folder:${folder.id}`}
          depth={depth + 1}
          subfolders={inside}
          minds={mindsByFolder.get(folder.id) ?? NO_MINDS}
          canvases={canvasesByFolder.get(folder.id) ?? NO_CANVASES}
          documents={documentsByFolder.get(folder.id) ?? NO_DOCUMENTS}
          renderDocument={renderDocument}
        />
      )}
    </li>
  );
}

function NotInAFolder({
  minds,
  canvases,
  documents,
  renderDocument,
  quiet,
  draggingOut,
  hasFolders,
}: {
  minds: readonly Mind[];
  canvases: readonly Canvas[];
  documents: readonly Document[];
  renderDocument(document: Document, depth: number): ReactNode;
  quiet: boolean;
  draggingOut: boolean;
  hasFolders: boolean;
}) {
  const t = useT();
  const drop = useDropTarget("sidebar-folder:none", folderTarget(null));
  // The quiet first open hands the tree no Documents, so the Examples section brings its own: a
  // Document opened from a Citation always has its row there (#2376).
  const exampleDocuments = useExampleDocuments();
  const examplesOnly = useAppStore((state) => {
    const examples = allExamples(state);
    return (
      quiet &&
      minds.length > 0 &&
      canvases.length === 0 &&
      minds.every((mind) => examples.some((each) => each.mindId === mind.id))
    );
  });
  const ownCount = useAppStore(
    (state) => documents.filter((each) => isOwnDocument(each, allExamples(state))).length,
  );
  // In the tree's keys, as the rows are: one Tab stop, and ↑ ↓ reach it (#1942).
  const offerItem = useTreeItem({ depth: 0 });
  /** A Folder, offered where one helps: the User's 8th loose Document and no Folder yet. */
  const offerFolder = !examplesOnly && !hasFolders && ownCount >= DAY_ONE_DOCUMENTS;
  // Until the User has a Folder, their loose Notes and Documents are two lists, Notes and
  // Documents, each counting its rows, whether or not the first open's card is dismissed, and
  // Canvases a third between them (#3406); once one exists, Not in a Folder holds them together,
  // Notes first (#2290). An example Mind not folded to its one row keeps its own Examples
  // heading, never a Note of the User's.
  const apart = !examplesOnly && !hasFolders;
  const exampleIds = useAppStore((state) => exampleMindIds(state).join(" "));
  const ownMinds = useMemo(() => {
    if (!apart) return minds;
    const examples = new Set(exampleIds.split(" ").filter(Boolean));
    return minds.filter((mind) => !examples.has(mind.id));
  }, [apart, minds, exampleIds]);
  const exampleMinds = useMemo(() => {
    if (!apart) return NO_MINDS;
    const examples = new Set(exampleIds.split(" ").filter(Boolean));
    return minds.filter((mind) => examples.has(mind.id));
  }, [apart, minds, exampleIds]);
  const title = examplesOnly
    ? t("sidebar.examples")
    : hasFolders
      ? t("library.unsorted")
      : t("sidebar.documents");
  const showSection =
    examplesOnly ||
    (hasFolders
      ? minds.length + canvases.length + documents.length > 0
      : documents.length > 0 || offerFolder) ||
    draggingOut;
  return (
    <div data-testid="not-in-a-folder" data-count={documents.length} data-minds={minds.length}>
      {apart && ownMinds.length > 0 && (
        <SidebarSection
          testId="notes-section"
          title={t("sidebar.notes")}
          headingTestId="notes-title"
          count={ownMinds.length}
        >
          <Contents
            listKey="notes"
            scope="sidebar"
            depth={0}
            minds={ownMinds}
            documents={NO_DOCUMENTS}
            renderDocument={renderDocument}
          />
        </SidebarSection>
      )}
      {apart && canvases.length > 0 && (
        <SidebarSection
          testId="canvases-section"
          title={t("sidebar.canvases")}
          headingTestId="canvases-title"
          count={canvases.length}
        >
          <Contents
            listKey="canvases"
            scope="sidebar"
            depth={0}
            minds={NO_MINDS}
            canvases={canvases}
            documents={NO_DOCUMENTS}
            renderDocument={renderDocument}
          />
        </SidebarSection>
      )}
      {showSection && (
        <SidebarSection
          testId="not-in-a-folder-section"
          title={title}
          headingTestId="not-in-a-folder-title"
          count={apart && documents.length > 0 ? documents.length : undefined}
          tooltip={!examplesOnly && hasFolders ? t("sidebar.notInFolder.hint") : undefined}
          actions={examplesOnly ? <ExamplesMenu /> : undefined}
          drop={drop}
        >
          <Contents
            listKey={NOT_IN_A_FOLDER}
            scope="sidebar"
            depth={0}
            minds={apart ? NO_MINDS : minds}
            canvases={apart ? NO_CANVASES : canvases}
            documents={examplesOnly ? exampleDocuments : documents}
            renderDocument={renderDocument}
          />
          {offerFolder && (
            <ul role="none">
              <li role="none" className="flex h-7 items-center">
                <button
                  type="button"
                  {...offerItem}
                  data-testid="offer-folder"
                  title={t("sidebar.newFolderKeys", { keys: shortcutLabel("folder.new") })}
                  onClick={() =>
                    void commands.run("folder.new").catch(useAppStore.getState().reportError)
                  }
                  style={{ marginLeft: rowPadding(0).paddingLeft + 24 }}
                  className="flex min-w-0 items-center gap-2 rounded-sm text-[12px] leading-4 text-ink-meta hover:text-ink hover:underline"
                >
                  <PlusLineIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{t("menu.newFolder")}</span>
                </button>
              </li>
            </ul>
          )}
        </SidebarSection>
      )}
      {apart && exampleMinds.length > 0 && (
        <SidebarSection
          testId="examples-section"
          title={t("sidebar.examples")}
          headingTestId="examples-title"
          actions={<ExamplesMenu />}
        >
          <Contents
            listKey="examples"
            scope="sidebar"
            depth={0}
            minds={exampleMinds}
            documents={quiet ? exampleDocuments : NO_DOCUMENTS}
            renderDocument={renderDocument}
          />
        </SidebarSection>
      )}
    </div>
  );
}
