import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import type { Document, LibraryGroup, Mind } from "../../../core/api";
import { shortcutLabel } from "../commands/keymap";
import { commands } from "../commands/registry";
import { useDropTarget } from "../dragDrop";
import { useFolderContents } from "../folderContents";
import { folderTarget, useDraggedOutOfFolder } from "../folderDrag";
import { useLanguage, useT } from "../i18n";
import { currentMindIdOf, currentTabOf } from "../layoutSlice";
import { formatCount } from "../linkedFolders";
import { DAY_ONE_DOCUMENTS } from "../ownDocuments";
import { useRequests } from "../requests";
import { useSelectable, useSeveralSelected } from "../selection";
import { FIRST_DOCUMENTS, moreDocumentsToShow } from "../sidebarList";
import { sorted } from "../sort";
import { type SortScope, sortOf, useSort } from "../sortChoices";
import { documentFields, mindFields } from "../sortFields";
import { allExamples, exampleMindIds, isOwnDocument, useAppStore } from "../store";
import { foldKeys, useTreeItem } from "../treeKeys";
import { useRename } from "../useRename";
import { ExamplesMenu } from "./ExamplesMenu";
import { InlineName } from "./InlineName";
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
const NO_DOCUMENT_IDS: ReadonlySet<string> = new Set();

const FOLDS_KEY = "incarnamind.sidebar.folders";

