import { type ReactNode, useEffect, useState } from "react";
import type { AgentClient, AgentSetupPreview } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { core } from "../../core";
import { useGap, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { ProblemMark } from "../ProblemLine";
import { SLOT, Slotted } from "../Slotted";
import { dialogTextClass, errorTextClass, fieldLabelClass, hintClass, inputClass } from "../ui";
import type { JustSetUp } from "./AgentPairingRow";
import { AgentShareChoice } from "./AgentShareChoice";
import { setupProblem } from "./agentWords";
import {
  AgentSecretNotice,
  connectAgent,
  FileChangePreview,
  useSecretStorage,
  useShareFolders,
} from "./connectShared";
import { ProposeChoice } from "./ProposeChoice";

/** The first line while the User has a Folder, by the Folders all leaves out (`leftOutOfAll`). */
const READS_WITH = {
  none: "agents.connect.reads",
  walled: "agents.connect.reads.walled",
} as const;

/** What the User chose before they allow: the Folders, Other agent's name, and whether it may write. */
export interface AgentChoice {
  folderIds: string[];
  name: string;
  propose: boolean;
}

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
      setProblem(setupProblem(error, t));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, problem, connect, clearProblem: () => setProblem(null) };
}

/**
 * What the User reads and chooses before an agent is connected (#351), which is also their
 * consent to its data flow, in a few lines (#3487, #3756): what it may read, with where that goes
 * (its own AI model), what IncarnaMind runs on the User's own account in the background, and
 * whether it may write notes (#352), which starts ticked wherever the card is drawn. Under Details:
 * what else it can read and what is sent, what a write allows, how the background run behaves,
 * and, for an agent whose settings file IncarnaMind writes, exactly what it adds there. What it reads is all of the
 * User's Documents and Notes, those added later too, until they choose Folders instead (#3544),
 * which is no choice while they have no Folder; the walled Folders all leaves out are said in the
 * first line. The same lines in the connect dialog and in the setup's step (#3362); `actions`
 * draws the press that allows.
 */
export function ConnectAgentFields({
  client,
  problem,
  actions,
}: {
  client: AgentClient;
  /** Why the last try to connect failed, shown here, where it happened. */
  problem: string | null;
  actions(allow: { choice: AgentChoice; disabled: boolean }): ReactNode;
}) {
  const t = useT();
  const gap = useGap();
  const folders = useShareFolders();
  const { storage, canKeepKey, accept: acceptPlainText } = useSecretStorage(client.id);
  /** The name the User gives "Other agent". */
  const [name, setName] = useState("");
  const [propose, setPropose] = useState(true);
  const [preview, setPreview] = useState<AgentSetupPreview | null>(null);
  const reportError = useAppStore((state) => state.reportError);

  // A new agent starts with all of it, and its own preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset folder choice only when switching client.
  useEffect(() => {
    folders.reset();
    setName("");
    setPropose(true);
    setPreview(null);
    let current = true;
    core.previewAgentSetup(client.id).then((value) => {
      if (current) setPreview(value);
    }, reportError);
    return () => {
      current = false;
    };
  }, [client.id, reportError]);

  const agent = name.trim() || clientInSentence(client, t);
  const { all, setAll, rows, leftOut, anyFolder, shared, chosen, toggle, allowed } = folders;

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
      {client.id === "codex" && (
        <p data-testid="connect-agent-background" className={dialogTextClass}>
          {t("agents.connect.background.codex")}
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
      <details data-testid="connect-agent-details" className="flex flex-col">
        <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
          {t("agents.connect.details")}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {!anyFolder && (
            <p data-testid="connect-agent-later" className={dialogTextClass}>
              {t("agents.connect.reads.later")}
            </p>
          )}
          <p className={dialogTextClass}>{t("agents.connect.body", { agent })}</p>
          <p className={dialogTextClass}>{t("agents.propose.hint")}</p>
          {client.id === "claude-code" && (
            <p data-testid="connect-agent-background-details" className={dialogTextClass}>
              {t("agents.connect.background.details")}
            </p>
          )}
          {client.id === "codex" && (
            <p data-testid="connect-agent-background-details" className={dialogTextClass}>
              {t("agents.connect.background.codex.details")}
              {gap(
                t("agents.connect.background.codex.details"),
                t("agents.connect.codexInstructions"),
              )}
              {t("agents.connect.codexInstructions")}
            </p>
          )}
          {preview && <FileChangePreview preview={preview} testIdPrefix="connect-agent" />}
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
      <AgentSecretNotice storage={storage} onAccept={acceptPlainText} />
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
