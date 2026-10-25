import type { DataFlowId, RegisteredDataFlow, TaggingRoute } from "../../core/api";

/** Where a flow sends: not known yet, no model, a model on this computer, or a service. */
export type FlowRoute = TaggingRoute | { where: "unknown" };

/** Where a flow sends, and whether the flows confirm it: only then is what is sent said. */
export interface TaggingService {
  route: FlowRoute;
  known: boolean;
  /** Whether the User allowed the service; null for a model on this computer, or before the flows are read. */
  allowed: boolean | null;
}

export const unknownService: TaggingService = {
  route: { where: "unknown" },
  known: false,
  allowed: null,
};

/**
 * Where a flow sends, from its model's route when that is read (tagging), else
 * from the flows. `known` is true only once the flows agree, so nothing about
 * what is sent is said before they are read. A flow with no services in the
 * flows is on this computer for Organize and page images; tagging says that
 * only when its model is.
 */
export function serviceOf(
  flow: DataFlowId,
  route: TaggingRoute | null,
  flows: RegisteredDataFlow[] | null,
): TaggingService {
  const registered = flows?.find((each) => each.id === flow);
  const to = registered?.services[0];
  if (flow !== "tagging") {
    if (!registered) return unknownService;
    return to
      ? {
          route: { where: "cloud", service: to.flow.service },
          known: true,
          allowed: to.consent === "accepted",
        }
      : { route: { where: "local" }, known: true, allowed: null };
  }
  if (route === null) {
    // Its model isn't read yet: the flows can still name the service, never say local.
    return to
      ? {
          route: { where: "cloud", service: to.flow.service },
          known: true,
          allowed: to.consent === "accepted",
        }
      : { route: { where: "unknown" }, known: false, allowed: null };
  }
  if (route.where === "none") return { route, known: false, allowed: null };
  if (route.where === "local") {
    return registered && !to
      ? { route, known: true, allowed: null }
      : { route, known: false, allowed: null };
  }
  if (!to || to.flow.service.id !== route.service.id) return { route, known: false, allowed: null };
  return { route, known: true, allowed: to.consent === "accepted" };
}

/** Whether page images go where Organize reads a scan now: a reader on this computer, or an allowed service. */
export function pageImagesSent(reading: boolean, reader: TaggingService): boolean {
  return (
    reading &&
    reader.known &&
    (reader.route.where === "local" || (reader.route.where === "cloud" && reader.allowed === true))
  );
}
