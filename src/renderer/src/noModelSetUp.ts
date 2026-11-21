import type { ChatReadiness } from "../../core/api";

/**
 * No model is set up in IncarnaMind: the readiness Questions use says there is no provider. A
 * model whose key or sign-in needs attention, or that Local mode holds back, is set up.
 */
export const noModelSetUp = (
  readiness: ChatReadiness | null,
): readiness is Extract<ChatReadiness, { ready: false; reason: "no-provider" }> =>
  readiness?.ready === false && readiness.reason === "no-provider";
