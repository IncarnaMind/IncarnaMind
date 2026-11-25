import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AgentClient, AgentClientId, AgentSetupPreview } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { type AgentConnectOutcome, manyAgentsConnector } from "../../agentConnection";
import { resetClaudeCodeInstall } from "../../claudeCodeInstall";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useGap, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { ProblemMark } from "../ProblemLine";
import { SLOT, Slotted } from "../Slotted";
import {
  checkBoxClass,
  checkRowClass,
  dialogTextClass,
  errorTextClass,
  fieldLabelClass,
  hintClass,
} from "../ui";
import { AgentShareChoice } from "./AgentShareChoice";
import { clientName, setupWords } from "./agentWords";
import {
  AgentSecretNotice,
  FileChangePreview,
  useSecretStorage,
  useShareFolders,
} from "./connectShared";
import { ProposeChoice } from "./ProposeChoice";

const READS_WITH = {
  none: "agents.connectAll.reads",
  walled: "agents.connectAll.reads.walled",
} as const;

/** What the User chose on the one sheet before connecting several apps (#3644). */
export interface ManyAgentsChoice {
  clients: AgentClient[];
  folderIds: string[];
  propose: boolean;
}

const connectManyAgents = manyAgentsConnector(core, (error) => {
  console.error("Couldn't turn connecting agents off again after a failed setup", error);
  useAppStore.getState().reportError(error);
});

