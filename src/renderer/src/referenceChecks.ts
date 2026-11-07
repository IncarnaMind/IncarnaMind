/**
 * Checking a Mind's reference list, the window's side: the line
 * under a verified document's claims (editor/ReferencesLine) starts it, says
 * how far it is, and lists what it found. Results live while the window
 * does; the core keeps what the services answered.
 */
import { create } from "zustand";
import type { CheckReferencesResult } from "../../core/api";
import { core } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";

export type ReferenceCheckState =
  | { kind: "checking"; done: number; total: number }
  | Extract<CheckReferencesResult, { kind: "checked" }>
  | { kind: "error"; message: string };

interface ReferenceChecks {
  /** By Mind: the check going, or how the last one ended. */
  byMind: Readonly<Record<string, ReferenceCheckState>>;
}

export const useReferenceChecks = create<ReferenceChecks>()(() => ({ byMind: {} }));

const set = (mindId: string, state: ReferenceCheckState | null) =>
  useReferenceChecks.setState((current) => {
    const byMind = { ...current.byMind };
    if (state) byMind[mindId] = state;
    else delete byMind[mindId];
    return { byMind };
  });

core.on("referenceCheck.progress", ({ mindId, done, total }) => {
  if (useReferenceChecks.getState().byMind[mindId]?.kind === "checking") {
    set(mindId, { kind: "checking", done, total });
  }
});

/**
 * Checks the Mind's reference list; `total` shows at once, before the core
 * says more. `again`: Check again or Try again, which asks about every kept
 * miss and failure again.
 */
export async function checkReferences(mindId: string, total: number, again = false): Promise<void> {
  set(mindId, { kind: "checking", done: 0, total });
  try {
    const result = await core.checkReferences(mindId, { again });
    set(mindId, result.kind === "checked" ? result : null);
  } catch (error) {
    set(mindId, { kind: "error", message: errorMessage(error, translateNow) });
  }
}

export const stopReferenceCheck = (mindId: string) => void core.stopReferenceCheck(mindId);
