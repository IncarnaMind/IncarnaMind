import { useMemo } from "react";
import { type AgentFolderRow, agentFolderRows, onlyNotInAFolder } from "../../agentFolders";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import { isListedDocument } from "../../meetingTranscript";
import { useAppStore } from "../../store";
import { FolderLineIcon, PlusLineIcon } from "../lineIcons";
import { buttonStyle } from "../ui";

/** What an agent may be allowed to read now: the Folders, then Not in a Folder while it holds a Document. */
export function useAgentFolderRows(enabled = true): AgentFolderRow[] {
  const folders = useAppStore((state) => state.library?.groups);
  const assignments = useAppStore((state) => state.library?.assignments);
  const documents = useAppStore((state) => state.documents);
  return useMemo(
    () => (enabled ? agentFolderRows(folders ?? [], documents, assignments ?? []) : []),
    [enabled, folders, assignments, documents],
  );
}

/**
 * The choices of what an agent may read, ticked in place: each Folder with its
 * Documents, Not in a Folder last. With no Document at all there is nothing to
 * choose, so the list's place offers Add Documents…, the Library's own action.
 * The same list is in the connect dialog and in a connected agent's Folders….
 */
export function AgentFolderList({
  rows,
  agent,
  chosen,
  onToggle,
}: {
  rows: readonly AgentFolderRow[];
  /** The agent, as a sentence names it. */
  agent: string;
  chosen: ReadonlySet<string>;
  onToggle(id: string, on: boolean): void;
}) {
  const t = useT();
  const language = useLanguage();
  const picking = useAppStore((state) => state.pickingDocuments);
  const anyDocument = useAppStore((state) => state.documents.some(isListedDocument));

  if (!anyDocument) {
    return (
      <div
        data-testid="agent-folders-empty"
        className="mt-1 flex flex-col items-start gap-1.5 rounded-lg border border-dashed border-rule-strong px-4 py-[18px]"
      >
        <p className="text-ui font-semibold text-ink">{t("agents.connect.empty.title")}</p>
        <p className="text-[13px] leading-[18px] text-ink-meta">
          {t("agents.connect.empty.body", { agent })}
        </p>
        <button
          type="button"
          data-testid="agent-add-documents"
          disabled={picking}
          onClick={() => void useAppStore.getState().pickDocuments()}
          className={`${buttonStyle("secondary", "sm")} mt-1.5`}
        >
          <PlusLineIcon className="size-4" />
          {t("sidebar.plus.addDocuments")}
        </button>
      </div>
    );
  }

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
          {t("agents.connect.allUnfiled")}
        </p>
      )}
    </>
  );
}
