import { AnswerError } from "../../editor/AnswerView";
import { useModelHealth } from "../../modelHealth";
import { useModelInUse } from "../../modelInUse";
import { useAppStore } from "../../store";

export function ModelHealthLine() {
  const choice = useModelInUse(null);
  const failure = useModelHealth((state) =>
    choice ? state.failures[choice.providerId] : undefined,
  );
  const openSettings = useAppStore((state) => state.openSettings);
  // A model that failed as a model says nothing of another of the provider's models.
  if (
    !choice ||
    !failure ||
    (failure.error.kind === "model" && failure.modelId !== choice.modelId)
  ) {
    return null;
  }
  return (
    <div data-testid="model-health" className="flex basis-full items-start gap-2">
      <span
        aria-hidden="true"
        data-testid="model-health-dot"
        className="mt-[11px] size-1.5 shrink-0 rounded-full bg-attention"
      />
      <AnswerError
        kind={failure.error.kind}
        modelId={failure.modelId}
        providerId={choice.providerId}
        resetsAt={failure.error.resetsAt ?? null}
        signInRoute={failure.error.signInRoute ?? null}
        details={failure.error.message}
        failedAt={failure.at}
        onOpenSettings={openSettings}
      />
    </div>
  );
}
