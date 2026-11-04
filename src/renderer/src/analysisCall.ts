import type { AnswerToolCall, EmbeddingModelError, EmbeddingModelStatus } from "../../core/api";
import { ANALYSIS_TIME_LIMIT_MS, CRASHED_LINE, UNAVAILABLE_LINES } from "../../shared/analysis";
import type { MessageKey } from "../../shared/i18n";
import { downloadProgress } from "./modelDownload";
import type { Translate } from "./objects";

const PYTHON_FAILURES: Record<EmbeddingModelError["kind"], MessageKey> = {
  network: "embedding.model.failure.network",
  integrity: "embedding.model.failure.integrity",
  storage: "embedding.model.failure.storage",
  load: "analysis.python.failure.load",
};

/**
 * What an Analysis call's step says. `python`: `run_code`'s Python, which a call that runs
 * Python waits on while it downloads the first time (ADR-0025).
 */
export function analysisCallText(
  t: Translate,
  call: AnswerToolCall,
  python: EmbeddingModelStatus | null = null,
): string {
  const ran = call.analysis;
  if (call.status === "running") {
    const waits = call.tool === "run_code" && call.input.language !== "bash";
    if (waits && python?.state === "downloading") {
      if (python.downloadedBytes >= python.totalBytes)
        return t("analysis.call.preparing.unpacking");
      const { downloaded, total } = downloadProgress(python, t);
      return t("analysis.call.preparing", { downloaded, total });
    }
    return t("analysis.call.running");
  }
  if (!ran) return t("analysis.call.didNotRun");
  const [document] = ran.documents;
  switch (ran.end) {
    case "done":
      return document ? t("analysis.call.ran", { document }) : t("analysis.call.ran.none");
    case "error":
      return document ? t("analysis.call.error", { document }) : t("analysis.call.error.none");
    case "timed-out":
      return t("analysis.call.timedOut", {
        seconds: Math.round((ran.limitMs ?? ANALYSIS_TIME_LIMIT_MS) / 1000),
      });
    case "out-of-memory":
      return t("analysis.call.outOfMemory");
    case "stopped":
      return t("analysis.call.stopped");
    case "crashed":
      return t(CRASHED_LINE);
    case "unavailable":
      return ran.reason === "python" && ran.python
        ? t("analysis.unavailable.python", { reason: t(PYTHON_FAILURES[ran.python]) })
        : t(UNAVAILABLE_LINES[ran.reason ?? "start"].text);
  }
}
