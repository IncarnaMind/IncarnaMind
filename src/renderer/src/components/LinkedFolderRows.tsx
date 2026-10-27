import { useEffect, useMemo } from "react";
import type { LinkedFolder } from "../../../core/api";
import { buildFolderTree } from "../folders";
import { useLanguage, useT } from "../i18n";
import { sourceRequest } from "../libraryPage";
import { indexingShare, linkedFolderRowState, rowStateLabel } from "../linkedFolders";
import { showOutputLocationSetting, useLinkedFolderWriting } from "../outputFiles";
import { useRequests } from "../requests";
import { sorted } from "../sort";
import { useSort } from "../sortChoices";
import { folderFields } from "../sortFields";
import { allExamples, useAppStore } from "../store";
import { useTreeItem } from "../treeKeys";
import { ExampleChip } from "./GettingStarted";
import { LinkLineIcon } from "./lineIcons";
import { ObjectMenu, useObjectMenu } from "./ObjectMenu";
import {
  clearsActions,
  rowActionsClass,
  rowButtonClass,
  rowClass,
  rowIconClass,
  rowPadding,
} from "./sidebarRows";

/** As long as the wash's animation lasts (`[data-just-linked]` in styles.css). */
const LINKED_WASH_MS = 1600;

/**
 * The sidebar's Linked folders (ADR-0010): a row each, with its state. A row
 * doesn't unfold, since its files already sit in the Folders and Not in a
 * Folder; it opens the Library on its Documents (its Source location, #1507),
 * where they are shown as on disk once #1250 adds Source locations.
 */
export function LinkedFolderRows({ hideExamples = false }: { hideExamples?: boolean }) {
  const folders = useAppStore((state) => state.folders);
  const linkedFolders = useAppStore((state) => state.linkedFolders);
  const writing = useLinkedFolderWriting();
  const documents = useAppStore((state) => state.documents);
  const exampleIds = useAppStore((state) =>
    allExamples(state)
      .flatMap((each) => (each.linkedFolderId ? [each.linkedFolderId] : []))
      .join(" "),
  );
  const filled = useMemo(() => new Set(documents.map((each) => each.linkedFolderId)), [documents]);
  const examples = useMemo(
    () => new Set(hideExamples ? exampleIds.split(" ").filter(Boolean) : []),
    [hideExamples, exampleIds],
  );
  const language = useLanguage();
  const sidebarSort = useSort((state) => state.scopes.sidebar ?? state.all);
  const roots = useMemo(
    () =>
      sorted(
        buildFolderTree(folders).filter(
          (node) =>
            node.folder.parentId === null && !examples.has(node.folder.linkedFolderId ?? ""),
        ),
        sidebarSort,
        (node) => folderFields(node.folder),
        language,
      ),
    [folders, sidebarSort, language, examples],
  );
  const linkedById = new Map(linkedFolders.map((linked) => [linked.id, linked]));
  return (
    <ul role="none" data-testid="linked-folder-rows">
      {roots.map(({ folder }) => {
        const linked = linkedById.get(folder.linkedFolderId);
        return linked ? (
          <LinkedFolderRow
            key={folder.id}
            // No answer yet for this folder is read-only; an unread or failed read says so, not read-only.
            readOnly={!writing.reading && !writing.problem && writing.allowed[linked.id] !== true}
            unchecked={writing.problem}
            linked={linked}
            folderId={folder.id}
            name={folder.name}
            hasContents={filled.has(linked.id)}
          />
        ) : null;
      })}
    </ul>
  );
}

