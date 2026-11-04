import { randomUUID } from "node:crypto";
import type { ExternalService } from "../api";
import type { Database } from "../storage";

/**
 * Whether automatic tagging or Organize may send this Document by itself to these services, the
 * ones the request it is about to make resolved to (#2308). Each one must have been turned on
 * for itself (`turnedOnAt`, null if it wasn't); then the Document must have arrived new at or
 * after that (`markArrived`: added by the User, found by the first scan of a Linked folder they
 * linked then, or reported by its watcher after that scan), or the User's own Organize or re-tag
 * must have sent it to that same service before (`clearForService`). Everything else waits for
 * them, whatever its file's times say and whatever brought it back, so a way in nobody listed
 * stays closed. With no service, nothing leaves the computer.
 */
export function mayBackgroundSend(
  db: Database,
  documentId: string,
  services: readonly ExternalService[],
  turnedOnAt: (service: ExternalService) => string | null,
): boolean {
  const arrivedAt =
    db.get<{ arrived_at: string }>(
      "SELECT arrived_at FROM document_arrivals WHERE document_id = ? AND deleted_at IS NULL",
      [documentId],
    )?.arrived_at ?? null;
  return services.every((service) => {
    const since = turnedOnAt(service);
    if (since === null) return false;
    if (arrivedAt !== null && arrivedAt >= since) return true;
    return (
      db.get<{ id: string }>(
        `SELECT id FROM tagging_clearances
         WHERE document_id = ? AND service_id = ? AND deleted_at IS NULL`,
        [documentId, service.id],
      ) !== undefined
    );
  });
}

/**
 * The time to record a turn-on at: `now`, or just after every arrival and every Linked folder
 * already here, if that is later. Times are kept to the millisecond, and a folder linked in the
 * same millisecond as the turn-on, before it, was there before (#2308).
 */
export function turnOnTime(db: Database, now: string): string {
  const latest = db.get<{ at: string | null }>(
    `SELECT max(at) AS at FROM (
       SELECT max(arrived_at) AS at FROM document_arrivals WHERE deleted_at IS NULL
       UNION ALL SELECT max(created_at) FROM linked_folders WHERE deleted_at IS NULL)`,
  )?.at;
  if (!latest || latest < now) return now;
  return new Date(Date.parse(latest) + 1).toISOString();
}

/** IncarnaMind saw this Document arrive new at `at` (see `mayBackgroundSend`). */
export function markArrived(db: Database, documentId: string, at: string): void {
  db.run(
    `INSERT INTO document_arrivals (id, document_id, arrived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (document_id) WHERE deleted_at IS NULL
     DO UPDATE SET arrived_at = excluded.arrived_at, updated_at = excluded.updated_at`,
    [randomUUID(), documentId, at, at, at],
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
