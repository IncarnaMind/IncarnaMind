/**
 * The processes a run of the User's own AI started, in a Note's conversation (#3653): only one
 * still running as it was seen is ever signalled, and what a crash left running ends at the next
 * start.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endLeftRuns, type ProcessRow, stillOurs } from "../../src/main/agentCommand";

const row = (pid: number, ppid: number, pgid: number, started: string): ProcessRow => ({
  pid,
  ppid,
  pgid,
  started,
});

describe("which processes are still a run's", () => {
  // protects=a process id seen under a run and reused since by another process (a different start) is never signalled, nor the group it now leads; fails_when=a reused id of the User's is killed
  it("leaves alone an id reused since it was seen", () => {
    const seen = [
      { pid: 40, pgid: 40, started: "Tue Nov 24 10:00:01 2026" },
      { pid: 41, pgid: 41, started: "Tue Nov 24 10:00:02 2026" },
    ];
    const rows = [
      row(40, 1, 40, "Tue Nov 24 10:00:01 2026"),
      row(41, 1, 41, "Tue Nov 24 10:07:30 2026"),
    ];
    expect(stillOurs(seen, rows)).toEqual({ pids: [40], groups: [40] });
  });

  // protects=while the run itself still runs, what is under it now is its own, seen before or not, and so is its group; fails_when=a command started since the last look is left running
  it("takes what is under the run now while it runs", () => {
    const rows = [row(30, 1, 30, "a"), row(31, 30, 31, "b"), row(32, 31, 31, "c")];
    expect(stillOurs([], rows, { pid: 30, running: true })).toEqual({
      pids: [31, 32],
      groups: [31, 30],
    });
    expect(stillOurs([], rows, { pid: 30, running: false })).toEqual({ pids: [], groups: [] });
  });
});

const startOf = (pid: number) =>
  execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("what a run left running when IncarnaMind crashed", () => {
  // protects=at its next start IncarnaMind ends what a run noted it started and still runs as noted, and forgets the note; one noted with another start is left alone; fails_when=a crash leaves a command running for good, or the sweep kills a process that only has a noted id
  it.skipIf(process.platform === "win32")(
    "ends at the next start what still runs as noted, and only that",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "own-ai-running-"));
      const sleep = () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
        });
      const left = sleep();
      const other = sleep();
      const [leftPid, otherPid] = [left.pid ?? 0, other.pid ?? 0];
      try {
        await writeFile(
          join(folder, "4242.json"),
          JSON.stringify([
            { pid: leftPid, pgid: leftPid, started: startOf(leftPid) },
            { pid: otherPid, pgid: otherPid, started: "Thu Jan  1 00:00:00 1970" },
          ]),
        );
        await endLeftRuns(folder);
        for (let wait = 0; wait < 30 && alive(leftPid); wait++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(alive(leftPid)).toBe(false);
        expect(alive(otherPid)).toBe(true);
        expect(await readdir(folder)).toEqual([]);
      } finally {
        for (const pid of [leftPid, otherPid]) if (alive(pid)) process.kill(pid, "SIGKILL");
        await rm(folder, { recursive: true, force: true });
      }
    },
  );

  // protects=with no folder of notes, the start goes on; fails_when=a first start fails on a folder not made yet
  it("goes on when nothing was noted", async () => {
    const folder = join(tmpdir(), "own-ai-running-none");
    await expect(endLeftRuns(folder)).resolves.toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });
});
