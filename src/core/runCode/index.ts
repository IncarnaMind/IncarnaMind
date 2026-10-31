/**
 * run_code (spike, docs/adr/0025): a Python or bash snippet the assistant
 * wrote, run by the Executor at level "os" on copies of the Documents it
 * names.
 *
 * - Each Document is copied (a copy-on-write clone where the disk has them)
 *   into inputs/, outside the folder the code may write, and checked against
 *   the SHA-256 its index recorded: a file that changed since is refused.
 * - The code runs in work/, its working folder and TMPDIR, the only folder it
 *   may write; it has no network, a time limit, kept output, and the
 *   Executor's limits on files, processes, memory and the folder's size.
 * - Python runs through runner.py, which gives it read_table, result and
 *   table. What it leaves in work/out comes back, within limits, and its
 *   figures are checked against the copied cells (./check).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ExecLimits, ExecResult, Executor } from "../adapters";
import { WORKING_FOLDER } from "../execution";
import { type ClaimedFigure, checkFigure, csvTable, type FigureCheck, readFigures } from "./check";
import runnerSource from "./runner.py?raw";

export type CodeLanguage = "python" | "bash";

/** A Document the code reads: where its file is, and the SHA-256 its index recorded. */
export interface CodeDocument {
  documentId: string;
  /** Its file's name, which the code reads it by in inputs/. */
  name: string;
  path: string;
  contentHash: string;
}

/** A Python the code runs with: the bundled one, or the User's. */
export interface CodePython {
  command: string;
  /** Packages it imports beyond its own, when they are kept apart (INCARNAMIND_SITE). */
  site?: string;
}

export interface CodeRunnerOptions {
  executor: Executor;
  /** Where each run gets its folder, removed when it ends. */
  tempDir: string;
  python: CodePython | null;
  limits: ExecLimits;
  maxOutputBytes: number;
  /** What comes back of work/out: how many files, and the bytes of each. */
  files: { count: number; bytes: number };
}

export interface CodeRequest {
  language: CodeLanguage;
  code: string;
  documents: readonly CodeDocument[];
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CodeFile {
  name: string;
  bytes: number;
  sha256: string;
  /** Its contents, when within the limit. */
  data: Uint8Array | null;
}

export interface CheckedFigure extends ClaimedFigure {
  check: FigureCheck;
}

export interface CodeRun {
  /** Why it didn't run, in plain words; null when it ran. */
  refused: string | null;
  exec: ExecResult | null;
  inputs: { documentId: string; name: string; sha256: string }[];
  codeSha256: string;
  files: CodeFile[];
  figures: CheckedFigure[];
  versions: unknown;
  /** Copying the inputs, running, and reading what it left. */
  ms: { stage: number; run: number; collect: number };
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const safeName = (name: string, taken: Set<string>): string => {
  const stem =
    basename(name)
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^\.+/, "") || "input";
  let candidate = stem;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${basename(stem, extname(stem))}-${n}${extname(stem)}`;
  }
  taken.add(candidate);
  return candidate;
};

export function createCodeRunner(options: CodeRunnerOptions) {
  return {
    level: options.executor.level,
    async run(request: CodeRequest): Promise<CodeRun> {
      const started = performance.now();
      const run = await mkdtemp(join(options.tempDir, "incarnamind-code-"));
      const inputs = join(run, "inputs");
      const lib = join(run, "lib");
      const work = join(run, "work");
      const out = join(work, "out");
      const base: Omit<CodeRun, "refused" | "ms"> = {
        exec: null,
        inputs: [],
        codeSha256: sha256(request.code),
        files: [],
        figures: [],
        versions: null,
      };
      try {
        await Promise.all([mkdir(inputs), mkdir(lib), mkdir(out, { recursive: true })]);
        const taken = new Set<string>();
        for (const document of request.documents) {
          const name = safeName(document.name, taken);
          const copy = join(inputs, name);
          await copyFile(document.path, copy, constants.COPYFILE_FICLONE);
          const hash = sha256(await readFile(copy));
          if (hash !== document.contentHash) {
            const stage = performance.now() - started;
            return {
              ...base,
              refused: `${document.name} changed since IncarnaMind read it, so the code didn't run. Read it again first.`,
              ms: { stage, run: 0, collect: 0 },
            };
          }
          await chmod(copy, 0o444);
          base.inputs.push({ documentId: document.documentId, name, sha256: hash });
        }
        await chmod(inputs, 0o555);
        if (request.language === "python" && !options.python) {
          return {
            ...base,
            refused: "Python isn't available here, so the code didn't run.",
            ms: { stage: performance.now() - started, run: 0, collect: 0 },
          };
        }
        const main = join(lib, request.language === "python" ? "main.py" : "main.sh");
        await writeFile(main, request.code);
        await writeFile(join(lib, "runner.py"), runnerSource);
        const python = options.python;
        const program =
          request.language === "python" && python
            ? { command: python.command, args: ["-I", "-B", join(lib, "runner.py")] }
            : { command: "bash", args: ["--noprofile", "--norc", main] };
        const ran = performance.now();
        const exec = await options.executor.run({
          ...program,
          cwd: work,
          env: {
            INCARNAMIND_INPUTS: inputs,
            INCARNAMIND_OUT: out,
            ...(python?.site ? { INCARNAMIND_SITE: python.site } : {}),
            PYTHONHASHSEED: "0",
            PYTHONIOENCODING: "utf-8",
            MPLBACKEND: "Agg",
            MPLCONFIGDIR: join(work, ".matplotlib"),
            OPENBLAS_NUM_THREADS: "2",
            OMP_NUM_THREADS: "2",
          },
          allow: {
            read: [inputs, lib, WORKING_FOLDER, ...(python?.site ? [python.site] : [])],
            write: [WORKING_FOLDER],
            network: "none",
          },
          timeoutMs: request.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          limits: options.limits,
          signal: request.signal,
        });
        const collecting = performance.now();
        const files: CodeFile[] = [];
        const names = (await readdir(out, { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort();
        let results: unknown = null;
        for (const name of names) {
          const path = join(out, name);
          const size = (await stat(path)).size;
          const data = size <= options.files.bytes ? new Uint8Array(await readFile(path)) : null;
          if (name === "results.json" && data) {
            try {
              results = JSON.parse(new TextDecoder().decode(data));
            } catch {
              results = null;
            }
            continue;
          }
          if (files.length < options.files.count) {
            files.push({ name, bytes: size, sha256: data ? sha256(data) : "", data });
          }
        }
        const tables = new Map<string, ReturnType<typeof csvTable>>();
        const tableOf = (input: string) => {
          if (!base.inputs.some((each) => each.name === input) || !/\.csv$/i.test(input))
            return null;
          return tables.get(input) ?? null;
        };
        for (const input of base.inputs) {
          if (!/\.csv$/i.test(input.name)) continue;
          const bytes = await readFile(join(inputs, input.name));
          if (sha256(bytes) !== input.sha256) continue;
          tables.set(input.name, csvTable(new TextDecoder().decode(bytes)));
        }
        const figures = readFigures(results).map((figure) => ({
          ...figure,
          check: checkFigure(figure, (input) => tableOf(input)),
        }));
        const versions =
          typeof results === "object" && results !== null
            ? ((results as Record<string, unknown>).versions ?? null)
            : null;
        return {
          ...base,
          refused: null,
          exec,
          files,
          figures,
          versions,
          ms: {
            stage: ran - started,
            run: collecting - ran,
            collect: performance.now() - collecting,
          },
        };
      } finally {
        await chmod(inputs, 0o755).catch(() => undefined);
        await rm(run, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    },
  };
}
