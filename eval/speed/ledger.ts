/**
 * What the paired runs of one piece of work have spent in all (INCARNAMIND_EVAL_SPEED_LEDGER): a
 * file each run adds its own spend to as it goes, so the cap that work was given
 * (INCARNAMIND_EVAL_SPEED_STOP_USD) holds over every run, a run that stopped halfway included.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Ledger {
  /** What the runs before this one spent, in dollars. */
  readonly before: number;
  /** This run has spent `usd` so far. */
  record(usd: number): Promise<void>;
}

const NONE: Ledger = { before: 0, record: async () => undefined };

/** The ledger at `path`, this run's entry named `run`; null: no ledger, each run counted alone. */
export async function openLedger(path: string | null, run: string): Promise<Ledger> {
  if (path === null) return NONE;
  let runs: Record<string, number> = {};
  try {
    const read: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof read !== "object" || read === null || Array.isArray(read)) {
      throw new Error(`${path} isn't a ledger: it holds no object of runs.`);
    }
    runs = Object.fromEntries(
      Object.entries(read).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
  }
  if (run in runs) throw new Error(`${path} already has a run named ${run}.`);
  const before = Object.values(runs).reduce((sum, usd) => sum + usd, 0);
  return {
    before,
    async record(usd) {
      runs = { ...runs, [run]: usd };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(runs, null, 2)}\n`);
    },
  };
}
