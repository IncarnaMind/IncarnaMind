import type { Document, DocumentFailureReason, DocumentStatus } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { unreadPages } from "./scanStatus";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A Document's status in full: for its tooltip and for screen readers. */
const statusMessages: Record<Exclude<DocumentStatus, "failed">, MessageKey> = {
  queued: "documents.status.queued",
  extracting: "documents.status.extracting",
  "waiting-for-model": "embedding.status.waiting",
  embedding: "embedding.status.embedding",
  ready: "documents.status.ready",
  "no-text": "documents.status.noText",
};

const failureMessages: Record<DocumentFailureReason, MessageKey> = {
  unreadable: "documents.failure.unreadable",
  "password-protected": "documents.failure.passwordProtected",
  "too-large": "documents.failure.tooLarge",
  "file-missing": "documents.failure.fileMissing",
  "processing-error": "documents.failure.processingError",
  // Worded with its pages (see `unreadPages`).
  "pages-unread": "documents.failure.pagesUnread.all",
  "forms-unread": "documents.failure.formsUnread",
  "app-stopped": "documents.failure.appStopped",
};

/**
 * Where a Document's reading is, in full words, with the reason if it
 * failed. `scanning` is what says so while its scanned pages are read.
 */
export function documentStatusText(
  item: Pick<Document, "status" | "failure" | "progress">,
  t: Translate,
  language: Language,
  scanning: string | null,
): string {
  if (item.status === "failed") {
    const unread = item.failure?.reason === "pages-unread";
    return t("documents.status.failed", {
      reason:
        unread && item.failure
          ? unreadPages(item.failure, t, language, "reason")
          : t(failureMessages[item.failure?.reason ?? "processing-error"]),
    });
  }
  const percent = Math.floor((item.progress ?? 0) * 100);
  return scanning ?? t(statusMessages[item.status], { percent });
}
