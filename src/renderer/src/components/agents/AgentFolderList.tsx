import { useMemo } from "react";
import { type AgentFolderRow, agentFolderRows, onlyNotInAFolder } from "../../agentFolders";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import { isListedDocument } from "../../meetingTranscript";
import { useAppStore } from "../../store";
import { FolderLineIcon } from "../lineIcons";

/** What an agent may be allowed to read now: the Folders, then Not in a Folder (see `agentFolderRows`). */
export function useAgentFolderRows(enabled = true, keepUnfiled = false): AgentFolderRow[] {
  const folders = useAppStore((state) => state.library?.groups);
  const assignments = useAppStore((state) => state.library?.assignments);
  const documents = useAppStore((state) => state.documents);
  return useMemo(
    () =>
      enabled ? agentFolderRows(folders ?? [], documents, assignments ?? [], keepUnfiled) : [],
    [enabled, folders, assignments, documents, keepUnfiled],
  );
}

/**
 * The choices of what an agent may read, ticked in place: each Folder with its
 * Documents, Not in a Folder last. With no Document at all, Not in a Folder is
 * the one choice: the Documents the User adds there next (#3364).
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
  const anyDocument = useAppStore((state) => state.documents.some(isListedDocument));

  return (
    <>
      <div
        data-testid="agent-folder-list"
        className="mt-1 flex max-h-48 flex-col overflow-y-auto rounded-lg border border-rule [&>*+*]:border-t [&>*+*]:border-rule"
      >
        {rows.map((row) => {
          const name = row.name ?? t("library.unsorted");
          return (
            <label
              key={row.id}
              data-testid="agent-folder-row"
              className="flex min-h-[34px] shrink-0 cursor-pointer items-center gap-2.5 px-3 text-[13px] leading-5 text-ink"
            >
              <input
                type="checkbox"
                data-testid="agent-folder"
                data-folder={row.id}
                checked={chosen.has(row.id)}
                onChange={(event) => onToggle(row.id, event.target.checked)}
                className="size-4 shrink-0 accent-ink"
              />
              <FolderLineIcon
                className={`size-3.5 shrink-0 ${row.name === null ? "opacity-60" : ""}`}
              />
              <span className="min-w-0 flex-1 truncate" title={name}>
                {name}
              </span>
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
