/**
 * What a Task offers, as data rather than markup: the commands the keyboard
 * runs on the Task in focus, and the actions its row in the Tasks popover
 * shows beside opening it (Stop while it is still going, nothing once done).
 */

import type { Task } from "../../core/api";
import type { CommandId } from "../../shared/commands";
import type { Translate } from "./objects";
import { pauseTask, resumeTask, stopTask } from "./tasks";

export interface TaskRowAction {
  key: string;
  label: string;
  /** What the row's tooltip names after its label, when a key does the same. */
  shortcut?: CommandId;
  run(): void;
}

/** What the keyboard commands do to a Task, when it can take it now. */
export type TaskCommand = "pause" | "resume" | "stop";

/**
 * Whether the Task in focus can take what the command does now: Pause while it
 * runs, Resume while it is paused (not while it waits for the User), Stop
 * while it is still going.
 */
export function taskOffers(task: Task | undefined, command: TaskCommand): boolean {
  if (!task) return false;
  switch (command) {
    case "pause":
      return task.status === "running" && task.ask === null && task.actions.includes("pause");
    case "resume":
      return task.status === "paused" && task.ask === null && task.actions.includes("pause");
    case "stop":
      return task.finishedAt === null && task.actions.includes("stop");
  }
}

export function taskRowActions(task: Task, t: Translate): TaskRowAction[] {
  const actions: TaskRowAction[] = [];
  if (taskOffers(task, "pause")) {
    actions.push({ key: "pause", label: t("task.pause"), run: () => void pauseTask(task.id) });
  }
  if (taskOffers(task, "resume")) {
    actions.push({ key: "resume", label: t("task.resume"), run: () => void resumeTask(task.id) });
  }
  if (taskOffers(task, "stop")) {
    actions.push({
      key: "stop",
      label: t("task.stop"),
      shortcut: "task.stop",
      run: () => void stopTask(task.id),
    });
  }
  return actions;
}
