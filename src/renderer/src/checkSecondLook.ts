import type { JevSettings, RegisteredDataFlow } from "../../core/api";

/**
 * Whether a check's second look catches a change of obligation on this device
 * (#1926): Jev is set up with its key, and the checks flow is allowed to send
 * a Supported sentence and its quote to it. No such consent exists before the
 * second look registers on the checks flow, so the card says what it misses.
 */
export function secondLookOn(
  jev: JevSettings | null,
  flows: readonly RegisteredDataFlow[],
): boolean {
  const service = jev?.service;
  if (!jev?.enabled || !jev.hasApiKey || !service) return false;
  const checks = flows.find((flow) => flow.id === "checks");
  return (
    checks?.services.some(
      (each) => each.flow.service.id === service.id && each.consent === "accepted",
    ) === true
  );
}
