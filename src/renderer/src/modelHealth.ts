import { create } from "zustand";
import type { ChatModelChoice, ProviderError, ProviderErrorKind } from "../../core/api";
import { core } from "./core";

export interface ModelFailure {
  modelId: string;
  error: ProviderError;
  /** ISO 8601. */
  at: string;
}

/**
 * Each chat provider's last real failure, from the Answers it wrote: a later Answer that works,
 * a key saved for it, or signing in to it again clears it. Nothing asks the provider just to
 * fill this.
 */
export const useModelHealth = create<{ failures: Readonly<Record<string, ModelFailure>> }>(() => ({
  failures: {},
}));

const UNHEALTHY: ReadonlySet<ProviderErrorKind> = new Set([
  "auth",
  "model",
  "network",
  "provider",
  "out-of-credit",
  "region",
  "not-signed-in",
  "plan-limit",
  "blocked",
]);

export function clearModelFailure(providerId: string): void {
  useModelHealth.setState(({ failures }) => {
    const { [providerId]: _, ...rest } = failures;
    return { failures: rest };
  });
}

const writing = new Map<string, ChatModelChoice>();
core.on("answer.started", ({ answerId, model }) => writing.set(answerId, model));
core.on("answer.finished", ({ answerId, status }) => {
  const model = writing.get(answerId);
  writing.delete(answerId);
  if (model && status === "done") clearModelFailure(model.providerId);
});
core.on("answer.failed", ({ answerId, error }) => {
  const model = writing.get(answerId);
  writing.delete(answerId);
  if (!model || !UNHEALTHY.has(error.kind)) return;
  const failure = { modelId: model.modelId, error, at: new Date().toISOString() };
  useModelHealth.setState(({ failures }) => ({
    failures: { ...failures, [model.providerId]: failure },
  }));
});
