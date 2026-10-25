/**
 * Plain words for a failure of the system's, by its code or the database's own words (a full
 * disk, a name too long), for the window's notices and the main process's sheets alike.
 */
import type { MessageKey } from "./i18n";

const SYSTEM_REASONS: readonly (readonly [RegExp, MessageKey])[] = [
  [/\b(EACCES|EPERM|EROFS)\b|attempt to write a readonly database/, "error.system.notAllowed"],
  [/\b(ENOSPC|EDQUOT)\b|database or disk is full/, "error.system.full"],
  [/disk I\/O error/, "error.system.diskError"],
  [/database is (?:locked|busy)/, "error.system.busy"],
  [/\b(ENOENT|ENOTDIR)\b/, "error.system.gone"],
  [/\bENAMETOOLONG\b/, "error.system.nameTooLong"],
  [/\bEEXIST\b/, "error.system.exists"],
];

/** The dictionary's plain words for a system failure's text; null when it names no code. */
export const systemReason = (text: string): MessageKey | null =>
  SYSTEM_REASONS.find(([code]) => code.test(text))?.[1] ?? null;
