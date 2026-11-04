/**
 * A run's folder holds copies of the User's Documents: one a crash or a failed removal left is
 * removed by the next runner, once it is older than any run takes, and nothing else is.
 */
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Executor } from "../../src/core/adapters";
import { createCodeRunner } from "../../src/main/runCode/runner";

const NOTHING_RUNS: Executor = {
  level: "os",
  run: () => Promise.reject(new Error("Nothing runs here.")),
};

async function runFolder(tempDir: string, name: string, ageMs: number) {
  const folder = join(tempDir, name);
  await mkdir(join(folder, "inputs"), { recursive: true });
  await writeFile(join(folder, "inputs", "sales.csv"), "region,revenue\nNorth,1\n");
  await chmod(join(folder, "inputs", "sales.csv"), 0o444);
  await chmod(join(folder, "inputs"), 0o555);
  // A folder the code took its owner's permissions from, which `rm` alone can't get past.
  await mkdir(join(folder, "done", "locked"), { recursive: true });
  await writeFile(join(folder, "done", "locked", "kept.txt"), "what the code wrote");
  await chmod(join(folder, "done", "locked"), 0o000);
  const when = new Date(Date.now() - ageMs);
  await utimes(folder, when, when);
  return folder;
}

test("a run folder left over an hour ago is removed when a runner is made; a newer one and other folders stay", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "incarnamind-left-behind-"));
  onTestFinished(async () => {
    for (const name of await readdir(tempDir)) {
      await chmod(join(tempDir, name, "inputs"), 0o755).catch(() => undefined);
      await chmod(join(tempDir, name, "done", "locked"), 0o755).catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true });
  });
  await runFolder(tempDir, "incarnamind-code-old", 61 * 60 * 1000);
  await runFolder(tempDir, "incarnamind-code-new", 59 * 60 * 1000);
  await runFolder(tempDir, "someone-else-old", 3 * 60 * 60 * 1000);
  const errors: unknown[] = [];
  createCodeRunner({
    executor: NOTHING_RUNS,
    tempDir,
    python: null,
    helper: "",
    font: null,
    appVersion: "test",
    reportError: (error) => errors.push(error),
  });
  await vi.waitFor(async () => {
    expect((await readdir(tempDir)).sort()).toEqual(["incarnamind-code-new", "someone-else-old"]);
  });
  expect(errors).toEqual([]);
});

test("a plot font that can't be found doesn't stop a bash run, which never reads it", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "incarnamind-font-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  const read: string[][] = [];
  const runner = createCodeRunner({
    executor: {
      level: "os",
      run: async (request) => {
        read.push(request.allow.read.filter((each): each is string => typeof each === "string"));
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    },
    tempDir,
    python: null,
    helper: "",
    font: join(tempDir, "fonts", "plot.otf"),
    appVersion: "test",
    reportError: (error) => {
      throw error;
    },
  });

  const ran = await runner.run({
    language: "bash",
    code: "true",
    documents: [],
    signal: new AbortController().signal,
  });

  expect(ran).toMatchObject({ kind: "ran", end: { kind: "done" } });
  expect(read).toHaveLength(1);
  expect(read[0]?.some((folder) => folder.includes("fonts"))).toBe(false);
});
