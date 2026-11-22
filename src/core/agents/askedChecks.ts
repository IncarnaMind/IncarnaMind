/**
 * The checks the User asked of their own AI (#3622). Pressing Check with no model set up asks one
 * connected agent to check the Note (./ask). While that ask stands, that agent may take the Note's
 * sentences and hand back its marks as it does for a Note it wrote: a Note the User wrote too, and
 * on a connection that may only read, since marks change none of the Note's words and the User
 * chose that agent with the press. One agent at a time for each Note, the last one asked; kept on
 * this device for as long as IncarnaMind runs.
 */

import type { AgentToolName } from "../api";

/**
 * The Tools a check the User asked may use when IncarnaMind starts the agent for it (ADR-0032):
 * what `check_mind_yourself`'s rules send it to, and nothing that changes words or reads other Notes.
 */
export const CHECK_RUN_TOOLS = [
  "check_mind_yourself",
  "search",
  "read_passages",
  "cite",
  "run_analysis",
  "report_check",
] as const satisfies readonly AgentToolName[];

/** A connection IncarnaMind started for one asked check: its Note, and the Tools it may call. */
export interface CheckRun {
  mindId: string;
  tools: readonly AgentToolName[];
}

/**
 * How long an ask stands. #3587's six real checks took 30 to 97 seconds from the press to the
 * marks; this leaves room for a Note many times longer, and for a User who sends the request a
 * while after pressing Check.
 */
export const ASKED_CHECK_MS = 30 * 60_000;

export function createAskedChecks(now: () => string) {
  const asked = new Map<string, { pairingId: string; at: number }>();
  return {
    /** The User asked `pairingId` to check the Note: the agent asked before it no longer may. */
    asked(pairingId: string, mindId: string): void {
      asked.set(mindId, { pairingId, at: Date.parse(now()) });
    },
    /** Whether the User asked `pairingId` to check the Note, and the ask still stands. */
    holds(pairingId: string, mindId: string): boolean {
      const ask = asked.get(mindId);
      if (!ask) return false;
      if (Date.parse(now()) - ask.at > ASKED_CHECK_MS) {
        asked.delete(mindId);
        return false;
      }
      return ask.pairingId === pairingId;
    },
    /** The check landed whole: the ask is over. */
    end(pairingId: string, mindId: string): void {
      if (asked.get(mindId)?.pairingId === pairingId) asked.delete(mindId);
    },
  };
}

export type AskedChecks = ReturnType<typeof createAskedChecks>;
