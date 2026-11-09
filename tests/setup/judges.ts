/**
 * Fails a test whose scripted model was asked a judge's question it had no reply for
 * (tests/helpers/models.ts): the judge reads a failed call as Not checked, so a reworded or new
 * question would otherwise pass as a check that failed closed (#2817).
 */
import { afterEach } from "vitest";

afterEach(() => {
  const asked = (globalThis as { unscriptedJudges?: string[] }).unscriptedJudges;
  const unscripted = asked?.splice(0) ?? [];
  if (unscripted.length > 0) {
    throw new Error(`A judge's question had no scripted reply: ${unscripted.join("; ")}`);
  }
});
