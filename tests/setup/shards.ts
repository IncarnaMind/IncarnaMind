import { readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Seconds each test file took on CI (tests/durations.json, written by scripts/unitDurations.ts). */
const DURATIONS: Record<string, number> = JSON.parse(
  readFileSync(new URL("../durations.json", import.meta.url), "utf8"),
);
/**
 * What a test file the table doesn't know yet counts as, by its size: the whole suite's seconds
 * over its bytes. Counted as a flat two seconds, a quarter of the suite's time went unseen within
 * a week of a refresh, and one shard took 412 s while the others took 700.
 */
const SECONDS_A_BYTE = 0.00027;
/**
 * What starting a file costs a shard beside its tests, which is all the table holds: without it
 * the hundreds of files that take no time were all dealt to one shard, which ran a minute longer.
 */
const SECONDS_TO_START = 0.3;

export const secondsOf = (id: string, bytes: number): number =>
  DURATIONS[id] ?? bytes * SECONDS_A_BYTE;

export function slowestFirst<File extends { id: string; seconds: number }>(
  files: readonly File[],
): File[] {
  return [...files].sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id));
}

/** The files of shard `index` (from 1) of `count`: the slowest dealt first to the lightest shard. */
export function balance(
  files: readonly { id: string; seconds: number }[],
  index: number,
  count: number,
): string[] {
  const shards = Array.from({ length: count }, () => ({ seconds: 0, ids: [] as string[] }));
  for (const file of slowestFirst(files)) {
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
  private timed(files: TestSpecification[]) {
    return files.map((file) => {
      const id = relative(this.ctx.config.root, file.moduleId).split(sep).join("/");
      const seconds = secondsOf(id, statSync(file.moduleId).size) + SECONDS_TO_START;
      return { id, file, seconds };
    });
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const timed = this.timed(files);
    const unique = [...new Map(timed.map((each) => [each.id, each])).values()];
    const mine = new Set(balance(unique, shard.index, shard.count));
    return timed.filter((each) => mine.has(each.id)).map((each) => each.file);
  }

  /**
   * A shard runs its slowest files first. Vitest orders by its cache of the last run, which CI
   * never has, and then by file size: a nine-line file that reads a table for half a minute ran
   * last, and a shard's last three minutes kept one or two of its four workers busy.
   */
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (!this.ctx.config.shard) return super.sort(files);
    return slowestFirst(this.timed(files)).map((each) => each.file);
  }
}
