import { taskOffers } from "../taskActions";
import { taskNow } from "../taskFocus";
import { requestTaskMenu } from "../taskMenu";
import { pauseTask, resumeTask, stopTask } from "../tasks";
import type { Command } from "./registry";

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
    when: (ctx) => taskOffers(taskNow(ctx), "pause"),
    run: (ctx) => {
      const task = taskNow(ctx);
      if (task) void pauseTask(task.id);
    },
  },
  {
    id: "task.resume",
    label: "command.resumeTask",
    keywords: ["command.resumeTask.keywords"],
    group: "main",
    reversible: true,
    when: (ctx) => taskOffers(taskNow(ctx), "resume"),
    run: (ctx) => {
      const task = taskNow(ctx);
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
    reversible: { confirm: "task.stopConfirm" },
    when: (ctx) => taskOffers(taskNow(ctx), "stop"),
    run: (ctx) => {
      const task = taskNow(ctx);
      if (task) void stopTask(task.id);
    },
  },
];
