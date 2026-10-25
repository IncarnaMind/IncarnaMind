/**
 * Tell it… (#130; DESIGN.md, Composer › Target and Task tray › Queued
 * messages): the composer aims at a running Task with a "→ Research" chip,
 * and what is sent there waits in the tray until the Task's next step starts,
 * which reads it. ✕ takes a message back (Undo tells it again); ↑ in an
 * empty composer takes the last one back to be edited.
 */
import type { Task, TaskMessage } from "../../core/api";
import { cutTitle } from "../../shared/naming";
import { useComposer } from "./composer";
import { tellTask, untellTask, useTasks } from "./tasks";
import { useUndo } from "./undo";

/** A Task the composer can send to: unfinished, of a kind that reads messages. */
export const tellable = (task: Task | undefined): task is Task =>
  task !== undefined && task.finishedAt === null && task.actions.includes("tell");

/** The Mind's Tasks that read messages, the one started last first. */
export const tellableIn = (mindId: string) =>
  Object.values(useTasks.getState().tasks)
    .filter((task) => task.mindId === mindId && tellable(task))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

/** Tell it…: what the composer sends next goes to the Task. */
export function aimAt(task: Task): void {
  if (!task.mindId) return;
  useComposer.getState().update(task.mindId, { tell: task.id });
  useComposer.getState().requestFocus();
}

/** ✕ on a queued message: the Task won't read it, and Undo tells it again. */
export async function takeBack(task: Task, message: TaskMessage): Promise<void> {
  await untellTask(task.id, message.id);
  const text = cutTitle(message.text);
  useUndo.getState().push({
    said: (t) => t("task.queued.tookBack", { text }),
    name: (t) => t("task.queued.undoName"),
    undo: () => tellTask(task.id, message.text),
  });
}

/**
 * ↑ in an empty composer: the last message the Mind's Task hasn't read comes
 * back into the composer, aimed at it, to be edited; with none queued, the
 * composer aims at the Task. Null when the Mind has no Task to tell.
 */
export function takeBackLast(mindId: string): Promise<void> | null {
  const tasks = tellableIn(mindId);
  const task = tasks.find((each) => each.queued.length > 0) ?? tasks[0];
  if (!task) return null;
  const last = task.queued.at(-1);
  const update = () =>
    useComposer.getState().update(mindId, { tell: task.id, ...(last && { text: last.text }) });
  if (!last) {
    update();
    return Promise.resolve();
  }
  return untellTask(task.id, last.id).then(update);
}
