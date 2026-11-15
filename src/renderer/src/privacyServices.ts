import type { DataFlowStatus, ExternalService, RegisteredDataFlow } from "../../core/api";

export interface ServiceUse {
  flow: RegisteredDataFlow["id"];
  sends: RegisteredDataFlow["sends"];
  status: DataFlowStatus;
}

export interface ServiceGroup {
  service: ExternalService;
  uses: ServiceUse[];
}

/** What the Privacy page says of a service, from its uses taken together. */
export type ServiceDecision =
  | { kind: "accepted"; chosen: boolean; at: string | null }
  | { kind: "partly" }
  | { kind: "declined"; at: string | null }
  | { kind: "sendsMore" }
  | { kind: "not-asked" };

export function groupByService(flows: readonly RegisteredDataFlow[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const flow of flows) {
    for (const status of flow.services) {
      const { service } = status.flow;
      const group = groups.get(service.id) ?? { service, uses: [] };
      group.uses.push({ flow: flow.id, sends: flow.sends, status });
      groups.set(service.id, group);
    }
  }
  return [...groups.values()];
}

/** Whether the use goes on now: the User allowed it, or it is on by default with another they allowed. */
export const inEffect = ({ status }: ServiceUse): boolean =>
  status.consent === "accepted" || status.byDefault === true;

/**
 * A service the User allowed everywhere says so once, with the first date; one
 * allowed for some uses only says that; the rest say the worst of their uses
 * (declined, then asks again because it sends more, then not asked). A use that is on by default
 * rests on the others' decision and adds none of its own.
 */
export function decisionOf(uses: readonly ServiceUse[]): ServiceDecision {
  const accepted = uses.filter(inEffect);
  if (accepted.length === uses.length && accepted.length > 0) {
    const decided = accepted.filter((use) => !use.status.byDefault);
    const dates = decided.flatMap((use) => use.status.decidedAt ?? []).sort();
    return {
      kind: "accepted",
      chosen: decided.every((use) => use.status.chosen),
      at: dates[0] ?? null,
    };
  }
  if (accepted.length > 0) return { kind: "partly" };
  const declined = uses.filter((use) => use.status.consent === "declined");
  if (declined.length > 0) {
    const dates = declined.flatMap((use) => use.status.decidedAt ?? []).sort();
    return { kind: "declined", at: dates.at(-1) ?? null };
  }
  if (uses.some((use) => use.status.decidedAt !== null)) return { kind: "sendsMore" };
  return { kind: "not-asked" };
}
