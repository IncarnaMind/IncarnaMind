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
import { useDropTarget } from "../../dragDrop";
import { folderTarget } from "../../folderDrag";
import { useLanguage, useT } from "../../i18n";
import { useLibraryFolds, useRevealed } from "../../libraryFolds";
import {
  FIRST_ROWS,
  NOT_IN_A_FOLDER,
  type SearchMatch,
  type LibrarySection as Section,
} from "../../libraryPage";
import { formatCount } from "../../linkedFolders";
import { organizeFailedIds, organizeStateOf } from "../../organizeOutcome";
import { sayWhenOrganized, useOrganizeAsk } from "../../organizeRun";
import { useRequests } from "../../requests";
import { useAppStore } from "../../store";
import { TREE_ROW } from "../../treeKeys";
import { useRename } from "../../useRename";
import { DetailsLine } from "../DetailsLine";
import { InlineName } from "../InlineName";
import { FolderLineIcon } from "../lineIcons";
import { ObjectMenu, useObjectMenu } from "../ObjectMenu";
import { NeedsModelCard } from "../providers/NeedsModelCard";
import { rowActionButtonClass } from "../sidebarRows";
import { providerOf } from "../TaggingSettings";
import { FolderForm } from "./FolderForm";
import { LibraryRow } from "./LibraryRow";
import { SectionHead, sectionNameClass } from "./SectionHead";

/** A link-like button in a section's head or foot: quiet until pointed at. */
export const quietButtonClass =
  "shrink-0 rounded-sm text-[13px] font-semibold text-ink-secondary hover:text-ink hover:underline disabled:opacity-50 disabled:hover:no-underline";

/**
 * One section of the Library page: a Folder's Documents, or those in no
 * Folder, under a head that folds it and remembers it. A long section lists
 * its first Documents, then "Show all N"; while the page is narrowed it lists
 * every match.
 */
export function LibrarySection({
  section,
  narrowing,
  matches,
  suggestedOf,
  notSortedOf,
  sortFailedOf,
}: {
  section: Section;
  narrowing: boolean;
  /** How each Document matches the search, by its id, while there is one. */
  matches: ReadonlyMap<string, SearchMatch> | null;
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
  const listed = narrowing || showingAll ? documents : documents.slice(0, FIRST_ROWS);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of rows in the page's grid, under its head.
    <div
      ref={element}
      role="rowgroup"
      data-testid="library-section"
      data-section={section.key}
      data-count={documents.length}
      className="mt-[18px] first:mt-2"
    >
      {section.folder ? (
        <FolderHead folder={section.folder} count={documents.length} open={open} />
      ) : (
        <LooseHead documents={documents} open={open} />
      )}
      {!section.folder && <OrganizeNeedsModel />}
      {open &&
        listed.map((doc) => (
          <LibraryRow
            key={doc.id}
            doc={doc}
            suggestedIn={suggestedOf(doc.id)}
            notSorted={notSortedOf(doc.id)}
            sortFailed={sortFailedOf(doc.id)}
            match={matches?.get(doc.id) ?? null}
            path={matches && section.folder ? section.folder.name : null}
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
  open,
}: {
  folder: LibraryGroup;
  count: number;
  open: boolean;
}) {
  const t = useT();
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
        tip={folder.description}
        testId="library-section-head"
        rowProps={rename.renaming ? {} : objectMenu.rowProps}
        drop={drop}
        end={
          !rename.renaming && (
            <ObjectMenu
              target={{ kind: "folder", id: folder.id }}
              label={t("folder.more", { name: folder.name })}
              here={{ "folder.rename": rename.start }}
              className={`${rowActionButtonClass} opacity-0 group-hover/head:opacity-100 group-has-[:focus-visible]/head:opacity-100 aria-expanded:opacity-100`}
            />
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
 * Organize, for the Documents in no Folder (its model is chosen in Settings ›
 * Models until #236 chooses it here), or how it is going, or what it couldn't
 * do, with one action.
 */
function Organize({ documents }: { documents: readonly Document[] }) {
  const t = useT();
  const all = useAppStore((state) => state.documents);
  const library = useAppStore((state) => state.library);
  const hasFolders = (library?.groups.length ?? 0) > 0;
  const hasModel = organizeHasModel(library?.settings);
  const states = useMemo(() => {
    const held = new Map((library?.assignments ?? []).map((item) => [item.documentId, item]));
    return all.map((doc) => organizeStateOf(doc, held.get(doc.id)));
  }, [all, library]);
  const pending = states.filter((state) => state.run === "working").length;
  const failed = useMemo(() => organizeFailedIds(all, library?.assignments ?? []), [all, library]);
  const run = (ids: readonly string[]) => {
    const app = useAppStore.getState();
    if (!hasModel) {
      useOrganizeAsk.getState().ask(ids);
      return;
    }
    const before = new Map(
      (app.library?.assignments ?? [])
        .filter((item) => ids.includes(item.documentId))
        .map((item) => [item.documentId, item]),
    );
    core
      .classifyDocuments([...ids])
      .then(() => app.refreshLibrary())
      .then(() => sayWhenOrganized(ids, before))
      .catch(app.reportError);
  };
  if (pending > 0) {
    return (
      <span
        role="status"
        data-testid="library-organizing"
        className="shrink-0 text-[13px] text-ink-meta"
      >
        {t("library.organizing", { count: pending })}
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
  if (!hasFolders || documents.length === 0) return null;
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
      await core.classifyDocuments([...ids]);
      await useAppStore.getState().refreshLibrary();
      await sayWhenOrganized(ids, undoing);
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
