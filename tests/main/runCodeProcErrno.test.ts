/**
 * Temporary diagnostic for #2524: on Linux, read /proc/<pid>/fd and /proc/<pid>/maps for a set of
 * short-lived processes (as the meter reads a run's processes from the host), and count the raw
 * errors by errno. It confirms whether the reads fail fast (ESRCH/ENOENT when a process exits mid
 * read) rather than time out, so the fix can tell a gone process from a real read error. Removed
 * before the pull request is ready; it asserts nothing but prints a table to the job log.
 */
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "vitest";

/** Keeps a tree of short-lived children churning for `ms`, from one bash process; resolves its pid. */
function churn(ms: number): { pid: number; stop: () => void } {
  // A fixed script, no interpolation: each round forks ~64 children that exit at once.
  const script = `
end=$(( $(date +%s) + ${Math.ceil(ms / 1000)} ))
while [ "$(date +%s)" -lt "$end" ]; do
  for i in $(seq 1 64); do ( : ) & done
  wait
done`;
  const child = spawn("bash", ["-c", script], { stdio: "ignore" });
  return { pid: child.pid ?? 0, stop: () => child.kill("SIGKILL") };
}

/** This user's pids whose parent chain reaches `root`, from a ps listing. */
async function tree(root: number): Promise<number[]> {
  const listing = await new Promise<string>((resolve) => {
    const ps = spawn("ps", ["-A", "-o", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout?.on("data", (c: Buffer) => {
      out += c;
    });
    ps.on("close", () => resolve(out));
  });
  const parents = new Map<number, number>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parents.set(pid, ppid ?? 0);
  }
  const under = (pid: number) => {
    for (let at = pid, hops = 0; at > 1 && hops < 64; at = parents.get(at) ?? 0, hops++) {
      if (at === root) return true;
    }
    return false;
  };
  return [...parents.keys()].filter(under);
}

const errnoOf = (error: unknown) => {
  const e = error as { code?: unknown; errno?: unknown };
  return typeof e.code === "string" ? e.code : String(e.errno ?? "unknown");
};

test.skipIf(process.platform !== "linux")(
  "diagnostic: /proc reads for churning processes fail by errno, not by timeout",
  async () => {
    const byOp: Record<string, Record<string, number>> = {
      "readdir fd": {},
      "stat fd": {},
      "read maps": {},
    };
    const count = (op: string, code: string) => {
      byOp[op] = byOp[op] ?? {};
      byOp[op][code] = (byOp[op][code] ?? 0) + 1;
    };
    const slow: { op: string; ms: number }[] = [];
    const timed = async <T>(op: string, work: () => Promise<T>): Promise<T | undefined> => {
      const started = performance.now();
      try {
        return await work();
      } catch (error) {
        count(op, errnoOf(error));
        return undefined;
      } finally {
        const took = performance.now() - started;
        if (took > 200) slow.push({ op, ms: Math.round(took) });
      }
    };

    const churning = churn(4000);
    const until = performance.now() + 4000;
    let rounds = 0;
    while (performance.now() < until) {
      rounds += 1;
      const pids = await tree(churning.pid);
      for (const pid of pids) {
        const fds = await timed("readdir fd", () => readdir(`/proc/${pid}/fd`));
        for (const fd of fds ?? []) await timed("stat fd", () => stat(`/proc/${pid}/fd/${fd}`));
        await timed("read maps", () => readFile(`/proc/${pid}/maps`, "utf8"));
      }
    }
    churning.stop();

    // biome-ignore lint/suspicious/noConsole: the diagnostic's whole output is this table.
    console.log(
      `\n#2524 /proc read errors over ${rounds} rounds:\n` +
        Object.entries(byOp)
          .map(([op, codes]) => `  ${op}: ${JSON.stringify(codes)}`)
          .join("\n") +
        `\n  reads over 200 ms: ${slow.length}${slow.length ? ` ${JSON.stringify(slow.slice(0, 5))}` : ""}\n`,
    );
  },
  60_000,
);
