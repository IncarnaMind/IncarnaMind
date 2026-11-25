import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentClient, AgentClientId, AgentPairing } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { unitsOf } from "../../../../shared/i18n/join";
import { resetClaudeCodeInstall } from "../../claudeCodeInstall";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import type { Read } from "../../useRead";
import { AgentFinder } from "../agents/AgentFinder";
import type { JustSetUp } from "../agents/AgentPairingRow";
import { clientName, doneWords, helpUrl, takesParts } from "../agents/agentWords";
import { ClaudeCodeInstallRow } from "../agents/ClaudeCodeInstallRow";
import { ConnectAgentFields, useAgentConnection } from "../agents/ConnectAgentFields";
import { ConnectManyFields, useManyAgentConnection } from "../agents/ConnectManyFields";
import { ConnectManyResult } from "../agents/ConnectManyResult";
import { LaunchDetails } from "../agents/LaunchDetails";
import { ReadProblem } from "../ReadProblem";
import { buttonStyle } from "../ui";
import { WorksRow } from "./SetupPanel";

/** Whether every agent listed, Other agent aside, is on this computer: then no tile says so (#3756). */
const everyFound = (shown: readonly AgentClient[]) =>
  shown.every((client) => client.id === "other" || client.installed);

const linkClass =
  "rounded-sm font-semibold text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0";

/**
 * The setup's first way to an AI (#3362): the one the User already has. Its agents, those on this
 * computer first, then Other agent. Choosing one shows the lines Settings › AI shows before
 * it connects one, and Allow and connect does what it does there, turning connecting agents on
 * with it: the agent is then the one Settings lists. A connected agent shows as set, with what is
 * left to do in it, and the tiles fold away until it is undone (#3756). It reads all of the User's Documents and notes, those added later too (#3544),
 * and it may write notes unless the User unticks it, so it can write the first one.
 */
