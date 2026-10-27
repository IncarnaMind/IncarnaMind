import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Task } from "../../../core/api";
import { mindName } from "../../../shared/naming";
import { focusComposer } from "../commands/assistant";
import { shortcutLabel } from "../commands/keymap";
import { dayOf } from "../dates";
import { withShortcut } from "../editor/withShortcut";
import { useLanguage, useT } from "../i18n";
import type { Translate } from "../objects";
import { useAppStore } from "../store";
import { taskRowActions } from "../taskActions";
import { chipOf, needsYou, taskGroups } from "../taskGroups";
import { useTaskMenu } from "../taskMenu";
import { loadTasks, showTask, useTasks } from "../tasks";
import { resultLine, stepLine, taskName } from "../taskText";
import { CheckLineIcon } from "./lineIcons";
import { buttonStyle } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

/** Room kept between the popover and the assistant below it. */
const ASSISTANT_GAP_PX = 8;

const allTasks = (state: { tasks: Readonly<Record<string, Task>> }) => Object.values(state.tasks);

/**
 * Ends the popover above the assistant when the assistant sits below it (docked at the
 * bottom, or floating), so it never covers the composer or the Question being asked.
 */
function keepAboveAssistant(menu: HTMLElement | null): void {
  const assistant = document.querySelector('[data-testid="assistant"]');
  if (!menu || !assistant) return;
  menu.style.removeProperty("max-height");
  const own = menu.getBoundingClientRect();
  const other = assistant.getBoundingClientRect();
  const across = own.left < other.right && other.left < own.right;
  if (across && other.top > own.top && own.bottom > other.top - ASSISTANT_GAP_PX) {
    menu.style.maxHeight = `${Math.max(0, other.top - own.top - ASSISTANT_GAP_PX)}px`;
  }
}

/**
 * The Tasks chip (#126; DESIGN.md, Finding Tasks; the board Tasks-Chip-Popover):
 * in the band, only while a Task runs or needs the User. Its popover lists
 * Needs you · Running · Recent (7 days); a row opens its Mind at the Task's
 * place, with its row in the tray, and offers Stop while its Task is still
 * going. Esc or a click outside closes it. "Show Tasks" opens it too when no
 * chip shows, from the band's corner, so Recent is always in reach.
 */
export function TasksChip() {
  const t = useT();
  const tasks = useTasks(useShallow(allTasks));
  const chip = chipOf(tasks);
  // Under the band, its right edge by the chip's: over the card, never the assistant beside it.
  const menu = usePopoverMenu({
    focus: "first",
    around: (button) => button.closest<HTMLElement>('[data-testid="tab-strip"]'),
    // The chip goes once the last Task stops, and the anchor can't take the focus: the User's
    // place is the composer they were in.
    whenFocusGone: focusComposer,
  });
  const { open } = menu;
  const menuRef = menu.menuProps.ref;
  const asked = useTaskMenu((state) => state.open);
  /** It was asked for from ⌘K: it shows and opens even with no chip in the band. */
  const [forced, setForced] = useState(false);
  /**
   * The Task a row action just acted on, and when it was last updated: its row takes the focus
   * back once that Task has changed, not when another Task's progress draws the list again.
   */
  const acted = useRef<{ id: string; updatedAt: string } | null>(null);

  useEffect(loadTasks, []);
  useLayoutEffect(() => {
    if (!asked) return;
    useTaskMenu.getState().taken();
    setForced(true);
  }, [asked]);
  useLayoutEffect(() => {
    if (!forced) return;
    const element = menuRef.current;
    if (element && !element.matches(":popover-open")) element.showPopover();
  }, [forced, menuRef]);
  useLayoutEffect(() => {
    if (open) keepAboveAssistant(menuRef.current);
  }, [open, menuRef]);
  // A row's action may take its button away, and the row may move to another group, which draws a
  // new row: the focus comes back to the row the Task is in now, once that Task has changed and
  // not when another one's progress draws the list again. A field an action opened keeps it.
  useLayoutEffect(() => {
    const pending = acted.current;
    if (pending === null) return;
    const task = tasks.find((each) => each.id === pending.id);
    if (task && task.updatedAt === pending.updatedAt) return;
    acted.current = null;
    const item = menuRef.current?.querySelector<HTMLElement>(
      `[data-task="${CSS.escape(pending.id)}"]`,
    );
    const focused = document.activeElement;
    const kept = item != null && focused instanceof HTMLElement && item.contains(focused);
    if (!kept) item?.querySelector<HTMLElement>('[data-testid="tasks-popover-row"]')?.focus();
  }, [tasks, menuRef]);

  // Kept mounted while it is open: the last Task stopping takes the chip away, and its row, now
  // in Recent, must keep the focus the User's action gave it.
  if (!chip && !forced && !open) return null;
  const summary = chip
    ? chip.running > 0
      ? t("tasks.chip.running", { count: chip.running })
      : t("tasks.chip.needsYou", { count: chip.needsYou })
    : "";
  return (
    <>
      {chip ? (
        <button
          type="button"
          {...menu.buttonProps}
          data-testid="tasks-chip"
          data-needs-you={chip.needsYou > 0 || undefined}
          aria-label={t("tasks.chip.label", { summary })}
          className="tasks-chip"
        >
          <span
            aria-hidden="true"
            className={chip.needsYou > 0 ? "task-dot task-dot--attention" : "task-dot"}
          />
          {summary}
        </button>
      ) : (
        <button
          type="button"
          {...menu.buttonProps}
          tabIndex={-1}
          aria-hidden="true"
          data-testid="tasks-anchor"
          className="tasks-anchor"
        />
      )}
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("tasks.popover.label")}
        data-testid="tasks-popover"
        className="model-menu tasks-popover"
        onToggle={(event) => {
          menu.menuProps.onToggle(event);
          // A close's event comes a task later, after Show Tasks may have opened it again: only
          // a close that is still one takes it off the screen.
          if (event.newState === "closed" && !menuRef.current?.matches(":popover-open")) {
            setForced(false);
          }
        }}
      >
        {open && (
          <TaskLists
            tasks={tasks}
            close={menu.close}
            onAct={(task) => {
              acted.current = { id: task.id, updatedAt: task.updatedAt };
            }}
          />
        )}
      </div>
    </>
  );
}

