/**
 * The real stoppers, for tests that run programs in the OS sandbox: a pid is signalled only when,
 * listed just before, it is a member of one of the runs recorded in the test's own records
 * folders, and a group (`-pgid`) only when every live process in that group is a verified member
 * of one of those runs (via `signallableGroups`). Any other live pid or group is refused, not
 * signalled, and kept for the test to fail on.
 */
import { appendFile, readdir, readFile } from "node:fs/promises";
import {
  classify,
  type GroupStopper,
  killProcess,
  killProcessGroup,
  listProcesses,
  type ProcessRow,
  type RunRecord,
  type Stopper,
  signallable,
  signallableGroups,
  startTimes,
  sweepRun,
} from "../../src/main/runLeftovers";
import { sandboxCheck } from "../../src/main/sandboxCheck";

export interface Signalled {
  pid: number;
  signal: string;
  command: string;
  startedMs: number;
  run?: string;
}

/** Where each signal is also written as a line of JSON, when a person runs the tests to read. */
const LOG = process.env.INCARNAMIND_TEST_SWEEP_SIGNALS;

/** The app and every ancestor up to PID 1, so `classify` and `signallableGroups` only check target rows. */
function ancestorsOf(rows: readonly ProcessRow[], app: number): ProcessRow[] {
  const byPid = new Map(rows.map((each) => [each.pid, each]));
  const chain: ProcessRow[] = [];
  const seen = new Set<number>();
  for (let pid = app; pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) break;
    chain.push(row);
    pid = row.ppid;
  }
  return chain;
}

function uniqueRows(rows: readonly ProcessRow[]): ProcessRow[] {
  const seen = new Set<number>();
  const kept: ProcessRow[] = [];
  for (const row of rows) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    kept.push(row);
  }
  return kept;
}

export function createSweepGuard() {
  const folders = new Set<string>();
  const signalled: Signalled[] = [];
  const refused: Signalled[] = [];

  async function runs(): Promise<RunRecord[]> {
    const found: RunRecord[] = [];
    for (const folder of folders) {
      const names = await readdir(folder).catch(() => []);
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const text = await readFile(`${folder}/${name}`, "utf8").catch(() => null);
        if (text !== null) found.push(JSON.parse(text) as RunRecord);
      }
    }
    return found;
  }

  const stoppedHere = new Set<number>();
  const stoppedGroupsHere = new Set<number>();
  const authorizedGroups = new Set<number>();
  const context = () => ({
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    app: process.pid,
    group: 0,
  });

  const stopper: Stopper = async (pid, signal) => {
    // Letting go on what this guard let be stopped: the one signal to a pid that may not be the
    // run's any more.
    if (signal === "SIGCONT") {
      const seen = { pid, signal, command: "", startedMs: 0 };
      if (!stoppedHere.has(pid)) {
        refused.push(seen);
        return false;
      }
      signalled.push(seen);
      return killProcess(pid, signal);
    }
    const rows = await listProcesses();
    const row = rows.find((each) => each.pid === pid);
    // Already exited before the guard checked it: nothing to signal and no wrong target.
    if (!row) return false;
    const seen = { pid, signal, command: row.command, startedMs: row.startedMs };
    const subset = uniqueRows([...ancestorsOf(rows, process.pid), row]);
    const ctx = context();
    let run: string | undefined;
    let gone = false;
    for (const record of await runs()) {
      const classified = await classify(subset, record, ctx, sandboxCheck, startTimes);
      const verdict = classified.find((each) => each.pid === pid)?.verdict;
      if (verdict === "member") {
        run = record.id;
        break;
      }
      if (verdict === "gone before check") gone = true;
    }
    if (LOG) await appendFile(LOG, `${JSON.stringify({ ...seen, run: run ?? null })}\n`);
    if (run === undefined) {
      if (gone) return false;
      refused.push(seen);
      return false;
    }
    signalled.push({ ...seen, run });
    if (signal === "SIGSTOP") stoppedHere.add(pid);
    return killProcess(pid, signal);
  };

  const groupStopper: GroupStopper = async (pgid, signal) => {
    const seenBase = { pid: -pgid, signal: String(signal), command: "", startedMs: 0 };
    if (!signallable(pgid, process.pid)) {
      refused.push(seenBase);
      return false;
    }
    if (signal === "SIGCONT") {
      if (!stoppedGroupsHere.has(pgid)) {
        refused.push(seenBase);
        return false;
      }
      signalled.push(seenBase);
      return killProcessGroup(pgid, "SIGCONT");
    }
    if (signal === 0) {
      if (!authorizedGroups.has(pgid)) {
        refused.push(seenBase);
        return false;
      }
      return killProcessGroup(pgid, 0);
    }
    const rows = await listProcesses();
    const inGroup = rows.filter((each) => each.group === pgid);
    if (inGroup.length === 0) return false;
    const seen = {
      pid: -pgid,
      signal,
      command: inGroup[0]?.command ?? "",
      startedMs: inGroup[0]?.startedMs ?? 0,
    };
    const ancestors = ancestorsOf(rows, process.pid);
    const forbidden = new Set<number>([0, 1, process.pid]);
    for (const each of ancestors) {
      forbidden.add(each.pid);
      forbidden.add(each.group);
    }
    const subset = uniqueRows([...ancestors, ...inGroup]);
    const ctx = context();
    let run: string | undefined;
    let hadVanished = false;
    for (const record of await runs()) {
      const classified = await classify(subset, record, ctx, sandboxCheck, startTimes);
      if (signallableGroups(classified, subset, ctx).includes(pgid)) {
        run = record.id;
        break;
      }
      if (!forbidden.has(pgid)) {
        const verdicts = inGroup.map(
          (member) => classified.find((each) => each.pid === member.pid)?.verdict,
        );
        if (
          verdicts.some((verdict) => verdict === "gone before check") &&
          verdicts.every((verdict) => verdict === "member" || verdict === "gone before check")
        ) {
          hadVanished = true;
        }
      }
    }
    if (LOG) await appendFile(LOG, `${JSON.stringify({ ...seen, run: run ?? null })}\n`);
    if (run === undefined) {
      if (hadVanished) return false;
      refused.push(seen);
      return false;
    }
    authorizedGroups.add(pgid);
    if (signal === "SIGSTOP") stoppedGroupsHere.add(pgid);
    signalled.push({ ...seen, run });
    return killProcessGroup(pgid, signal);
  };

  async function sweepRemaining(): Promise<number[]> {
    if (process.platform !== "darwin") return [];
    const ctx = context();
    const left: number[] = [];
    for (const record of await runs()) {
      left.push(
        ...(await sweepRun(record, 0, {
          list: listProcesses,
          started: startTimes,
          check: sandboxCheck,
          stopper,
          groupStopper,
          log: () => {},
          platform: ctx.platform,
          uid: ctx.uid,
          app: ctx.app,
        })),
      );
    }
    return left;
  }

  return {
    stopper,
    groupStopper,
    sweep: { stopper, groupStopper },
    signalled,
    refused,
    sweepRemaining,
    /** A records folder whose runs' members these stoppers may signal. */
    records(folder: string): string {
      folders.add(folder);
      return folder;
    },
  };
}
