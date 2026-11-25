import { useState } from "react";
import type { AgentClient, AgentClientId } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import type { AgentConnectOutcome } from "../../agentConnection";
import { core } from "../../core";
import { ClaimMarkIcon } from "../../editor/icons";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { WorksRow } from "../firstRun/SetupPanel";
import { ProblemMark } from "../ProblemLine";
import { buttonStyle } from "../ui";
import { clientName, doneWords, helpUrl, setupProblem, takesParts } from "./agentWords";
import { LaunchDetails } from "./LaunchDetails";

const linkClass =
  "rounded-sm font-semibold text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0";

/**
 * Per-app results after connecting several AI apps in one press (#3644): connected (with Undo),
 * waiting on Install (with Open again), waiting on paste (with Copy and Help), or failed (with Try again).
 */
export function ConnectManyResult({
  outcomes,
  undone,
  onUndo,
  onRetry,
}: {
  outcomes: readonly AgentConnectOutcome[];
  undone: ReadonlySet<AgentClientId>;
  onUndo(clientId: AgentClientId, pairingId: string): Promise<void>;
  onRetry(client: AgentClient): Promise<void>;
}) {
  const t = useT();
  const language = useLanguage();
  const reportError = useAppStore((state) => state.reportError);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<AgentClientId | null>(null);

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
    } catch (error) {
      reportError(error);
    }
  };

  const undo = async (clientId: AgentClientId, pairingId: string) => {
    try {
      await onUndo(clientId, pairingId);
    } catch (error) {
      reportError(error);
    }
  };

  const retry = async (client: AgentClient) => {
    setRetrying(client.id);
    try {
      await onRetry(client);
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div data-testid="connect-many-result" className="flex flex-col gap-2.5">
      {outcomes.map((outcome) => {
        const label = clientName(outcome.client, t);
        const agent = clientInSentence(outcome.client, t);

        if (outcome.kind === "failed") {
          const reason = setupProblem(outcome.error, t);
          return (
            <div
              key={outcome.client.id}
              data-testid="connect-many-outcome"
              data-client={outcome.client.id}
              data-outcome="failed"
              className="flex flex-col gap-1"
            >
              <div
                role="alert"
                className="flex items-center gap-2 rounded-lg bg-wash px-3 py-2 text-[13px] leading-5 font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-rule)]"
              >
                <ProblemMark />
                <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
              </div>
              <p className="px-3 text-[12px] leading-[18px] text-ink-meta">
                {t("agents.connectAll.failed", { agent: label, reason })}
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  data-testid="connect-many-retry"
                  disabled={retrying === outcome.client.id}
                  onClick={() => void retry(outcome.client)}
                  className={linkClass}
                >
                  {t("agents.connectAll.retry")}
                </button>
              </p>
            </div>
          );
        }

        if (undone.has(outcome.client.id)) {
          return (
            <p
              key={outcome.client.id}
              data-testid="connect-many-outcome"
              data-client={outcome.client.id}
              data-outcome="undone"
              role="status"
              className="px-3 text-[12px] leading-[18px] text-ink-meta"
            >
              {t("agents.connectAll.undone", { agent })}
            </p>
          );
        }

        const { pairing, result } = outcome;
        if (result.kind === "wrote") {
          return (
            <div
              key={outcome.client.id}
              data-testid="connect-many-outcome"
              data-client={outcome.client.id}
              data-outcome="connected"
              className="flex flex-col gap-1"
            >
              <WorksRow
                text={t("setupPage.agent.connected", { agent: pairing.name })}
                testId="connect-many-connected"
              />
              <p role="status" className="px-3 text-[12px] leading-[18px] text-ink-meta">
                {doneWords(result, pairing, t)}
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  data-testid="connect-many-undo"
                  onClick={() => void undo(outcome.client.id, pairing.id)}
                  className={linkClass}
                >
                  {t("agents.done.undo")}
                </button>
              </p>
            </div>
          );
        }

        if (result.kind === "opened") {
          return (
            <div
              key={outcome.client.id}
              data-testid="connect-many-outcome"
              data-client={outcome.client.id}
              data-outcome="opened"
              className="flex flex-col gap-1"
            >
              <div
                data-testid="connect-many-waiting"
                className="flex items-center gap-2 rounded-lg bg-wash px-3 py-2 text-[13px] leading-5 font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-rule)]"
              >
                <ClaimMarkIcon state="not-checked" className="size-4 shrink-0 text-ink-meta" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {t("agents.connectAll.waitingPress", { agent: label })}
                </span>
              </div>
              <p role="status" className="px-3 text-[12px] leading-[18px] text-ink-meta">
                {doneWords(result, pairing, t)}
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  data-testid="connect-many-open-again"
                  onClick={() => void core.openAgentInstallAgain(pairing.id).catch(reportError)}
                  className={linkClass}
                >
                  {t("agents.connectAll.openAgain", { agent: label })}
                </button>
              </p>
            </div>
          );
        }

        return (
          <div
            key={outcome.client.id}
            data-testid="connect-many-outcome"
            data-client={outcome.client.id}
            data-outcome="copy"
            className="flex flex-col gap-1.5"
          >
            <div
              data-testid="connect-many-paste"
              className="flex items-center gap-2 rounded-lg bg-wash px-3 py-2 text-[13px] leading-5 font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-rule)]"
            >
              <ClaimMarkIcon state="not-checked" className="size-4 shrink-0 text-ink-meta" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {t("agents.connectAll.waitingPaste", { agent: label })}
              </span>
            </div>
            <p role="status" className="px-3 text-[12px] leading-[18px] text-ink-meta">
              {doneWords(result, pairing, t, { copied: false })}
              {pairing.client && (
                <>
                  <span aria-hidden="true"> · </span>
                  <a
                    href={helpUrl(pairing.client, language)}
                    target="_blank"
                    rel="noreferrer"
                    className={linkClass}
                  >
                    {t("agents.settings.help")}
                  </a>
                </>
              )}
            </p>
            <div className="flex items-start gap-2 px-3">
              <pre
                data-testid="connect-many-paste-text"
                className="min-w-0 flex-1 overflow-x-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink"
              >
                {result.shown}
              </pre>
              <button
                type="button"
                data-testid="connect-many-copy"
                onClick={() => void copy(pairing.id, result.text)}
                className={buttonStyle("secondary", "sm")}
              >
                {copiedId === pairing.id ? t("agents.pairing.copied") : t("agents.pairing.copy")}
              </button>
            </div>
            {takesParts(pairing.client) && (
              <div className="px-3">
                <LaunchDetails pairingId={pairing.id} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
