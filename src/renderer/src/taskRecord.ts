import type { TaskRecordDetails } from "../../core/api";
import type { Translate } from "./objects";

export function recordLines(
  details: TaskRecordDetails,
  t: Translate,
): {
  sources: string[];
  approvals: string[];
  messages: string[];
} {
  const { sources } = details;
  return {
    sources: sources
      ? sources.declined
        ? [t("task.record.sources.declined")]
        : sources.documents === 0
          ? [t("task.record.sources.empty")]
          : [
              t("task.record.sources.inFolder", {
                saved: t(
                  sources.documents === 1
                    ? "research.summary.saved.one"
                    : "research.summary.saved.other",
                  { count: sources.documents },
                ),
                folder: sources.folder,
              }),
              ...(sources.tags.length > 0
                ? [t("task.record.sources.tags", { tags: sources.tags.join(", ") })]
                : []),
            ]
      : [t("task.record.sources.empty")],
    approvals:
      details.approvals.length > 0
        ? details.approvals.map(
            ({ key, allowed }) =>
              `${key.replace(/^~approve:/, "")}: ${t(allowed ? "task.record.allowed" : "task.record.denied")}`,
          )
        : [t("task.record.approvals.empty")],
    messages: details.messages.length > 0 ? details.messages : [t("task.record.messages.empty")],
  };
}
