/**
 * `run_code` (ADR-0025): the contract between the core, which offers the Tool and keeps what a
 * run gives, and the host that runs it (src/main/runCode). The host copies the Documents, runs
 * the code in the OS sandbox with IncarnaMind's own Python or bash, and reads back what it left;
 * the core never touches the files itself.
 */
import type {
  AnalysisEnd,
  AnalysisInput,
  AnalysisOutput,
  AnalysisVersions,
} from "../../shared/analysis";
import type { ExecResult, Executor, Logger, SandboxLevel } from "../adapters";
import { sha256 as sha256Text } from "../analysis";
import type { AnalysisRangeInput, EmbeddingModelError, EmbeddingModelStatus } from "../api";
import type { CitationSource } from "../documents";

export type CodeLanguage = "python" | "bash";

/** A Document the code reads: the Passage the model named it by, and where its file is. */
export interface CodeDocument {
  source: CitationSource;
  /** Its file, absolute. */
  path: string;
  /** The User had the Library read its hidden sheets: read_table gives them as well. */
  readHiddenSheets?: boolean;
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

/** Runs one call's code: what the host gives the core. */
export interface CodeRunner {
  /** The Executor's level: `run_code` is offered only at "os". */
  level: SandboxLevel;
  /** Whether this copy has IncarnaMind's own Python at all; bash runs without it. */
  hasPython: boolean;
  /** Whether Python can be had now: this copy has it, and its download or start hasn't failed. */
  pythonUsable(): boolean;
  run(request: CodeRequest): Promise<CodeRun>;
}

/** The archive this build of the app goes with, as the build wrote it. */
export interface PythonRuntimeManifest {
  /** Its file name: "python-runtime-darwin-arm64.tar.zst". */
  file: string;
  /** Where it is downloaded from. */
  url: string;
  size: number;
  /** In hex. */
  sha256: string;
  /** "darwin-arm64", "linux-x64". */
  platform: string;
  /** CPython's version: "3.14.10". */
  python: string;
  /** Each distribution it has, by name: `{ numpy: "2.5.4" }`. */
  packages: Readonly<Record<string, string>>;
}

/** IncarnaMind's own Python where it is installed on this computer. */
export interface InstalledPython {
  /** The interpreter: …/python/bin/python3. */
  command: string;
  /**
   * Where it is installed, …/python, which each of its runs names in its request: the one folder
   * in the data folder the sandbox lets a program read for being where its interpreter is.
   */
  prefix: string;
}

/** IncarnaMind's own Python, as the core shows and stops it. */
export interface PythonRuntimeHandle {
  manifest: PythonRuntimeManifest;
  status(): EmbeddingModelStatus;
  /**
   * The interpreter once it is downloaded, checked and imported here; null until then. Asking never
   * starts a download (ADR-0022): Skill scripts use it only when `run_code` has got it already.
   */
  installed(): InstalledPython | null;
  close(): void;
}

/** What the host needs from the core to start `run_code`. */
export interface CodeHostContext {
  /** The OS sandbox's Executor. */
  executor: Executor;
  dataDir: string;
  tempDir: string;
  fetch: typeof fetch;
  emitStatus(status: EmbeddingModelStatus): void;
  log?: Logger;
}

/** The host's side of `run_code`, which the desktop app passes in as an adapter. */
export interface CodeHost {
  start(context: CodeHostContext): { runner: CodeRunner; python: PythonRuntimeHandle | null };
}

/** SHA-256 of a table's headings and rows, as an Analysis's range input records it. */
export const tableSha256 = (table: CodeTable) =>
  sha256Text(JSON.stringify([table.job.columns, table.job.rows]));
