/**
 * What a check's scope couldn't read when it started, kept beside the Mind's
 * Blocks (`MIND_CHECK_UNREAD_FIELD`) by the request that made the checks, so
 * the line beside them and the AI use statement say what was unread then, not
 * now (ADR-0003).
 */
import type * as Y from "yjs";
import {
  MIND_CHECK_UNREAD_FIELD,
  type UnreadFile,
  type UnreadParts,
  type UnreadReason,
} from "../core/api";
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
  parts: "unread.reason.parts",
};

const REASONS = Object.keys(UNREAD_REASON_KEYS) as UnreadReason[];

/** "3 files couldn't be read": the line beside an Answer, a check, and in what an export keeps. */
export function unreadCountText(files: readonly UnreadFile[], t: Translate): string {
  return t(files.length === 1 ? "unread.count.one" : "unread.count", { count: files.length });
}

const withThousandSeparators = (number: number) =>
  String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * What of a workbook wasn't read (#740): its hidden sheets, and the sheets its rows were cut
 * short in. `names`: name the sheets, as the app and the check record do; an export that goes to
 * someone else counts them instead.
 */
export function unreadPartsText(parts: UnreadParts, t: Translate, names: boolean): string {
  const segments: string[] = [];
  if (parts.hiddenSheets.length > 0) {
    segments.push(
      names
        ? t(
            parts.hiddenSheets.length === 1
              ? "unread.parts.hiddenNames.one"
              : "unread.parts.hiddenNames.other",
            {
              names: parts.hiddenSheets
                .map((name) => `“${name}”`)
                .join(t("unread.parts.names.separator")),
            },
          )
        : t(
            parts.hiddenSheets.length === 1
              ? "unread.parts.hidden.one"
              : "unread.parts.hidden.other",
            {
              count: parts.hiddenSheets.length,
            },
          ),
    );
  }
  const cut = parts.rowsCut.length + parts.sheetsNotRead.length;
  if (cut > 0) {
    if (names) {
      for (const each of parts.rowsCut) {
        segments.push(
          t("unread.parts.rows", { names: each.sheet, from: withThousandSeparators(each.from) }),
        );
      }
      for (const sheet of parts.sheetsNotRead) {
        segments.push(t("unread.parts.notRead", { names: sheet }));
      }
    } else {
      segments.push(
        t(cut === 1 ? "unread.parts.rowsCount.one" : "unread.parts.rowsCount.other", {
          count: cut,
        }),
      );
    }
  }
  return segments.join(t("unread.parts.separator"));
}

/**
 * "Contract.doc: Format not read yet (.doc)…", as the list and an export's own text say it.
 * `names`: name a workbook's sheets; an export that goes to someone else counts them instead.
 */
export function unreadFileText(
  file: Pick<UnreadFile, "name" | "reason" | "extension" | "parts">,
  t: Translate,
  names = true,
): string {
  const reason =
    file.reason === "parts" && file.parts
      ? unreadPartsText(file.parts, t, names)
      : t(UNREAD_REASON_KEYS[file.reason], { extension: file.extension ?? "" });
  return `${file.name}${t("unread.file.reason", { reason })}`;
}

/** A stored UnreadParts, or null when there is none or it isn't one. */
export function parseUnreadParts(json: string | null): UnreadParts | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parts = partsOf(value);
  return parts && unreadOfParts(parts) ? parts : null;
}

/** An UnreadParts a Mind's check kept, or one read from storage; null when it isn't one. */
export function partsOf(value: unknown): UnreadParts | null {
  if (!isRecord(value)) return null;
  const names = (list: unknown): string[] | null =>
    Array.isArray(list) && list.every((each) => typeof each === "string") ? list : null;
  const hiddenSheets = names(value.hiddenSheets);
  const sheetsNotRead = names(value.sheetsNotRead);
  const rowsCut = Array.isArray(value.rowsCut)
    ? value.rowsCut.flatMap((each): { sheet: string; from: number }[] =>
        isRecord(each) &&
        typeof each.sheet === "string" &&
        typeof each.from === "number" &&
        Number.isInteger(each.from) &&
        each.from >= 1
          ? [{ sheet: each.sheet, from: each.from }]
          : [],
      )
    : null;
  return hiddenSheets && sheetsNotRead && rowsCut ? { hiddenSheets, rowsCut, sheetsNotRead } : null;
}

/** Whether a workbook said some of it wasn't read (#740). */
export const unreadOfParts = (parts: UnreadParts): boolean =>
  parts.hiddenSheets.length > 0 || parts.rowsCut.length > 0 || parts.sheetsNotRead.length > 0;

/** What workbooks left unread, counted, for an export that doesn't name files (#740). */
export function unreadPartsCounts(files: readonly UnreadFile[], t: Translate): string[] {
  let hidden = 0;
  let cut = 0;
  for (const file of files) {
    if (!file.parts) continue;
    hidden += file.parts.hiddenSheets.length;
    cut += file.parts.rowsCut.length + file.parts.sheetsNotRead.length;
  }
  return [
    ...(hidden > 0
      ? [
          t(hidden === 1 ? "unread.parts.hidden.one" : "unread.parts.hidden.other", {
            count: hidden,
          }),
        ]
      : []),
    ...(cut > 0
      ? [
          t(cut === 1 ? "unread.parts.rowsCount.one" : "unread.parts.rowsCount.other", {
            count: cut,
          }),
        ]
      : []),
  ];
}

/** The check record names at most this many files, then says how many more (#740). */
export const CHECK_RECORD_NAMES = 20;

/**
 * The lines the check record's summary holds: the count, then each file with why, at most
 * `CHECK_RECORD_NAMES` of them and a last line for the rest (#740).
 */
export function unreadRecordLines(files: readonly UnreadFile[], t: Translate): string[] {
  const shown = files.slice(0, CHECK_RECORD_NAMES).map((file) => unreadFileText(file, t));
  const left = files.length - shown.length;
  return [
    unreadCountText(files, t),
    ...shown,
    ...(left > 0 ? [t("unread.more", { count: left })] : []),
  ];
}

/** The Mind settings key that says its exports name the files they couldn't read; absent: count only. */
const NAMES_KEY = "unreadFileNames";

/** Whether this Mind's exports name the files that couldn't be read, or only count them (#740). */
export function unreadFileNamesOf(settings: Y.Map<unknown>): boolean {
  return settings.get(NAMES_KEY) === true;
}

export function setUnreadFileNames(settings: Y.Map<unknown>, names: boolean): void {
  if (names) {
    if (settings.get(NAMES_KEY) !== true) settings.set(NAMES_KEY, true);
  } else if (settings.has(NAMES_KEY)) {
    settings.delete(NAMES_KEY);
  }
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
    const parts = partsOf(each.parts);
    return [
      {
        name,
        reason,
        extension: text(each.extension),
        documentId: text(each.documentId),
        pages: Array.isArray(each.pages)
          ? each.pages.filter((page): page is number => Number.isInteger(page) && page >= 1)
          : [],
        ...(parts ? { parts } : {}),
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
      files.map(({ name, reason, extension, documentId, pages, parts }) => ({
        name,
        reason,
        extension,
        documentId,
        pages: [...pages],
        ...(parts && {
          parts: {
            hiddenSheets: [...parts.hiddenSheets],
            rowsCut: parts.rowsCut.map((each) => ({ ...each })),
            sheetsNotRead: [...parts.sheetsNotRead],
          },
        }),
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
