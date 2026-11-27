import type { AgentClient } from "../../../../core/api";
import { useT } from "../../i18n";
import { clientName } from "../agents/agentWords";
import { ConnectAgentFields, useAgentConnection } from "../agents/ConnectAgentFields";
import { ChevronRightLineIcon } from "../icons";
import { buttonStyle } from "../ui";
import { SetupPanel, type StepPlace } from "./SetupPanel";
import { AppMark, type Choice, type Done } from "./yourAiParts";

/**
 * Another app… in the Your AI step (#3791): the AI apps that aren't on this computer and Other
 * agent, each connected through the sheet Settings › AI connects it with.
 */
export function AnotherApp({
  place,
  clients,
  chosen,
  onChoose,
  onBack,
  onDone,
}: {
  place: StepPlace;
  clients: readonly AgentClient[];
  chosen: AgentClient | null;
  onChoose(client: AgentClient): void;
  onBack(): void;
  onDone(done: Done, choice: Choice): void;
}) {
  const t = useT();
  const connection = useAgentConnection();
  const crumb = {
    label: chosen ? t("setupPage.ai.another.title") : t("setupPage.ai.title"),
    onClick: onBack,
  };
  if (chosen) {
    return (
      <SetupPanel
        place={place}
        view={`app:${chosen.id}`}
        title={clientName(chosen, t)}
        crumb={crumb}
        foot={null}
      >
        <div data-testid="setup-another-connect" className="flex flex-col gap-3">
          <ConnectAgentFields
            client={chosen}
            problem={connection.problem}
            actions={({ choice, disabled }) => (
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="setup-another-allow"
                  disabled={disabled || connection.busy}
                  onClick={() =>
                    void connection.connect(chosen, choice, { enable: true }).then((done) => {
                      if (done) {
                        onDone(
                          { client: chosen, pairingId: done.pairingId, result: done.result },
                          { propose: choice.propose },
                        );
                      }
                    })
                  }
                  className={buttonStyle("primary", "md")}
                >
                  {t("setupPage.ai.connect")}
                </button>
              </div>
            )}
          />
        </div>
      </SetupPanel>
    );
  }
  return (
    <SetupPanel
      place={place}
      view="another"
      title={t("setupPage.ai.another.title")}
      crumb={crumb}
      foot={null}
    >
      <ul data-testid="setup-another" className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
        {clients.map((client) => {
          const name = clientName(client, t);
          return (
            <li key={client.id} className="flex min-w-0">
              <button
                type="button"
                data-testid="setup-another-app"
                data-value={client.id}
                onClick={() => onChoose(client)}
                className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left text-ui text-ink shadow-[inset_0_0_0_1px_var(--color-rule-strong)] hover:bg-hover"
              >
                <AppMark name={name} />
                <span className="min-w-0 flex-1 truncate" title={name}>
                  {name}
                </span>
                <ChevronRightLineIcon aria-hidden="true" className="shrink-0 text-ink-meta" />
              </button>
            </li>
          );
        })}
      </ul>
    </SetupPanel>
  );
}
