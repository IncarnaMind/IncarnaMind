/**
 * The decision model the User chose to read the sentences of Check this Note first (#3118): what
 * the choice allows, and the reader each run asks (./decisionFirst).
 *
 * Its requests are the "decision-checks" data flow, to the model's host. The User allows it where
 * they choose the model, on the line that says what goes (ADR-0022); a run never asks. A model
 * with no measured lines (./decisionLines) can't be chosen: its answers would mean nothing.
 */
import type { CheckDecisionModel, DataKind, ProviderError } from "../../api";
import type { Consent } from "../../consent";
import { InvalidInputError, TaggingNotReadyError } from "../../errors";
import { isDecisionModelChoice } from "../../providers/catalog/decisions";
import { classifyProviderError } from "../../providers/providerErrors";
import { slots } from "../../runs/stop";
import type { DecisionHosts } from "../../tags/decisionHosts";
import type { DecisionReader } from "./decisionFirst";
import { decisionLinesFor } from "./decisionLines";

export const DECISION_CHECKS_FLOW_SENDS: readonly DataKind[] = ["checked-sentences"];

// A reading is two short answers about one Passage: a host that takes longer isn't answering.
const LIMITS = { retries: 1, timeoutMs: 15_000 };
// As many requests at once as the lines were measured with, none refused.
const AT_ONCE = 32;

/** A run's reader: once a request fails it asks no more, and `stopped` says why. */
export interface RunDecisionReader extends DecisionReader {
  stopped(): ProviderError | null;
}

export interface DecisionChoiceOptions {
  chosen(): CheckDecisionModel | null;
  hosts: Pick<DecisionHosts, "asker" | "service">;
  consent: Consent;
  localOnly(): boolean;
}

export type DecisionChoice = ReturnType<typeof createDecisionChoice>;

export function createDecisionChoice(options: DecisionChoiceOptions) {
  const { hosts, consent } = options;
  consent.registry.register({
    id: "decision-checks",
    sends: DECISION_CHECKS_FLOW_SENDS,
    services: async () => {
      const choice = options.chosen();
      const service = choice && hosts.service(choice.host);
      return service ? [service] : [];
    },
  });

  return {
    /** Throws, in the words the User reads, unless `choice` is one they can make now. */
    async check(choice: unknown): Promise<void> {
      if (choice === null) return;
      if (!isDecisionModelChoice(choice) || !decisionLinesFor(choice.host, choice.modelId))
        throw new InvalidInputError({ key: "error.check.decisionModel" });
      if (options.localOnly()) throw new InvalidInputError({ key: "error.check.decisionLocal" });
      await hosts.asker(choice.host, choice.modelId, "decision-checks", LIMITS);
    },

    /** The User chose a model where its line says what goes to its host: that allows it. */
    chose(choice: CheckDecisionModel | null): void {
      const service = choice && hosts.service(choice.host);
      if (service) consent.choose(["decision-checks"], service);
    },

    /**
     * The chosen model for one run, or null where none reads now: none chosen, Local mode, the
     * User took back what the choice allowed, or its host's key is gone.
     */
    async reader(): Promise<RunDecisionReader | null> {
      const choice = options.chosen();
      const lines = choice && decisionLinesFor(choice.host, choice.modelId);
      if (!choice || !lines || options.localOnly()) return null;
      const service = hosts.service(choice.host);
      if (!service || !consent.allows("decision-checks", service)) return null;
      const ask = await hosts
        .asker(choice.host, choice.modelId, "decision-checks", LIMITS)
        .catch((error: unknown) => {
          if (error instanceof TaggingNotReadyError) return null;
          throw error;
        });
      if (!ask) return null;
      const atOnce = slots(AT_ONCE);
      let stopped: ProviderError | null = null;
      return {
        model: { providerId: null, modelId: choice.modelId },
        lines,
        stopped: () => stopped,
        ask: (state, questions, signal) =>
          atOnce.run(async () => {
            if (stopped || signal.aborted) return null;
            try {
              return await ask(state, questions, signal);
            } catch (error) {
              if (!signal.aborted && !stopped) {
                stopped = classifyProviderError(error);
                console.warn(
                  `The decision model ${choice.modelId} couldn't read a sentence, so the AI model checks the rest of this run: ${stopped.message}`,
                );
              }
              return null;
            }
          }),
      };
    },
  };
}
