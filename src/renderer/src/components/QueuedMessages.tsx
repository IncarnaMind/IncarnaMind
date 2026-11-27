import type { Task } from "../../../core/api";
import { cutTitle } from "../../../shared/naming";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { takeBack } from "../taskTell";
import { RemoveIcon } from "./icons";

/**
 * What the User told a Task that it hasn't read yet (DESIGN.md, Task tray ›
 * Queued messages), nearest the composer: "↳ “…” · read at the next step",
 * wrapping rather than cut, each with ✕ to take it back.
 */
export function QueuedMessages({ task }: { task: Task }) {
  const t = useT();
  const report = useAppStore((state) => state.reportError);
  return (
    <ul data-testid="task-queued" aria-label={t("task.queued.label")} className="task-queued">
      {task.queued.map((message) => (
        <li key={message.id} data-testid="task-queued-message" className="task-queued-message">
          <span aria-hidden="true" className="task-queued-arrow">
            ↳
          </span>
          <span className="task-queued-text">
            {t("task.queued.text", { text: message.text })}
            <span className="task-queued-when"> · {t("task.queued.when")}</span>
          </span>
          <button
            type="button"
            data-testid="task-queued-remove"
            aria-label={t("task.queued.remove", { text: cutTitle(message.text) })}
            title={t("task.queued.remove", { text: cutTitle(message.text) })}
            onClick={() => takeBack(task, message).catch(report)}
            className="task-queued-remove"
          >
            <RemoveIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}
