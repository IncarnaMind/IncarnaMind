import { type ReactNode, useEffect } from "react";
import type { ProviderErrorKind } from "../../../../core/api";
import { useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { ollamaLineAction } from "../../ollamaProblem";
import { useAppStore } from "../../store";
import { type ProblemAction, ProblemLine } from "../ProblemLine";
import { getOllama } from "./GetOllama";
import { useOllamaStatus } from "./OllamaCard";

function AnswerProblem({
  kind,
  details,
  action,
  children,
}: {
  kind: ProviderErrorKind;
  details: string | null;
  action: ProblemAction | undefined;
  children: ReactNode;
}) {
  return (
    <div contentEditable={false} data-testid="answer-error" data-error-kind={kind}>
      <ProblemLine
        action={action && { ...action, testId: "answer-error-action" }}
        title={details ?? undefined}
        className="mt-1 select-none"
      >
        {children}
      </ProblemLine>
    </div>
  );
}

export function LocalModelRefusedLine({
  model,
  details,
}: {
  model: string;
  details: string | null;
}) {
  const t = useT();
  return (
    <AnswerProblem
      kind="local-mode"
      details={details}
      action={{
        label: t("localMode.turnOff"),
        onClick: () =>
          turnOffLocalMode().catch((error: unknown) => useAppStore.getState().reportError(error)),
      }}
    >
      {t("answer.error.local-mode", { model })}
    </AnswerProblem>
  );
}

export function OllamaNotRunningLine({
  details,
  onRetry,
}: {
  details: string | null;
  onRetry?: (() => void) | undefined;
}) {
  const t = useT();
  const { status, opening, detect, open } = useOllamaStatus();
  // Back from getting Ollama, or from starting it by hand: Try again once it runs.
  useEffect(() => {
    const lookAgain = () => void detect();
    window.addEventListener("focus", lookAgain);
    return () => window.removeEventListener("focus", lookAgain);
  }, [detect]);
  const next = ollamaLineAction(status, opening);
  let action: ProblemAction | undefined;
  if (next === "try-again" && onRetry) {
    action = { label: t("answer.error.retry"), onClick: onRetry };
  } else if (next === "open") {
    action = {
      label: t("localModel.open"),
      onClick: () =>
        void open().then((opened) => {
          if (opened?.running) onRetry?.();
        }),
    };
  } else if (next === "get") {
    action = { label: `${t("providers.ollama.get")} ↗`, onClick: getOllama };
  }
  return (
    <AnswerProblem kind="ollama-not-running" details={details} action={action}>
      {opening ? t("localModel.opening") : t("answer.error.ollama-not-running")}
    </AnswerProblem>
  );
}
