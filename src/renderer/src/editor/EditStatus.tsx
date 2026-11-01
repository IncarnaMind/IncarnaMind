import { ProblemLine } from "../components/ProblemLine";
import { readinessAction, readinessAlso } from "../components/providers/ChatReadinessNotice";
import { readinessKey, serviceName } from "../components/providers/shared";
import {
  dismissEditProblem,
  type EditProblem,
  stopEdit,
  TRANSLATE_LANGUAGES,
  useEdits,
} from "../editWithAi";
import { providerErrorText } from "../errors";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";

/**
 * Edit with AI in the composer's row (#93): what the AI is doing with the
 * selected text, with Stop, while it works; or, when it gave no changes, why,
 * as one line with the one thing that helps (DESIGN.md, Problems).
 */
export function EditStatus({ mindId }: { mindId: string }) {
  const t = useT();
  const pending = useEdits((state) => state.pending[mindId]);
  const problem = useEdits((state) => state.problems[mindId]);

  if (pending?.menu || problem?.menu) return null;
  if (pending) {
    const language =
      TRANSLATE_LANGUAGES.find((each) => each.prompt === pending.language)?.name ??
      pending.language ??
      "";
    return (
      <ProblemLine
        role="status"
        testId="edit-pending"
        className="composer-problem"
        details={pending.estimate?.parts ?? []}
        title={pending.estimate?.title}
        action={{ label: t("edit.stop"), testId: "edit-stop", onClick: () => stopEdit(mindId) }}
      >
        <span className="edit-pending-dot" aria-hidden="true" />
        {pending.part
          ? t("edit.pending.part", { at: pending.part.at, of: pending.part.of })
          : t(`edit.pending.${pending.action}`, { language })}
      </ProblemLine>
    );
  }
  return problem ? <EditProblemLine mindId={mindId} problem={problem} /> : null;
}

/** What an Edit with AI problem's line says and offers. */
export interface EditProblemParts {
  text: string;
  /** The one thing that helps: Try again, a model, or the way to set one up. */
  action?: { label: string; run(): void };
  /** A second way out, beside the action (a sign-in route's other way back). */
  also?: { label: string; run(): void };
  role: "alert" | "status";
}

/**
 * The words and actions of the one line for why an Edit with AI gave no
 * changes, for either place it shows: the composer or the selection menu, and
 * the page's line under the text (`useMenuEditLine`). One copy, so the two
 * cannot drift apart. `onRetry` is told as Try again asks for the edit again.
 */
export function editProblemParts(
  problem: EditProblem,
  t: ReturnType<typeof useT>,
  language: ReturnType<typeof useLanguage>,
  openSettings: ReturnType<typeof useAppStore.getState>["openSettings"],
  mindId: string,
  onRetry?: () => void,
): EditProblemParts {
  switch (problem.kind) {
    case "not-ready": {
      const { readiness } = problem;
      const service = "provider" in readiness ? serviceName(readiness.provider, t, language) : "";
      const way = readinessAction(readiness, t, openSettings, t("question.setUp"), () =>
        dismissEditProblem(mindId),
      );
      const other = readinessAlso(readiness, t, openSettings, () => dismissEditProblem(mindId));
      return {
        text: t(readinessKey(readiness), { service }).replace(/[.。]$/, ""),
        action: { label: way.label, run: way.onClick },
        ...(other ? { also: { label: other.label, run: other.onClick } } : {}),
        role: "alert",
      };
    }
    case "block-too-long":
      return {
        // A Block can't be split: the model that can't take it is the one to change.
        text: t("edit.problem.block-too-long", {
          model: problem.model ?? t("answer.error.thisModel"),
        }),
        action: {
          label: t("edit.problem.chooseAnotherModel"),
          run: () => {
            dismissEditProblem(mindId);
            openSettings("models");
          },
        },
        role: "alert",
      };
    case "local-mode":
      return {
        text: t("edit.problem.local-mode"),
        action: {
          label: t("edit.problem.chooseModel"),
          run: () => {
            dismissEditProblem(mindId);
            openSettings("models");
          },
        },
        role: "alert",
      };
    case "failed":
      return {
        text: t("edit.problem.failed", { message: problem.message }),
        action: {
          label: t("edit.problem.retry"),
          run: () => {
            dismissEditProblem(mindId);
            onRetry?.();
            problem.retry();
          },
        },
        role: "alert",
      };
    case "consent-revoked":
      return { text: providerErrorText(problem.error, t), role: "alert" };
    case "unchanged":
      return {
        text: problem.said
          ? t("edit.problem.unchanged.said", { said: problem.said })
          : t("edit.problem.unchanged"),
        role: "status",
      };
    default:
      return {
        text: t(`edit.problem.${problem.kind}`),
        role: "alert",
      };
  }
}

/**
 * The one line for why an Edit with AI gave no changes, with the one thing
 * that helps. `onRetry` is told as Try again asks for the edit again.
 */
export function EditProblemLine({
  mindId,
  problem,
  className = "composer-problem",
  onRetry,
}: {
  mindId: string;
  problem: EditProblem;
  className?: string;
  onRetry?(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const openSettings = useAppStore((state) => state.openSettings);
  const parts = editProblemParts(problem, t, language, openSettings, mindId, onRetry);
  const close = {
    label: t("edit.close"),
    testId: "edit-problem-close",
    onClick: () => dismissEditProblem(mindId),
  };
  const action = parts.action
    ? { label: parts.action.label, onClick: () => parts.action?.run() }
    : close;
  const also = parts.also && { label: parts.also.label, onClick: () => parts.also?.run() };
  return (
    <ProblemLine
      role={parts.role}
      testId="edit-problem"
      className={className}
      action={action}
      {...(also ? { also } : {})}
    >
      {parts.text}
    </ProblemLine>
  );
}
