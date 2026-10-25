/**
 * What a check's scope couldn't read when it started, kept beside the Mind's
 * Blocks (`MIND_CHECK_UNREAD_FIELD`) by the request that made the checks, so
 * the line beside them and the AI use statement say what was unread then, not
 * now (ADR-0003).
 */
import type * as Y from "yjs";
import { MIND_CHECK_UNREAD_FIELD, type UnreadFile, type UnreadReason } from "../core/api";
import { isRecord } from "../core/errors";
import type { MessageKey, MessageParams } from "./i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export const UNREAD_REASON_KEYS: Record<UnreadReason, MessageKey> = {
  format: "unread.reason.format",
  scan: "unread.reason.scan",
  password: "unread.reason.password",
  damaged: "unread.reason.damaged",
  "too-large": "unread.reason.too-large",
  pages: "unread.reason.pages",
};

const REASONS = Object.keys(UNREAD_REASON_KEYS) as UnreadReason[];

/** "3 files couldn't be read": the line beside an Answer, a check, and in what an export keeps. */
export function unreadCountText(files: readonly UnreadFile[], t: Translate): string {
  return t(files.length === 1 ? "unread.count.one" : "unread.count", { count: files.length });
}

/** "Contract.doc: Format not read yet (.doc)…", as the list and an export's own text say it. */
export function unreadFileText(
  file: Pick<UnreadFile, "name" | "reason" | "extension">,
  t: Translate,
): string {
  return `${file.name}${t("unread.file.reason", {
    reason: t(UNREAD_REASON_KEYS[file.reason], { extension: file.extension ?? "" }),
  })}`;
}

const unreadOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_CHECK_UNREAD_FIELD);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function keptFiles(value: unknown): Omit<UnreadFile, "id">[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each) => {
    if (!isRecord(each)) return [];
    const name = text(each.name);
    const reason = REASONS.find((known) => known === each.reason);
    if (!name || !reason) return [];
    return [
      {
        name,
        reason,
        extension: text(each.extension),
        documentId: text(each.documentId),
        pages: Array.isArray(each.pages)
          ? each.pages.filter((page): page is number => Number.isInteger(page) && page >= 1)
          : [],
      },
    ];
  });
}

/**
 * Records what a request's scope couldn't read, and drops what earlier
 * requests recorded once no mark names them (`requests` is the ones the
 * Mind's marks name now), in one Yjs transaction.
 */
export function recordCheckUnread(
  doc: Y.Doc,
  request: string,
  files: readonly UnreadFile[],
  requests: ReadonlySet<string>,
): void {
  const unread = unreadOf(doc);
  doc.transact(() => {
    for (const key of [...unread.keys()]) {
      if (key !== request && !requests.has(key)) unread.delete(key);
    }
    if (files.length === 0) return;
    // Without a file's path, which is this computer's, not the Mind's.
    unread.set(
      request,
      files.map(({ name, reason, extension, documentId, pages }) => ({
        name,
        reason,
        extension,
        documentId,
        pages: [...pages],
      })),
    );
  });
}

/**
 * The files that couldn't be read when these requests' checks started, each
 * once: a Document by its id, any other file by its name (two of one name in
 * one request stay two).
 */
export function checkUnreadOf(doc: Y.Doc, requests: Iterable<string>): UnreadFile[] {
  const unread = unreadOf(doc);
  const found = new Map<string, UnreadFile>();
  for (const request of new Set(requests)) {
    const seen = new Map<string, number>();
    for (const file of keptFiles(unread.get(request))) {
      const key = file.documentId ?? file.name;
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      const id = nth === 0 ? key : `${key}#${nth}`;
      if (!found.has(id)) found.set(id, { id, ...file });
    }
  }
  return [...found.values()];
}

export function observeCheckUnread(doc: Y.Doc, listener: () => void): () => void {
  const unread = unreadOf(doc);
  unread.observe(listener);
  return () => unread.unobserve(listener);
}
