/**
 * `run_code` (ADR-0025): Python or bash an Answer wrote, run by the Executor
 * at level "os" on copies of the Documents it names.
 *
 * - Each Document is copied (a copy-on-write clone where the disk has them)
 *   into inputs/, which the code may read but not write, and the copy must
 *   have the SHA-256 the index recorded for the version the model was given:
 *   a file that changed since is refused before anything runs.
 * - A sheet or CSV file is also read here, from that copy, with the reader the
 *   index uses (past the index's own limits, to `TABLE_LIMITS`), and handed to
 *   the code as read_table's rows; a figure the code gives with figure() is
 *   worked out again from those cells, never from what the sandbox says.
 * - The code runs in work/, its working folder and TMPDIR and the only folder
 *   it may write, with no network, a time limit, kept output, and the
 *   Executor's limits on files, processes, memory and the folder's size.
 * - What it leaves in work/out comes back as data, within limits: a file is
 *   only ever read as bytes, and a link or a file with another name is skipped.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  ANALYSIS_LIMITS,
  type AnalysisEnd,
  type AnalysisInput,
  type AnalysisOutput,
  type AnalysisVersions,
  noAnalysisOutput,
  OUT_FILES,
  readAnalysisEnd,
  readAnalysisOutput,
} from "../../shared/analysis";
import type { UnitText } from "../../shared/units";
import type { ExecLimits, ExecResult, Executor } from "../adapters";
import { sha256 as sha256Text } from "../analysis";
import { readRange, sheetRows, sheetsOf, WHOLE } from "../analysis/ranges";
import { rangeInput } from "../analysis/tool";
import type { AnalysisRangeInput, EmbeddingModelError } from "../api";
import type { CitationSource } from "../documents";
import { extractCsv } from "../documents/formats/csv";
import { extractXlsx } from "../documents/formats/xlsx";
import { WORKING_FOLDER } from "../execution";
import type { PythonRuntime } from "./python";
import runnerSource from "./runner.py?raw";

export type CodeLanguage = "python" | "bash";

/** A Document the code reads: the Passage the model named it by, and where its file is. */
export interface CodeDocument {
  source: CitationSource;
  /** Its file, absolute. */
  path: string;
}

/** How long one call may run. */
export const RUN_CODE_TIME_LIMIT_MS = 120_000;

/** What a run may use besides its time (ADR-0025, decision 2). */
export const RUN_CODE_LIMITS = {
  fileBytes: 100 * 1024 * 1024,
  processes: 64,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  folderBytes: 200 * 1024 * 1024,
} as const satisfies ExecLimits;

/** How much of each output stream is kept. */
export const RUN_CODE_OUTPUT_BYTES = 64 * 1024;

/** The Documents one run may copy: each, and all of them together. */
export const INPUT_BYTES = { each: 1024 * 1024 * 1024, all: 2 * 1024 * 1024 * 1024 };

/** The rows and cells of one Document read_table gives: ten times what the index keeps. */
export const TABLE_LIMITS = { rows: 200_000, cells: 2_000_000 };

/** A sheet or CSV file larger than this isn't read as a table here: its text would be held whole. */
export const TABLE_FILE_BYTES = 100 * 1024 * 1024;

/** A text file's start that comes back to the model with its name. */
const PREVIEW_CHARACTERS = 2000;
const PREVIEWED = new Set([
  ".csv",
  ".tsv",
  ".txt",
  ".json",
  ".md",
  ".log",
  ".html",
  ".xml",
  ".sql",
]);

export interface CodeRunnerOptions {
  /** The OS sandbox's: `run_code` runs at no other level. */
  executor: Executor;
  /** Where each run gets its folder, removed when it ends. */
  tempDir: string;
  /** IncarnaMind's own Python; null where this copy has none, which leaves bash. */
  python: PythonRuntime | null;
  /** The helper Analyses run through, which Python here runs through too. */
  helper: string;
  /** The font plots draw what matplotlib's own fonts lack with; null: none. */
  font: string | null;
  appVersion: string;
  /** How long one run may take; `RUN_CODE_TIME_LIMIT_MS` unless a test says. */
  timeLimitMs?: number;
}

export interface CodeRequest {
  language: CodeLanguage;
  code: string;
  documents: readonly CodeDocument[];
  signal: AbortSignal;
}

/** A Document as the run copied it: the name the code reads it by in ../inputs. */
export interface CodeFile {
  name: string;
  documentId: string;
  documentName: string;
  contentHash: string;
  bytes: number;
}

/** A file the code left in out/. */
export interface CodeOutFile {
  name: string;
  bytes: number;
  sha256: string;
  /** The start of a text file, for the model; absent for anything else. */
  text?: string;
}

