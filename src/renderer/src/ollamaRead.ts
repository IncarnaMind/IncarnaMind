import type { OllamaStatus } from "../../core/api";

/**
 * What a look for the model app on this computer says: still looking (the first look, or the one
 * retry after a wait that ran out), settled in doubt, running, or not running. Everything that
 * shows the probe reads this, so the setup card, Settings and the local-model dialog cannot say
 * different things about the same look.
 */
export type OllamaRead = "looking" | "no-answer" | "running" | "not-running";

export function ollamaRead(ollama: {
  status: OllamaStatus | null;
  /** The retry after a wait that ran out is still to come. */
  retryComing: boolean;
}): OllamaRead {
  const { status } = ollama;
  if (status === null) return "looking";
  if (status.running) return "running";
  // Silence is not an answer: a look that ran out of time is in doubt until its retry has run.
  if (status.unknown !== true) return "not-running";
  return ollama.retryComing ? "looking" : "no-answer";
}
