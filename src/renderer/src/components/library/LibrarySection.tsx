import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  Document,
  LibraryGroup,
  LibrarySettings,
  TaggingClassifier,
  TaggingModelOption,
} from "../../../../core/api";
import { organizeModelOf } from "../../../../shared/libraryModels";
import { core } from "../../core";
import { useDraggedRef, useDragSource, useDropTarget } from "../../dragDrop";
import { folderDrag, folderTarget } from "../../folderDrag";
import { folderPathLabel } from "../../folders";
import { useLanguage, useT } from "../../i18n";
import { useLibraryFolds, useRevealed } from "../../libraryFolds";
import {
  childrenOf,
  FIRST_ROWS,
  NOT_IN_A_FOLDER,
  type SearchMatch,
  type LibrarySection as Section,
} from "../../libraryPage";
import { formatCount } from "../../linkedFolders";
import { organizeDocuments, useProposing } from "../../organizeDocuments";
import { organizeFailedIds, organizeStateOf } from "../../organizeOutcome";
import { useOrganizeAsk } from "../../organizeRun";
import { useRequests } from "../../requests";
import { useSidebarMove } from "../../sidebarMoves";
import { useAppStore } from "../../store";
import { isMoveToKey, TREE_ROW } from "../../treeKeys";
import { useRename } from "../../useRename";
import { DetailsLine } from "../DetailsLine";
import { InlineName } from "../InlineName";
import { ChevronRightLineIcon, FolderLineIcon, LockLineIcon } from "../lineIcons";
import { ObjectMenu, useObjectMenu } from "../ObjectMenu";
import { NeedsModelCard } from "../providers/NeedsModelCard";
import {
  dropAfterClass,
  dropBeforeClass,
  dropIntoClass,
  rowActionButtonClass,
} from "../sidebarRows";
import { providerOf } from "../TaggingSettings";
import { FolderForm } from "./FolderForm";
import { LibraryRow, pageRowClass } from "./LibraryRow";
import { SectionHead, sectionNameClass } from "./SectionHead";

/** A link-like button in a section's head or foot: quiet until pointed at. */
export const quietButtonClass =
  "shrink-0 rounded-sm text-[13px] font-semibold text-ink-secondary hover:text-ink hover:underline disabled:opacity-50 disabled:hover:no-underline";

/**
 * One section of the Library page: a Folder's Documents, or those in no
 * Folder, under a head that folds it and remembers it. A Folder's sub-Folders
 * come first, each opening inline; a long list shows its first Documents, then
 * "Show all N"; while the page is narrowed it lists every match, opening the
 * sub-Folders that hold one.
 */
