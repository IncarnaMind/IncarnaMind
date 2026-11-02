import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task } from "./task";

/**
 * A task's folder, from the repository's root, where the npm scripts run: this module loads both
 * as an ES module (the reference runner) and as CommonJS (Playwright), so it can't use either's
 * own name for its folder.
 */
export const taskFolder = (id: string): string => resolve("eval/any-analysis/tasks", id);

/** The tasks named, each from its own folder, or every task. */
export async function tasksNamed(ids: readonly string[]): Promise<readonly Task[]> {
  if (ids.length === 0) return (await import("./tasks")).TASKS;
  return Promise.all(
    ids.map(
      async (id) =>
        ((await import(pathToFileURL(resolve(taskFolder(id), "task.ts")).href)) as { task: Task })
          .task,
    ),
  );
}
