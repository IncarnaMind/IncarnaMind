/**
 * Services' answers, kept on this computer (migration 96) so checking a list
 * again sends nothing, and doesn't spend OpenAlex's free daily allowance,
 * which everyone on a network shares. A record of the work cited is kept for
 * good, and so is a miss (no record, a DOI no agency registered yet, a search
 * that found the work nowhere) and a failure: checking the list again asks no
 * service. The User's own Check again asks about misses and failures once
 * more, as a work can be registered or indexed later.
 */
import { randomUUID } from "node:crypto";
import { titleWords } from "../../shared/referenceList";
import type { ReferenceName, ReferenceService } from "../api";
import { isRecord } from "../errors";
import { SourceError, type SourceErrorReason } from "../sources/http";
import type { Database } from "../storage";
import type { Lookups } from "./lookups";
import type { WorkRecord } from "./match";

/** What a check reads of a record, which is all the cache keeps. */
const kept = (record: WorkRecord) => ({
  title: record.fields.title ?? "",
  authors: record.fields.authors ?? [],
  doi: record.fields.doi ?? null,
  years: record.years,
  preprint: record.preprint === true,
});

const isName = (value: unknown): value is ReferenceName =>
  isRecord(value) &&
  (typeof value.literal === "string" ||
    (typeof value.family === "string" && typeof value.given === "string"));

function recordOf(value: unknown): WorkRecord | null {
  if (!isRecord(value) || typeof value.title !== "string") return null;
  const { authors, doi, years } = value;
  return {
    fields: {
      title: value.title,
      authors: Array.isArray(authors) ? authors.filter(isName) : [],
      ...(typeof doi === "string" && { doi }),
    },
    years: Array.isArray(years)
      ? years.filter((year): year is number => typeof year === "number")
      : [],
    preprint: value.preprint === true,
  };
}

const recordsOf = (value: unknown): WorkRecord[] =>
  Array.isArray(value) ? value.map(recordOf).filter((each) => each !== null) : [];

/** A text as its words, folded: the same title or reference written another way is the same key. */
const wordsKey = (text: string) => titleWords(text).join(" ");

/** A kept failure, as it is stored: the service's reason, and when it takes requests again. */
interface KeptFailure {
  reason: SourceErrorReason;
  resetsAt: number | null;
}

const isSourceErrorReason = (value: unknown): value is SourceErrorReason =>
  value === "unreachable" ||
  value === "rate-limited" ||
  value === "service-error" ||
  value === "not-found" ||
  value === "not-open" ||
  value === "needs-key" ||
  value === "key-rejected";

const failureOf = (value: unknown): KeptFailure | null => {
  if (!isRecord(value) || !isRecord(value.failed)) return null;
  const { reason, resetsAt } = value.failed;
  if (!isSourceErrorReason(reason)) return null;
  return { reason, resetsAt: typeof resetsAt === "number" ? resetsAt : null };
};

/** Whether a kept answer is a failure, rather than what a service answered; unreadable counts as replaceable. */
const storedFailure = (answer: string): boolean => {
  try {
    return failureOf(JSON.parse(answer)) !== null;
  } catch {
    return true;
  }
};

