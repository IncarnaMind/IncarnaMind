/**
 * The decision model that reads the sentences of Check this Note first (#3118): which one reads a
 * run, what a choice allows, and the reader each run asks (./decisionFirst).
 *
 * Its requests are the "decision-checks" data flow, to the model's host. The User allows it where
 * they choose the model, on the line that says what goes (ADR-0022); a run never asks. A model
 * with no measured lines (./decisionLines) can't be chosen: its answers would mean nothing.
 */
import type { CheckDecisionModel, CheckDecisionStatus, DataKind, ExternalService } from "../../api";
import type { Consent } from "../../consent";
import { InvalidInputError, TaggingNotReadyError } from "../../errors";
import { DECISION_HOST_ENTRIES, isDecisionModelChoice } from "../../providers/catalog/decisions";
import { classifyProviderError } from "../../providers/providerErrors";
import { slots } from "../../runs/stop";
import type { DecisionHosts } from "../../tags/decisionHosts";
import type { DecisionReader } from "./decisionFirst";
import { decisionLinesFor, MEASURED_DECISION_MODELS } from "./decisionLines";

export const DECISION_CHECKS_FLOW_SENDS: readonly DataKind[] = ["checked-sentences"];

/**
 * Whether a measured model reads for a User who hasn't said, where their own AI model for checks
 * already runs on its host's service: the check sends the same text there, so nothing new leaves
 * the computer and nowhere new (ADR-0022). The one value that ships it on or off.
 */
const READS_BY_DEFAULT = true;

// A check waits for its sentence's reading, so a host is waited for once and no longer than no
// measured answer took: of 13,179 at 32 at once the slowest came after 3.6 s, half within 0.3 s.
// The first request to fail ends a run's readings.
const LIMITS = { retries: 0, timeoutMs: 5_000 };
// As many requests at once as the lines were measured with, none refused.
const AT_ONCE = 32;

export interface DecisionChoiceOptions {
  /** What the User said: a model, "off", or nothing yet (null). */
  chosen(): CheckDecisionModel | "off" | null;
  hosts: Pick<DecisionHosts, "asker" | "ready" | "service">;
  consent: Consent;
  localOnly(): boolean;
  /** The service the User's own AI model for checks runs on; null: none outside this computer. */
  checksService(): ExternalService | null;
  readsByDefault?: boolean;
}

export type DecisionChoice = ReturnType<typeof createDecisionChoice>;

