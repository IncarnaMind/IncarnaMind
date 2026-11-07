import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Seconds each test file took on CI (tests/durations.json); refresh it from a green run's log. */
const DURATIONS: Record<string, number> = JSON.parse(
  readFileSync(new URL("../durations.json", import.meta.url), "utf8"),
);
/** Most files take a second or two; one the table doesn't know yet counts as this. */
const UNKNOWN_SECONDS = 2;

/** The files of shard `index` (from 1) of `count`: the slowest dealt first to the lightest shard. */
export function balance(
  files: readonly { id: string; seconds: number }[],
  index: number,
  count: number,
): string[] {
  const shards = Array.from({ length: count }, () => ({ seconds: 0, ids: [] as string[] }));
  const slowestFirst = [...files].sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id));
  for (const file of slowestFirst) {
    const lightest = shards.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    lightest.seconds += file.seconds;
    lightest.ids.push(file.id);
  }
  return shards[index - 1]?.ids ?? [];
}

/**
 * Vitest's own shards hold equal numbers of files, and a few files take minutes, so one shard took
 * twice as long as another. These hold about equal time. Vitest calls `shard` with the files left
 * after `--changed`, so a pull request's tests are balanced too.
 */
export class BalancedShards extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const idOf = (file: TestSpecification) =>
      relative(this.ctx.config.root, file.moduleId).split(sep).join("/");
    const timed = [...new Set(files.map(idOf))].map((id) => ({
      id,
      seconds: DURATIONS[id] ?? UNKNOWN_SECONDS,
    }));
    const mine = new Set(balance(timed, shard.index, shard.count));
    return files.filter((file) => mine.has(idOf(file)));
  }
}
