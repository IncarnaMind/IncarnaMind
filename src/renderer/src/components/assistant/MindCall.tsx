import type { AnswerToolCall } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { mindCallText } from "../../answerStepWords";
import { namedMind } from "../../changeProblems";
import { useT } from "../../i18n";
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
