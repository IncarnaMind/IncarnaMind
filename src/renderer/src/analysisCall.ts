import type { AnswerToolCall } from "../../core/api";
import { CRASHED_LINE, UNAVAILABLE_LINES } from "../../shared/analysis";
import type { Translate } from "./objects";

export function analysisCallText(t: Translate, call: AnswerToolCall): string {
  const ran = call.analysis;
  if (call.status === "running") return t("analysis.call.running");
  if (!ran) return t("analysis.call.didNotRun");
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
