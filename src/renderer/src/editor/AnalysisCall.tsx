import type { AnswerToolCall } from "../../../core/api";
import { CRASHED_LINE, UNAVAILABLE_LINES } from "../../../shared/analysis";
import { TableLineIcon } from "../components/lineIcons";
import { useT } from "../i18n";
import type { Translate } from "../objects";

export function analysisCallText(t: Translate, call: AnswerToolCall): string {
  const ran = call.analysis;
  if (call.status === "running" || !ran) return t("analysis.call.running");
  const [document] = ran.documents;
  switch (ran.end) {
    case "done":
      return document ? t("analysis.call.ran", { document }) : t("analysis.call.ran.none");
    case "error":
      return document ? t("analysis.call.error", { document }) : t("analysis.call.error.none");
    case "timed-out":
      return t("analysis.call.timedOut", { seconds: Math.round((ran.limitMs ?? 60_000) / 1000) });
    case "out-of-memory":
      return t("analysis.call.outOfMemory");
    case "stopped":
      return t("analysis.call.stopped");
    case "crashed":
      return t(CRASHED_LINE);
    case "unavailable":
      return t(UNAVAILABLE_LINES[ran.reason ?? "start"].text);
  }
}

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
        <TableLineIcon className={`answer-call-icon ${running ? "animate-pulse" : ""}`} />
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
