import type { Task } from "../../../core/api";
import { useT } from "../i18n";
import { taskName } from "../taskText";
import { RemoveIcon } from "./icons";

/** The composer's target (DESIGN.md, Composer › Target): "→ Research ✕", Enter sends to the Task. */
export function TaskTargetChip({
  task,
  canTell,
  onRemove,
}: {
  task: Task;
  canTell: boolean;
  onRemove(): void;
}) {
  const t = useT();
  const name = taskName(task, t);
  return (
    <span
      data-testid="composer-tell"
      title={t(canTell ? "task.tell.hint" : "task.tell.finished", { task: name })}
      className="question-skill"
    >
      <span className="truncate">{t("task.tell.chip", { task: name })}</span>
      <button
        type="button"
        data-testid="composer-tell-remove"
        aria-label={t("task.tell.remove")}
        title={t("task.tell.remove")}
        // The text keeps the focus.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="scope-chip-remove"
      >
        <RemoveIcon className="size-2.5" />
      </button>
    </span>
  );
}
