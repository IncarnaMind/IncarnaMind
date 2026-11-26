import { type ReactNode, useEffect, useRef, useState } from "react";
import { type AgentClient, type AgentPairing, ALL_SHARED_ID } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import {
  cancelClaudeCodeInstall,
  resetClaudeCodeInstall,
  useClaudeCodeInstallState,
} from "../../claudeCodeInstall";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { clientName, setupProblem } from "../agents/agentWords";
import { connectManyAgents } from "../agents/connectShared";
import { ProblemMark } from "../ProblemLine";
import { buttonStyle } from "../ui";
import { InstallingRow } from "./ClaudeCodeInstallLine";
import { SetupPanel, type StepPlace } from "./SetupPanel";
import { stillNeedsUser } from "./yourAiList";
import { AppMark, type Choice, type Done, listClass, StepFoot } from "./yourAiParts";

/** The pairings that wait for their app's own Install, as Settings › AI is told of them; null until read. */
function useAwaitingInstall(): readonly string[] | null {
  const [awaiting, setAwaiting] = useState<readonly string[] | null>(null);
  const reportError = useAppStore((state) => state.reportError);
  useEffect(() => {
    core.getAgents().then((settings) => setAwaiting(settings.awaitingInstall), reportError);
    return core.on("agents.changed", (settings) => setAwaiting(settings.awaitingInstall));
  }, [reportError]);
  return awaiting;
}

const outcomeOf = (
  outcome: Awaited<ReturnType<typeof connectManyAgents>>[number],
  client: AgentClient,
): Done =>
  outcome.kind === "connected"
    ? { client, pairingId: outcome.pairing.id, result: outcome.result }
    : { client, error: outcome.error };

/**
 * After Connect in the Your AI step (#3791), while an app chosen still needs the User: each row
 * says what is left, with the one button that does it, and a line to paste shows only under
 * Details. Once every app works, first run moves on by itself; Set up later moves on with something
 * left. `installs`: the same press installs Claude Code, which connects once signed in.
 */