function TaskLists({
  tasks,
  close,
  onAct,
}: {
  tasks: readonly Task[];
  close(): void;
  onAct(task: Task): void;
}) {
  const t = useT();
  const groups = taskGroups(tasks);
  const open = (task: Task) => {
    close();
    showTask(task);
  };
  const section = (
    heading: "tasks.group.needsYou" | "tasks.group.running" | "tasks.group.recent",
    list: readonly Task[],
  ) =>
    list.length > 0 && (
      <section className="model-menu-list" aria-label={t(heading)}>
        <p className="model-menu-heading">{t(heading)}</p>
        {list.map((task) => (
          <TaskItem key={task.id} task={task} onOpen={() => open(task)} onAct={() => onAct(task)} />
        ))}
      </section>
    );
  const empty = tasks.length === 0;
  return (
    <>
      {empty ? (
        <p data-testid="tasks-popover-empty" className="tasks-popover-empty">
          {t("tasks.popover.empty")}
        </p>
      ) : (
        <>
          {section("tasks.group.needsYou", groups.needsYou)}
          {section("tasks.group.running", groups.running)}
          {section("tasks.group.recent", groups.recent)}
        </>
      )}
    </>
  );
}

/**
 * One Task in the popover: the row opens it, and the actions beside it (from
 * `taskRowActions`) act on it as data. After one, the focus stays on its row,
 * which moves as the list regroups, unless the action moved it into a field.
 */
function TaskItem({ task, onOpen, onAct }: { task: Task; onOpen(): void; onAct(): void }) {
  const t = useT();
  const language = useLanguage();
  const mind = useAppStore((state) => {
    const mind = state.minds.find((each) => each.id === task.mindId);
    return mind ? mindName(mind) : "";
  });
  const finished = task.finishedAt !== null;
  const { title, line } = finished
    ? recentText(task, mind, t, language)
    : { title: taskName(task, t), line: [mind, stepLine(task, t, language)] };
  const actions = taskRowActions(task, t);
  const act = (run: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    onAct();
    run();
  };
  return (
    <div role="none" data-task={task.id} className="tasks-popover-item">
      <button
        type="button"
        role="menuitem"
        data-testid="tasks-popover-row"
        onClick={onOpen}
        className="model-menu-item tasks-popover-row"
      >
        {finished ? (
          task.status === "done" ? (
            <CheckLineIcon aria-hidden="true" className="tasks-popover-done" />
          ) : (
            <span aria-hidden="true" className="task-dot task-dot--idle" />
          )
        ) : (
          <span
            aria-hidden="true"
            className={
              needsYou(task)
                ? "task-dot task-dot--attention"
                : task.status === "running"
                  ? "task-dot"
                  : "task-dot task-dot--idle"
            }
          />
        )}
        <span className="model-menu-name">
          <span className="tasks-popover-title">{title}</span>
          <span className="model-menu-hint tasks-popover-line">
            {line.filter(Boolean).join(" · ")}
          </span>
        </span>
      </button>
      {actions.length > 0 && (
        // One place for the actions, however many a Task offers, so a second fits beside the first.
        <div className="tasks-popover-actions">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              data-testid={`tasks-popover-${action.key}`}
              onClick={act(action.run)}
              className={buttonStyle("ghost", "sm")}
              {...withShortcut(
                action.label,
                action.shortcut ? shortcutLabel(action.shortcut) : undefined,
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function recentText(
  task: Task,
  mind: string,
  t: Translate,
  language: ReturnType<typeof useLanguage>,
): { title: string; line: string[] } {
  const name = taskName(task, t);
  return {
    title: mind ? t("tasks.row.recentTitle", { task: name, mind }) : name,
    line: [
      dayOf(new Date(task.finishedAt ?? task.updatedAt), new Date(), language, t),
      resultLine(task, t),
    ],
  };
}
