/**
 * The end-of-turn checks (#946): when the model stops, the reply is read by
 * one list of checks, in a fixed order. A check finds nothing, or something
 * wrong: a note to ask the model once more with, and the claims to flag the
 * reply with if it stands. Each check asks at most once, the whole list asks
 * `MAX_NUDGES` times at most, and no ask goes past the step budget. What is
 * left is flagged, by every check, the same way: an Answer flagged with
 * Regenerate (`claims-unbacked`).
 */
import type { ClaimedChange } from "../api";

/** What a check found wrong in the reply. */
export interface TurnFinding {
  /** What to tell the model so it writes the reply again. */
  note: string;
  /** What flags the reply if it stands: none, for a check that only asks. */
  claims: readonly ClaimedChange[];
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

/** What the checks make of a reply: to ask the model once more, or the claims to flag it with. */
export type Settled = { nudge: string } | { claims: ClaimedChange[] };

export async function settleReply(
  checks: readonly TurnCheck[],
  reply: string,
  nudges: Nudges,
): Promise<Settled> {
  const claims = new Set<ClaimedChange>();
  for (const each of checks) {
    const found = await each.check(reply);
    if (!found) continue;
    if (found.note && nudges.take(each.name)) return { nudge: found.note };
    for (const claim of found.claims) claims.add(claim);
  }
  return { claims: [...claims] };
}

/** What flags a reply that is not asked about again. */
export const claimsOf = async (
  checks: readonly TurnCheck[],
  reply: string,
): Promise<ClaimedChange[]> => {
  const settled = await settleReply(checks, reply, { take: () => false });
  return "claims" in settled ? settled.claims : [];
};