export function LibrarySection({
  section,
  narrowing,
  matches,
  folders,
  counts,
  documentsOf,
  pathOf,
  suggestedOf,
  notSortedOf,
  sortFailedOf,
}: {
  section: Section;
  narrowing: boolean;
  /** How each Document matches the search, by its id, while there is one. */
  matches: ReadonlyMap<string, SearchMatch> | null;
  /** Every Folder, in the sidebar's order, its sub-Folders after it. */
  folders: readonly LibraryGroup[];
  /** How many Documents each Folder holds, its sub-Folders included, in what the page lists. */
  counts: ReadonlyMap<string, number>;
  /** The Documents filed in a Folder itself, in the page's order. */
  documentsOf(folderId: string): readonly Document[];
  /** Where a Document is, while a search names it out of its tree: "Thesis › Chapter 2". */
  pathOf(documentId: string): string | null;
  /** The Suggested Folder a Document waits in, by its id, if it waits in one. */
  suggestedOf(documentId: string): string | null;
  /** Why Organize couldn't sort a Document, by its id, if it couldn't. */
  notSortedOf(documentId: string): string | null;
  /** Why a Suggested Folder's latest run failed, by a Document's id, if it did. */
  sortFailedOf(documentId: string): string | null;
}) {
  const t = useT();
  const language = useLanguage();
  const open = useLibraryFolds((state) => !state.folded.has(section.key));
  const showingAll = useLibraryFolds((state) => state.showingAll.has(section.key));
  const element = useRevealed<HTMLDivElement>(section.key);
  const { documents } = section;
  const count = section.folder
    ? (counts.get(section.folder.id) ?? documents.length)
    : documents.length;
  // While a search narrows the page, the count is the matches, and those are all shown.
  const inSubfolders = narrowing ? 0 : Math.max(0, count - documents.length);
  const listed = narrowing || showingAll ? documents : documents.slice(0, FIRST_ROWS);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of rows in the page's grid, under its head.
    <div
      ref={element}
      role="rowgroup"
      data-testid="library-section"
      data-section={section.key}
      data-count={count}
      className="mt-[18px] first:mt-2"
    >
      {section.folder ? (
        <FolderHead folder={section.folder} count={count} inSubfolders={inSubfolders} open={open} />
      ) : (
        <LooseHead documents={documents} open={open} />
      )}
      {!section.folder && <OrganizeNeedsModel />}
      {open &&
        section.folder &&
        childrenOf(folders, section.folder.id)
          .filter((child) => !narrowing || (counts.get(child.id) ?? 0) > 0)
          .map((child) => (
            <SubfolderRow
              key={child.id}
              folder={child}
              depth={1}
              folders={folders}
              counts={counts}
              documentsOf={documentsOf}
              narrowing={narrowing}
              matches={matches}
              pathOf={pathOf}
              suggestedOf={suggestedOf}
              notSortedOf={notSortedOf}
              sortFailedOf={sortFailedOf}
            />
          ))}
      {open &&
        listed.map((doc) => (
          <LibraryRow
            key={doc.id}
            doc={doc}
            depth={section.folder ? 1 : 0}
            suggestedIn={suggestedOf(doc.id)}
            notSorted={notSortedOf(doc.id)}
            sortFailed={sortFailedOf(doc.id)}
            match={matches?.get(doc.id) ?? null}
            path={narrowing ? pathOf(doc.id) : null}
          />
        ))}
      {open && listed.length < documents.length && (
        <div className="flex min-h-8 items-center border-b border-rule pl-14">
          <button
            type="button"
            data-testid="library-show-all"
            onClick={() => useLibraryFolds.getState().showAll(section.key)}
            className={quietButtonClass}
          >
            {t("library.showAll", { count: formatCount(documents.length, language) })}
          </button>
        </div>
      )}
    </div>
  );
}

/** The ⋯ a Folder's row opens its Move to… beside. */
const menuAnchorOf = (row: HTMLElement | null): HTMLElement | null =>
  row?.querySelector<HTMLElement>("[data-object-menu]") ?? null;

