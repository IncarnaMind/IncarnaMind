import type { AgentClient } from "../../core/api";

/** How many agents a list shows before the User types, Other agent aside. */
export const LISTED_AT_FIRST = 7;

const folded = (text: string) => text.toLocaleLowerCase().replace(/[\s._-]+/g, "");

/**
 * The agents a list shows, from the core's list (those on this computer first, then the most
 * used). Before anything is typed: every agent found here, then the most used up to
 * LISTED_AT_FIRST. Typed: every agent whose name, or another name it goes by, holds what was
 * typed. Other agent comes last either way, for any agent the list doesn't name.
 */
export function agentsShown(
  clients: readonly AgentClient[],
  query: string,
  nameOf: (client: AgentClient) => string,
): AgentClient[] {
  const agents = clients.filter((client) => client.id !== "other");
  const other = clients.filter((client) => client.id === "other");
  const typed = folded(query);
  if (typed === "") {
    const found = agents.filter((client) => client.installed);
    const more = agents.filter((client) => !client.installed);
    return [...found, ...more.slice(0, Math.max(0, LISTED_AT_FIRST - found.length)), ...other];
  }
  const named = agents.filter((client) =>
    [nameOf(client), client.name, ...client.otherNames].some((name) =>
      folded(name).includes(typed),
    ),
  );
  return [...named, ...other];
}
