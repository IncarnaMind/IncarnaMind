import { isRecord } from "../../shared/record";
import type { ModelFacts } from "./catalog/types";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** OpenRouter's listing, shared by the bundled catalog and live model lists. */
export function openRouterReasoningFacts(model: Record<string, unknown>): Partial<ModelFacts> {
  const reasoning = isRecord(model.reasoning) ? model.reasoning : null;
  if (reasoning?.mandatory !== true) return {};
  const supported = Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts : [];
  const effort = EFFORTS.find((value) => supported.includes(value));
  return {
    reasoning: true,
    thinkingOff: { openrouter: { reasoning: effort ? { effort } : { enabled: true } } },
    // Mandatory-reasoning Claude endpoints reject forced Tools (#2248).
    ...(typeof model.id === "string" &&
      /^~?anthropic\/claude-/.test(model.id) && {
        forcedToolChoice: false,
      }),
  };
}