/** A sheet read_table can give: its rows as the job's input, and the record a Citation keeps. */
export interface CodeTable {
  job: Extract<AnalysisInput, { kind: "table" }>;
  record: Omit<AnalysisRangeInput, "sha256">;
  /** Its file in ../inputs and its sheet: what read_table names it by. */
  file: string;
  sheet: string | null;
}

export type CodeRun =
  | { kind: "refused"; reason: string }
  | { kind: "no-python"; error: EmbeddingModelError | null }
  | {
      kind: "ran";
      end: AnalysisEnd;
      output: AnalysisOutput;
      ms: number;
      exec: ExecResult;
      files: CodeFile[];
      out: CodeOutFile[];
      /** Files left in out/ past `OUT_FILES`. */
      outLeft: number;
      tables: CodeTable[];
      /** The tables read_table gave, by name. */
      read: string[];
      versions: AnalysisVersions;
    };

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** A file name the code can type, kept apart from the run's others. */
function safeName(name: string, taken: Set<string>): string {
  const stem =
    basename(name)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
      .replace(/^[.\s]+/, "")
      .trim() || "input";
  let candidate = stem;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${basename(stem, extname(stem))}-${n}${extname(stem)}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** The sheets read_table gives of a copied Document: none for a kind with no rows. */
async function readTables(
  file: string,
  name: string,
  source: CitationSource,
): Promise<CodeTable[]> {
  const kind = source.documentKind;
  if (kind !== "csv" && kind !== "xlsx") return [];
  if ((await stat(file)).size > TABLE_FILE_BYTES) return [];
  const bytes = new Uint8Array(await readFile(file));
  const units: UnitText[] =
    kind === "csv"
      ? extractCsv(bytes, TABLE_LIMITS).units
      : (await extractXlsx(bytes, false, TABLE_LIMITS)).units;
  const tables: CodeTable[] = [];
  for (const sheet of sheetsOf(units)) {
    const read = readRange(sheetRows(units, sheet), WHOLE, TABLE_LIMITS);
    if (!read || read.rows.length === 0) continue;
    const tableName = sheet === null ? name : `${name}!${sheet}`;
    tables.push({ ...rangeInput(tableName, source, units, sheet, read), file: name, sheet });
  }
  return tables;
}

/** Reads `path` only when it is a plain file of its own, never through a link, up to `limit` bytes. */
async function ownFile(path: string, limit: number): Promise<Buffer | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.nlink !== 1 || info.size > limit) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`;
}

/** How a run ended, from what the Executor saw, before what the code itself said. */
function endOf(exec: ExecResult, signal: AbortSignal, limitMs: number): AnalysisEnd | null {
  if (signal.aborted) return { kind: "stopped" };
  if (exec.timedOut) return { kind: "timed-out", limitMs };
  if (exec.limit === "memory") return { kind: "out-of-memory" };
  if (exec.limit === "folder") {
    return {
      kind: "error",
      message: `It wrote more than ${RUN_CODE_LIMITS.folderBytes / 1024 / 1024} MB into its folder and was stopped.`,
      line: null,
    };
  }
  return null;
}

const printedOf = (exec: ExecResult) =>
  [exec.stdout.trimEnd(), exec.stdoutTruncated ? "(cut)" : ""].filter(Boolean).join("\n");

export function createCodeRunner(options: CodeRunnerOptions) {
  const timeLimitMs = options.timeLimitMs ?? RUN_CODE_TIME_LIMIT_MS;
  const helperSha256 = sha256(`${options.helper}\n${runnerSource}`);

  async function stage(
    run: string,
    request: CodeRequest,
  ): Promise<{ refused: string } | { files: CodeFile[]; tables: CodeTable[] }> {
    const inputs = join(run, "inputs");
    const taken = new Set<string>();
    const files: CodeFile[] = [];
    const tables: CodeTable[] = [];
    let all = 0;
    for (const document of request.documents) {
      const { source } = document;
      const size = (await stat(document.path).catch(() => null))?.size ?? null;
      if (size === null) {
        return { refused: `${source.documentName}'s file can't be found, so nothing ran.` };
      }
      all += size;
      if (size > INPUT_BYTES.each || all > INPUT_BYTES.all) {
        return {
          refused: `${source.documentName} makes the files too large to copy for one run (${INPUT_BYTES.each / 1024 ** 3} GB each, ${INPUT_BYTES.all / 1024 ** 3} GB in all), so nothing ran.`,
        };
      }
      // The file's own name, extension and all: a Document's name drops it, and the User may rename it.
      const name = safeName(basename(document.path), taken);
      const copy = join(inputs, name);
      await copyFile(document.path, copy, constants.COPYFILE_FICLONE);
      if ((await hashFile(copy)) !== source.contentHash) {
        return {
          refused: `${source.documentName} changed since IncarnaMind read it, so nothing ran. Search it again, then run the code on what you find.`,
        };
      }
      await chmod(copy, 0o444);
      files.push({
        name,
        documentId: source.documentId,
        documentName: source.documentName,
        contentHash: source.contentHash,
        bytes: size,
      });
      if (request.language === "python") tables.push(...(await readTables(copy, name, source)));
    }
    await chmod(inputs, 0o555);
    return { files, tables };
  }

  async function collect(out: string): Promise<{ files: CodeOutFile[]; left: number }> {
    if (!(await lstat(out).catch(() => null))?.isDirectory()) return { files: [], left: 0 };
    const names = (await readdir(out).catch(() => [] as string[])).sort();
    const files: CodeOutFile[] = [];
    let left = 0;
    for (const name of names) {
      const data =
        files.length < OUT_FILES.count ? await ownFile(join(out, name), OUT_FILES.bytes) : null;
      if (!data) {
        left++;
        continue;
      }
      const preview = PREVIEWED.has(extname(name).toLowerCase())
        ? new TextDecoder("utf-8", { fatal: false }).decode(
            data.subarray(0, PREVIEW_CHARACTERS * 4),
          )
        : null;
      files.push({
        name,
        bytes: data.byteLength,
        sha256: sha256(data),
        ...(preview !== null && {
          text: Array.from(preview).slice(0, PREVIEW_CHARACTERS).join(""),
        }),
      });
    }
    return { files, left };
  }

  return {
    level: options.executor.level,
    /** Whether Python can run here at all: this copy has IncarnaMind's own. */
    hasPython: options.python !== null,
    async run(request: CodeRequest): Promise<CodeRun> {
      let command: string;
      let fontCache: string | null = null;
      let versions: AnalysisVersions;
      if (request.language === "python") {
        if (!options.python) return { kind: "no-python", error: null };
        const ready = await options.python.ensure(request.signal);
        if (!ready.ok) return { kind: "no-python", error: ready.error };
        command = ready.python.command;
        fontCache = ready.python.fontCache;
        const { manifest } = ready.python;
        versions = {
          language: "python",
          languageVersion: manifest.python,
          runtime: `CPython ${manifest.python} (${manifest.file}, SHA-256 ${manifest.sha256})`,
          packages: manifest.packages,
          helper: helperSha256,
          app: options.appVersion,
        };
      } else {
        command = "/bin/bash";
        versions = {
          language: "bash",
          languageVersion: "",
          runtime: "/bin/bash, in the OS sandbox",
          packages: {},
          helper: "",
          app: options.appVersion,
        };
      }
      request.signal.throwIfAborted();
      const run = await mkdtemp(join(options.tempDir, "incarnamind-code-"));
      const lib = join(run, "lib");
      const work = join(run, "work");
      const out = join(work, "out");
      try {
        await Promise.all([
          mkdir(join(run, "inputs")),
          mkdir(join(lib, "tables"), { recursive: true }),
          mkdir(out, { recursive: true }),
        ]);
        const staged = await stage(run, request);
        if ("refused" in staged) return { kind: "refused", reason: staged.refused };
        const result = join(work, `.incarnamind-result-${sha256(run).slice(0, 12)}.json`);
        if (request.language === "python") {
          // matplotlib rebuilds a missing font cache, about 8 s: each run starts from the one the
          // first import built.
          if (fontCache) {
            await cp(fontCache, join(work, ".matplotlib"), { recursive: true }).catch(
              (error: unknown) => {
                // Only a speed-up: without it, matplotlib builds its own.
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              },
            );
          }
          await writeFile(join(lib, "runner.py"), runnerSource);
          await writeFile(join(lib, "incarnamind.py"), options.helper);
          const index = await Promise.all(
            staged.tables.map(async (table, at) => {
              const path = `${at + 1}.json`;
              await writeFile(join(lib, "tables", path), JSON.stringify(table.job));
              return { file: table.file, sheet: table.sheet, name: table.job.name, path };
            }),
          );
          await writeFile(join(lib, "tables", "index.json"), JSON.stringify(index));
          await writeFile(
            join(lib, "job.json"),
            JSON.stringify({
              code: request.code,
              limits: ANALYSIS_LIMITS,
              font: options.font,
              tableMegabytes: TABLE_FILE_BYTES / 1024 / 1024,
              inputsFolder: join(run, "inputs"),
              result,
            }),
          );
        } else {
          await writeFile(join(lib, "main.sh"), request.code);
        }
        const started = performance.now();
        const exec = await options.executor.run({
          command,
          args:
            request.language === "python"
              ? ["-I", "-B", join(lib, "runner.py")]
              : ["--noprofile", "--norc", join(lib, "main.sh")],
          cwd: work,
          env: {
            HOME: work,
            // bash takes its folder from PWD; getcwd() can't read the folders above it in the sandbox.
            PWD: work,
            INCARNAMIND_INPUTS: join(run, "inputs"),
            INCARNAMIND_OUT: out,
            ...(request.language === "python" && {
              INCARNAMIND_JOB: join(lib, "job.json"),
              INCARNAMIND_WORKING_FOLDER: work,
              MPLBACKEND: "Agg",
              MPLCONFIGDIR: join(work, ".matplotlib"),
              PYTHONHASHSEED: "0",
              PYTHONIOENCODING: "utf-8",
              OPENBLAS_NUM_THREADS: "2",
              OMP_NUM_THREADS: "2",
            }),
          },
          allow: {
            read: [
              join(run, "inputs"),
              lib,
              WORKING_FOLDER,
              ...(options.font ? [dirname(options.font)] : []),
            ],
            write: [WORKING_FOLDER],
            network: "none",
          },
          timeoutMs: timeLimitMs,
          maxOutputBytes: RUN_CODE_OUTPUT_BYTES,
          limits: RUN_CODE_LIMITS,
          signal: request.signal,
        });
        const ms = Math.round(performance.now() - started);
        // Read back from where the sandbox can't write: a process the code left running (a session
        // of its own escapes the stop on macOS) can no longer swap a file or a folder for a link.
        // `rename` moves a link itself, never what it points at.
        const done = join(run, "done");
        await rename(work, done).catch((error: unknown) => {
          // The code removed its own folder: it left nothing to read.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        const folder = (await lstat(done).catch(() => null))?.isDirectory() ? done : null;
        const stopped = endOf(exec, request.signal, timeLimitMs);
        let end: AnalysisEnd;
        let output = noAnalysisOutput();
        let read: string[] = [];
        if (request.language === "python") {
          const raw = folder && (await ownFile(join(folder, basename(result)), 64 * 1024 * 1024));
          let given: unknown = null;
          try {
            given = raw ? JSON.parse(raw.toString("utf8")) : null;
          } catch {
            given = null;
          }
          const fields =
            typeof given === "object" && given !== null ? (given as Record<string, unknown>) : {};
          output = readAnalysisOutput(fields.output);
          const names = new Set(staged.tables.map((table) => table.job.name));
          read = Array.isArray(fields.read)
            ? fields.read.filter(
                (name): name is string => typeof name === "string" && names.has(name),
              )
            : [];
          end =
            stopped ??
            readAnalysisEnd(fields.end) ??
            (exec.exitCode === 0
              ? { kind: "crashed" }
              : {
                  kind: "error",
                  message: tail(
                    exec.stderr.trim() || `Python exited with code ${exec.exitCode}.`,
                    ANALYSIS_LIMITS.errorCharacters,
                  ),
                  line: null,
                });
          const printed = printedOf(exec);
          if (printed)
            output.printed = `${output.printed}${output.printed ? "\n" : ""}${printed}`.slice(
              0,
              ANALYSIS_LIMITS.printed,
            );
        } else {
          output.printed = printedOf(exec).slice(0, ANALYSIS_LIMITS.printed);
          output.cut.printed = exec.stdoutTruncated || exec.stdout.length > ANALYSIS_LIMITS.printed;
          end =
            stopped ??
            (exec.exitCode === 0
              ? { kind: "done" }
              : {
                  kind: "error",
                  message: tail(
                    exec.stderr.trim() || `It exited with code ${exec.exitCode}.`,
                    ANALYSIS_LIMITS.errorCharacters,
                  ),
                  line: null,
                });
        }
        const collected = folder ? await collect(join(folder, "out")) : { files: [], left: 0 };
        return {
          kind: "ran",
          end,
          output,
          ms,
          exec,
          files: staged.files,
          out: collected.files,
          outLeft: collected.left,
          tables: staged.tables,
          read,
          versions,
        };
      } finally {
        await chmod(join(run, "inputs"), 0o755).catch(() => undefined);
        await rm(run, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    },
  };
}

export type CodeRunner = ReturnType<typeof createCodeRunner>;

/** SHA-256 of a table's headings and rows, as an Analysis's range input records it. */
export const tableSha256 = (table: CodeTable) =>
  sha256Text(JSON.stringify([table.job.columns, table.job.rows]));
