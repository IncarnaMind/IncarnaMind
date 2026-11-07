/**
 * The end-of-turn checks (#946): when the model stops, the reply is read by
 * one list of checks, in a fixed order. A check finds nothing, or something
 * wrong: a note to ask the model once more with, and the claims to flag the
 * reply with if it stands. Each check asks at most once, the whole list asks
 * `MAX_NUDGES` times at most, and no ask goes past the step budget. What is
 * left is flagged, by every check, the same way: an Answer flagged with
 * Regenerate (`claims-unbacked`).
 */
import type { ClaimedChange, ClaimedCommand, ClaimedTool } from "../api";

/** What a check found wrong in the reply. */
export interface TurnFinding {
  /** What to tell the model so it writes the reply again. */
  note: string;
  /**
   * The Tool the model calls first when asked: a record it names and never made. Claude Haiku
   * 5.5, told to call `cite`, wrote the same reply again in about one ask in twenty.
   */
  requires?: string;
  /** The ask lets the model only write: what it asks about has run, and calling again would repeat it. */
  writeOnly?: true;
  /** What flags the reply if it stands: none, for a check that only asks. */
  claims: readonly ClaimedChange[];
  /** The Tools the reply says ran that didn't (#1796), which flag it too. */
  tools?: readonly ClaimedTool[];
  /** What the reply says it did in the app that no call did (#2407), which flags it too. */
  commands?: readonly ClaimedCommand[];
}

export interface TurnCheck {
  /** Names the check for its one ask; unique in the list. */
  name: string;
  /** `setAside`: the turns before the reply that the Run set aside after its search, as `text-set-aside` gives them. */
  check(
    reply: string,
    setAside?: readonly string[],
  ): TurnFinding | null | Promise<TurnFinding | null>;
  /**
   * Starts the check on what the reply will be, while the turn waits on other work before it
   * ends; `check` with that same reply then takes this result, and with any other reply checks
   * it afresh. For a check that asks a model, so its request runs beside the other work.
   */
  warm?(reply: string): void;
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

/**
 * What flags a reply that stands: the changes, the Tools and what in the app it claims that none
 * of its calls made.
 */
export interface Flags {
  claims: ClaimedChange[];
  tools?: ClaimedTool[];
  commands?: ClaimedCommand[];
}

/**
 * What the checks make of a reply: to ask the model once more (and the Tools
 * the ask is about, which the Answer shows as a step, and the one it must call
 * first, and what flags the reply should it stand after all), or what to flag it with.
 */
export type Settled =
  | {
      nudge: string;
      requires?: string;
      writeOnly?: true;
      tools?: readonly ClaimedTool[];
      flags: Flags;
    }
  | Flags;

const flagsOfFinding = (found: TurnFinding): Flags => ({
  claims: [...found.claims],
  ...(found.tools && found.tools.length > 0 && { tools: [...found.tools] }),
  ...(found.commands && found.commands.length > 0 && { commands: [...found.commands] }),
});

/** Both sets of flags, each claim once. */
export function mergedFlags(one: Flags, other: Flags): Flags {
  const tools = [...new Set([...(one.tools ?? []), ...(other.tools ?? [])])];
  const commands = [...new Set([...(one.commands ?? []), ...(other.commands ?? [])])];
  return {
    claims: [...new Set([...one.claims, ...other.claims])],
    ...(tools.length > 0 && { tools }),
    ...(commands.length > 0 && { commands }),
  };
}

export async function settleReply(
  checks: readonly TurnCheck[],
  reply: string,
  nudges: Nudges,
  setAside: readonly string[] = [],
): Promise<Settled> {
  const claims = new Set<ClaimedChange>();
  const tools = new Set<ClaimedTool>();
  const commands = new Set<ClaimedCommand>();
  for (const each of checks) {
    const found = await each.check(reply, setAside);
    if (!found) continue;
    if (found.note && nudges.take(each.name)) {
      return {
        nudge: found.note,
        ...(found.requires && { requires: found.requires }),
        ...(found.writeOnly && { writeOnly: true }),
        ...(found.tools && found.tools.length > 0 && { tools: found.tools }),
        flags: flagsOfFinding(found),
      };
    }
    for (const claim of found.claims) claims.add(claim);
    for (const tool of found.tools ?? []) tools.add(tool);
    for (const command of found.commands ?? []) commands.add(command);
  }
  return {
    claims: [...claims],
    ...(tools.size > 0 && { tools: [...tools] }),
    ...(commands.size > 0 && { commands: [...commands] }),
  };
}

/** What flags a reply that is not asked about again. */
export const flagsOf = async (checks: readonly TurnCheck[], reply: string): Promise<Flags> => {
  const settled = await settleReply(checks, reply, { take: () => false });
  return "claims" in settled ? settled : { claims: [] };
};
