import { useMemo } from "react";
import { type AgentFolderRow, agentFolderRows, onlyNotInAFolder } from "../../agentFolders";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import { allExamples, isExampleDocument, isOwnDocument, useAppStore } from "../../store";
import { FolderLineIcon, LockLineIcon } from "../lineIcons";

/** What an agent may be allowed to read now: the Folders, then Not in a Folder (see `agentFolderRows`). */
export function useAgentFolderRows(enabled = true, keepUnfiled = false): AgentFolderRow[] {
  const folders = useAppStore((state) => state.library?.groups);
  const assignments = useAppStore((state) => state.library?.assignments);
  const documents = useAppStore((state) => state.documents);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  return useMemo(() => {
    if (!enabled) return [];
    const made = allExamples({ examples, otherExamples });
    return agentFolderRows(folders ?? [], documents, assignments ?? [], keepUnfiled, (document) =>
      isExampleDocument(document, made),
    );
  }, [enabled, folders, assignments, documents, keepUnfiled, examples, otherExamples]);
}

/**
 * The choices of what an agent may read, ticked in place: each Folder under the one it is inside,
 * with the Documents an agent given it reads, Not in a Folder last. With no Document at all, Not
 * in a Folder is the one choice: the Documents the User adds there next (#3364).
 * A ticked Folder shares those inside it (#3394): they show ticked and fixed, saying so, as a
 * choice another one covers does elsewhere, and come back to their own choice once it is
 * unticked. A walled Folder is its own choice, with the lock the sidebar gives it.
 * The same list is in the connect dialog and in a connected agent's Folders….
 */
export function AgentFolderList({
  rows,
  chosen,
  onToggle,
}: {
  rows: readonly AgentFolderRow[];
  chosen: ReadonlySet<string>;
  onToggle(id: string, on: boolean): void;
}) {
  const t = useT();
  const language = useLanguage();
  const anyDocument = useAppStore((state) =>
    state.documents.some((document) => isOwnDocument(document, allExamples(state))),
  );

  return (
    <>
      <div
        data-testid="agent-folder-list"
        className="mt-1 flex max-h-48 flex-col overflow-y-auto rounded-lg border border-rule [&>*+*]:border-t [&>*+*]:border-rule"
      >
        {rows.map((row) => {
          const name = row.name ?? t("library.unsorted");
          const sharer = row.sharedWith.find((id) => chosen.has(id));
          const sharedBy = sharer ? (rows.find((each) => each.id === sharer)?.name ?? "") : null;
          const withWords =
            sharedBy === null ? undefined : t("agents.folders.sharedWith", { folder: sharedBy });
          return (
            <label
              key={row.id}
              data-testid="agent-folder-row"
              data-shared-with={sharer}
              style={{ paddingInlineStart: `${12 + row.depth * 16}px` }}
              className={`flex min-h-[34px] shrink-0 items-center gap-2.5 pr-3 text-[13px] leading-5 text-ink ${sharer ? "cursor-default" : "cursor-pointer"}`}
            >
              <input
                type="checkbox"
                data-testid="agent-folder"
                data-folder={row.id}
                checked={sharer !== undefined || chosen.has(row.id)}
                disabled={sharer !== undefined}
                aria-description={withWords}
                onChange={(event) => onToggle(row.id, event.target.checked)}
                className="size-4 shrink-0 accent-ink"
              />
              <FolderLineIcon
                className={`size-3.5 shrink-0 ${row.name === null ? "opacity-60" : ""}`}
              />
              <span className="min-w-0 flex-1 truncate" title={name}>
                {name}
              </span>
              {row.walled && (
                <span
                  data-testid="agent-folder-wall"
                  role="img"
                  aria-label={t("folder.wall.title")}
                  title={t("folder.wall.title")}
                  className="flex shrink-0"
                >
                  <LockLineIcon className="size-3.5 text-ink-meta" />
                </span>
              )}
              {withWords && (
                <span
                  data-testid="agent-folder-shared-with"
                  className="min-w-0 max-w-[45%] shrink truncate text-[12px] leading-4 text-ink-meta"
                  title={withWords}
                >
                  {withWords}
                </span>
              )}
              <span
                data-testid="agent-folder-count"
                className="shrink-0 text-[12px] leading-4 tabular-nums text-ink-meta"
              >
                {t(row.documents === 1 ? "library.count.one" : "library.count", {
                  count: formatCount(row.documents, language),
                })}
              </span>
            </label>
          );
        })}
      </div>
      {onlyNotInAFolder(rows) && (
        <p
          data-testid="agent-folders-all-unfiled"
          className="mt-1.5 text-[13px] leading-[18px] text-ink-meta"
        >
          {anyDocument ? t("agents.connect.allUnfiled") : t("agents.connect.noneYet")}
        </p>
      )}
    </>
  );
}
