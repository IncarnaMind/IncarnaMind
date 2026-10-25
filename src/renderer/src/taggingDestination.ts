import type { DataFlowId, ExternalService, RegisteredDataFlow } from "../../core/api";

/**
 * Where a flow sends now: not known until its flows have been read, a model on
 * this computer, or a service. "Not known" is its own state so nothing says a
 * Document stays here before that is known (#1021).
 */
export type TaggingDestination =
  | { where: "unknown" }
  | { where: "local" }
  | { where: "cloud"; service: ExternalService; allowed: boolean };

export const unknownDestination: TaggingDestination = { where: "unknown" };

/** The first service a flow sends to now; a flow with none runs on this computer. */
export function destinationOf(flows: RegisteredDataFlow[], flow: DataFlowId): TaggingDestination {
  const to = flows.find((each) => each.id === flow)?.services[0];
  return to
    ? { where: "cloud", service: to.flow.service, allowed: to.consent === "accepted" }
    : { where: "local" };
}

/** Where a flow sends once its flows are read; a failed read is reported and leaves it not known. */
export async function destinationFrom(
  read: () => Promise<RegisteredDataFlow[]>,
  flow: DataFlowId,
  report: (error: unknown) => void,
): Promise<TaggingDestination> {
  try {
    return destinationOf(await read(), flow);
  } catch (error) {
    report(error);
    return unknownDestination;
  }
}
