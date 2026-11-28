/**
 * Types shared between the core (`OpenNoteEditor` adapter), Electron main, preload bridge, and
 * renderer for lossless immediate outside-agent writes in a mounted Note editor (#3839).
 */
import type { NamedChange, RemovedParagraphs } from "../core/api";

/** Result of preparing an open Note editor before an immediate agent write (#3839). */
export type OpenNotePrepareResult =
  | { open: false }
  | { open: true; busy: true }
  | { open: true; busy: false; token: string };

/** Details passed to a mounted Note editor to accept an agent's Proposals on the UI thread (#3839). */
export interface OpenNoteAcceptInput {
  mindId: string;
  request: string;
  token: string;
  stateVector: Uint8Array;
  changed: number;
  added: number;
  tables: number;
  tablesRemoved?: true;
  removed?: RemovedParagraphs;
  named?: NamedChange;
}

export type OpenNoteAcceptResult = "applied" | "changed" | "not-open" | "timeout";

/**
 * Reaches a mounted editable Note editor in the host window, when the Note is currently shown in
 * one (#3839). Absent in headless/CLI/test runs, where writes apply directly in the core.
 */
export interface OpenNoteEditor {
  /**
   * Flushes any in-flight local edits from the mounted editor to the core before a write begins.
   * Waits briefly for active IME composition to settle before returning `{ open: true, busy: true }`.
   */
  prepareWrite(mindId: string): Promise<OpenNotePrepareResult>;
  /**
   * Accepts `request`'s Proposals on the mounted editor's UI thread in one Undo step, saving a
   * Checkpoint first and drawing the inline applied-edit line. Returns `"changed"` with zero DOM
   * mutation if the User edited a targeted paragraph, remained busy past the settle window, or any
   * target is stale; returns `"timeout"` when the window did not answer in time so the core can
   * confirm the document state directly.
   */
  acceptInEditor(input: OpenNoteAcceptInput): Promise<OpenNoteAcceptResult>;
}
