import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { LinkedFolder } from "../../../core/api";
import { exampleLinkedIds, unboundLinkedFolders } from "../boundFolders";
import { sidebarHandle } from "../commands/handles";
import { useLanguage, useT } from "../i18n";
import { sourceRequest } from "../libraryPage";
import { folderName, indexingShare, linkedFolderRowState, rowStateLabel } from "../linkedFolders";
import { isListedDocument } from "../meetingTranscript";
import { useRequests } from "../requests";
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
 * The User's Linked folders filed as no Folder (#3613), each a row in the one list of Folders: a
 * Linked folder is a Folder bound to it until the User turns that off from its menu. A row
 * doesn't unfold; it opens the Library on its Documents (its Source location, #1507).
 */
export function UnboundLinkedFolderRows() {
  const exampleIds = useAppStore(exampleLinkedIds);
  const rows = useAppStore(
    useShallow((state) => unboundLinkedFolders(state, new Set(exampleIds.split(" ")))),
  );
  const folders = useAppStore((state) => state.folders);
  const documents = useAppStore((state) => state.documents);
  const filled = useMemo(
    () => new Set(documents.filter(isListedDocument).map((each) => each.linkedFolderId)),
    [documents],
  );
  if (rows.length === 0) return null;
  return (
    <ul role="none" data-testid="linked-folder-rows">
      {rows.map((linked) => (
        <LinkedFolderRow
          key={linked.id}
          linked={linked}
          folderId={linked.folderId}
          name={
            folders.find((each) => each.id === linked.folderId)?.name ?? folderName(linked.path)
          }
          hasContents={filled.has(linked.id)}
        />
      ))}
    </ul>
  );
}

function LinkedFolderRow({
  linked,
  folderId,
  name,
  hasContents,
}: {
  linked: LinkedFolder;
  folderId: string;
  name: string;
  hasContents: boolean;
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
    if (sidebarHandle.current?.hidden) sidebarHandle.current.toggle();
    document
      .querySelector(`[data-linked-folder-id="${linked.id}"][data-root]`)
      ?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => useRequests.getState().clear("showLinked"), LINKED_WASH_MS);
    return () => clearTimeout(timer);
  }, [justLinked, linked.id]);

  return (
    <li role="none" data-testid="linked-folder-row">
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
      {state.kind === "empty" && (
        // Under its row, never in its place: the row says its state, and this says why (#763).
        <p
          role="status"
          data-testid="linked-folder-nothing-to-read"
          className="pr-2 pb-1 pl-8 text-[12px] leading-[18px] text-ink-meta"
        >
          {t("linkedFolders.nothingToRead.notice", { folder: name })}
        </p>
      )}
    </li>
  );
}
