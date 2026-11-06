/**
 * Throwaway measurement, never merged: what the meter's open-file read costs on Linux while
 * run_code's bash runs in the OS sandbox, read from the timing a ci/ branch adds to the meter.
 * It prints a table to the job log and asserts nothing.
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createProcessLauncher } from "../../src/main/processes";
import { createCodeRunner } from "../../src/main/runCode/runner";
import { loadOsSandbox, readDeniedFolders } from "../../src/main/sandbox";
import { createSweepGuard } from "../helpers/sweepGuard";

const seccomp = join(
  dirname(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"))),
  "vendor",
  "seccomp",
  process.arch,
  "apply-seccomp",
);
const sandbox = await loadOsSandbox({ seccompHelper: seccomp });
const guard = createSweepGuard();

interface MeasureRead {
  scenario: string;
  wallMs: number;
  cpuMs: number;
  pids: number;
  fds: number;
  outcome: string;
}
interface MeasureTrace {
  scenario: string;
  reads: MeasureRead[];
  errnos: Record<string, Record<string, number>>;
  overdue: Record<string, number>;
  fds: number;
  tree: Record<string, string[]>;
}
const trace: MeasureTrace = ((globalThis as { __meterTrace?: MeasureTrace }).__meterTrace ??= {
  scenario: "",
  reads: [],
  errnos: {},
  overdue: {},
  fds: 0,
  tree: {},
});

let root = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "incarnamind-measure-")));
  for (const folder of ["home", "data", "temp"]) await mkdir(join(root, folder), { recursive: true });
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function runner(timeLimitMs: number, reports: string[]) {
  if (!sandbox.available) throw new Error(sandbox.reason);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const executor = sandbox.createExecutor({
    processes: createProcessLauncher(async () => env),
    environment: async () => env,
    tempDir: join(root, "temp"),
    denyRead: readDeniedFolders({
      platform: process.platform,
      home: join(root, "home"),
      dataDir: join(root, "data"),
      temporaryFolder: tmpdir(),
      ...(typeof process.getuid === "function" && { uid: process.getuid() }),
    }),
    reportError: (error) => reports.push(String(error)),
    runRecords: guard.records(join(root, "data", "runs")),
    sweep: { stopper: guard.stopper },
  });
  return createCodeRunner({
    executor,
    tempDir: join(root, "temp"),
    python: null,
    helper: "",
    font: null,
    appVersion: "0.0.0-measure",
    timeLimitMs,
    reportError: (error) => reports.push(String(error)),
  });
}

const SCENARIOS: { name: string; limitMs: number; code: string }[] = [
  { name: "one sleeping process", limitMs: 20_000, code: "sleep 6; echo done" },
  {
    name: "60 processes churning for 8 s",
    limitMs: 20_000,
    code: 'end=$(( $(date +%s) + 8 )); while [ "$(date +%s)" -lt "$end" ]; do for i in $(seq 1 60); do ( : ) & done; wait; done; echo done',
  },
  {
    name: "63 processes x ~1,020 fds on one unlinked file, 18 s",
    limitMs: 25_000,
    code: `perl -e 'open(my $f, "+>", "held") or die; print $f "x" x 1_000_000; unlink "held"; my @d; for (1..1015) { open(my $c, "<&", $f) or last; push @d, $c; } for (1..62) { defined(my $p = fork) or last; if (!$p) { sleep 18; exit 0 } } sleep 18; print "held\\n"'`,
  },
];

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
const ms = (value: number) => value.toFixed(1);

test.skipIf(process.platform !== "linux" || !sandbox.available)(
  "measurement: the meter's open-file read on Linux, through run_code",
  async () => {
    const lines: string[] = [];
    for (const scenario of SCENARIOS) {
      trace.scenario = scenario.name;
      const reports: string[] = [];
      const started = performance.now();
      const ran = await runner(scenario.limitMs, reports).run({
        language: "bash",
        code: scenario.code,
        documents: [],
        signal: new AbortController().signal,
      });
      const took = performance.now() - started;
      const reads = trace.reads.filter((read) => read.scenario === scenario.name);
      const walls = reads.map((read) => read.wallMs);
      const cpus = reads.map((read) => read.cpuMs);
      const outcomes: Record<string, number> = {};
      for (const read of reads) outcomes[read.outcome] = (outcomes[read.outcome] ?? 0) + 1;
      const end =
        ran.kind === "ran"
          ? ran.end.kind === "error"
            ? `error: ${ran.end.message.slice(0, 80)}`
            : JSON.stringify(ran.end)
          : ran.kind;
      lines.push(
        [
          `## ${scenario.name}`,
          `end ${end} after ${ms(took)} ms`,
          `reads ${reads.length}; pids per read p50 ${percentile(reads.map((r) => r.pids), 50)} max ${percentile(reads.map((r) => r.pids), 100)}; fds per read p50 ${percentile(reads.map((r) => r.fds), 50)} max ${percentile(reads.map((r) => r.fds), 100)}`,
          `wall ms p50 ${ms(percentile(walls, 50))} p95 ${ms(percentile(walls, 95))} max ${ms(percentile(walls, 100))}`,
          `cpu ms p50 ${ms(percentile(cpus, 50))} p95 ${ms(percentile(cpus, 95))} max ${ms(percentile(cpus, 100))}`,
          `outcomes ${JSON.stringify(outcomes)}; overdue ticks ${trace.overdue[scenario.name] ?? 0}`,
          `errnos ${JSON.stringify(trace.errnos[scenario.name] ?? {})}`,
          `reports ${JSON.stringify(reports.map((report) => report.slice(0, 240)))}`,
          "processes (first sight):",
          ...(trace.tree?.[scenario.name] ?? []).map((line) => `  ${line.slice(0, 1500)}`),
        ].join("\n"),
      );
    }
    // biome-ignore lint/suspicious/noConsole: the measurement's whole output is this table.
    console.log(`\n#METER-MEASURE\n${lines.join("\n\n")}\n#METER-MEASURE-END\n`);
  },
  180_000,
);