/** Connects several AI apps sequentially under one choice, with per-app Undo and Try again (#3644). */
export function useManyAgentConnection() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<AgentConnectOutcome[] | null>(null);
  const [undone, setUndone] = useState<ReadonlySet<AgentClientId>>(new Set());
  const lastChoice = useRef<{ folderIds: string[]; propose: boolean; enable?: boolean } | null>(
    null,
  );

  const connectAll = async (
    choice: ManyAgentsChoice,
    options: { enable?: boolean } = {},
  ): Promise<AgentConnectOutcome[] | null> => {
    setBusy(true);
    setProblem(null);
    lastChoice.current = { folderIds: choice.folderIds, propose: choice.propose, ...options };
    try {
      const results = await connectManyAgents(choice.clients, choice, options);
      setUndone(new Set());
      setOutcomes(results);
      if (results.some((each) => each.kind === "connected" && each.client.id === "claude-code")) {
        void resetClaudeCodeInstall();
      }
      return results;
    } catch (error) {
      setProblem(errorMessage(error, t));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const retryOne = async (client: AgentClient): Promise<void> => {
    const choice = lastChoice.current;
    if (!choice) return;
    setProblem(null);
    try {
      const [retried] = await connectManyAgents([client], choice, { enable: choice.enable });
      if (!retried) return;
      if (retried.kind === "connected" && client.id === "claude-code") {
        void resetClaudeCodeInstall();
      }
      setUndone((prev) => {
        if (!prev.has(client.id)) return prev;
        const next = new Set(prev);
        next.delete(client.id);
        return next;
      });
      setOutcomes((prev) =>
        prev ? prev.map((each) => (each.client.id === client.id ? retried : each)) : [retried],
      );
    } catch (error) {
      setOutcomes((prev) =>
        prev
          ? prev.map((each) =>
              each.client.id === client.id ? { kind: "failed", client, error } : each,
            )
          : [{ kind: "failed", client, error }],
      );
    }
  };

  const undoOne = async (clientId: AgentClientId, pairingId: string): Promise<void> => {
    await core.undoAgentSetup(pairingId);
    setUndone((prev) => new Set(prev).add(clientId));
  };

  const hasActiveOutcome = Boolean(
    outcomes?.some((each) => each.kind === "connected" && !undone.has(each.client.id)),
  );

  return {
    busy,
    problem,
    outcomes,
    undone,
    hasActiveOutcome,
    connectAll,
    retryOne,
    undoOne,
    clearProblem: () => setProblem(null),
    clear: () => {
      setOutcomes(null);
      setUndone(new Set());
      setProblem(null);
    },
  };
}

/**
 * The one consent sheet before connecting several found AI apps at once (#3644):
 * what they may read and whether they may write chosen once, one tick per found app
 * (all ticked at first), and what will be written for each under Details.
 */
export function ConnectManyFields({
  clients,
  problem = null,
  actions,
}: {
  clients: readonly AgentClient[];
  /** Why turning connecting agents on failed before any app ran, shown on the sheet. */
  problem?: string | null;
  actions(allow: { choice: ManyAgentsChoice; disabled: boolean }): ReactNode;
}) {
  const t = useT();
  const gap = useGap();
  const folders = useShareFolders();
  const [propose, setPropose] = useState(true);
  const [unchecked, setUnchecked] = useState<ReadonlySet<AgentClientId>>(new Set());
  const [previews, setPreviews] = useState<Partial<Record<AgentClientId, AgentSetupPreview>>>({});
  const reportError = useAppStore((state) => state.reportError);
  const clientKey = clients.map((client) => client.id).join(",");
  const { storage, canKeepKey, accept: acceptPlainText } = useSecretStorage(clientKey);
  const fileClientIds = useMemo(
    () => clients.filter((client) => client.setup === "file").map((client) => client.id),
    [clients],
  );
  const fileClientKey = fileClientIds.join(",");

  useEffect(() => {
    const offered = new Set(clients.map((client) => client.id));
    setUnchecked((prev) => {
      const next = new Set([...prev].filter((id) => offered.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [clients]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch previews when the file-client list changes.
  useEffect(() => {
    setPreviews({});
    if (fileClientIds.length === 0) return;
    let current = true;
    for (const id of fileClientIds) {
      core.previewAgentSetup(id).then((value) => {
        if (current && value) {
          setPreviews((prev) => ({ ...prev, [id]: value }));
        }
      }, reportError);
    }
    return () => {
      current = false;
    };
  }, [fileClientKey, reportError]);

  const { all, setAll, rows, leftOut, anyFolder, shared, chosen, toggle, allowed } = folders;
  const selectedClients = clients.filter((client) => !unchecked.has(client.id));
  const toggleApp = (clientId: AgentClientId, on: boolean) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const claudeCode = selectedClients.find((client) => client.id === "claude-code");
  const codex = selectedClients.find((client) => client.id === "codex");

  return (
    <>
      <p data-testid="connect-many-reads" className={dialogTextClass}>
        {t(!anyFolder ? "agents.connectAll.reads.all" : READS_WITH[leftOut])}
      </p>
      {anyFolder && (
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="sr-only">{t("agents.connectAll.folders")}</legend>
          <AgentShareChoice
            all={all}
            onAll={setAll}
            rows={rows}
            chosen={chosen}
            onToggle={toggle}
          />
        </fieldset>
      )}
      <ProposeChoice
        checked={propose}
        onChange={setPropose}
        hint={false}
        testId="connect-many-propose"
        label={t(shared ? "agents.connectAll.propose" : "agents.connectAll.proposeFolders")}
      />
      <fieldset className="flex min-w-0 flex-col gap-1.5 border-0 p-0">
        <legend className={`${fieldLabelClass} mb-1`}>{t("agents.connectAll.apps")}</legend>
        {clients.map((client) => {
          const checked = !unchecked.has(client.id);
          return (
            <label
              key={client.id}
              data-testid="connect-many-app"
              data-client={client.id}
              className={checkRowClass}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => toggleApp(client.id, event.target.checked)}
                className={`${checkBoxClass} accent-ink`}
              />
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-ink">{clientName(client, t)}</span>
                <span className="text-[12px] leading-5 text-ink-meta">
                  {" · "}
                  {setupWords(client, t)}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {claudeCode && (
        <p data-testid="connect-many-background-claude" className={dialogTextClass}>
          {t("agents.connect.background", { agent: clientInSentence(claudeCode, t) })}
        </p>
      )}
      {codex && (
        <p data-testid="connect-many-background-codex" className={dialogTextClass}>
          {t("agents.connect.background.codex")}
        </p>
      )}
      <p className={dialogTextClass}>{t("agents.connectAll.eachOwn")}</p>
      <details data-testid="connect-many-details" className="flex flex-col">
        <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
          {t("agents.connect.details")}
        </summary>
        <div className="mt-2 flex flex-col gap-2.5 border-t border-rule pt-2">
          {!anyFolder && <p className={dialogTextClass}>{t("agents.connect.reads.later")}</p>}
          <p data-testid="connect-many-consent-body" className={dialogTextClass}>
            {t("agents.connectAll.body")}
          </p>
          <p className={dialogTextClass}>{t("agents.propose.hint")}</p>
          {claudeCode && (
            <p className={dialogTextClass}>{t("agents.connect.background.details")}</p>
          )}
          {codex && (
            <p className={dialogTextClass}>
              {t("agents.connect.background.codex.details")}
              {gap(
                t("agents.connect.background.codex.details"),
                t("agents.connect.codexInstructions"),
              )}
              {t("agents.connect.codexInstructions")}
            </p>
          )}
          {selectedClients.map((client) => {
            const preview = previews[client.id];
            const agent = clientInSentence(client, t);
            return (
              <div
                key={client.id}
                data-testid="connect-many-app-detail"
                data-client={client.id}
                className="flex flex-col gap-1"
              >
                <p className="text-[12px] leading-[18px] font-semibold text-ink">
                  {clientName(client, t)}
                </p>
                {client.setup === "file" ? (
                  preview && <FileChangePreview preview={preview} testIdPrefix="connect-many" />
                ) : (
                  <p className={dialogTextClass}>
                    {client.setup === "bundle"
                      ? t("agents.connectAll.detail.bundle")
                      : client.setup === "link"
                        ? t("agents.connectAll.detail.link", { agent })
                        : setupWords(client, t)}
                  </p>
                )}
                {client.skillPath && (
                  <p className={dialogTextClass}>
                    <Slotted
                      message={t("agents.connect.skill", { path: SLOT, agent })}
                      slot={<InlinePath path={client.skillPath} />}
                    />
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </details>
      {allowed.length === 0 && <p className={hintClass}>{t("agents.connect.pickOne")}</p>}
      {selectedClients.length === 0 && (
        <p className={hintClass}>{t("agents.connectAll.pickApp")}</p>
      )}
      <AgentSecretNotice storage={storage} onAccept={acceptPlainText} />
      {problem && (
        <p data-testid="connect-many-problem" role="alert" className={errorTextClass}>
          <ProblemMark />
          {problem}
        </p>
      )}
      {actions({
        choice: { clients: selectedClients, folderIds: allowed, propose },
        disabled: allowed.length === 0 || selectedClients.length === 0 || !canKeepKey,
      })}
    </>
  );
}
