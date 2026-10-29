import { useEffect, useState } from "react";
import type { TaskRecordDetails } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { recordLines } from "../../taskRecord";
import { MetaLine } from "../MetaLine";

export function TaskRecord({ taskId }: { taskId: string }) {
  const t = useT();
  const [details, setDetails] = useState<TaskRecordDetails | null>(null);
  const report = useAppStore((state) => state.reportError);
  useEffect(() => {
    let current = true;
    core.getTaskRecordDetails(taskId).then((record) => {
      if (current) setDetails(record);
    }, report);
    return () => {
      current = false;
    };
  }, [taskId, report]);
  if (!details) return null;
  const lines = recordLines(details, t);
  return (
    <div data-testid="task-record-details" className="task-progress-details">
      <MetaLine as="p" parts={[t("task.record.sources"), ...lines.sources]} />
      <MetaLine as="p" parts={[t("task.record.approvals"), ...lines.approvals]} />
      <MetaLine as="p" parts={[t("task.record.messages"), ...lines.messages]} />
    </div>
  );
}
