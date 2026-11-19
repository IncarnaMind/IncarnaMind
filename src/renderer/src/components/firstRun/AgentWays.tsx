import { useId, useState } from "react";
import type { AgentClient, AgentClientId, AgentPairing } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import type { JustSetUp } from "../agents/AgentPairingRow";
import { clientName, doneWords, helpUrl } from "../agents/agentWords";
import { ConnectAgentFields, useAgentConnection } from "../agents/ConnectAgentFields";
import { buttonStyle } from "../ui";
import { WorksRow } from "./SetupPanel";

const linkClass =
  "rounded-sm font-semibold text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0";

/**
 * The setup's first way to an AI (#3362): the one the User already has. Its agents, those on this
 * computer first, then Other agent. Choosing one shows the lines Settings › Agents shows before
 * it connects one, and Allow and connect does what it does there, turning connecting agents on
 * with it: the agent is then the one Settings lists. A connected agent shows as set, with what is
 * left to do in it. With nothing to read yet it reads Not in a Folder, and it may write notes
 * unless the User unticks it, so it can write the first one.
 */
export function AgentWays({
  clients,
  pairings,
}: {
  clients: readonly AgentClient[];
  pairings: readonly AgentPairing[];
}) {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const reportError = useAppStore((state) => state.reportError);
  const [chosen, setChosen] = useState<AgentClient | null>(null);
  const [justSetUp, setJustSetUp] = useState<JustSetUp | null>(null);
  const connection = useAgentConnection();

  const allow = async (client: AgentClient, choice: Parameters<typeof connection.connect>[1]) => {
    const done = await connection.connect(client, choice, { enable: true });
    if (!done) return;
    setJustSetUp(done);
    setChosen(null);
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h2 id={`${id}-title`} className="text-ui font-semibold text-ink">
        {t("setupPage.ai.agents")}
      </h2>
      {pairings.map((pairing) => {
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
          </div>
        );
      })}
      <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0 max-[520px]:grid-cols-1">
        <legend className="sr-only">{t("setupPage.ai.agents")}</legend>
        {clients.map((client) => (
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
              checked={chosen?.id === client.id}
              onChange={() => {
                connection.clearProblem();
                setChosen(client);
              }}
              className="size-4 shrink-0 accent-ink"
            />
            <span className="min-w-0 flex-1 truncate text-ui font-semibold text-ink">
              {clientName(client, t)}
            </span>
            {client.installed && (
              <span className="shrink-0 text-[12px] leading-4 text-ink-meta">
                {t("setupPage.agent.found")}
              </span>
            )}
          </label>
        ))}
      </fieldset>
      {chosen && (
        <div
          data-testid="setup-agent-connect"
          className="flex flex-col gap-3 rounded-lg px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-rule)]"
        >
          <h3 className="text-ui font-semibold text-ink">
            {t("agents.connect.title", { agent: clientInSentence(chosen, t) })}
          </h3>
          <ConnectAgentFields
            client={chosen}
            problem={connection.problem}
            writes
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
