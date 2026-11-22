import { type ReactNode, useEffect, useState } from "react";
import {
  type AgentClient,
  type AgentSetupPreview,
  ALL_SHARED_ID,
  NOT_IN_A_FOLDER_ID,
  type SecretStorageStatus,
} from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { agentConnector } from "../../agentConnection";
import { leftOutOfAll, onlyNotInAFolder } from "../../agentFolders";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { ProblemMark } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { SLOT, Slotted } from "../Slotted";
import { dialogTextClass, errorTextClass, fieldLabelClass, hintClass, inputClass } from "../ui";
import { useAgentFolderRows } from "./AgentFolderList";
import type { JustSetUp } from "./AgentPairingRow";
import { AgentShareChoice } from "./AgentShareChoice";
import { ProposeChoice } from "./ProposeChoice";

const ALL_UNFILED: ReadonlySet<string> = new Set([NOT_IN_A_FOLDER_ID]);
/** The first line while the User has a Folder, by the Folders all leaves out (`leftOutOfAll`). */
const READS_WITH = {
  none: "agents.connect.reads",
  projects: "agents.connect.reads.projects",
  walled: "agents.connect.reads.walled",
} as const;
const NOTHING: ReadonlySet<string> = new Set();

/** What the User chose before they allow: the Folders, Other agent's name, and whether it may write. */
export interface AgentChoice {
  folderIds: string[];
  name: string;
  propose: boolean;
}

const connectAgent = agentConnector(core, (error) => {
  console.error("Couldn't turn connecting agents off again after a failed setup", error);
  useAppStore.getState().reportError(error);
});

