import { useComposer } from "../composer";
import { taskOffers } from "../taskActions";
import { taskInFocus } from "../taskGroups";
import { requestTaskMenu } from "../taskMenu";
import { pauseTask, resumeTask, stopTask, useTasks } from "../tasks";
import type { Command } from "./registry";

/** The Task whose block or row holds the focus, if one does: what the User is looking at. */
function focusedTaskId(): string | null {
  if (typeof document === "undefined") return null;
  const element = document.activeElement;
  const id =
    element instanceof Element
      ? element.closest<HTMLElement>("[data-task]")?.dataset.task
      : undefined;
  return id ?? null;
}

/** The Task the keyboard acts on now (see `taskInFocus`). */
function taskNow() {
  const { seat } = useComposer.getState();
  return taskInFocus(
    Object.values(useTasks.getState().tasks),
    seat?.mindId ?? null,
    focusedTaskId(),
  );
}

export const taskCommands: readonly Command[] = [
  {
    // The Tasks chip's popover (#126): always offered, so Recent is in reach with no chip in
    // the band, and it says when there is nothing to show.
    id: "tasks.show",
    label: "command.showTasks",
    keywords: ["command.showTasks.keywords"],
    group: "open",
    reversible: true,
    run: requestTaskMenu,
  },
  {
    id: "task.pause",
    label: "command.pauseTask",
    keywords: ["command.pauseTask.keywords"],
    group: "main",
    reversible: true,
    when: () => taskOffers(taskNow(), "pause"),
    run: () => {
      const task = taskNow();
      if (task) void pauseTask(task.id);
    },
  },
  {
    id: "task.resume",
    label: "command.resumeTask",
    keywords: ["command.resumeTask.keywords"],
    group: "main",
    reversible: true,
    when: () => taskOffers(taskNow(), "resume"),
    run: () => {
      const task = taskNow();
      if (task) void resumeTask(task.id);
    },
  },
  {
    id: "task.stop",
    label: "command.stopTask",
    keywords: ["command.stopTask.keywords"],
    // ⌘. on macOS, Ctrl+. elsewhere, as Stop's tooltips show (DESIGN.md, Task progress).
    shortcut: { keys: "CmdOrCtrl+." },
    group: "main",
    // What it did stays; stopping is not taken back, and asking again starts another Task.
    reversible: true,
    when: () => taskOffers(taskNow(), "stop"),
    run: () => {
      const task = taskNow();
      if (task) void stopTask(task.id);
    },
  },
];
