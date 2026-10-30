import type { RegisteredDataFlow, TaggingFlow, TaggingRoute } from "../../core/api";

/** Where a flow sends: not known yet, no model, a model on this computer, or a service. */
export type FlowRoute = TaggingRoute | { where: "unknown" };

/** Where a flow sends, and whether the flows confirm it: only then is what is sent said. */
export interface TaggingService {
  route: FlowRoute;
  known: boolean;
  /** Whether the User allowed the service; null for a model on this computer, or before the flows are read. */
  allowed: boolean | null;
  /** A cloud page reader also receives classification context, under that flow's consent. */
  classificationAllowed?: boolean | null;
}

export const unknownService: TaggingService = {
  route: { where: "unknown" },
  known: false,
  allowed: null,
};

/**
 * The current model names the destination; the flow's matching service names
 * its consent. A retained decision never becomes a current destination.
 */
export function serviceOf(
  flow: TaggingFlow,
  route: TaggingRoute | null,
  flows: RegisteredDataFlow[] | null,
): TaggingService {
  const registered = flows?.find((each) => each.id === flow);
  if (route === null) return unknownService;
  if (route.where === "none") return { route, known: false, allowed: null };
  if (route.where === "local") {
    return { route, known: registered !== undefined, allowed: null };
  }
  const to = registered?.services.find((each) => each.flow.service.id === route.service.id);
  if (!to) return { route, known: false, allowed: null };
  return {
    route,
    known: true,
    allowed: to.consent === "accepted",
    ...(flow === "scan-images" && {
      classificationAllowed: serviceOf("classification", route, flows).allowed,
    }),
  };
}

/** Whether page images go where Organize reads a scan now: a reader on this computer, or an allowed service. */
export function pageImagesSent(reading: boolean, reader: TaggingService): boolean {
  return (
    reading &&
    reader.known &&
    (reader.route.where === "local" ||
      (reader.route.where === "cloud" &&
        reader.allowed === true &&
        reader.classificationAllowed === true))
  );
}
