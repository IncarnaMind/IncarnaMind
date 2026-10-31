import type { Database } from "../storage";

/**
 * Whether a Document is held "off": it came in, or was waiting, while tagging and sorting by
 * themselves were off for where they send now (#2308). Nothing sends it by itself, neither
 * automatic tagging nor Organize, also when it is read again; Organize or a re-tag the User starts
 * clears it.
 */
export function heldOff(db: Database, documentId: string): boolean {
  return (
    db.get<{ tagging_status: string }>(
      "SELECT tagging_status FROM documents WHERE id = ? AND deleted_at IS NULL",
      [documentId],
    )?.tagging_status === "off"
  );
}