/** A list's lookups, each reference's settled by its verdict. */
export function createLookupCache(lookups: Lookups, db: Database, now: () => string) {
  return {
    /**
     * The lookups for one reference. What they keep is a miss, or a failure,
     * until `settle` says the reference's record was found; `askMissesAgain`
     * (the User's Check again) asks about every kept miss and failure again.
     */
    forReference(askMissesAgain: boolean) {
      /** Each answer this check used, settled later only while it is still the stored one. */
      const used = new Map<
        string,
        { service: ReferenceService; kind: string; key: string; answer: string }
      >();
      const use = (service: ReferenceService, kind: string, key: string, answer: string) =>
        used.set(`${service}\u0000${kind}\u0000${key}`, { service, kind, key, answer });

      const remember = async <T>(
        service: ReferenceService,
        kind: string,
        key: string,
        ask: () => Promise<T>,
        stored: {
          write: (answer: T) => unknown;
          read: (value: unknown) => T;
          found: (answer: T) => boolean;
        },
      ): Promise<T> => {
        const row = db.get<{ answer: string; kept: number }>(
          `SELECT answer, kept FROM reference_lookups
           WHERE service = ? AND kind = ? AND lookup_key = ? AND deleted_at IS NULL`,
          [service, kind, key],
        );
        // Everything sent is kept, so a check asks once: only Check again looks a miss or a failure up again.
        if (row && (row.kept === 1 || !askMissesAgain)) {
          let value: unknown;
          try {
            value = JSON.parse(row.answer);
          } catch (error) {
            console.error(`A kept ${service} answer couldn't be read; asking again.`, error);
          }
          const failed = value === undefined ? null : failureOf(value);
          if (failed) {
            throw new SourceError(
              failed.reason,
              `The ${service} service failed when this was sent before.`,
              null,
              failed.resetsAt,
            );
          }
          if (value !== undefined) {
            try {
              const answer = stored.read(value);
              use(service, kind, key, row.answer);
              return answer;
            } catch (error) {
              console.error(`A kept ${service} answer couldn't be read; asking again.`, error);
            }
          }
        }
        const at = now();
        const keep = (storedAnswer: unknown, settled: boolean) => {
          const answer = JSON.stringify(storedAnswer);
          const current = db.get<{ id: string; answer: string; kept: number }>(
            `SELECT id, answer, kept FROM reference_lookups
             WHERE service = ? AND kind = ? AND lookup_key = ? AND deleted_at IS NULL`,
            [service, kind, key],
          );
          // Two checks of the same reference can be in flight: a settled answer stays, and a
          // failure doesn't replace one that succeeded. Only what is still stored settles.
          if (current?.kept === 1) return;
          if (failureOf(storedAnswer) && current && !storedFailure(current.answer)) return;
          db.run(
            `INSERT INTO reference_lookups
               (id, service, kind, lookup_key, answer, kept, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (service, kind, lookup_key) WHERE deleted_at IS NULL
             DO UPDATE SET answer = excluded.answer, kept = excluded.kept,
               updated_at = excluded.updated_at`,
            [current?.id ?? randomUUID(), service, kind, key, answer, settled ? 1 : 0, at, at],
          );
          if (!failureOf(storedAnswer)) use(service, kind, key, answer);
        };
        let answer: T;
        try {
          answer = await ask();
        } catch (error) {
          if (error instanceof SourceError) {
            keep({ failed: { reason: error.reason, resetsAt: error.resetsAt } }, false);
          }
          throw error;
        }
        keep(stored.write(answer), stored.found(answer));
        return answer;
      };

      const record = {
        write: (answer: WorkRecord | null) => answer && kept(answer),
        read: recordOf,
        found: (answer: WorkRecord | null) => answer !== null,
      };
      // A search's candidates may all be other works: only the verdict says it found this one.
      const records = {
        write: (answer: WorkRecord[]) => answer.map(kept),
        read: recordsOf,
        found: () => false,
      };
      const agency = {
        write: (answer: string | null) => answer,
        read: (value: unknown) => (typeof value === "string" ? value : null),
        found: (answer: string | null) => answer !== null,
      };

      const { crossref, openalex, arxiv } = lookups;
      const cached: Lookups = {
        crossref: {
          byDoi: (doi, signal) =>
            remember(
              "crossref",
              "doi",
              doi.toLowerCase(),
              () => crossref.byDoi(doi, signal),
              record,
            ),
          agency: (doi, signal) =>
            remember(
              "crossref",
              "agency",
              doi.toLowerCase(),
              () => crossref.agency(doi, signal),
              agency,
            ),
          search: (reference, signal) =>
            remember(
              "crossref",
              "search",
              wordsKey(reference),
              () => crossref.search(reference, signal),
              records,
            ),
        },
        openalex: {
          byDoi: (doi, signal) =>
            remember(
              "openalex",
              "doi",
              doi.toLowerCase(),
              () => openalex.byDoi(doi, signal),
              record,
            ),
          search: (title, signal) =>
            remember(
              "openalex",
              "title",
              wordsKey(title),
              () => openalex.search(title, signal),
              records,
            ),
        },
        arxiv: {
          byId: (id, signal) => remember("arxiv", "id", id, () => arxiv.byId(id, signal), record),
        },
      };
      return {
        lookups: cached,
        /** Keeps for good what found the reference's record, once the check says it did. */
        settle(found: boolean) {
          if (!found || used.size === 0) return;
          for (const { service, kind, key, answer } of used.values())
            db.run(
              `UPDATE reference_lookups SET kept = 1
               WHERE service = ? AND kind = ? AND lookup_key = ? AND answer = ? AND deleted_at IS NULL`,
              [service, kind, key, answer],
            );
        },
      };
    },
  };
}
