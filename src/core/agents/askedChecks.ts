/**
 * The checks the User asked of their own AI (#3622). Pressing Check with no model set up asks one
 * connected agent to check the Note (./ask). While that ask stands, that agent may take the Note's
 * sentences and hand back its marks as it does for a Note it wrote: a Note the User wrote too, and
 * on a connection that may only read, since marks change none of the Note's words and the User
 * chose that agent with the press. One agent at a time for each Note, the last one asked; kept on
 * this device for as long as IncarnaMind runs.
 */

import {
  AGENT_TOOLS,
  type AgentActivity,
  type AgentToolName,
  type NoteChangeApplied,
  type NoteSelectionBlock,
} from "../api";

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

/**
 * A connection IncarnaMind started for one check the User pressed (./ownRun): its Note, and the
 * Tools it may call. The grant is the run's only hold on the Note: the run records no ask, so the
 * agent's own connections gain nothing from it, and nothing of it stands once the run ends.
 */
export interface CheckRun {
  kind: "check";
  mindId: string;
  tools: readonly AgentToolName[];
}

/**
 * Every Tool of the connection: a Note's conversation runs the command line with its own tools, so
 * a file it made reaches the Library by its path, as from the agent the User runs themselves
 * (#3653).
 */
export const CONVERSATION_TOOLS = AGENT_TOOLS;

/** The words selected in one top-level Block of the Note, by the plain text kept around them. */
export type SelectedInBlock = NoteSelectionBlock;

/**
 * A connection IncarnaMind started for one request typed at a Note's foot (./noteConversations):
 * it stands for the pairing, with its reach and write switch, and every Tool but a file by its
 * path. `front`: the Note the request was made from, and the words selected in it, if any.
 */
export interface ConversationRun extends ConversationHears {
  kind: "conversation";
  tools: readonly AgentToolName[];
  /**
   * The Note asked from, the words selected in it, and what the User typed; and the real path of
   * the conversation's own folder, the only place a file by its path is taken from (null: none is).
   */
  front: {
    mindId: string;
    selection: readonly SelectedInBlock[] | null;
    words: string;
    folder: string | null;
  };
}

/** What a conversation's run hears of its own calls, and only its own (#3627). */
export interface ConversationHears {
  /** Each request of changes made in the front Note that applies at once, with what it changed. */
  asked?(made: AskedInFront): void;
  /**
   * Each call of the run as IncarnaMind starts it, once it is let in; what it returns is called
   * as the call ends, however it ends.
   */
  calling?(tool: AgentToolName): () => void;
  /** Each call of the run, as its activity row records it. */
  called?(call: RunCall): void;
}

/** A call of a run, as its activity row records it. */
export type RunCall = Pick<
  AgentActivity,
  "tool" | "summary" | "outcome" | "problem" | "count" | "effects" | "documentIds"
>;

/** A request of changes in the front Note that applies at once, and what it changed, as its line counts. */
export type AskedInFront = NoteChangeApplied;

export type RunGrant = CheckRun | ConversationRun;

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
    /** IncarnaMind started an agent for the Note's check (./ownRun): an agent asked before no longer may. */
    withdraw(mindId: string): void {
      asked.delete(mindId);
    },
  };
}

export type AskedChecks = ReturnType<typeof createAskedChecks>;
