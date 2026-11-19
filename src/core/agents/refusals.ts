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

/** A call's text argument, trimmed; a refusal when it is missing, blank or longer than `max`. */
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
