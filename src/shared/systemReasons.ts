/**
 * Plain words for a failure of the system's, by its code or the database's own words (a full
 * disk, a name too long), for the window's notices and the main process's sheets alike; and the
 * few words a save's line gives after "Couldn't save:", the same failure with less room.
 */
import type { MessageKey } from "./i18n";

interface SystemFailure {
  match: RegExp;
  /** What a notice or the quit sheet says: a sentence. */
  sentence: MessageKey;
  /** What a save's line says after "Couldn't save:". */
  reason: MessageKey;
}

const SYSTEM_FAILURES: readonly SystemFailure[] = [
  {
    match: /\b(EACCES|EPERM|EROFS)\b|attempt to write a readonly database/,
    sentence: "error.system.notAllowed",
    reason: "export.failed.readOnly",
  },
  {
    match: /\b(ENOSPC|EDQUOT)\b|database or disk is full/,
    sentence: "error.system.full",
    reason: "export.failed.full",
  },
  {
    match: /disk I\/O error/,
    sentence: "error.system.diskError",
    reason: "export.failed.diskError",
  },
  {
    match: /database is (?:locked|busy)/,
    sentence: "error.system.busy",
    reason: "export.failed.busy",
  },
  {
    match: /\b(ENOENT|ENOTDIR)\b/,
    sentence: "error.system.gone",
    reason: "export.failed.gone",
  },
  {
    match: /\bENAMETOOLONG\b/,
    sentence: "error.system.nameTooLong",
    reason: "export.failed.nameTooLong",
  },
  {
    match: /\bEEXIST\b/,
    sentence: "error.system.exists",
    reason: "export.failed.exists",
  },
];

const failureIn = (text: string) => SYSTEM_FAILURES.find(({ match }) => match.test(text));

/** The dictionary's plain words for a system failure's text; null when it names no code. */
export const systemReason = (text: string): MessageKey | null => failureIn(text)?.sentence ?? null;

/** Why a file couldn't be written, in a few words, for "Couldn't save: …"; null when it names no code. */
export const saveFailureReason = (text: string): MessageKey | null =>
  failureIn(text)?.reason ?? null;
