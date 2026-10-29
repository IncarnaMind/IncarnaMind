import { execFileSync } from "node:child_process";
import { relative } from "node:path";

/**
 * The short commit the working tree is on, marked when it has uncommitted
 * changes. Changes inside `outputs` (a run's own result files) don't count.
 */
export function commitOf(root: string, outputs: readonly string[] = []): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    const excluded = outputs.map((folder) => `:(exclude)${relative(root, folder) || "."}`);
    const changed = git("status", "--porcelain", "--", ".", ...excluded) !== "";
    return `${git("rev-parse", "--short", "HEAD")}${changed ? " (with uncommitted changes)" : ""}`;
  } catch {
    return "unknown";
  }
}