/** Connecting an agent (#351), in Settings › AI and the setup's Your AI step (#3362). */
export function useAgentConnection() {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const connect = async (
    client: AgentClient,
    choice: AgentChoice,
    options: { enable?: boolean } = {},
  ): Promise<JustSetUp | null> => {
    setBusy(true);
    setProblem(null);
    try {
      const { pairing, result } = await connectAgent(
        {
          client: client.id,
          folderIds: choice.folderIds,
          ...(choice.name && { name: choice.name }),
          propose: choice.propose,
        },
        options,
      );
      // The agent is connected either way: "Copy settings" in its details copies it again.
      if (result.kind === "copy")
        await navigator.clipboard.writeText(result.text).catch(reportError);
      return { pairingId: pairing.id, result };
    } catch (error) {
      setProblem(errorMessage(error, t));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, problem, connect, clearProblem: () => setProblem(null) };
}

/**
 * What the User reads and chooses before an agent is connected (#351), which is also their
 * consent to its data flow, in three lines (#3487): what it may read, with where that goes (its
 * own AI model), whether it may write notes (#352), and that it can be disconnected at any time.
 * Under Details: what else it can read and what is sent, what a write allows, and, for an agent
 * whose settings file IncarnaMind writes, exactly what it adds there. What it reads is all of the
 * User's Documents and Notes, those added later too, until they choose Folders instead (#3544),
 * which is no choice while they have no Folder; the walled Folders all leaves out are said in the
 * first line. The same lines in the connect dialog and in the setup's step (#3362); `actions`
 * draws the press that allows.
 */
export function ConnectAgentFields({
  client,
  problem,
  writes = false,
  actions,
}: {
  client: AgentClient;
  /** Why the last try to connect failed, shown here, where it happened. */
  problem: string | null;
  /** Whether "may write notes" starts ticked. */
  writes?: boolean;
  actions(allow: { choice: AgentChoice; disabled: boolean }): ReactNode;
}) {
  const t = useT();
  const [all, setAll] = useState(true);
  /** What the User has ticked; null until they tick or untick something. */
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const rows = useAgentFolderRows(true);
  const leftOut = leftOutOfAll(useAppStore((state) => state.library?.groups) ?? []);
  /** The name the User gives "Other agent". */
  const [name, setName] = useState("");
  const [propose, setPropose] = useState(writes);
  const [preview, setPreview] = useState<AgentSetupPreview | null>(null);
  /** Where the agent's key can be kept: with no keyring (Linux), only once the User allows plain text. */
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const reportError = useAppStore((state) => state.reportError);

  // A new agent starts with all of it, and its own preview.
  useEffect(() => {
    setAll(true);
    setPicked(null);
    setName("");
    setPropose(writes);
    setPreview(null);
    let current = true;
    core.previewAgentSetup(client.id).then((value) => {
      if (current) setPreview(value);
    }, reportError);
    core.getSecretStorage().then((value) => {
      if (current) setStorage(value);
    }, reportError);
    return () => {
      current = false;
    };
  }, [client.id, writes, reportError]);
  const canKeepKey = storage?.canSave !== false;

  const agent = name.trim() || clientInSentence(client, t);
  const anyFolder = rows.some((row) => row.id !== NOT_IN_A_FOLDER_ID);
  const shared = all || !anyFolder;
  const chosen = picked ?? (onlyNotInAFolder(rows) ? ALL_UNFILED : NOTHING);
  const toggle = (folderId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(folderId);
    else next.delete(folderId);
    setPicked(next);
  };
  const allowed = shared
    ? [ALL_SHARED_ID]
    : rows.filter((row) => chosen.has(row.id)).map((row) => row.id);

  return (
    <>
      <p data-testid="connect-agent-reads" className={dialogTextClass}>
        {t(!anyFolder ? "agents.connect.reads.all" : READS_WITH[leftOut], { agent })}
      </p>
      {client.id === "claude-code" && (
        <p data-testid="connect-agent-background" className={dialogTextClass}>
          {t("agents.connect.background", { agent })}
        </p>
      )}
      {client.id === "other" && (
        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>{t("agents.connect.name")}</span>
          <input
            type="text"
            data-testid="connect-agent-name"
            value={name}
            placeholder={t("agents.connect.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </label>
      )}
      {anyFolder && (
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="sr-only">{t("agents.connect.folders")}</legend>
          <AgentShareChoice
            all={all}
            onAll={setAll}
            rows={rows}
            chosen={chosen}
            onToggle={toggle}
          />
        </fieldset>
      )}
      <ProposeChoice checked={propose} onChange={setPropose} hint={false} noFolders={shared} />
      <p data-testid="connect-agent-disconnect" className={dialogTextClass}>
        {t("agents.connect.disconnect")}
      </p>
      <details data-testid="connect-agent-details" className="flex flex-col">
        <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
          {t("agents.connect.details")}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className={dialogTextClass}>{t("agents.connect.body", { agent })}</p>
          <p className={dialogTextClass}>{t("agents.propose.hint")}</p>
          {preview && (
            <div data-testid="connect-agent-change" className="flex flex-col gap-1">
              <p className={dialogTextClass}>
                <Slotted
                  message={t("agents.connect.fileChange", { path: SLOT })}
                  slot={<InlinePath path={preview.path} />}
                />
              </p>
              <details data-testid="connect-agent-change-lines">
                <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
                  {t("agents.connect.showChange")}
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
                  {preview.change}
                </pre>
              </details>
              {preview.backup && (
                <p data-testid="connect-agent-backup" className={dialogTextClass}>
                  <Slotted
                    message={t("agents.connect.backup", { path: SLOT })}
                    slot={<InlinePath path={preview.backup} />}
                  />
                </p>
              )}
            </div>
          )}
          {client.skillPath && (
            <p data-testid="connect-agent-skill" className={dialogTextClass}>
              <Slotted
                message={t("agents.connect.skill", { path: SLOT, agent })}
                slot={<InlinePath path={client.skillPath} />}
              />
            </p>
          )}
        </div>
      </details>
      {allowed.length === 0 && <p className={hintClass}>{t("agents.connect.pickOne")}</p>}
      {storage && !storage.canSave && (
        <SecretStorageNotice
          status={storage}
          onAccept={() => core.acceptPlainTextSecretStorage().then(setStorage, reportError)}
        />
      )}
      {problem && (
        <p data-testid="connect-agent-problem" role="alert" className={errorTextClass}>
          <ProblemMark />
          {problem}
        </p>
      )}
      {actions({
        choice: { folderIds: allowed, name, propose },
        disabled: allowed.length === 0 || !canKeepKey,
      })}
    </>
  );
}