interface Folds {
  /** The Folders shown open; the rest are closed. */
  open: ReadonlySet<string>;
  tagsFolded: boolean;
  /** How many Documents each lists, past the first few, by key. Forgotten at a restart. */
  shown: Readonly<Record<string, number>>;
  toggle(folderId: string): void;
  /** Opens a Folder (e.g. the open Mind's), if it isn't. */
  reveal(folderId: string): void;
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
 * Folder lists its Minds, then its Documents (the first few, then "Show N
 * more Documents"), and opens and closes in place: the main area stays as it
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

  const { orderedGroups, documentsByFolder, mindsByFolder } = useFolderContents(documents, {
    hideExamples,
  });
  const assignments = useAppStore((state) => state.library?.assignments);
  const suggestedByFolder = useMemo(() => {
    const byFolder = new Map<string, Set<string>>();
    for (const item of assignments ?? []) {
      if (!item.suggested || item.groupId === null) continue;
      const ids = byFolder.get(item.groupId) ?? new Set<string>();
      ids.add(item.documentId);
      byFolder.set(item.groupId, ids);
    }
    return byFolder;
  }, [assignments]);

  const draggingOut = useDraggedOutOfFolder();
  const looseMinds = mindsByFolder.get(null) ?? NO_MINDS;
  const looseDocuments = documentsByFolder.get(null) ?? NO_DOCUMENTS;
  const newFolderLabel = t("sidebar.newFolderKeys", { keys: shortcutLabel("folder.new") });

  return (
    <div data-testid="library-folders">
      {orderedGroups.length > 0 && (
        <SidebarSection
          testId="folders-section"
          title={t("library.groups")}
          headingTestId="folders-title"
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
            {orderedGroups.map((folder) => (
              <FolderGroup
                key={folder.id}
                folder={folder}
                minds={mindsByFolder.get(folder.id) ?? NO_MINDS}
                documents={documentsByFolder.get(folder.id) ?? NO_DOCUMENTS}
                suggested={suggestedByFolder.get(folder.id) ?? NO_DOCUMENT_IDS}
                renderDocument={renderDocument}
              />
            ))}
          </ul>
        </SidebarSection>
      )}
      {(looseMinds.length > 0 || looseDocuments.length > 0 || draggingOut) && (
        <NotInAFolder
          minds={looseMinds}
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

/** A Folder's or Not in a Folder's contents: its Minds, then its first Documents and "Show N more". */
function Contents({
  listKey,
  scope,
  depth,
  minds,
  documents,
  renderDocument,
}: {
  listKey: string;
  /** Whose sort it follows: its Folder's, or the sidebar's for Not in a Folder. */
  scope: SortScope;
  depth: number;
  minds: readonly Mind[];
  documents: readonly Document[];
  renderDocument(document: Document, depth: number): ReactNode;
}) {
  const t = useT();
  const language = useLanguage();
  const sort = useSort(sortOf(scope));
  const extra = useFolds((state) => state.shown[listKey] ?? 0);
  const listed = FIRST_DOCUMENTS + extra;
  const rows = useMemo(() => {
    if (sort?.foldersFirst === false) {
      return sorted<Mind | Document>(
        [...minds, ...documents],
        sort,
        (item) => ("autoTitle" in item ? mindFields(item) : documentFields(t)(item)),
        language,
      );
    }
    // Folders first, or no choice: the Minds, then the Documents, each in its order.
    return [
      ...sorted(minds, sort, mindFields, language),
      ...sorted(documents, sort, documentFields(t), language),
    ];
  }, [minds, documents, sort, language, t]);
  const more = moreDocumentsToShow(extra, documents.length - listed);
  const showMoreItem = useTreeItem({ depth });
  if (minds.length === 0 && documents.length === 0) return null;
  let documentsListed = 0;
  return (
    <ul role="none">
      {rows.map((each) => {
        if ("autoTitle" in each) return <MindRow key={each.id} mind={each} depth={depth} />;
        documentsListed += 1;
        return documentsListed <= listed ? renderDocument(each, depth) : null;
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

/**
 * A Folder's row and, while open, what is in it. Clicking (or Enter, or
 * Space) opens and closes it in place; ⌘-click and Shift-click select it;
 * double-click or F2 renames it. Its row takes a drop, and opens when a drag
 * rests on it folded, as in Finder.
 */
function FolderGroup({
  folder,
  minds,
  documents,
  suggested,
  renderDocument,
}: {
  folder: LibraryGroup;
  minds: readonly Mind[];
  documents: readonly Document[];
  /** The Documents this Folder only suggests, of those it lists. */
  suggested: ReadonlySet<string>;
  renderDocument(document: Document, depth: number): ReactNode;
}) {
  const expanded = useFolds((state) => state.open.has(folder.id));
  const shownInLibrary = useAppStore(
    (state) =>
      currentTabOf(state.layout)?.item.kind === "library" && state.libraryFilter === folder.id,
  );
  const toggle = () => useFolds.getState().toggle(folder.id);
  const drop = useDropTarget(
    `sidebar-folder:${folder.id}`,
    folderTarget(folder.id),
    expanded ? undefined : () => useFolds.getState().reveal(folder.id),
  );
  const object = { kind: "folder", id: folder.id } as const;
  const select = useSelectable(object, "sidebar", toggle);
  const several = useSeveralSelected("sidebar");
  const lit = select.selected || shownInLibrary;
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
  const treeItem = useTreeItem({ depth: 0, expanded, selected: lit });
  const fold = foldKeys(expanded, toggle);
  const Chevron = expanded ? ChevronDownLineIcon : ChevronRightLineIcon;
  const suggestedCount = useMemo(
    () => documents.reduce((count, doc) => count + (suggested.has(doc.id) ? 1 : 0), 0),
    [documents, suggested],
  );

  return (
    <li
      role="none"
      data-testid="library-folder"
      data-folder-id={folder.id}
      data-count={documents.length}
      data-minds={minds.length}
      data-expanded={expanded}
      data-drop-target={drop.over ? "true" : undefined}
      {...select.refProps}
    >
      <div
        {...(rename.renaming ? {} : objectMenu.rowProps)}
        {...drop.props}
        className={`${rowClass(lit, "app", several && select.selected)} ${drop.over ? dropIntoClass : ""}`}
      >
        {rename.renaming ? (
          <span className="flex h-full w-full min-w-0 items-center gap-2 pr-1 pl-2">
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
            title={folder.description ? `${folder.name}\n${folder.description}` : folder.name}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) select.onClick(event);
              // A plain click only opens or closes it: the Mind the User is in stays the one lit.
              // The second click of a double-click renames instead.
              else if (event.detail <= 1) toggle();
            }}
            onKeyDown={(event) => {
              rename.nameProps.onKeyDown(event);
              fold(event);
            }}
            className={`${rowButtonClass} ${clearsActions.menu}`}
          >
            <FolderLineIcon className={rowIconClass(lit)} />
            <span data-testid="row-text" className="min-w-0 flex-1 truncate">
              {folder.name}
            </span>
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
            <span
              data-testid="browse-count"
              className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-ink-meta actions-shown:hidden"
            >
              {minds.length + documents.length}
              {suggestedCount > 0 &&
                ` · ${t("sidebar.folder.suggested", {
                  count: formatCount(suggestedCount, language),
                })}`}
            </span>
            <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-ink-meta" />
          </button>
        )}
        {!rename.renaming && (
          <div className={rowActionsClass}>
            <ObjectMenu
              target={object}
              label={t("folder.more", { name: folder.name })}
              tabIndex={-1}
              here={{ "folder.rename": rename.start }}
            />
          </div>
        )}
      </div>
      {expanded && (
        <Contents
          listKey={folder.id}
          scope={`folder:${folder.id}`}
          depth={1}
          minds={minds}
          documents={documents}
          renderDocument={renderDocument}
        />
      )}
    </li>
  );
}

function NotInAFolder({
  minds,
  documents,
  renderDocument,
  quiet,
  draggingOut,
  hasFolders,
}: {
  minds: readonly Mind[];
  documents: readonly Document[];
  renderDocument(document: Document, depth: number): ReactNode;
  quiet: boolean;
  draggingOut: boolean;
  hasFolders: boolean;
}) {
  const t = useT();
  const drop = useDropTarget("sidebar-folder:none", folderTarget(null));
  const examplesOnly = useAppStore((state) => {
    const examples = allExamples(state);
    return (
      quiet &&
      minds.length > 0 &&
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
  // Documents, each counting its rows, whether or not the first open's card is dismissed; once
  // one exists, Not in a Folder holds them together, Notes first (#2290). An example Mind not
  // folded to its one row keeps its own Examples heading, never a Note of the User's.
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
    (hasFolders ? minds.length + documents.length > 0 : documents.length > 0 || offerFolder) ||
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
            documents={documents}
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
            documents={NO_DOCUMENTS}
            renderDocument={renderDocument}
          />
        </SidebarSection>
      )}
    </div>
  );
}