export function YourAiAfter({
  place,
  done,
  installs,
  choice,
  claudeCode,
  pairings,
  onDone,
  onUndo,
}: {
  place: StepPlace;
  done: readonly Done[];
  installs: boolean;
  choice: Choice;
  claudeCode: AgentClient | null;
  pairings: readonly AgentPairing[];
  /** Applies `update` to what is done as it is when it lands, so two results never undo each other. */
  onDone(update: (current: readonly Done[]) => readonly Done[]): void;
  onUndo(): void;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const awaiting = useAwaitingInstall();
  const install = useClaudeCodeInstallState();
  const [undoing, setUndoing] = useState(false);
  // Connections still being made (a retry, or Claude Code once signed in): Undo waits for them, so
  // none it should take back lands after it.
  const [connecting, setConnecting] = useState(0);
  const handedOff = useRef(false);
  const moved = useRef(false);
  const undone = useRef(new Set<string>());
  const connectWithChoice = async (client: AgentClient) => {
    setConnecting((count) => count + 1);
    try {
      const [outcome] = await connectManyAgents(
        [client],
        { folderIds: [ALL_SHARED_ID], propose: choice.propose },
        { enable: true },
      );
      return outcome;
    } finally {
      setConnecting((count) => count - 1);
    }
  };
  const put = (client: AgentClient, outcome: Parameters<typeof outcomeOf>[0]) =>
    onDone((current) =>
      current.some((each) => each.client.id === client.id)
        ? current.map((each) => (each.client.id === client.id ? outcomeOf(outcome, client) : each))
        : [...current, outcomeOf(outcome, client)],
    );

  // Signed in to the Claude Code it installed: the same press connects it, as the row said it would.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connects once, when the sign-in lands.
  useEffect(() => {
    if (!installs || install.kind !== "signed-in" || !claudeCode || handedOff.current) return;
    if (done.some((each) => each.client.id === "claude-code")) return;
    handedOff.current = true;
    connectWithChoice(claudeCode)
      .then((outcome) => {
        if (!outcome) return;
        void resetClaudeCodeInstall();
        put(claudeCode, outcome);
      })
      .catch(reportError);
  }, [installs, install.kind, claudeCode, done, reportError]);

  const pairingOf = (id: string) => pairings.find((pairing) => pairing.id === id);
  // Until the waiting Installs are read, an app that isn't written to is taken as still waiting.
  const left = (each: Done) =>
    "error" in each
      ? true
      : awaiting === null
        ? each.result.kind !== "wrote"
        : stillNeedsUser(each.result, pairingOf(each.pairingId), awaiting);
  // Installing goes on until it ends: a plan without Claude Code ends it, and asks nothing more.
  const installing = installs && !done.some((each) => each.client.id === "claude-code");
  const leftNames = [
    ...done.filter(left).map((each) => clientName(each.client, t)),
    ...(installing && install.kind !== "no-plan" ? ["Claude Code"] : []),
  ];
  const nothingLeft = leftNames.length === 0;
  // A plan without Claude Code stays on screen, said on its row, until the User goes on.
  const stays = installing && install.kind === "no-plan";

  useEffect(() => {
    if (!nothingLeft || stays || moved.current) return;
    moved.current = true;
    place.next();
  }, [nothingLeft, stays, place]);

  const retry = async (client: AgentClient) => {
    const outcome = await connectWithChoice(client);
    if (outcome) put(client, outcome);
  };

  const undo = async () => {
    if (undoing || connecting > 0) return;
    setUndoing(true);
    try {
      if (installs) await cancelClaudeCodeInstall();
      // An Undo that failed part way is pressed again: what it already took back is gone.
      for (const each of done) {
        if (!("pairingId" in each) || undone.current.has(each.pairingId)) continue;
        await core.undoAgentSetup(each.pairingId);
        undone.current.add(each.pairingId);
      }
      onUndo();
    } catch (error) {
      reportError(error);
    } finally {
      setUndoing(false);
    }
  };

  return (
    <SetupPanel
      place={place}
      view="ai-after"
      title={t("setupPage.ai.title")}
      lead={
        leftNames.length === 1
          ? t("setupPage.ai.left.one", { agent: leftNames[0] ?? "" })
          : leftNames.length > 1
            ? t("setupPage.ai.left.many")
            : undefined
      }
      foot={
        <StepFoot
          place={place}
          start={
            <button
              type="button"
              data-testid="setup-undo"
              disabled={undoing || connecting > 0}
              onClick={() => void undo()}
              className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
            >
              {t("agents.done.undo")}
            </button>
          }
          later={!nothingLeft}
          main={
            <button
              type="button"
              data-testid="setup-next"
              disabled={!nothingLeft}
              onClick={place.next}
              className={buttonStyle("primary", "lg")}
            >
              {t("setupPage.continue")}
            </button>
          }
        />
      }
    >
      <ul data-testid="setup-done" aria-label={t("setupPage.ai.title")} className={listClass}>
        {done.map((each) => (
          <DoneRow
            key={each.client.id}
            done={each}
            left={left(each)}
            onRetry={() => retry(each.client)}
          />
        ))}
        {installing && <InstallingRow state={install} />}
      </ul>
    </SetupPanel>
  );
}

/** One app connected in the press: Connected, or what is left with its one button, or why it failed. */
function DoneRow({ done, left, onRetry }: { done: Done; left: boolean; onRetry(): Promise<void> }) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = clientName(done.client, t);
  const agent = clientInSentence(done.client, t);
  let line = t("setupPage.ai.connected");
  let action: ReactNode = null;
  let details: string | null = null;
  if ("error" in done) {
    line = setupProblem(done.error, t);
    action = (
      <button
        type="button"
        data-testid="setup-done-retry"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onRetry()
            .catch(reportError)
            .finally(() => setBusy(false));
        }}
        className={buttonStyle("secondary", "sm")}
      >
        {t("agents.connectAll.retry")}
      </button>
    );
  } else if (left && done.result.kind === "opened") {
    line = t("setupPage.ai.row.install", { agent });
    const { pairingId } = done;
    action = (
      <button
        type="button"
        data-testid="setup-done-open"
        onClick={() => void core.openAgentInstallAgain(pairingId).catch(reportError)}
        className={buttonStyle("secondary", "sm")}
      >
        {t("setupPage.ai.row.open", { agent })}
      </button>
    );
  } else if (left && done.result.kind === "copy") {
    const { text, shown, how } = done.result;
    line = t(how === "command" ? "setupPage.ai.row.command" : "setupPage.ai.row.settings", {
      agent,
    });
    details = shown;
    action = (
      <button
        type="button"
        data-testid="setup-done-copy"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => setCopied(true), reportError)
        }
        className={buttonStyle("secondary", "sm")}
      >
        {t(copied ? "agents.pairing.copied" : "agents.pairing.copy")}
      </button>
    );
  }
  return (
    <li
      data-testid="setup-done-row"
      data-client={done.client.id}
      data-left={left || undefined}
      className="flex flex-col border-t border-rule first:border-t-0"
    >
      <div className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2">
        <AppMark name={name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-ink" title={name}>
            {name}
          </span>
          <span
            role="status"
            className={`text-[12px] leading-[18px] ${left ? "text-ink-secondary" : "text-ink-meta"}`}
          >
            {"error" in done && <ProblemMark />}
            {line}
          </span>
        </span>
        {action}
      </div>
      {details !== null && (
        <details data-testid="setup-done-details" className="px-3 pb-2 pl-[52px]">
          <summary className="cursor-pointer text-[12px] leading-[18px] text-ink-secondary">
            {t("agents.connect.details")}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
            {details}
          </pre>
        </details>
      )}
    </li>
  );
}
