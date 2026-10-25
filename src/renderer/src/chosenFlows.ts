import { CHOSEN_PROVIDER_FLOWS, type ChosenProviderFlow } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";

const FLOW_LINES = {
  chat: "providers.sends.chat",
  checks: "providers.sends.checks",
  suggestions: "providers.sends.suggestions",
  edits: "providers.sends.edits",
} as const satisfies Record<ChosenProviderFlow, MessageKey>;

const linesOf = (lines: Record<ChosenProviderFlow, MessageKey>): MessageKey[] => [
  ...new Set(CHOSEN_PROVIDER_FLOWS.map((flow) => lines[flow])),
];

/** The list behind Details: what every flow that choosing the provider allows sends. */
export const chosenFlowLines = (): MessageKey[] => linesOf(FLOW_LINES);
