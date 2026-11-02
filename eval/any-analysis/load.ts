import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task } from "./task";

export const taskFolder = (id: string): string => join(__dirname, "tasks", id);

/** The tasks named, each from its own folder, or every task. */
export async function tasksNamed(ids: readonly string[]): Promise<readonly Task[]> {
  if (ids.length === 0) return (await import("./tasks")).TASKS;
  return Promise.all(
    ids.map(
      async (id) =>
        ((await import(pathToFileURL(join(taskFolder(id), "task.ts")).href)) as { task: Task })
          .task,
    ),
  );
}
