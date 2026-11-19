import { type ReactNode, useEffect, useState } from "react";
import {
  type AgentClient,
  type AgentSetupPreview,
  NOT_IN_A_FOLDER_ID,
  type SecretStorageStatus,
} from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { agentConnector } from "../../agentConnection";
import { onlyNotInAFolder } from "../../agentFolders";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { ProblemMark } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { SLOT, Slotted } from "../Slotted";
import { dialogTextClass, errorTextClass, fieldLabelClass, hintClass, inputClass } from "../ui";
import { AgentFolderList, useAgentFolderRows } from "./AgentFolderList";
import type { JustSetUp } from "./AgentPairingRow";
import { ProposeChoice } from "./ProposeChoice";

const ALL_UNFILED: ReadonlySet<string> = new Set([NOT_IN_A_FOLDER_ID]);
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

/** Connecting an agent (#351), in Settings › Agents and the setup's Your AI step (#3362). */
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
 * consent to its data flow: what it will be able to read, where that goes (its own AI model, under
 * its service's terms, which may train on it), the Folders it may read (none chosen until the User
 * picks, unless Not in a Folder is the one choice), whether it may write notes (#352), and, for an
 * agent whose settings file IncarnaMind writes, exactly what it adds there. The same lines in the
 * connect dialog and in the setup's step (#3362); `actions` draws the press that allows.
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
  /** What the User has ticked; null until they tick or untick something. */
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const rows = useAgentFolderRows(true);
  /** The name the User gives "Other agent". */
  const [name, setName] = useState("");
  const [propose, setPropose] = useState(writes);
  const [preview, setPreview] = useState<AgentSetupPreview | null>(null);
  /** Where the agent's key can be kept: with no keyring (Linux), only once the User allows plain text. */
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const reportError = useAppStore((state) => state.reportError);

  // A new agent starts with nothing picked, and its own preview.
  useEffect(() => {
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
  // Not in a Folder alone is ticked: it is every Document, so there is nothing else to choose.
  const chosen = picked ?? (onlyNotInAFolder(rows) ? ALL_UNFILED : NOTHING);
  const toggle = (folderId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(folderId);
    else next.delete(folderId);
    setPicked(next);
  };
  const allowed = rows.filter((row) => chosen.has(row.id)).map((row) => row.id);

  return (
    <>
      <p className={dialogTextClass}>{t("agents.connect.body", { agent })}</p>
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
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className={fieldLabelClass}>{t("agents.connect.folders")}</legend>
        <AgentFolderList rows={rows} chosen={chosen} onToggle={toggle} />
      </fieldset>
      <ProposeChoice checked={propose} onChange={setPropose} />
      {preview && (
        <div data-testid="connect-agent-change" className="flex flex-col gap-1">
          <p className={dialogTextClass}>
            <Slotted
              message={t("agents.connect.fileChange", { path: SLOT })}
              slot={<InlinePath path={preview.path} />}
            />
          </p>
          <details>
            <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
              {t("agents.connect.showChange")}
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
              {preview.change}
            </pre>
          </details>
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
      {rows.length > 0 && allowed.length === 0 && (
        <p className={hintClass}>{t("agents.connect.pickOne")}</p>
      )}
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
