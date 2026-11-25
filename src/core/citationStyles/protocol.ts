/** What the core and the citation-style thread (./styleWorker) send each other. */
import type { FormatJob } from "./format";
import type { EngineOutput, StyleDescription } from "./wasm";

/** A style of the pack to format with, by its file's name, and the locale its terms come from. */
export interface EngineStyle {
  packId: string;
  locale?: string;
}

export type WorkerRequest =
  | {
      id: number;
      style: EngineStyle;
      job: FormatJob;
    }
  | { close: true };

export type WorkerResponse =
  | { id: number; ok: true; description: StyleDescription; output: EngineOutput }
  | {
      id: number;
      ok: false;
      message: string;
      /** The style itself can't be used, rather than this request. */
      style: boolean;
    };
