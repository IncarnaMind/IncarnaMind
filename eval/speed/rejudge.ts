/**
 * The judge of a run that judges saved replies again: priced, every request counted with the
 * refused and failed ones, stopped at a spend, and its spend put on the gate's one ledger.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { judgeOf } from "./judge";
import { openLedger } from "./ledger";
import { env } from "./settings";

export async function openRejudge(what: string, defaultStopUsd: number) {
  const stopUsd = Number(env("STOP_USD") ?? defaultStopUsd);
  const startedAt = new Date().toISOString();
  const judged = judgeOf([]);
  if (!judged.priced) {
    throw new Error(
      `The judge ${judged.name} has no price in the catalog, so the stop of $${stopUsd} can't be kept: nothing was sent.`,
    );
  }
  const ledger = await openLedger(env("LEDGER"), `${startedAt} ${what}`);
  let attempts = 0;
  const refused: string[] = [];
  const counting: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      attempts++;
      try {
        return await doGenerate();
      } catch (error) {
        refused.push(error instanceof Error ? error.message.slice(0, 120) : String(error));
        throw error;
      }
    },
  };
  return {
    startedAt,
    stopUsd,
    name: judged.name,
    model: wrapLanguageModel({ model: judged.model, middleware: counting }),
    attempts: () => attempts,
    refused,
    spent: judged.spent,
    /** This run's spend with the ledger's runs before it. */
    spentInAll: () => ledger.before + judged.spent(),
    atStop: () => ledger.before + judged.spent() >= stopUsd,
    /** Writes what the run has spent so far on the ledger. */
    record: () => ledger.record(judged.spent()),
  };
}
