import type { Document } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";
import { userFile } from "./fileInfo";

/** What a Document that needs attention says, in plain words, and what can be done about it. */
export interface DocumentFix {
  reason: MessageKey;
  /** Open its file in the system's app for it: it can be repaired, or unlocked, there. */
  open: boolean;
  /** Read it again, or open it in the app that can print a flattened copy. */
  retry: "retry" | "readAgain" | "print" | null;
}

/**
 * The plain reason and the next steps for a Document that couldn't be read,
 * is a scan with no text, or is empty (#763); null for a Document that needs
 * none. Retrying needs the file where it was.
 */
export function documentFix(doc: Document): DocumentFix | null {
  const here = doc.fileStatus === "available";
  if (doc.size === 0 && doc.status !== "queued" && doc.status !== "extracting") {
    return { reason: "library.fix.empty", open: false, retry: here ? "retry" : null };
  }
  if (doc.status === "no-text") {
    return { reason: "library.fix.scan", open: here, retry: here ? "readAgain" : null };
  }
  if (doc.status !== "failed" || !doc.failure) return null;
  switch (doc.failure.reason) {
    case "unreadable":
      return {
        reason: doc.kind === "pdf" ? "library.fix.damaged.pdf" : "library.fix.damaged",
        open: here,
        retry: here ? "retry" : null,
      };
    case "password-protected":
      return { reason: "library.fix.password", open: here, retry: here ? "retry" : null };
    case "too-large":
      return { reason: "library.fix.tooLarge", open: here, retry: null };
    case "pages-unread":
      return { reason: "library.fix.pages", open: here, retry: here ? "readAgain" : null };
    case "forms-unread":
      return { reason: "library.fix.forms", open: here, retry: here ? "print" : null };
    case "processing-error":
      return { reason: "library.fix.processing", open: false, retry: here ? "retry" : null };
    case "app-stopped":
      return { reason: "library.fix.appStopped", open: false, retry: here ? "retry" : null };
    default:
      return null;
  }
}

/**
 * Whether the fix's Open in default app applies: the file is the User's to
 * open. A web page's snapshot and a Transcript have no such file (#763).
 */
export const canOpenFix = (doc: Document): boolean =>
  documentFix(doc)?.open === true && userFile(doc);
