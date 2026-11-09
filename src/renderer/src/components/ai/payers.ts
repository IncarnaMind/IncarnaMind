import type { ChatProvider } from "../../../../core/api";

/** Who pays for a model, as every picker on Settings › AI groups them: a plan, a key, or no one. */
export type Payer = { kind: "plan"; providerId: string } | { kind: "keys" } | { kind: "local" };

export const isPlan = (provider: Pick<ChatProvider, "kind">): boolean =>
  provider.kind === "chatgpt" || provider.kind === "claude-account" || provider.kind === "copilot";

export function payerOf(provider: ChatProvider): Payer {
  if (isPlan(provider)) return { kind: "plan", providerId: provider.id };
  return provider.service === null ? { kind: "local" } : { kind: "keys" };
}

const payerKey = (payer: Payer) =>
  payer.kind === "plan" ? `plan:${payer.providerId}` : payer.kind;

/**
 * Items in the pickers' order: each plan's own group first, then the User's keys, then this
 * computer. Within a group the items keep the order they came in.
 */
export function groupByPayer<T>(
  items: readonly T[],
  payer: (item: T) => Payer,
): { payer: Payer; items: T[] }[] {
  const groups = new Map<string, { payer: Payer; items: T[] }>();
  for (const item of items) {
    const each = payer(item);
    const key = payerKey(each);
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { payer: each, items: [item] });
  }
  const rank = (each: Payer) => (each.kind === "plan" ? 0 : each.kind === "keys" ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a.payer) - rank(b.payer));
}
