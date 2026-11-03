import { execFileSync } from "node:child_process";
import { isAbsolute, relative } from "node:path";

/**
 * The short commit the working tree is on, marked when it has uncommitted
 * changes. Changes inside `outputs` (a run's own result files) don't count.
 */
export function commitOf(root: string, outputs: readonly string[] = []): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    // A folder outside the repository can't change its status, and git refuses it as a pathspec.
    const inside = outputs
      .map((folder) => relative(root, folder))
      .filter((path) => !path.startsWith("..") && !isAbsolute(path));
    const excluded = inside.map((path) => `:(exclude)${path || "."}`);
    const changed = git("status", "--porcelain", "--", ".", ...excluded) !== "";
    return `${git("rev-parse", "--short", "HEAD")}${changed ? " (with uncommitted changes)" : ""}`;
  } catch {
    return "unknown";
  }
}
