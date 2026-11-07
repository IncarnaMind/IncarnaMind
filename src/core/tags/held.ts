import { randomUUID } from "node:crypto";
import type { ExternalService } from "../api";
import type { Database } from "../storage";

/**
 * The next place in this database's order of arrivals, Linked folder links and turn-ons (#2370).
 * The database counts it, so a clock step can't reorder what came first.
 */
export function nextSequence(db: Database, at: string): number {
  const row = db.get<{ value: number }>(
    `INSERT INTO tagging_sequence (id, value, created_at, updated_at)
     VALUES ('tagging', 1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at
     RETURNING value`,
    [at, at],
  );
  if (!row) throw new Error("The tagging sequence didn't record a place.");
  return row.value;
}

/**
 * Whether automatic tagging or Organize may send this Document by itself to these services, the
 * ones the request it is about to make resolved to (#2308). Each one must have been turned on
 * for itself (`turnedOnSeq`, null if it wasn't); then the Document must have arrived new after
 * that place in the database's order (`markArrived`: added by the User, found by the first scan
 * of a Linked folder they linked then, or reported by its watcher after that scan), or the User's
 * own Organize or re-tag must have sent it to that same service before (`clearForService`).
 * Everything else waits for them, whatever its file's times say and whatever brought it back, so
 * a way in nobody listed stays closed. With no service, nothing leaves the computer.
 */
export function mayBackgroundSend(
  db: Database,
  documentId: string,
  services: readonly ExternalService[],
  turnedOnSeq: (service: ExternalService) => number | null,
): boolean {
  const arrivedSeq =
    db.get<{ arrived_seq: number }>(
      "SELECT arrived_seq FROM document_arrivals WHERE document_id = ? AND deleted_at IS NULL",
      [documentId],
    )?.arrived_seq ?? null;
  return services.every((service) => {
    const since = turnedOnSeq(service);
    if (since === null) return false;
    if (arrivedSeq !== null && arrivedSeq > since) return true;
    return (
      db.get<{ id: string }>(
        `SELECT id FROM tagging_clearances
         WHERE document_id = ? AND service_id = ? AND deleted_at IS NULL`,
        [documentId, service.id],
      ) !== undefined
    );
  });
}

/** IncarnaMind saw this Document arrive new at `at`, at `seq` (see `mayBackgroundSend`). */
export function markArrived(db: Database, documentId: string, at: string, seq: number): void {
  db.run(
    `INSERT INTO document_arrivals (id, document_id, arrived_at, arrived_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (document_id) WHERE deleted_at IS NULL
     DO UPDATE SET arrived_at = excluded.arrived_at, arrived_seq = excluded.arrived_seq, updated_at = excluded.updated_at`,
    [randomUUID(), documentId, at, seq, at, at],
  );
}

/**
 * The User's own Organize or re-tag sent this Document to these services at `at`: from then it
 * may go to them, and only to them, by itself.
 */
export function clearForService(
  db: Database,
  documentId: string,
  services: readonly ExternalService[],
  at: string,
): void {
  db.transaction(() => {
    for (const service of services) {
      db.run(
        `INSERT INTO tagging_clearances (id, document_id, service_id, cleared_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (document_id, service_id) WHERE deleted_at IS NULL
         DO UPDATE SET cleared_at = excluded.cleared_at, updated_at = excluded.updated_at`,
        [randomUUID(), documentId, service.id, at, at, at],
      );
    }
  });
}