/** A sub-Folder's row inside its section: its triangle, name, count and Place, opening inline. */
function SubfolderRow({
  folder,
  depth,
  folders,
  counts,
  documentsOf,
  narrowing,
  matches,
  pathOf,
  suggestedOf,
  notSortedOf,
  sortFailedOf,
}: {
  folder: LibraryGroup;
  /** 1 for a Folder in a section, 2 for one inside it, and so on. */
  depth: number;
  folders: readonly LibraryGroup[];
  counts: ReadonlyMap<string, number>;
  documentsOf(folderId: string): readonly Document[];
  narrowing: boolean;
  matches: ReadonlyMap<string, SearchMatch> | null;
  pathOf(documentId: string): string | null;
  suggestedOf(documentId: string): string | null;
  notSortedOf(documentId: string): string | null;
  sortFailedOf(documentId: string): string | null;
}) {
  const t = useT();
  const language = useLanguage();
  const savedOpen = useLibraryFolds((state) => state.subOpen.has(folder.id));
  const open = narrowing || savedOpen;
  const children = childrenOf(folders, folder.id);
  const documents = documentsOf(folder.id);
  const count = counts.get(folder.id) ?? documents.length;
  const element = useRevealed<HTMLDivElement>(folder.id);
  const toggle = () => useLibraryFolds.getState().toggleSub(folder.id);
  const rename = useRename<HTMLButtonElement>(`library-subfolder:${folder.id}`, toggle);
  const object = { kind: "folder", id: folder.id } as const;
  const objectMenu = useObjectMenu(object);
  const renameFolder = useAppStore((state) => state.renameFolder);
  const dragSource = useDragSource(() => (rename.renaming ? null : folderDrag(folder, "library")));
  const dragged = useDraggedRef(object);
  const drop = useDropTarget(
    `library-subfolder:${folder.id}`,
    folderTarget(folder.id, () => element.current?.getBoundingClientRect() ?? null),
    open ? undefined : () => useLibraryFolds.getState().setSubOpen(folder.id, true),
  );
  const indent = 16 * Math.min(depth, 3);
  const path = folderPathLabel(folders, folder.id);
  const place =
    drop.over?.place === "before"
      ? dropBeforeClass
      : drop.over?.place === "after"
        ? dropAfterClass
        : drop.over
          ? dropIntoClass
          : "";
  const listed = narrowing ? documents : documents.slice(0, FIRST_ROWS);
  const showingAll = useLibraryFolds((state) => state.showingAll.has(folder.id));
  const shown = showingAll ? documents : listed;
  const deep = depth > 3 ? path.split(" › ").slice(-2).join(" › ") : null;
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a row of columns in a grid of sections, not a table row. */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: its name's button takes the focus, and the arrow keys move between them. */}
      <div
        ref={element}
        role="row"
        data-testid="library-subfolder"
        data-folder-id={folder.id}
        data-depth={depth}
        data-count={count}
        data-drop-target={drop.over ? "true" : undefined}
        data-dragging={dragged || undefined}
        {...(rename.renaming ? {} : objectMenu.rowProps)}
        className={`${pageRowClass(false, dragged)} ${place}`}
      >
        <div
          {...(rename.renaming ? {} : dragSource)}
          {...drop.props}
          className="flex min-h-[39px] items-center gap-4 pr-1.5"
          style={{ paddingLeft: indent }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              tabIndex={-1}
              data-testid="library-subfolder-toggle"
              aria-expanded={open}
              aria-label={t(open ? "library.collapse" : "library.expand", { name: folder.name })}
              title={t(open ? "library.collapse" : "library.expand", { name: folder.name })}
              onClick={toggle}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-meta hover:bg-hover hover:text-ink"
            >
              <ChevronRightLineIcon className={`size-3.5 ${open ? "rotate-90" : ""}`} />
            </button>
            <FolderLineIcon className="size-4 shrink-0 text-ink-meta" />
            {rename.renaming ? (
              <InlineName
                value={folder.name}
                label={t("folder.renameLabel", { name: folder.name })}
                testId="library-subfolder-rename"
                {...rename.field((next) => renameFolder(folder.id, next))}
              />
            ) : (
              <button
                {...rename.nameProps}
                type="button"
                {...TREE_ROW}
                data-testid="library-subfolder-name"
                aria-expanded={open}
                title={`${path}${folder.description ? `\n${folder.description}` : ""}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  if (event.detail <= 1) toggle();
                }}
                onKeyDown={(event) => {
                  rename.nameProps.onKeyDown(event);
                  // ← closes it and → opens it, as the sidebar's tree does.
                  foldKeys(folder.id, open)(event);
                  if (isMoveToKey(event)) {
                    event.preventDefault();
                    useSidebarMove.getState().show(menuAnchorOf(element.current), object);
                  }
                }}
                className={`${sectionNameClass} font-medium`}
              >
                {folder.name}
              </button>
            )}
            <span
              data-testid="library-subfolder-count"
              className="shrink-0 text-[12px] tabular-nums text-ink-meta"
            >
              {formatCount(count, language)}
            </span>
            {deep && (
              <span
                data-testid="library-subfolder-path"
                title={path}
                className="max-w-56 shrink-0 truncate rounded-sm bg-chip px-1.5 text-[11px] leading-[18px] text-ink-secondary"
              >
                … › {deep}
              </span>
            )}
            {!rename.renaming && (
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
                          element.current?.querySelector<HTMLElement>("[data-object-menu]") ?? null,
                          object,
                        ),
                    ),
                }}
              />
            )}
          </div>
          <span className="w-[200px] shrink-0 group-data-[hide~=narrow]/page:w-[152px] group-data-[hide~=narrower]/page:w-[112px] group-data-[hide~=narrowest]/page:w-[88px] group-data-[hide~=chips]/page:w-auto" />
          <span
            data-testid="library-subfolder-format"
            className="w-[76px] shrink-0 text-[13px] text-ink-secondary group-data-[hide~=format]/page:hidden"
          >
            {t("library.format.folder")}
          </span>
          <span className="w-24 shrink-0 group-data-[hide~=added]/page:hidden" />
          <span className="flex w-7 shrink-0 justify-end" />
        </div>
      </div>
      {open &&
        children
          .filter((child) => !narrowing || (counts.get(child.id) ?? 0) > 0)
          .map((child) => (
            <SubfolderRow
              key={child.id}
              folder={child}
              depth={depth + 1}
              folders={folders}
              counts={counts}
              documentsOf={documentsOf}
              narrowing={narrowing}
              matches={matches}
              pathOf={pathOf}
              suggestedOf={suggestedOf}
              notSortedOf={notSortedOf}
              sortFailedOf={sortFailedOf}
            />
          ))}
      {open &&
        shown.map((doc) => (
          <LibraryRow
            key={doc.id}
            doc={doc}
            depth={depth + 1}
            suggestedIn={suggestedOf(doc.id)}
            notSorted={notSortedOf(doc.id)}
            sortFailed={sortFailedOf(doc.id)}
            match={matches?.get(doc.id) ?? null}
            path={narrowing ? pathOf(doc.id) : null}
          />
        ))}
      {open && !narrowing && shown.length < documents.length && (
        <div
          className="flex min-h-8 items-center border-b border-rule"
          style={{ paddingLeft: indent + 20 }}
        >
          <button
            type="button"
            data-testid="library-subfolder-show-all"
            onClick={() => useLibraryFolds.getState().showAll(folder.id)}
            className={quietButtonClass}
          >
            {t("library.showAll", { count: formatCount(documents.length, language) })}
          </button>
        </div>
      )}
    </>
  );
}

/** ← folds a section and → opens it, as in the sidebar's tree. */
function foldKeys(key: string, open: boolean) {
  return (event: KeyboardEvent) => {
    if ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open)) {
      event.preventDefault();
      useLibraryFolds.getState().toggle(key);
    }
  };
}

/**
 * A Folder's head: its name, which folds the section and renames in place
 * (double-click or F2), how many it holds and, pointed at, its ⋯, with its
 * description as the head's tooltip and in Get info. Edit description… opens
 * the Folder's form under it.
 */
function FolderHead({
  folder,
  count,
  inSubfolders,
  open,
}: {
  folder: LibraryGroup;
  /** How many Documents it holds, its sub-Folders included. */
  count: number;
  /** How many of those are in its sub-Folders. */
  inSubfolders: number;
  open: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const toggle = () => useLibraryFolds.getState().toggle(folder.id);
  // The first click of a double-click folds or unfolds it: back as it was before renaming.
  const rename = useRename<HTMLButtonElement>(`library-folder:${folder.id}`, toggle);
  const objectMenu = useObjectMenu({ kind: "folder", id: folder.id });
  const [editing, setEditing] = useState(false);
  const editFolder = useRequests((state) => state.editFolder);
  useEffect(() => {
    if (editFolder !== folder.id) return;
    setEditing(true);
    useLibraryFolds.getState().setOpen(folder.id, true);
    useRequests.getState().clear("editFolder");
  }, [editFolder, folder.id]);
  const arrows = foldKeys(folder.id, open);
  const drop = useDropTarget(
    `library-folder:${folder.id}`,
    folderTarget(folder.id),
    open ? undefined : () => useLibraryFolds.getState().setOpen(folder.id, true),
  );
  const dragSource = useDragSource(() => (rename.renaming ? null : folderDrag(folder, "library")));
  let name: ReactNode;
  if (rename.renaming) {
    name = (
      <InlineName
        value={folder.name}
        label={t("folder.renameLabel", { name: folder.name })}
        testId="library-section-rename"
        className="h-7 w-full max-w-80 min-w-0 rounded-sm border border-accent bg-sheet px-1.5 text-[15px] font-semibold text-ink outline-1 outline-offset-0 outline-accent select-text"
        {...rename.field((next) => useAppStore.getState().renameFolder(folder.id, next))}
      />
    );
  } else {
    name = (
      <button
        {...rename.nameProps}
        type="button"
        {...TREE_ROW}
        data-testid="library-section-name"
        aria-expanded={open}
        title={folder.description ? `${folder.name}\n${folder.description}` : folder.name}
        onClick={(event) => {
          // The second click of a double-click renames instead.
          if (event.detail <= 1) toggle();
        }}
        onKeyDown={(event) => {
          rename.nameProps.onKeyDown(event);
          arrows(event);
          if (isMoveToKey(event)) {
            event.preventDefault();
            useSidebarMove
              .getState()
              .show(
                event.currentTarget
                  .closest<HTMLElement>('[role="row"]')
                  ?.querySelector<HTMLElement>("[data-object-menu]") ?? null,
                { kind: "folder", id: folder.id },
              );
          }
        }}
        className={sectionNameClass}
      >
        {folder.name}
      </button>
    );
  }
  return (
    <>
      <SectionHead
        label={folder.name}
        open={open}
        onToggle={toggle}
        icon={<FolderLineIcon className="size-4" />}
        name={name}
        count={count}
        after={
          inSubfolders > 0 && (
            <span
              data-testid="library-section-subfolders"
              className="shrink-0 text-[12px] tabular-nums text-ink-meta"
            >
              · {t("library.inSubfolders", { count: formatCount(inSubfolders, language) })}
            </span>
          )
        }
        tip={folder.description}
        testId="library-section-head"
        rowProps={rename.renaming ? {} : { ...objectMenu.rowProps, ...dragSource }}
        drop={drop}
        end={
          !rename.renaming && (
            <>
              {folder.keepInside === true && (
                <span
                  data-testid="folder-wall"
                  role="img"
                  aria-label={t("folder.wall.title")}
                  title={t("folder.wall.title")}
                  className="flex shrink-0"
                >
                  <LockLineIcon className="size-4 text-ink-meta" />
                </span>
              )}
              <ObjectMenu
                target={{ kind: "folder", id: folder.id }}
                label={t("folder.more", { name: folder.name })}
                here={{
                  "folder.rename": rename.start,
                  "folder.moveTo": () =>
                    requestAnimationFrame(() =>
                      useSidebarMove
                        .getState()
                        .show(
                          document.querySelector<HTMLElement>(
                            `[data-object-menu="folder:${CSS.escape(folder.id)}"]`,
                          ),
                          { kind: "folder", id: folder.id },
                        ),
                    ),
                }}
                className={`${rowActionButtonClass} opacity-0 group-hover/head:opacity-100 group-has-[:focus-visible]/head:opacity-100 aria-expanded:opacity-100`}
              />
            </>
          )
        }
      />
      {editing && (
        <FolderForm group={folder} close={() => setEditing(false)} className="mt-3 mb-4 ml-14" />
      )}
    </>
  );
}

/**
 * Not in a Folder's head: how many are in no Folder and, at its end, Organize,
 * which suggests a Folder for each, or how it is going, or what went wrong.
 */
function LooseHead({ documents, open }: { documents: readonly Document[]; open: boolean }) {
  const t = useT();
  const label = t("library.unsorted");
  const toggle = () => useLibraryFolds.getState().toggle(NOT_IN_A_FOLDER);
  const drop = useDropTarget(
    "library-folder:none",
    folderTarget(null),
    open ? undefined : () => useLibraryFolds.getState().setOpen(NOT_IN_A_FOLDER, true),
  );
  return (
    <SectionHead
      label={label}
      open={open}
      onToggle={toggle}
      icon={<FolderLineIcon className="size-4 opacity-60" />}
      name={
        <button
          type="button"
          {...TREE_ROW}
          data-testid="library-section-name"
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={foldKeys(NOT_IN_A_FOLDER, open)}
          className={sectionNameClass}
        >
          {label}
        </button>
      }
      count={documents.length}
      testId="library-section-head"
      end={<Organize documents={documents} />}
      drop={drop}
    />
  );
}

const organizeHasModel = (settings: LibrarySettings | undefined) =>
  !!settings && organizeModelOf(settings) !== null;

/**
 * Organize, for the Documents in no Folder, Folders or none (#2308), or how it is going, or what
 * it couldn't do, with one action.
 */
function Organize({ documents }: { documents: readonly Document[] }) {
  const t = useT();
  const all = useAppStore((state) => state.documents);
  const library = useAppStore((state) => state.library);
  const proposing = useProposing((state) => state.proposing);
  const states = useMemo(() => {
    const held = new Map((library?.assignments ?? []).map((item) => [item.documentId, item]));
    return all.map((doc) => organizeStateOf(doc, held.get(doc.id)));
  }, [all, library]);
  const pending = states.filter((state) => state.run === "working").length;
  const failed = useMemo(() => organizeFailedIds(all, library?.assignments ?? []), [all, library]);
  const run = (ids: readonly string[]) => {
    organizeDocuments(ids).catch(useAppStore.getState().reportError);
  };
  if (proposing || pending > 0) {
    return (
      <span
        role="status"
        data-testid="library-organizing"
        className="shrink-0 text-[13px] text-ink-meta"
      >
        {proposing ? t("library.organize.reading") : t("library.organizing", { count: pending })}
      </span>
    );
  }
  if (failed.size > 0) {
    const retry = () => run([...failed]);
    return (
      <span
        role="alert"
        data-testid="library-organize-failed"
        className="min-w-0 truncate text-[13px] text-ink-meta"
      >
        {t(failed.size === 1 ? "library.organize.failed.one" : "library.organize.failed", {
          count: failed.size,
        })}
        <span aria-hidden="true"> · </span>
        <button type="button" onClick={retry} className={quietButtonClass}>
          {t("library.organize.retry")}
        </button>
      </span>
    );
  }
  if (documents.length === 0) return null;
  return (
    <button
      type="button"
      data-testid="library-organize"
      title={t("library.organize.explain")}
      onClick={() => run(documents.map((doc) => doc.id))}
      className={quietButtonClass}
    >
      {t("library.classify")}
    </button>
  );
}

/**
 * Organize with no model chosen (#763): a row under Not in a Folder's head says so where it was
 * asked. With no AI model at all, first run's key field is offered in place (#1922); once one
 * works, the model Automatic sorts with, saying what would go to its company. The answer is
 * kept, so Organize asks once.
 */
function OrganizeNeedsModel() {
  const t = useT();
  const language = useLanguage();
  const ids = useOrganizeAsk((state) => state.ids);
  const hasModel = useAppStore((state) => organizeHasModel(state.library?.settings));
  // Only "no provider at all" is what first run's key field answers; every other reason has its own line.
  const noProvider = useAppStore(
    (state) => state.chatReadiness?.ready === false && state.chatReadiness.reason === "no-provider",
  );
  const [automatic, setAutomatic] = useState<TaggingModelOption | null>(null);
  const asked = ids !== null && !hasModel;
  useEffect(() => {
    if (!asked || noProvider) return;
    let current = true;
    const load = () =>
      core.getTaggingModels().then(
        (models) => {
          if (current) setAutomatic(models.automatic);
        },
        (error: unknown) => console.error("Organize couldn't work out the model to offer.", error),
      );
    load();
    const stop = core.on("chatReadiness.changed", () => void load());
    return () => {
      current = false;
      stop();
    };
  }, [asked, noProvider]);
  if (!asked) return null;
  const close = () => useOrganizeAsk.getState().close();
  const use = async (classifier: TaggingClassifier) => {
    const settings = useAppStore.getState().library?.settings;
    if (!settings || ids === null) return;
    // Saving the model sets the waiting Documents going, so what Undo goes back to is read first.
    const undoing = new Map(
      (useAppStore.getState().library?.assignments ?? [])
        .filter((item) => ids.includes(item.documentId))
        .map((item) => [item.documentId, item]),
    );
    try {
      await core.saveLibrarySettings({ ...settings, organizeWith: classifier });
      await useAppStore.getState().refreshLibrary();
      close();
      await organizeDocuments(ids, undoing);
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  };
  const dismiss = (
    <button
      type="button"
      data-testid="library-organize-dismiss"
      onClick={close}
      className={`self-start ${quietButtonClass}`}
    >
      {t("library.organize.dismiss")}
    </button>
  );
  if (noProvider) {
    return (
      <div
        role="status"
        data-testid="library-organize-needs-model"
        className="flex flex-col gap-1 border-b border-rule py-2 pl-14 text-[13px] leading-5 text-ink-meta"
      >
        <NeedsModelCard
          line="needsModel.organize"
          testId="library-organize-key"
          onDone={() => {
            // The key saved, Organize goes on with the model it now reaches (#1922).
            void core.getTaggingModels().then(
              (models) => models.automatic && use(models.automatic.classifier),
              (error: unknown) => useAppStore.getState().reportError(error),
            );
          }}
        />
        {dismiss}
      </div>
    );
  }
  const company = automatic && (providerOf(automatic, language) ?? t("providers.kind.ollama"));
  return (
    <div
      role="status"
      data-testid="library-organize-needs-model"
      className="flex flex-col gap-0.5 border-b border-rule py-2 pl-14 text-[13px] leading-5 text-ink-meta"
    >
      <p>{t("library.organize.needsModel")}</p>
      {automatic && automatic.group !== "local" && company && (
        <DetailsLine
          testId="library-organize-sends"
          details={t("library.organize.sends.details", { company })}
        >
          {t("library.organize.sends", { company })}
        </DetailsLine>
      )}
      <p className="flex flex-wrap gap-x-4">
        {automatic && company && (
          <button
            type="button"
            data-testid="library-organize-use"
            onClick={() => void use(automatic.classifier)}
            className={quietButtonClass}
          >
            {t("library.organize.use", { company })}
          </button>
        )}
        <button
          type="button"
          data-testid="library-organize-set-up"
          onClick={() => {
            close();
            useAppStore.getState().openSettings("models", "tagging");
          }}
          className={quietButtonClass}
        >
          {t("library.organize.setUp")}
        </button>
        {dismiss}
      </p>
    </div>
  );
}