export function AgentWays({
  clients,
  pairings,
  onSetUpModel,
}: {
  clients: Exclude<Read<readonly AgentClient[]>, { state: "loading" }>;
  pairings: readonly AgentPairing[];
  onSetUpModel(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const reportError = useAppStore((state) => state.reportError);
  const [chosen, setChosen] = useState<AgentClient | "all" | null>(null);
  const [justSetUp, setJustSetUp] = useState<JustSetUp | null>(null);
  const connection = useAgentConnection();
  const many = useManyAgentConnection();
  const list = useRef<HTMLFieldSetElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const inUse = new Set(pairings.map((pairing) => pairing.client));
  const foundToConnect =
    clients.state === "ready"
      ? clients.data.filter(
          (client) => client.installed && client.id !== "other" && !inUse.has(client.id),
        )
      : [];
  const offerAll = foundToConnect.length >= 2;
  // When two or more apps are found and none is connected yet, "All N" starts chosen (#3644).
  const autoAll = useRef(false);
  useEffect(() => {
    if (
      !autoAll.current &&
      offerAll &&
      pairings.length === 0 &&
      chosen === null &&
      !many.outcomes
    ) {
      autoAll.current = true;
      setChosen("all");
    }
  }, [offerAll, pairings.length, chosen, many.outcomes]);
  const chosenKey = chosen === "all" ? "all" : (chosen?.id ?? null);
  // The card opens under the tiles, out of view at the usual window size: its Allow must show.
  useEffect(() => {
    if (chosenKey) card.current?.scrollIntoView({ block: "nearest" });
  }, [chosenKey]);
  // Try again goes once the agents are listed: the focus moves on to the first of them.
  const failed = useRef(clients.state === "failed");
  useEffect(() => {
    if (clients.state === "failed") failed.current = true;
    else if (failed.current) {
      failed.current = false;
      if (document.activeElement === document.body) list.current?.querySelector("input")?.focus();
    }
  }, [clients.state]);

  const allow = async (client: AgentClient, choice: Parameters<typeof connection.connect>[1]) => {
    const done = await connection.connect(client, choice, { enable: true });
    if (!done) return;
    setJustSetUp(done);
    setChosen(null);
    if (client.id === "claude-code") void resetClaudeCodeInstall();
  };

  const allowAll = async (choice: Parameters<typeof many.connectAll>[0]) => {
    const results = await many.connectAll(choice, { enable: true });
    if (results) setChosen(null);
  };

  const openClaudeCodeConnect = useCallback(() => {
    if (clients.state !== "ready") return;
    const claudeCode = clients.data.find((each) => each.id === "claude-code");
    if (claudeCode) {
      connection.clearProblem();
      setChosen(claudeCode);
    }
  }, [clients, connection]);

  const selectClaudeDesktop = useCallback(() => {
    if (clients.state !== "ready") return;
    const desktop = clients.data.find((each) => each.id === "claude-desktop");
    if (desktop) {
      connection.clearProblem();
      setChosen(desktop);
    }
  }, [clients, connection]);

  const outcomePairingIds = new Set(
    (many.outcomes ?? []).flatMap((each) => (each.kind === "connected" ? [each.pairing.id] : [])),
  );
  const singlePairings = pairings.filter((pairing) => !outcomePairingIds.has(pairing.id));

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h2 id={`${id}-title`} className="text-ui font-semibold text-ink">
        {t("setupPage.ai.agents")}
      </h2>
      {!pairings.some((each) => each.client === "claude-code") && (
        <ClaudeCodeInstallRow
          variant="first-run"
          pairings={pairings}
          onSignedIn={openClaudeCodeConnect}
          onSetUpModel={onSetUpModel}
          onKeepDesktop={selectClaudeDesktop}
        />
      )}
      {singlePairings.map((pairing) => {
        const done = justSetUp?.pairingId === pairing.id ? justSetUp.result : null;
        return (
          <div key={pairing.id} className="flex flex-col gap-1">
            <WorksRow
              text={t("setupPage.agent.connected", { agent: pairing.name })}
              testId="setup-agent-connected"
            />
            {done && (
              <p
                data-testid="setup-agent-done"
                role="status"
                className="px-3 text-[12px] leading-[18px] text-ink-meta"
              >
                {doneWords(done, pairing, t)}
                {done.kind === "wrote" && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <button
                      type="button"
                      data-testid="setup-agent-undo"
                      onClick={() =>
                        core.undoAgentSetup(pairing.id).then(() => setJustSetUp(null), reportError)
                      }
                      className={linkClass}
                    >
                      {t("agents.done.undo")}
                    </button>
                  </>
                )}
                {pairing.client && done.kind === "copy" && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <a
                      href={helpUrl(pairing.client as AgentClientId, language)}
                      target="_blank"
                      rel="noreferrer"
                      className={linkClass}
                    >
                      {t("agents.settings.help")}
                    </a>
                  </>
                )}
              </p>
            )}
            {done?.kind === "copy" && takesParts(pairing.client) && (
              <div className="px-3">
                <LaunchDetails pairingId={pairing.id} />
              </div>
            )}
          </div>
        );
      })}
      {many.outcomes && (
        <ConnectManyResult
          outcomes={many.outcomes}
          undone={many.undone}
          onUndo={many.undoOne}
          onRetry={many.retryOne}
        />
      )}
      {clients.state === "failed" && (
        <ReadProblem
          words={t("setupPage.agents.failed")}
          read={clients}
          testId="setup-agents-problem"
        />
      )}
      {clients.state === "ready" && !justSetUp && !many.hasActiveOutcome && (
        <AgentFinder clients={clients.data} testId="setup-agents">
          {(shown) => (
            <fieldset
              ref={list}
              className="m-0 grid grid-cols-2 gap-2 border-0 p-0 max-[520px]:grid-cols-1"
            >
              <legend className="sr-only">{t("setupPage.ai.agents")}</legend>
              {offerAll && (
                <label
                  data-testid="setup-agent-all"
                  className="col-span-full flex min-h-9 min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 shadow-[inset_0_0_0_1px_var(--color-rule-strong)] hover:bg-hover has-[input:checked]:shadow-[inset_0_0_0_2px_var(--color-ink)]"
                >
                  <input
                    type="radio"
                    name={`${id}-agent`}
                    value="all"
                    checked={chosen === "all"}
                    onChange={() => {
                      connection.clearProblem();
                      many.clear();
                      setChosen("all");
                    }}
                    className="mt-0.5 size-4 shrink-0 accent-ink"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui font-semibold text-ink">
                      {t("agents.connectAll.tile", { count: foundToConnect.length })}
                    </span>
                    <span className="block text-[12px] leading-4 text-ink-meta">
                      {unitsOf(
                        foundToConnect.map((client) => clientName(client, t)),
                        language,
                      )}
                    </span>
                  </span>
                </label>
              )}
              {shown.map((client) => (
                <label
                  key={client.id}
                  data-testid="setup-agent"
                  data-value={client.id}
                  className="flex min-h-9 min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--color-rule-strong)] hover:bg-hover has-[input:checked]:shadow-[inset_0_0_0_2px_var(--color-ink)]"
                >
                  <input
                    type="radio"
                    name={`${id}-agent`}
                    value={client.id}
                    checked={chosen !== "all" && chosen?.id === client.id}
                    onChange={() => {
                      connection.clearProblem();
                      many.clear();
                      setChosen(client);
                    }}
                    className="size-4 shrink-0 accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate text-ui font-semibold text-ink">
                    {clientName(client, t)}
                  </span>
                  {client.installed && !everyFound(shown) && (
                    <span className="shrink-0 text-[12px] leading-4 text-ink-meta">
                      {t("setupPage.agent.found")}
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
          )}
        </AgentFinder>
      )}
      {chosen === "all" && offerAll && (
        <div
          ref={card}
          data-testid="setup-agent-connect-all"
          className="flex scroll-mb-28 flex-col gap-3 rounded-lg px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-rule)]"
        >
          <h3 className="text-ui font-semibold text-ink">{t("agents.connectAll.title")}</h3>
          <ConnectManyFields
            clients={foundToConnect}
            problem={many.problem}
            actions={({ choice, disabled }) => (
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="setup-agent-allow-all"
                  disabled={disabled || many.busy}
                  onClick={() => void allowAll(choice)}
                  className={buttonStyle("primary", "md")}
                >
                  {t("agents.connectAll.allow", { count: choice.clients.length })}
                </button>
              </div>
            )}
          />
        </div>
      )}
      {chosen && chosen !== "all" && (
        <div
          ref={card}
          data-testid="setup-agent-connect"
          className="flex scroll-mb-28 flex-col gap-3 rounded-lg px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-rule)]"
        >
          <h3 className="text-ui font-semibold text-ink">
            {t("agents.connect.title", { agent: clientInSentence(chosen, t) })}
          </h3>
          <ConnectAgentFields
            client={chosen}
            problem={connection.problem}
            actions={({ choice, disabled }) => (
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="setup-agent-allow"
                  disabled={disabled || connection.busy}
                  onClick={() => void allow(chosen, choice)}
                  className={buttonStyle("primary", "md")}
                >
                  {t("agents.connect.allow")}
                </button>
              </div>
            )}
          />
        </div>
      )}
    </section>
  );
}
