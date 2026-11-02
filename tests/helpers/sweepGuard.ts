/**
 * The real stopper, for tests that run programs in the OS sandbox: it signals a pid only when,
 * listed just before, it is a member of one of the runs recorded in the test's own records
 * folders. Any other pid is refused, not signalled, and kept for the test to fail on.
 */
import { appendFile, readdir, readFile } from "node:fs/promises";
import {
  classify,
  killProcess,
  listProcesses,
  type RunRecord,
  type Stopper,
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

  const stopper: Stopper = async (pid, signal) => {
    const rows = await listProcesses();
    const row = rows.find((each) => each.pid === pid);
    const seen = { pid, signal, command: row?.command ?? "", startedMs: row?.startedMs ?? 0 };
    const context = {
      platform: process.platform,
      uid: process.getuid?.() ?? -1,
      app: process.pid,
      group: 0,
    };
    let run: string | undefined;
    for (const record of await runs()) {
      const classified = await classify(rows, record, context, sandboxCheck);
      if (classified.some((each) => each.pid === pid && each.verdict === "member")) {
        run = record.id;
        break;
      }
    }
    if (LOG) await appendFile(LOG, `${JSON.stringify({ ...seen, run: run ?? null })}\n`);
    if (run === undefined) {
      refused.push(seen);
      return false;
    }
    signalled.push({ ...seen, run });
    return killProcess(pid, signal);
  };

  return {
    stopper,
    signalled,
    refused,
    /** A records folder whose runs' members this stopper may signal. */
    records(folder: string): string {
      folders.add(folder);
      return folder;
    },
  };
}
