/**
 * How an outside agent's call is refused (#351): in plain words, in the interface language, for the
 * agent to pass on to the User, with the kind of problem its activity row keeps.
 */
import type { AgentProblem } from "../api";

/** Why a call was refused or failed, in the interface language, for the agent to pass on. */
export class AgentRefusedError extends Error {
  constructor(
    readonly problem: AgentProblem,
    message: string,
  ) {
    super(message);
    this.name = "AgentRefusedError";
  }
}

/**
 * A refusal of something the call named that the pairing doesn't reach, or that isn't there: the
 * answer that reads as "nothing is there", so it is told with the line that the User has more
 * than the pairing reaches, where they have (#3544).
 */
export class NotReachedError extends AgentRefusedError {
  constructor(message: string) {
    super("not-found", message);
  }
}

/** A call's text argument, trimmed; a refusal when it is missing, blank or longer than `max`. */
/** The longest path an agent may name for a file on this computer. */
export const MAX_PATH_CHARS = 4096;

export function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentRefusedError("invalid", `${what} must be text.`);
  }
  if (value.length > max) {
    throw new AgentRefusedError("invalid", `${what} is longer than ${max} characters.`);
  }
  return value.trim();
}

/** A call's whole-number argument, `fallback` when it is left out. */
export function whole(
  value: unknown,
  what: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AgentRefusedError("invalid", `${what} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}
