import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type AgentClient,
  type AgentClientId,
  type AgentSetupPreview,
  ALL_SHARED_ID,
  NOT_IN_A_FOLDER_ID,
  type SecretStorageStatus,
} from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { type AgentConnectOutcome, manyAgentsConnector } from "../../agentConnection";
import { leftOutOfAll, onlyNotInAFolder } from "../../agentFolders";
import { resetClaudeCodeInstall } from "../../claudeCodeInstall";
import { core } from "../../core";
import { useGap, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { SLOT, Slotted } from "../Slotted";
import { checkBoxClass, checkRowClass, dialogTextClass, fieldLabelClass, hintClass } from "../ui";
import { useAgentFolderRows } from "./AgentFolderList";
import { AgentShareChoice } from "./AgentShareChoice";
import { clientName } from "./agentWords";

const ALL_UNFILED: ReadonlySet<string> = new Set([NOT_IN_A_FOLDER_ID]);
const NOTHING: ReadonlySet<string> = new Set();
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
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<AgentConnectOutcome[] | null>(null);
  const lastChoice = useRef<{ folderIds: string[]; propose: boolean; enable?: boolean } | null>(
    null,
  );

  const connectAll = async (
    choice: ManyAgentsChoice,
    options: { enable?: boolean } = {},
  ): Promise<AgentConnectOutcome[]> => {
    setBusy(true);
    lastChoice.current = { folderIds: choice.folderIds, propose: choice.propose, ...options };
    try {
      const results = await connectManyAgents(choice.clients, choice, options);
      setOutcomes(results);
      if (results.some((each) => each.kind === "connected" && each.client.id === "claude-code")) {
        void resetClaudeCodeInstall();
      }
      return results;
    } finally {
      setBusy(false);
    }
  };

  const retryOne = async (client: AgentClient): Promise<void> => {
    const choice = lastChoice.current;
    if (!choice) return;
    const [retried] = await connectManyAgents([client], choice, { enable: choice.enable });
    if (!retried) return;
    if (retried.kind === "connected" && client.id === "claude-code") {
      void resetClaudeCodeInstall();
    }
    setOutcomes((prev) =>
      prev ? prev.map((each) => (each.client.id === client.id ? retried : each)) : [retried],
    );
  };

  const undoOne = async (_clientId: AgentClientId, pairingId: string): Promise<void> => {
    await core.undoAgentSetup(pairingId);
  };

  return {
    busy,
    outcomes,
    connectAll,
    retryOne,
    undoOne,
    clear: () => setOutcomes(null),
  };
}

function howItConnects(client: AgentClient, t: ReturnType<typeof useT>): string {
  const agent = clientInSentence(client, t);
  switch (client.setup) {
    case "file":
      return t("agents.connectAll.how.file");
    case "bundle":
      return t("agents.connectAll.how.bundle");
    case "link":
      return t("agents.connectAll.how.link", { agent });
    case "command":
      return t("agents.connectAll.how.command");
    case "manual":
      return t("agents.connectAll.how.paste", { agent });
  }
}

/**
 * The one consent sheet before connecting several found AI apps at once (#3644):
 * what they may read and whether they may write chosen once, one tick per found app
 * (all ticked at first), and what will be written for each under Details.
 */
