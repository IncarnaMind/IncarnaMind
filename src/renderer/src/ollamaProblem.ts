import type { OllamaStatus } from "../../core/api";

export type OllamaLineAction = "try-again" | "open" | "get" | null;

export function ollamaLineAction(status: OllamaStatus | null, opening: boolean): OllamaLineAction {
  if (status === null || opening) return null;
  if (status.running) return "try-again";
  // A look that ran out of time is not an answer: asking again is the only honest step, since
  // getting or opening the app would claim it is missing.
  if (status.unknown === true) return "try-again";
  return status.installed ? "open" : "get";
}
