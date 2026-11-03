import { NO_MIND, useComposer } from "../composer";
import { togglePlanView } from "../research";
import { taskNow } from "../taskFocus";
import { aimAt, tellable, tellableIn } from "../taskTell";
import { focusComposer } from "./assistant";
import type { Command, CommandContext } from "./registry";

/** The Task the composer would tell: the one in focus while it reads messages, else the Mind's newest. */
const toldTask = (ctx: CommandContext) => {
  const focused = taskNow(ctx);
  if (focused !== undefined && tellable(focused)) return focused;
  const { seat } = useComposer.getState();
  return seat ? tellableIn(seat.mindId)[0] : undefined;
};

/** The Task in focus with a plan to show: a Research Task, running or done. */
const plannedTask = (ctx: CommandContext) => {
  const task = taskNow(ctx);
  return task?.actions.includes("plan") ? task : undefined;
};

export const researchCommands: readonly Command[] = [
  {
    // Research (#130): the composer takes a topic, for the Mind the assistant reads.
    id: "research.start",
    label: "research.command",
    keywords: ["research.command.keywords"],
    group: "main",
    // It only marks the composer; the Task starts from the plan card, writing into a new Mind
    // when no Mind is in focus.
    reversible: true,
    run: () => {
      const { seat, update } = useComposer.getState();
      update(seat?.mindId ?? NO_MIND, { research: true, skill: null, analyse: false });
      focusComposer();
    },
  },
  {
    // Tell it… (#130), as in the Task's progress: the composer aims at it.
    id: "task.tell",
    label: "command.tellTask",
    keywords: ["command.tellTask.keywords"],
    group: "main",
    // It only aims the composer; Esc goes back to asking.
    reversible: true,
    when: (ctx) => toldTask(ctx) !== undefined,
    run: (ctx) => {
      const task = toldTask(ctx);
      if (task) aimAt(task);
    },
  },
  {
    // Plan, as in a Research Task's progress: its plan in the tray, or put away. Done, the
    // steps it ran stay in reach.
    id: "research.plan",
    label: "command.researchPlan",
    keywords: ["command.researchPlan.keywords"],
    group: "open",
    reversible: true,
    when: (ctx) => plannedTask(ctx) !== undefined,
    run: (ctx) => {
      const task = plannedTask(ctx);
      if (task) togglePlanView(task);
    },
  },
];
