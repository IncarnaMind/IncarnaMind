/**
 * How a Document's scanned pages (#397) are spoken of: while they are read
 * ("Reading 12 scanned pages…"), and when some couldn't be ("Scanned pages 3
 * and 7 couldn't be read"), in the row's status, its tooltip and the viewer.
 */
import type { DocumentFailure, DocumentKind, DocumentScanProgress } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Page numbers as a list: "3, 7 and 9" in English, "3、7、9" in Chinese. */
export function pageList(pages: readonly number[], language: Language): string {
  const numbers = pages.map(String);
  return language === "zh-CN"
    ? numbers.join("、")
    : new Intl.ListFormat(language, { type: "conjunction" }).format(numbers);
}

const SCANNING_KEYS = {
  "scanned-pages": {
    one: "documents.status.scanning.one",
    other: "documents.status.scanning.other",
  },
  pictures: {
    one: "documents.status.readingPictures.one",
    other: "documents.status.readingPictures.other",
  },
} as const satisfies Record<DocumentScanProgress["of"], Record<"one" | "other", MessageKey>>;

export function scanningStatus(scan: DocumentScanProgress, t: Translate) {
  const keys = SCANNING_KEYS[scan.of];
  return {
    short: t("documents.statusShort.scanning", { read: scan.read, count: scan.pages }),
    full: t(scan.pages === 1 ? keys.one : keys.other, { count: scan.pages, read: scan.read }),
  };
}

/** Which scanned pages couldn't be read, as a reason ("scanned page 3 couldn't be read") or a sentence. */
export function unreadPages(
  failure: DocumentFailure,
  t: Translate,
  language: Language,
  as: "reason" | "sentence",
  kind: DocumentKind = "pdf",
): string {
  if (kind === "image") {
    return t(as === "reason" ? "documents.failure.pictureUnread" : "documents.pictureUnread");
  }
  const pages = failure.pages ?? [];
  const keys = {
    reason: {
      all: "documents.failure.pagesUnread.all",
      one: "documents.failure.pagesUnread.one",
      other: "documents.failure.pagesUnread.other",
    },
    sentence: {
      all: "documents.pagesUnread.all",
      one: "documents.pagesUnread.one",
      other: "documents.pagesUnread.other",
    },
  } as const satisfies Record<string, Record<string, MessageKey>>;
  if (pages.length === 0) return t(keys[as].all);
  return t(pages.length === 1 ? keys[as].one : keys[as].other, {
    pages: pageList(pages, language),
  });
}
