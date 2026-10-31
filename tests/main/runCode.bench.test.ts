/**
 * What the OS sandbox and run_code add to a run (spike, docs/adr/0025):
 * medians of plain and sandboxed starts, with and without pandas, and the
 * whole run_code path. Runs only with RUN_CODE_BENCH=1 and RUN_CODE_PYTHON;
 * prints its numbers as JSON.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createCodeRunner } from "../../src/core/runCode";
import { createProcessLauncher } from "../../src/main/processes";
import { loadOsSandbox } from "../../src/main/sandbox";
import { createTempDataFolder } from "../helpers/core";

const python = process.env.RUN_CODE_PYTHON;
const site = process.env.RUN_CODE_SITE;
const ROUNDS = 10;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
};

async function timed(work: () => Promise<unknown>): Promise<number> {
  await work();
  const times: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  return median(times);
}

test.skipIf(process.env.RUN_CODE_BENCH !== "1" || !python)(
  "run_code's overhead",
  async () => {
    const runtime = dirname(
      dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")),
    );
    const sandbox = await loadOsSandbox({
      seccompHelper: join(runtime, "vendor", "seccomp", process.arch, "apply-seccomp"),
    });
    if (!sandbox.available || !python) throw new Error("no sandbox or no Python");
    const root = await realpath(await createTempDataFolder());
    const home = join(root, "home");
    const tempDir = join(root, "temp");
    await mkdir(home);
    await mkdir(tempDir);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const executor = sandbox.createExecutor({
      processes: createProcessLauncher(async () => env),
      environment: async () => env,
      tempDir,
      denyRead: [home],
      reportError: () => undefined,
    });
    const plain = promisify(execFile);
    const pythonEnv = site ? { ...env, PYTHONPATH: site } : env;
    const sandboxed = async (command: string, args: string[]) => {
      const result = await executor.run({
        command,
        args,
        env: site ? { PYTHONPATH: site } : {},
        allow: { read: site ? [site] : [], write: [], network: "none" },
        timeoutMs: 60_000,
        maxOutputBytes: 65_536,
        signal: new AbortController().signal,
      });
      if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
      return result;
    };
    const rows = ["region,quarter,revenue"];
    for (let n = 0; n < 50_000; n++) rows.push(`R${n % 7},Q${(n % 4) + 1},${(n % 997) + 0.5}`);
    const csvText = `${rows.join("\n")}\n`;
    const csv = join(home, "big.csv");
    await writeFile(csv, csvText);
    const runner = createCodeRunner({
      executor,
      tempDir,
      python: { command: python, ...(site ? { site } : {}) },
      limits: {
        fileBytes: 50 << 20,
        processes: 64,
        memoryBytes: 2 * 1024 ** 3,
        folderBytes: 200 << 20,
      },
      maxOutputBytes: 65_536,
      files: { count: 20, bytes: 5 << 20 },
    });
    const document = {
      documentId: "doc",
      name: "big.csv",
      path: csv,
      contentHash: createHash("sha256").update(csvText).digest("hex"),
    };
    const analysis = `
df = read_table("big.csv")
result("total", df["revenue"].sum(), "Total", None, of=df["revenue"], how="sum")
table("by_region", df.groupby(["region", "quarter"])["revenue"].sum().to_frame())
`;
    const runs: number[] = [];
    const stages: number[] = [];
    const ran: number[] = [];
    const collects: number[] = [];
    let checks: string[] = [];
    for (let round = 0; round <= ROUNDS; round++) {
      const start = performance.now();
      const result = await runner.run({
        language: "python",
        code: analysis,
        documents: [document],
        timeoutMs: 60_000,
        signal: new AbortController().signal,
      });
      if (round === 0) continue;
      runs.push(performance.now() - start);
      stages.push(result.ms.stage);
      ran.push(result.ms.run);
      collects.push(result.ms.collect);
      checks = result.figures.map((figure) => figure.check.kind);
    }
    const numbers = {
      rounds: ROUNDS,
      bashTrue: {
        plain: await timed(() => plain("bash", ["-c", "true"])),
        sandboxed: await timed(() => sandboxed("bash", ["-c", "true"])),
      },
      pythonPass: {
        plain: await timed(() => plain(python, ["-I", "-c", "pass"])),
        sandboxed: await timed(() => sandboxed(python, ["-I", "-c", "pass"])),
      },
      pythonImportPandas: {
        plain: await timed(() => plain(python, ["-s", "-c", "import pandas"], { env: pythonEnv })),
        sandboxed: await timed(() => sandboxed(python, ["-s", "-c", "import pandas"])),
      },
      runCode50kRows: {
        total: median(runs),
        stage: median(stages),
        run: median(ran),
        collect: median(collects),
        checks,
      },
    };
    const out = process.env.RUN_CODE_BENCH_OUT;
    if (out) await writeFile(out, JSON.stringify(numbers, null, 1));
    expect(checks).toEqual(["recalculated"]);
  },
  600_000,
);
