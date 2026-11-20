import type { ChatModelChoice } from "../core/api";

export function meetingSummaryModelRoute(
  model: ChatModelChoice,
  serviceId: string | null = null,
): string {
  return `builtin:${JSON.stringify([model.providerId, model.modelId, serviceId])}`;
}
