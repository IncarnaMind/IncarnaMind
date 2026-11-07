/**
 * macOS's `sandbox_check`: what the Seatbelt profile a running process carries allows it. A
 * process can't drop or change its profile, so this tells a run's processes from every other
 * (src/main/runLeftovers.ts), and it reads what a profile denies (tests). It is called through
 * JavaScript for Automation, which macOS always has, so the app ships no native helper.
 *
 * `sandbox_check` takes its filter's value as a variadic argument. On Apple silicon variadic
 * arguments go on the stack, after the eight argument registers: the binding fills those with
 * the fixed arguments and padding, so the value lands where the function reads it. On Intel
 * they go in registers like any other.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What a check asks: may `pid` do `operation` on this path, or look up this Mach service? */
export interface SandboxQuestion {
  pid: number;
  operation: "file-write-create" | "file-read-data" | "mach-lookup";
  /** A path for file operations (it must exist), a service's name for mach-lookup. */
  value: string;
}

/** The filters sandbox.h names: SANDBOX_FILTER_PATH, SANDBOX_FILTER_GLOBAL_NAME. */
const FILTERS = { path: 1, "global-name": 2 } as const;

/** SANDBOX_CHECK_NO_REPORT: a denied check isn't logged as a violation. */
const NO_REPORT = 0x40000000;

const SCRIPT = `
function run(argv) {
  const arm = argv[0] === "arm64";
  const questions = JSON.parse(argv[1]);
  ObjC.bindFunction("sandbox_check", arm
    ? ["int", ["int", "char *", "int", "long", "long", "long", "long", "long", "char *"]]
    : ["int", ["int", "char *", "int", "char *"]]);
  return JSON.stringify(questions.map((q) => arm
    ? $.sandbox_check(q.pid, q.operation, q.type, 0, 0, 0, 0, 0, q.value)
    : $.sandbox_check(q.pid, q.operation, q.type, q.value)));
}`;

/** Questions per osascript call: they go in its arguments, which the system caps (ARG_MAX). */
const PER_CALL = 500;

/**
 * For each question, 0 where the profile allows it (or the process has none), 1 where it
 * denies it, -1 where the check failed (the process is gone). Rejects where osascript can't run.
 */
export async function sandboxCheck(
  questions: readonly SandboxQuestion[],
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<number[]> {
  const answers: number[] = [];
  for (let at = 0; at < questions.length; at += PER_CALL) {
    answers.push(...(await checkSome(questions.slice(at, at + PER_CALL), timeoutMs)));
  }
  return answers;
}

async function checkSome(
  questions: readonly SandboxQuestion[],
  timeoutMs: number | undefined,
): Promise<number[]> {
  if (questions.length === 0) return [];
  const asked = questions.map((question) => ({
    pid: question.pid,
    operation: question.operation,
    type:
      (question.operation === "mach-lookup" ? FILTERS["global-name"] : FILTERS.path) | NO_REPORT,
    value: question.value,
  }));
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", SCRIPT, process.arch, JSON.stringify(asked)],
    { maxBuffer: 16 * 1024 * 1024, ...(timeoutMs !== undefined && { timeout: timeoutMs }) },
  );
  const answers: unknown = JSON.parse(stdout.trim());
  if (
    !Array.isArray(answers) ||
    answers.length !== questions.length ||
    !answers.every((each) => typeof each === "number")
  ) {
    throw new Error(`sandbox_check gave ${stdout.trim().slice(0, 200)}`);
  }
  return answers;
}
