import { NO_MIND, useComposer } from "../composer";
import { togglePlanView } from "../research";
import { aimAt, tellableIn } from "../taskTell";
import { focusComposer } from "./assistant";
import type { Command } from "./registry";

/** The running Task of the Mind the composer reads that takes messages, if any. */
const toldTask = () => {
  const { seat } = useComposer.getState();
  return seat ? tellableIn(seat.mindId)[0] : undefined;
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
    when: () => toldTask() !== undefined,
    run: () => {
      const task = toldTask();
      if (task) aimAt(task);
    },
  },
  {
    // Plan, as in a running Research's progress: its plan in the tray, or put away.
    id: "research.plan",
    label: "command.researchPlan",
    keywords: ["command.researchPlan.keywords"],
    group: "open",
    reversible: true,
    when: () => toldTask() !== undefined,
    run: () => {
      const task = toldTask();
      if (task) togglePlanView(task);
    },
  },
];
