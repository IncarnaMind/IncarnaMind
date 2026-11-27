import type { Task } from "../../../core/api";
import { RemoveIcon } from "../components/icons";
import { useT } from "../i18n";
import { taskName } from "../taskText";

/** The composer's target (DESIGN.md, Composer › Target): "→ Research ✕", Enter sends to the Task. */
export function TaskTargetChip({ task, onRemove }: { task: Task; onRemove(): void }) {
  const t = useT();
  const name = taskName(task, t);
  return (
    <span
      data-testid="composer-tell"
      title={t("task.tell.hint", { task: name })}
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
        <RemoveIcon />
      </button>
    </span>
  );
}
