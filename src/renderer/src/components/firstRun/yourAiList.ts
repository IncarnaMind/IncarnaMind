/**
 * The first run's Your AI list (#3791), as plain data: which AI apps count as found, in which order,
 * which one starts ticked, and when an app the User connected still needs them.
 */
import type {
  AgentClient,
  AgentClientId,
  AgentPairing,
  AgentSetupResult,
} from "../../../../core/api";

/** The apps that lead the list when found, in this order; the rest follow in the list's own. */
const FIRST: readonly AgentClientId[] = ["claude-code", "codex", "claude-desktop"];

/** The list shows this many found apps; the rest fold into one row that opens in place. */
export const SHOWN_FIRST = 3;

/**
 * The AI apps on this computer, each once, those that lead first. Claude Code counts as found once
 * its one-press install has put it here, before the list of apps is read again.
 */
export function foundApps(clients: readonly AgentClient[], claudeCodeHere: boolean): AgentClient[] {
  const found = clients.filter(
    (client) =>
      client.id !== "other" &&
      (client.installed || (claudeCodeHere && client.id === "claude-code")),
  );
  const rank = (client: AgentClient) => {
    const at = FIRST.indexOf(client.id);
    return at === -1 ? FIRST.length : at;
  };
  return found
    .map((client, index) => ({ client, index }))
    .sort((a, b) => rank(a.client) - rank(b.client) || a.index - b.index)
    .map(({ client }) => client);
}

/** The apps a step can still connect: found, and not connected already. */
export const notConnected = (
  found: readonly AgentClient[],
  pairings: readonly AgentPairing[],
): AgentClient[] => {
  const inUse = new Set(pairings.map((pairing) => pairing.client));
  return found.filter((client) => !inUse.has(client.id));
};

/**
 * The one app ticked as the step opens: the first found that isn't connected, while none is. With
 * one connected already, the User came back to the step, and nothing is ticked for them.
 */
export function firstTicked(
  found: readonly AgentClient[],
  pairings: readonly AgentPairing[],
): AgentClientId | null {
  if (pairings.length > 0) return null;
  return notConnected(found, pairings)[0]?.id ?? null;
}

/** A small mark for an app until it has its own icon: its name's first letters, two at most. */
export function monogram(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const [first = "", second] = words;
  const initial = (word: string) => Array.from(word)[0] ?? "";
  const capital = second !== undefined && /^\p{Lu}/u.test(second);
  return `${initial(first)}${capital ? initial(second) : ""}`.toUpperCase();
}

/**
 * Whether a connected app still needs the User: its own app's Install not pressed yet, or a line
 * not yet pasted, until it has first reached IncarnaMind.
 */
export function stillNeedsUser(
  result: AgentSetupResult,
  pairing: Pick<AgentPairing, "id" | "lastUsedAt"> | undefined,
  awaitingInstall: readonly string[],
): boolean {
  if (result.kind === "wrote") return false;
  if (!pairing) return true;
  if (result.kind === "opened" && result.how === "bundle") {
    return awaitingInstall.includes(pairing.id);
  }
  return pairing.lastUsedAt === null;
}
