/**
 * Only the reference is sent, on its own flow, "reference-check"; starting a
 * check is the consent (ADR-0022), and local mode sends nothing. What the
 * services answered is kept (./cache).
 */
import type {
  CheckReferencesResult,
  DataKind,
  ReferenceCheck,
  ReferenceCheckReason,
  ReferenceService,
} from "../api";
import type { Consent } from "../consent";
import { ConsentDeclinedError, ConsentRevokedError, LocalModeError } from "../errors";
import type { MindContent } from "../mindContent";
import { parseMindId } from "../minds";
import { createSendGate } from "../sendGate";
import { gatedHttp, type SourceHttp } from "../sources/http";
import type { Database } from "../storage";
import { createLookupCache } from "./cache";
import { type CheckRun, checkReference, ServiceFailure } from "./check";
import { referenceList } from "./list";
import { createLookups, REFERENCE_SERVICES } from "./lookups";
import { citedReference } from "./match";

/** What the "reference-check" flow sends: each reference, as written. */
export const REFERENCE_CHECK_SENDS: readonly DataKind[] = ["references"];

export interface ReferenceChecksOptions {
  consent: Consent;
  localOnly(): boolean;
  http: SourceHttp;
  /** Each service's API, unless the host says otherwise (tests). */
  urls?: Partial<Record<ReferenceService, string>> | undefined;
  content: Pick<MindContent, "read">;
  db: Database;
  now: () => string;
  progress(event: { mindId: string; done: number; total: number }): void;
  signal: AbortSignal;
}

export function createReferenceChecks(options: ReferenceChecksOptions) {
  const { consent } = options;
  const services = Object.values(REFERENCE_SERVICES);
  const gate = createSendGate(consent, options.localOnly);
  const http = gatedHttp(options.http, () => {
    for (const service of services) gate.check("reference-check", service);
  });
  const cache = createLookupCache(createLookups(http, options.urls), options.db, options.now);
  const running = new Map<string, AbortController>();

  consent.registry.register({
    id: "reference-check",
    sends: REFERENCE_CHECK_SENDS,
    // It goes nowhere until a check asks; then the decision is listed.
    services: async () => [],
  });

  const notChecked = (
    reference: string,
    reason: ReferenceCheckReason,
    service: ReferenceService | null = null,
  ): ReferenceCheck => ({
    reference,
    mark: "not-checked",
    service,
    record: null,
    differences: [],
    reason,
  });

  return {
    /** `again` (Check again) asks about every miss again, however recent. */
    async check(mindIdInput: unknown, again = false): Promise<CheckReferencesResult> {
      const mindId = parseMindId(mindIdInput);
      const entries = options.content
        .read(mindId, referenceList)
        .map((entry) => ({ ...entry, cited: citedReference(entry.text) }));
      if (entries.length === 0) return { kind: "no-references" };

      running.get(mindId)?.abort();
      const controller = new AbortController();
      running.set(mindId, controller);
      const signal = AbortSignal.any([controller.signal, options.signal]);
      const all = (reason: ReferenceCheckReason): CheckReferencesResult => ({
        kind: "checked",
        references: entries.map((entry) => ({
          blockId: entry.blockId,
          ...notChecked(entry.cited.text, reason),
        })),
      });
      try {
        if (options.localOnly()) return all("local-mode");
        // The action names the services and what goes to them: starting the check allows it.
        for (const service of services) consent.choose(["reference-check"], service);
        try {
          for (const service of services) await consent.ensure("reference-check", service);
        } catch (error) {
          if (error instanceof ConsentDeclinedError) return all("declined");
          if (error instanceof LocalModeError) return all("local-mode");
          throw error;
        }
        const references: (ReferenceCheck & { blockId: string })[] = [];
        const stopped: CheckRun["stopped"] = new Map();
        for (const [index, entry] of entries.entries()) {
          if (signal.aborted) return { kind: "cancelled" };
          const lookups = cache.forReference(again);
          let result: ReferenceCheck;
          try {
            result = await checkReference(
              entry.cited,
              { lookups: lookups.lookups, stopped },
              signal,
            );
            lookups.settle(result.mark === "found" || result.mark === "mismatch");
          } catch (error) {
            if (signal.aborted) return { kind: "cancelled" };
            if (error instanceof LocalModeError || error instanceof ConsentRevokedError) {
              const reason = error instanceof LocalModeError ? "local-mode" : "declined";
              for (const rest of entries.slice(index)) {
                references.push({ blockId: rest.blockId, ...notChecked(rest.cited.text, reason) });
              }
              return { kind: "checked", references };
            }
            if (!(error instanceof ServiceFailure)) throw error;
            result = {
              ...notChecked(entry.cited.text, error.reason, error.service),
              ...(error.resetsAt !== null && {
                resetsAt: new Date(error.resetsAt).toISOString(),
              }),
            };
          }
          references.push({ blockId: entry.blockId, ...result });
          options.progress({ mindId, done: index + 1, total: entries.length });
        }
        return { kind: "checked", references };
      } finally {
        if (running.get(mindId) === controller) running.delete(mindId);
      }
    },

    stop(mindIdInput: unknown): void {
      running.get(parseMindId(mindIdInput))?.abort();
    },
  };
}
