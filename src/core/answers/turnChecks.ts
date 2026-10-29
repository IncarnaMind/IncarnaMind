/**
 * The end-of-turn checks (#946): when the model stops, the reply is read by
 * one list of checks, in a fixed order. A check finds nothing, or something
 * wrong: a note to ask the model once more with, and the claims to flag the
 * reply with if it stands. Each check asks at most once, the whole list asks
 * `MAX_NUDGES` times at most, and no ask goes past the step budget. What is
 * left is flagged, by every check, the same way: an Answer flagged with
 * Regenerate (`claims-unbacked`).
 */
import type { ClaimedChange, ClaimedTool } from "../api";

/** What a check found wrong in the reply. */
export interface TurnFinding {
  /** What to tell the model so it writes the reply again. */
  note: string;
  /**
   * The Tool the model calls first when asked: a record it names and never made. Claude Haiku
   * 5.5, told to call `cite`, wrote the same reply again in about one ask in twenty.
   */
  requires?: string;
  /** What flags the reply if it stands: none, for a check that only asks. */
  claims: readonly ClaimedChange[];
  /** The Tools the reply says ran that didn't (#1796), which flag it too. */
  tools?: readonly ClaimedTool[];
}

export interface TurnCheck {
  /** Names the check for its one ask; unique in the list. */
  name: string;
  check(reply: string): TurnFinding | null | Promise<TurnFinding | null>;
}

/** The most times, in all, the checks of one Answer ask the model once more. */
export const MAX_NUDGES = 2;

export interface Nudges {
  /** Whether the check may ask now; if so, it has asked. */
  take(name: string): boolean;
}

/** The asks of one Answer: `steps` is how many model calls it has made of `maxSteps`. */
export function createNudges(maxSteps: number, steps: () => number): Nudges {
  const asked = new Set<string>();
  return {
    take(name) {
      if (asked.has(name) || asked.size >= MAX_NUDGES || steps() >= maxSteps) return false;
      asked.add(name);
      return true;
    },
  };
}

/** What flags a reply that stands: the changes and the Tools it claims that none of its calls made. */
export interface Flags {
  claims: ClaimedChange[];
  tools?: ClaimedTool[];
}

/**
 * What the checks make of a reply: to ask the model once more (and the Tools
 * the ask is about, which the Answer shows as a step, and the one it must call
 * first), or what to flag it with.
 */
export type Settled = { nudge: string; requires?: string; tools?: readonly ClaimedTool[] } | Flags;

export async function settleReply(
  checks: readonly TurnCheck[],
  reply: string,
  nudges: Nudges,
): Promise<Settled> {
  const claims = new Set<ClaimedChange>();
  const tools = new Set<ClaimedTool>();
  for (const each of checks) {
    const found = await each.check(reply);
    if (!found) continue;
    if (found.note && nudges.take(each.name)) {
      return {
        nudge: found.note,
        ...(found.requires && { requires: found.requires }),
        ...(found.tools && found.tools.length > 0 && { tools: found.tools }),
      };
    }
    for (const claim of found.claims) claims.add(claim);
    for (const tool of found.tools ?? []) tools.add(tool);
  }
  return { claims: [...claims], ...(tools.size > 0 && { tools: [...tools] }) };
}

/** What flags a reply that is not asked about again. */
export const flagsOf = async (checks: readonly TurnCheck[], reply: string): Promise<Flags> => {
  const settled = await settleReply(checks, reply, { take: () => false });
  return "claims" in settled ? settled : { claims: [] };
};
