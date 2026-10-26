import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { killCopies, listedCopies } from "../../e2e/lifecycle";

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const gone = once(child, "exit");
    child.kill("SIGKILL");
    await gone;
  }
});

async function start(tag: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready"); process.stdin.resume()', "--", tag],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  children.push(child);
  if (!child.stdout) throw new Error("The process inventory control has no stdout.");
  await once(child.stdout, "data");
  return child;
}

test("inventory and cleanup affect only the tagged run, preserving another live process", async () => {
  const tag = `--incarnamind-smoke-copy=${randomUUID()}`;
  const otherTag = `--incarnamind-smoke-copy=${randomUUID()}`;
  const first = await start(tag);
  const other = await start(otherTag);
  expect(listedCopies(tag, process.execPath).map(({ pid }) => pid)).toEqual([first.pid]);
  expect(listedCopies(otherTag, process.execPath).map(({ pid }) => pid)).toEqual([other.pid]);
  const gone = once(first, "exit");
  killCopies(tag, process.execPath);
  await gone;
  expect(listedCopies(tag, process.execPath)).toEqual([]);
  expect(other.kill(0)).toBe(true);
  expect(listedCopies(otherTag, process.execPath).map(({ pid }) => pid)).toEqual([other.pid]);
});

test("an absent or multiword tag cannot select processes for cleanup", () => {
  expect(() => killCopies("", process.execPath)).toThrow("one nonempty argument");
  expect(() => killCopies("two arguments", process.execPath)).toThrow("one nonempty argument");
});
