import type { AnswerToolCall } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { namedMind, problemText } from "../../changeProblems";
import { useT } from "../../i18n";
import type { Translate } from "../../objects";
import { useAppStore } from "../../store";
import { MindLineIcon } from "../lineIcons";

/**
 * The Mind a call of a Minds' Tool (#202) is about, as the User knows it: the
 * one it changed or made, or the one it couldn't change, by its name now;
 * else the one it named, or the title it gave; else the Mind in focus.
 */
function useCallMind(call: AnswerToolCall): { mindId: string | null; name: string } {
  const t = useT();
  const problem = call.mindProblem;
  const changed =
    call.mindChange?.mindId ?? (problem && "mindId" in problem ? problem.mindId : null);
  const mind = useAppStore((state) =>
    changed ? state.minds.find((each) => each.id === changed) : undefined,
  );
  return { mindId: mind ? changed : null, name: (mind && mindName(mind)) || namedMind(t, call) };
}

/** What a call of a Minds' Tool is doing, or did, in its row's words. */
export function mindCallText(t: Translate, call: AnswerToolCall, mind: string): string {
  const change = call.mindChange;
  if (call.status === "running") {
    if (call.tool === "read_mind") return t("mindCall.reading", { mind });
    const checking = change?.checking ?? 0;
    if (checking > 0) {
      return checking === 1
        ? t("mindCall.checking.one", { mind })
        : t("mindCall.checking", { mind, count: checking });
    }
    if (call.tool === "create_mind") {
      return mind ? t("mindCall.creating", { mind }) : t("mindCall.creating.new");
    }
    return t(call.tool === "add_to_mind" ? "mindCall.adding" : "mindCall.editing", { mind });
  }
  if (call.status === "failed") {
    const why = call.mindProblem && problemText(t, call.mindProblem, mind);
    if (why) return why;
    if (call.tool === "read_mind") return t("mindCall.readFailed", { mind });
    return t(call.tool === "create_mind" ? "mindCall.createFailed" : "mindCall.failed", { mind });
  }
  if (call.tool === "read_mind") return t("mindCall.read", { mind });
  const count = change?.proposals ?? 0;
  if (change?.created) {
    if (count === 0) return t("mindCall.created", { mind });
    return t(count === 1 ? "mindCall.created.one" : "mindCall.created.changes", { mind, count });
  }
  if (!change) return t("mindCall.unchanged", { mind });
  if (change.revised) {
    if (count === 0) return t("mindCall.revised.none", { mind });
    return t(count === 1 ? "mindCall.revised.one" : "mindCall.revised", { mind, count });
  }
  return t(count === 1 ? "mindCall.edited.one" : "mindCall.edited", { mind, count });
}

/**
 * The row of a call of a Minds' Tool (#202): what it read, changed or made,
 * with Open for a Mind it changed or made.
 */
export function MindCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const { mindId, name } = useCallMind(call);
  const text = mindCallText(t, call, name);
  const running = call.status === "running";
  return (
    <div
      contentEditable={false}
      data-testid="answer-mind-call"
      data-tool={call.tool}
      data-status={call.status}
      className="answer-call"
    >
      <span className="answer-call-summary answer-call-summary--static">
        <MindLineIcon
          className={`answer-call-icon ${running ? "motion-safe:animate-pulse" : ""}`}
        />
        <span className="answer-call-text" title={text}>
          {text}
        </span>
        {mindId && call.mindChange && (
          <button
            type="button"
            data-testid="answer-mind-open"
            onClick={() => useAppStore.getState().openMind(mindId)}
            className="answer-action"
          >
            {t("mindCall.open")}
          </button>
        )}
      </span>
    </div>
  );
}
