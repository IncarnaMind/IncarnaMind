import type { AgentClient } from "../../core/api";

const folded = (text: string) => text.toLocaleLowerCase().replace(/[\s._-]+/g, "");

/**
 * The agents a list shows, from the core's list (those on this computer first, then the most
 * used): chat apps before coding tools (#3487), those found here first in each. Before anything is
 * typed: every agent, so none leaves the list because another was found (#3767). Typed: every
 * agent whose name, or another name it goes by, holds what was typed. Other agent comes last
 * either way, for any agent the list doesn't name.
 */
export function agentsShown(
  clients: readonly AgentClient[],
  query: string,
  nameOf: (client: AgentClient) => string,
): AgentClient[] {
  const agents = clients.filter((client) => client.id !== "other");
  const other = clients.filter((client) => client.id === "other");
  const typed = folded(query);
  const chatFirst = (list: readonly AgentClient[]) => [
    ...list.filter((client) => client.chat),
    ...list.filter((client) => !client.chat),
  ];
  if (typed === "") return [...chatFirst(agents), ...other];
  const named = agents.filter((client) =>
    [nameOf(client), client.name, ...client.otherNames].some((name) =>
      folded(name).includes(typed),
    ),
  );
  return [...chatFirst(named), ...other];
}
