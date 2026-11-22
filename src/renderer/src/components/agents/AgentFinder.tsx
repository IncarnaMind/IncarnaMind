import { type ReactNode, useState } from "react";
import type { AgentClient } from "../../../../core/api";
import { agentsShown } from "../../agentList";
import { useT } from "../../i18n";
import { SearchField } from "../SearchField";
import { clientName } from "./agentWords";

/**
 * The agents to connect (#3374), in the setup's Your AI step and Settings › AI: those on this
 * computer first, then the most used, and any other found by typing its name. Each place draws
 * the agents its own way.
 */
export function AgentFinder({
  clients,
  testId,
  children,
}: {
  clients: readonly AgentClient[];
  testId: string;
  children(shown: readonly AgentClient[]): ReactNode;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const shown = agentsShown(clients, query, (client) => clientName(client, t));
  const count = clients.filter((client) => client.id !== "other").length;
  const unmatched = query.trim() !== "" && shown.every((client) => client.id === "other");
  return (
    <div className="flex flex-col gap-2">
      <div data-later-focus>
        <SearchField
          value={query}
          onChange={setQuery}
          label={t("agents.find", { count })}
          testId={`${testId}-search`}
          className="h-8"
        />
      </div>
      {unmatched && (
        <p data-testid={`${testId}-none`} className="px-1 text-[13px] leading-5 text-ink-meta">
          {t("agents.find.none", { query: query.trim() })}
        </p>
      )}
      {children(shown)}
    </div>
  );
}