function LinkedFolderRow({
  linked,
  folderId,
  name,
  hasContents,
  readOnly,
  unchecked,
}: {
  linked: LinkedFolder;
  folderId: string;
  name: string;
  hasContents: boolean;
  /** The User hasn't allowed IncarnaMind to add files here, so its row says read-only (#1942). */
  readOnly: boolean;
  /** That answer couldn't be read: the row says so, and opens where it is given. */
  unchecked: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const state = linkedFolderRowState(linked, hasContents);
  const status = rowStateLabel(state, t, language);
  const progress = indexingShare(state);
  const object = { kind: "linkedFolder", id: linked.id } as const;
  const objectMenu = useObjectMenu(object);
  const treeItem = useTreeItem({ depth: 0 });
  const isExample = useAppStore((current) =>
    allExamples(current).some((each) => each.linkedFolderId === linked.id),
  );
  const justLinked = useRequests((current) => current.showLinked === linked.id);
  // Its row, once it shows: in sight, washed for a moment, then as any other (#763).
  useEffect(() => {
    if (!justLinked) return;
    document
      .querySelector(`[data-linked-folder-id="${linked.id}"][data-root]`)
      ?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => useRequests.getState().clear("showLinked"), LINKED_WASH_MS);
    return () => clearTimeout(timer);
  }, [justLinked, linked.id]);

  return (
    <li role="none">
      <div
        data-testid="folder-item"
        data-depth={0}
        data-folder-id={folderId}
        data-linked-folder-id={linked.id}
        data-root="true"
        data-state={state.kind}
        data-status={linked.status}
        {...(justLinked && { "data-just-linked": "true" })}
        {...objectMenu.rowProps}
        className={`${rowClass(false, state.kind === "unavailable" ? "muted" : "item")} @container`}
      >
        <button
          type="button"
          {...treeItem}
          data-testid="linked-folder-open"
          title={linked.path}
          onClick={(event) =>
            useAppStore
              .getState()
              .openLibrary(sourceRequest(linked.id), { side: event.metaKey || event.ctrlKey })
          }
          className={`${rowButtonClass} ${clearsActions.menu}`}
          style={rowPadding(0)}
        >
          <LinkLineIcon className={rowIconClass(false)} />
          <span data-testid="row-text" className="min-w-12 flex-1 truncate">
            {name}
          </span>
          {!status && isExample && <ExampleChip />}
          {!status && !isExample && readOnly && (
            <span
              data-testid="linked-folder-read-only"
              title={t("linkedFolders.readOnly.full")}
              className="shrink-0 text-label font-semibold text-ink-meta"
            >
              {t("linkedFolders.readOnly")}
            </span>
          )}
          {status && (
            <span
              data-testid="folder-status"
              data-state={state.kind}
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
          )}
        </button>
        {!status && !isExample && unchecked && (
          // Not read-only, only unknown: saying where the answer lives is the honest line (#1942).
          // Beside the row's button, never in it: one control inside another runs both on one click.
          // Its 33px keep it clear of the row's actions, which take that room when the row is pointed at.
          <button
            type="button"
            data-testid="linked-folder-writing-unchecked"
            title={t("linkedFolders.readOnly.unchecked.title")}
            onClick={showOutputLocationSetting}
            tabIndex={-1}
            className="mr-[33px] shrink-0 rounded-sm text-label font-semibold text-ink-meta hover:text-ink hover:underline"
          >
            {t("linkedFolders.readOnly.unchecked")}
          </button>
        )}
        {progress !== null && (
          <span
            aria-hidden="true"
            data-testid="folder-progress"
            className="pointer-events-none absolute right-2 bottom-0.5 left-8 h-0.5 overflow-hidden rounded-full bg-rule"
          >
            <span
              className={`block h-full rounded-full transition-[width] duration-180 ease-in-out motion-reduce:transition-none ${
                state.kind === "paused" ? "bg-ink-placeholder" : "bg-accent"
              }`}
              style={{ width: `${Math.round(progress * 1000) / 10}%` }}
            />
          </span>
        )}
        <div className={rowActionsClass}>
          <ObjectMenu target={object} label={t("linkedFolders.more", { name })} tabIndex={-1} />
        </div>
      </div>
    </li>
  );
}
