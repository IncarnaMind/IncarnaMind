import type { AnswerToolCall } from "../../../core/api";
import { UNAVAILABLE_LINES } from "../../../shared/analysis";
import { analysisCallText } from "../analysisCall";
import { useT } from "../i18n";
import { TableIcon } from "./icons";

export function AnalysisCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const running = call.status === "running";
  const text = analysisCallText(t, call);
  const fix =
    call.analysis?.end === "unavailable"
      ? UNAVAILABLE_LINES[call.analysis.reason ?? "start"].fix
      : undefined;
  return (
    <div
      contentEditable={false}
      data-testid="answer-analysis-call"
      data-status={call.status}
      data-end={call.analysis?.end ?? ""}
      className="answer-call"
    >
      <span className="answer-call-summary answer-call-summary--static">
        <TableIcon className={`answer-call-icon ${running ? "animate-pulse" : ""}`} />
        <span className="answer-call-text" title={text}>
          {text}
        </span>
        {fix && (
          <a
            data-testid="answer-analysis-fix"
            href={fix.url}
            target="_blank"
            rel="noreferrer"
            className="answer-action"
          >
            {t(fix.label)}
          </a>
        )}
      </span>
    </div>
  );
}
