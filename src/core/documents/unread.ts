import { basename } from "node:path";
import type { Document, UnreadFile, UnreadReason } from "../api";

/** Why a Document that failed couldn't be read (#740): "damaged" for a broken file or anything else. */
const FAILED: Record<string, UnreadReason> = {
  "password-protected": "password",
  "too-large": "too-large",
  "pages-unread": "pages",
  "forms-unread": "pages",
};

/**
 * The Documents among `documents` that couldn't be read, and why: scans with no
 * text yet, password-protected and damaged files, those too large to open, and
 * scans some of whose pages are unread. A file that has gone isn't one: it
 * is missing, and says so itself.
 */
export function findUnreadDocuments(documents: readonly Document[]): UnreadFile[] {
  const found: UnreadFile[] = [];
  for (const document of documents) {
    if (document.fileStatus === "missing") continue;
    let reason: UnreadReason | null = null;
    if (document.status === "no-text") reason = "scan";
    else if (document.status === "failed")
      reason = FAILED[document.failure?.reason ?? ""] ?? "damaged";
    if (reason === null) continue;
    found.push({
      id: document.id,
      name: basename(document.path) || document.name,
      reason,
      extension: null,
      documentId: document.id,
      pages: reason === "pages" ? (document.failure?.pages ?? []) : [],
    });
  }
  return found;
}
