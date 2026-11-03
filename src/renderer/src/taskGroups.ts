import type { Task } from "../../core/api";

/** Whether a Task waits for the User: an ask, or a pause only they can lift. */
export const needsYou = (task: Task): boolean =>
  task.finishedAt === null &&
  (task.ask !== null ||
    (task.status === "paused" && task.pausedReason !== null && task.pausedReason !== "user"));

/** Whether a Task is doing its steps: running, asking nothing. */
export const isRunning = (task: Task): boolean =>
  task.finishedAt === null && task.status === "running" && task.ask === null;

export interface TaskGroups {
  needsYou: Task[];
  /** Running, and those the User paused, most recent first. */
  running: Task[];
  /** Finished in the last 7 days (the core lists no older ones), most recent first. */
  recent: Task[];
}

const newestFirst = (a: Task, b: Task) =>
  (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt);

/** The Tasks chip's popover (DESIGN.md, Finding Tasks): Needs you · Running · Recent. */
export function taskGroups(tasks: readonly Task[]): TaskGroups {
  const sorted = [...tasks].sort(newestFirst);
  return {
    needsYou: sorted.filter(needsYou),
    running: sorted.filter((task) => task.finishedAt === null && !needsYou(task)),
    recent: sorted.filter((task) => task.finishedAt !== null),
  };
}

/**
 * The Task the keyboard acts on: the one whose block or row held the focus,
 * done or not, else the newest unfinished Task of the Mind in focus: none when
 * no Mind is in focus and no Task holds it. A done Task in focus is never
 * swapped for another one, which a command could act on by mistake.
 */
export function taskInFocus(
  tasks: readonly Task[],
  mindId: string | null,
  focusedTaskId: string | null,
): Task | undefined {
  const focused =
    focusedTaskId === null ? undefined : tasks.find((task) => task.id === focusedTaskId);
  if (focused) return focused;
  if (mindId === null) return undefined;
  return tasks
    .filter((task) => task.mindId === mindId && task.finishedAt === null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/** What the chip says, or null while no Task runs or needs the User (it isn't shown then). */
export function chipOf(tasks: readonly Task[]): { running: number; needsYou: number } | null {
  const running = tasks.filter(isRunning).length;
  const waiting = tasks.filter(needsYou).length;
  return running + waiting > 0 ? { running, needsYou: waiting } : null;
}

/** When the thread on screen began, and the Tasks it has shown running since. */
export interface ThreadStart {
  since: string;
  /** Kept as the thread is drawn: a Task seen running stays when it finishes. */
  seen: Set<string>;
}

/**
 * The Tasks a conversation's thread shows for the Mind the assistant reads
 * (#657): those still going, those it showed going, the one a click asked to
 * show, and those started since the thread began; oldest first.
 */
export function threadTasks(
  tasks: readonly Task[],
  mindId: string | null,
  thread: ThreadStart,
  shown: string | null,
): Task[] {
  if (mindId === null) return [];
  const shownTasks = tasks
    .filter(
      (task) =>
        task.mindId === mindId &&
        (task.finishedAt === null ||
          thread.seen.has(task.id) ||
          task.id === shown ||
          task.startedAt >= thread.since),
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const task of shownTasks) if (task.finishedAt === null) thread.seen.add(task.id);
  return shownTasks;
}

/**
 * The thread in order: its messages as they are, each Task where it started
 * among them, by time. A Task started before the first message comes first.
 */
export function interleave<M extends { createdAt: string }>(
  messages: readonly M[],
  tasks: readonly Task[],
): ({ kind: "message"; message: M } | { kind: "task"; task: Task })[] {
  const entries: ({ kind: "message"; message: M } | { kind: "task"; task: Task })[] = [];
  let next = 0;
  for (const message of messages) {
    for (let task = tasks[next]; task && task.startedAt < message.createdAt; task = tasks[next]) {
      entries.push({ kind: "task", task });
      next++;
    }
    entries.push({ kind: "message", message });
  }
  for (const task of tasks.slice(next)) entries.push({ kind: "task", task });
  return entries;
}
