/**
 * What a run of the set keeps of each task (README.md): the Answer as the
 * conversation holds it, how the task's files were taken in, the requests
 * its model calls made, and what the harness saw of containment. The scorer
 * reads only this, so a run is scored again offline.
 */
import type { ConversationAnswer } from "../../src/core/api";
import type { TaskLanguage } from "./task";

/** The Answer as its conversation holds it, its pictures' PNGs replaced by their SHA-256. */
export type SavedAnswer = Pick<
  ConversationAnswer,
  | "status"
  | "text"
  | "citations"
  | "figures"
  | "analyses"
  | "toolCalls"
  | "usage"
  | "errorKind"
  | "errorMessage"
>;

/** How the app took in one of the task's files. */
export interface DocumentEnd {
  name: string;
  /** The English task's name for the same file, which `sources.documents` names. */
  english: string;
  added: boolean;
  /** Its processing status when the question was asked; null when it wasn't added. */
  status: string | null;
  /** Why it wasn't added or read, as the app said. */
  problem: string | null;
}

/** One model request, from the app's own meter (model_requests). */
export interface RequestUsage {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  at: string;
}

/** What the harness saw while the task ran (C4). */
export interface Containment {
  /** Connections the local listener heard, by the request line each opened with. */
  connections: string[];
  /** The canary's secret was in something the run gave: an Analysis's output or the Answer. */
  canaryRead: boolean;
  /** An Analysis's code named the canary file. */
  canaryNamed: boolean;
  /** Files in the task's folder that changed, appeared or went while it ran. */
  changed: string[];
}

/** A file the Answer saved, as the harness read it. */
export interface SavedFile {
  name: string;
  extension: string;
  /** Live formula cells in it, for a workbook. */
  formulas: number;
}

export interface AnswerRecord {
  task: string;
  language: TaskLanguage;
  /** "anthropic/claude-haiku-5-5". */
  model: string;
  /** SHA-256 of the inputs it was given (`inputsHash`): scored only against the reference worked out from them. */
  inputs: string;
  documents: DocumentEnd[];
  answer: SavedAnswer | null;
  /** Why there is no Answer: the run's own words. */
  problem: string | null;
  /** From asking to the Answer's end. */
  seconds: number;
  requests: RequestUsage[];
  containment: Containment;
  files: SavedFile[];
}

/** A run's file of saved Answers. */
export interface RunRecord {
  run: {
    startedAt: string;
    /** The commit the app was built from. */
    commit: string;
    model: string;
    /** "A test build, Chromium's sandbox on, Pyodide 314.0.7". */
    runtime: string;
  };
  answers: AnswerRecord[];
}
