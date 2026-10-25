/**
 * The hidden window that runs Analyses (ADR-0023): the scheme its page and
 * the bundled Python come from, and what the main process and its page say
 * to each other. Pure: the main process, the window's preload and its page
 * share it.
 */

/** Served only to the window's own session, which cancels every request but this scheme's. */
export const ANALYSIS_SCHEME = "incarnamind-analysis";
export const ANALYSIS_ORIGIN = `${ANALYSIS_SCHEME}://app`;

/** Where the page finds Pyodide and the packages under its origin. */
export const PYTHON_PATH = "/python/";

/** The window's page reaches its preload as `window.incarnamindAnalysis`. */
export const ANALYSIS_BRIDGE_KEY = "incarnamindAnalysis";

export const ANALYSIS_CHANNELS = {
  /** Main → page: run a job (`AnalysisRequest`). */
  run: "analysis:run",
  /** Page → main: Python is ready, or couldn't start (`AnalysisReady`). */
  ready: "analysis:ready",
  /** Page → main: a job's interpreter is ready and it has started (its id): its time runs from now. */
  started: "analysis:started",
  /** Page → main: what a job came to (`AnalysisReply`). */
  done: "analysis:done",
} as const;

export interface AnalysisRequest {
  id: number;
  /** The job and its limits, as JSON, as the helper reads them. */
  job: string;
}

export type AnalysisReady = { ok: true } | { ok: false; message: string };

/** What a job came to, as the helper's JSON; or why the interpreter failed under it. */
export type AnalysisReply = { id: number; result: string } | { id: number; failure: string };

/** Longer, a reply isn't one the helper wrote within its limits: the page doesn't pass it on. */
export const MAX_REPLY_CHARACTERS = 16_000_000;

export interface AnalysisBridge {
  onRun(listener: (request: AnalysisRequest) => void): void;
  ready(state: AnalysisReady): void;
  started(id: number): void;
  done(reply: AnalysisReply): void;
}