export function createDecisionChoice(options: DecisionChoiceOptions) {
  const { hosts, consent } = options;
  const readsByDefault = options.readsByDefault ?? READS_BY_DEFAULT;
  // Listed in Settings › Privacy from this same rule, so one that reads by default is there
  // before its first run.
  consent.registry.register({
    id: "decision-checks",
    sends: DECISION_CHECKS_FLOW_SENDS,
    services: async () => {
      const service = listed()?.service;
      return service ? [service] : [];
    },
    byDefault: (serviceId) => {
      const using = listed();
      return using?.byDefault === true && using.service.id === serviceId;
    },
  });

  /**
   * The model set to read the User's checks: the one they chose, else, where they haven't said, a
   * measured one on the service their own AI model for checks runs on. `byDefault` marks the
   * second: it reads because the User's checks already go to that service.
   */
  function standing(): {
    choice: CheckDecisionModel;
    service: ExternalService;
    byDefault: boolean;
  } | null {
    const chosen = options.chosen();
    if (chosen === "off" || options.localOnly()) return null;
    if (chosen) {
      const service = hosts.service(chosen.host);
      return service && { choice: chosen, service, byDefault: false };
    }
    const checksService = options.checksService();
    if (!readsByDefault || !checksService) return null;
    const measured = MEASURED_DECISION_MODELS.find(
      (each) => hosts.service(each.host)?.id === checksService.id,
    );
    if (!measured) return null;
    const { host, modelId } = measured;
    return { choice: { host, modelId }, service: checksService, byDefault: true };
  }

  /**
   * The model Settings › Privacy lists. By default it rests on the User having allowed checks to
   * that service: until they have, none reads and nothing is listed.
   */
  function listed() {
    const using = standing();
    return using?.byDefault && !consent.allows("checks", using.service) ? null : using;
  }

  /**
   * The model that reads a check whose AI model runs on `runService`. By default that is only a
   * check that goes to the service Settings and Privacy name: a Note checked with a model on
   * another service is not read, whichever of the two services the decision model is on.
   */
  function inUse(runService: ExternalService | null) {
    const using = listed();
    return using?.byDefault && runService?.id !== using.service.id ? null : using;
  }

  return {
    /**
     * What Settings › AI shows: the model its switch turns on, and whether it is set to read. One
     * that reads by default shows so before the User's first check, which asks about checks itself.
     */
    async status(): Promise<CheckDecisionStatus> {
      const chosen = options.chosen();
      const using = standing();
      const { host, modelId } =
        using?.choice ?? (chosen && chosen !== "off" ? chosen : MEASURED_DECISION_MODELS[0]);
      const entry = DECISION_HOST_ENTRIES[host];
      const listing = entry.models.find((each) => each.id === modelId);
      const blocked = options.localOnly()
        ? "local-mode"
        : (await hosts.ready()).includes(host)
          ? null
          : "no-key";
      return {
        model: { host, modelId, name: listing?.name ?? modelId },
        hostName: entry.name,
        maker: listing && !entry.name.en.startsWith(listing.maker) ? listing.maker : null,
        reads: blocked || !using ? null : using.byDefault ? "default" : "chosen",
        blocked,
      };
    },

    /** Throws, in the words the User reads, unless `choice` is one they can make now. */
    async check(choice: unknown): Promise<void> {
      if (choice === null || choice === "off") return;
      if (!isDecisionModelChoice(choice) || !decisionLinesFor(choice.host, choice.modelId))
        throw new InvalidInputError({ key: "error.check.decisionModel" });
      if (options.localOnly()) throw new InvalidInputError({ key: "error.check.decisionLocal" });
      await hosts.asker(choice.host, choice.modelId, "decision-checks", LIMITS);
    },

    /** The User chose a model where its line says what goes to its host: that allows it. */
    async chose(choice: CheckDecisionModel | "off" | null): Promise<void> {
      if (choice === "off") {
        // Off forgets what allowed it, whoever turned it on: Settings › Privacy lists nothing.
        for (const { flow, consent: decided } of await consent.list())
          if (flow.id === "decision-checks" && decided !== "not-asked")
            consent.revoke("decision-checks", flow.service.id);
        return;
      }
      const service = choice && hosts.service(choice.host);
      if (service) consent.choose(["decision-checks"], service);
    },

    /**
     * The reader for one run whose AI model runs on `runService`, or null where none reads
     * now: none in use, Local mode, the User took back what allowed it, or its host's key is gone.
     * A request that fails ends the run's readings and is logged: the AI model checks the rest, as
     * with no decision model, and the User is shown nothing.
     */
    async reader(runService: ExternalService | null): Promise<DecisionReader | null> {
      const using = inUse(runService);
      const lines = using && decisionLinesFor(using.choice.host, using.choice.modelId);
      if (!using || !lines) return null;
      const { choice, service } = using;
      // By default the reading rests on the User's choice of this service for their checks. Its
      // first run records it, so Settings › Privacy says since when it has read.
      if (using.byDefault && consent.status("decision-checks", service) === "not-asked")
        consent.choose(["decision-checks"], service);
      if (!consent.allows("decision-checks", service)) return null;
      const ask = await hosts
        .asker(choice.host, choice.modelId, "decision-checks", LIMITS)
        .catch((error: unknown) => {
          if (error instanceof TaggingNotReadyError) return null;
          throw error;
        });
      if (!ask) return null;
      const atOnce = slots(AT_ONCE);
      let failed = false;
      return {
        model: { providerId: null, modelId: choice.modelId },
        lines,
        ask: (state, questions, signal) =>
          atOnce.run(async () => {
            if (failed || signal.aborted) return null;
            try {
              return await ask(state, questions, signal);
            } catch (error) {
              if (!signal.aborted && !failed) {
                failed = true;
                console.warn(
                  `The decision model ${choice.modelId} couldn't read a sentence, so the AI model checks the rest of this run: ${classifyProviderError(error).message}`,
                );
              }
              return null;
            }
          }),
      };
    },
  };
}