export function ConnectManyFields({
  clients,
  actions,
}: {
  clients: readonly AgentClient[];
  actions(allow: { choice: ManyAgentsChoice; disabled: boolean }): ReactNode;
}) {
  const t = useT();
  const gap = useGap();
  const [all, setAll] = useState(true);
  const [pickedFolders, setPickedFolders] = useState<ReadonlySet<string> | null>(null);
  const [propose, setPropose] = useState(true);
  const [unchecked, setUnchecked] = useState<ReadonlySet<AgentClientId>>(new Set());
  const [previews, setPreviews] = useState<Partial<Record<AgentClientId, AgentSetupPreview>>>({});
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const rows = useAgentFolderRows(true);
  const leftOut = leftOutOfAll(useAppStore((state) => state.library?.groups) ?? []);
  const reportError = useAppStore((state) => state.reportError);
  const fileClientIds = clients
    .filter((client) => client.setup === "file")
    .map((client) => client.id)
    .join(",");
  const clientKey = clients.map((client) => client.id).join(",");

  useEffect(() => {
    setUnchecked(new Set());
    setPreviews({});
    if (!clientKey) return;
    let current = true;
    const ids = fileClientIds === "" ? [] : (fileClientIds.split(",") as AgentClientId[]);
    for (const id of ids) {
      core.previewAgentSetup(id).then((value) => {
        if (current && value) {
          setPreviews((prev) => ({ ...prev, [id]: value }));
        }
      }, reportError);
    }
    core.getSecretStorage().then((value) => {
      if (current) setStorage(value);
    }, reportError);
    return () => {
      current = false;
    };
  }, [clientKey, fileClientIds, reportError]);

  const canKeepKey = storage?.canSave !== false;
  const anyFolder = rows.some((row) => row.id !== NOT_IN_A_FOLDER_ID);
  const shared = all || !anyFolder;
  const chosenFolders = pickedFolders ?? (onlyNotInAFolder(rows) ? ALL_UNFILED : NOTHING);
  const toggleFolder = (folderId: string, on: boolean) => {
    const next = new Set(chosenFolders);
    if (on) next.add(folderId);
    else next.delete(folderId);
    setPickedFolders(next);
  };
  const allowedFolders = shared
    ? [ALL_SHARED_ID]
    : rows.filter((row) => chosenFolders.has(row.id)).map((row) => row.id);

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
            chosen={chosenFolders}
            onToggle={toggleFolder}
          />
        </fieldset>
      )}
      <label className={checkRowClass}>
        <input
          type="checkbox"
          data-testid="connect-many-propose"
          checked={propose}
          onChange={(event) => setPropose(event.target.checked)}
          className={checkBoxClass}
        />
        {t(shared ? "agents.connectAll.propose" : "agents.connectAll.proposeFolders")}
      </label>
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
                className={checkBoxClass}
              />
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-ink">{clientName(client, t)}</span>
                <span className="text-[12px] leading-5 text-ink-meta">
                  {" · "}
                  {howItConnects(client, t)}
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
                {preview ? (
                  <>
                    <p className={dialogTextClass}>
                      <Slotted
                        message={t("agents.connect.fileChange", { path: SLOT })}
                        slot={<InlinePath path={preview.path} />}
                      />
                    </p>
                    <details data-testid="connect-many-change-lines">
                      <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
                        {t("agents.connect.showChange")}
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
                        {preview.change}
                      </pre>
                    </details>
                    {preview.backup && (
                      <p className={dialogTextClass}>
                        <Slotted
                          message={t("agents.connect.backup", { path: SLOT })}
                          slot={<InlinePath path={preview.backup} />}
                        />
                      </p>
                    )}
                  </>
                ) : (
                  <p className={dialogTextClass}>
                    {client.setup === "bundle"
                      ? t("agents.connectAll.detail.bundle")
                      : client.setup === "link"
                        ? t("agents.connectAll.detail.link", { agent })
                        : client.setup === "command"
                          ? t("agents.connectAll.detail.command")
                          : t("agents.connectAll.detail.paste", { agent })}
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
      {allowedFolders.length === 0 && <p className={hintClass}>{t("agents.connect.pickOne")}</p>}
      {selectedClients.length === 0 && (
        <p className={hintClass}>{t("agents.connectAll.pickApp")}</p>
      )}
      {storage && !storage.canSave && (
        <SecretStorageNotice
          status={storage}
          onAccept={() => core.acceptPlainTextSecretStorage().then(setStorage, reportError)}
        />
      )}
      {actions({
        choice: { clients: selectedClients, folderIds: allowedFolders, propose },
        disabled: allowedFolders.length === 0 || selectedClients.length === 0 || !canKeepKey,
      })}
    </>
  );
}
