import { wrapLanguageModel } from "ai";
import type { unbackedClaims } from "../../src/core/answers/claimedChanges";
import type { Probe } from "./claimProbes";
import { MINDS, names, parts, requestOf } from "./claimProbes";
import type { Row } from "./privacyMoves";

type Check = typeof unbackedClaims;
type ChatModel = Parameters<Check>[4]["model"];

export interface Arm {
  name: string;
  check: Check;
}

/** What the requests of a run have cost so far, by what the provider reported. */
export interface Meter {
  requests: number;
  inputTokens: number;
  /** Of `inputTokens`, those the provider read from its cache, which cost far less. */
  cacheReadTokens: number;
  outputTokens: number;
  /** Every request refused, failed or timed out since the last check began, in the provider's words. */
  refused: string[];
}

export const newMeter = (): Meter => ({
  requests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  refused: [],
});

/** A model whose requests are counted, with the tokens each used and every one the provider refused. */
export function metered(model: ChatModel, meter: Meter): ChatModel {
  return wrapLanguageModel({
    model,
    middleware: [
      {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate }) => {
          meter.requests += 1;
          try {
            const result = await doGenerate();
            meter.inputTokens += result.usage.inputTokens.total ?? 0;
            meter.cacheReadTokens += result.usage.inputTokens.cacheRead ?? 0;
            meter.outputTokens += result.usage.outputTokens.total ?? 0;
            return result;
          } catch (error) {
            meter.refused.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      },
    ],
  });
}

/**
 * Each probe through each arm, `runs` times, the arms in turn inside the one run, in an order that
 * shifts with the probe and the run so none is always first. A check that didn't get an answer to
 * every request is counted apart and never asked again. Stops, saying so, once `dollarsOf` the
 * tokens used so far reaches `stop`.
 */
export async function runArms({
  arms,
  probes,
  runs,
  stop,
  model,
  meter,
  dollarsOf,
  onRow,
}: {
  arms: readonly Arm[];
  probes: readonly Probe[];
  runs: number;
  /** In dollars; 0 for none. */
  stop: number;
  model: ChatModel;
  meter: Meter;
  dollarsOf: (inputTokens: number, outputTokens: number, cacheReadTokens: number) => number;
  /** Each row as it is made, so a run that is cut short keeps what it measured. */
  onRow?: (row: Row) => void;
}): Promise<{ rows: Row[]; stopped: string | null }> {
  const rows: Row[] = [];
  const counted = metered(model, meter);
  for (let run = 1; run <= runs; run++) {
    for (const [at, probe] of probes.entries()) {
      const turn = arms.map((_, index) => arms[(index + at + run) % arms.length]);
      for (const arm of turn) {
        if (!arm) continue;
        if (
          stop > 0 &&
          dollarsOf(meter.inputTokens, meter.outputTokens, meter.cacheReadTokens) >= stop
        ) {
          return { rows, stopped: `the stop of $${stop.toFixed(2)} was reached` };
        }
        meter.refused = [];
        const before = { input: meter.inputTokens, output: meter.outputTokens };
        const result = await arm.check(
          probe.reply,
          probe.calls ?? [],
          MINDS,
          probe.focused ?? null,
          {
            model: counted,
            request: requestOf(probe.id),
            names,
            parts,
            states: (change) =>
              probe.waiting?.includes(change.request)
                ? null
                : { waiting: 0, accepted: 0, rejected: 0, applied: true },
            signal: new AbortController().signal,
          },
        );
        const flagged =
          result.claims.length + result.commands.length > 0 || result.unfinished === true;
        const failed = result.failed === true;
        // A failed check that found nothing is an unreadable verdict, not a "nothing flagged".
        const unanswered = meter.refused.length > 0 || (failed && (!result.usage || !flagged));
        const row: Row = {
          probe: probe.id,
          run,
          arm: arm.name,
          expected: probe.unbacked,
          flagged,
          counted: !unanswered,
          failed,
          refused: [...meter.refused],
          inputTokens: meter.inputTokens - before.input,
          outputTokens: meter.outputTokens - before.output,
        };
        rows.push(row);
        onRow?.(row);
      }
    }
  }
  return { rows, stopped: null };
}
