/**
 * Plain words for a failure of the system's, by its code or the database's own words (a full
 * disk, a name too long), for the window's notices and the main process's sheets alike; and the
 * few words a save's line gives after "Couldn't save:", the same failure with less room.
 */
import type { MessageKey } from "./i18n";

/** Why a file couldn't be written, in a few words: a key, and the file the system's text names. */
export interface SaveFailureReason {
  key: MessageKey;
  values?: Readonly<Record<string, string>>;
}

interface SystemFailure {
  match: RegExp;
  /** What a notice or the quit sheet says: a sentence. */
  sentence: MessageKey;
  /** What a save's line says after "Couldn't save:". */
  reason: MessageKey;
  /** Whether `reason` names the file the system's text names; `unnamed` says it when there is none. */
  namesFile?: boolean;
  unnamed?: MessageKey;
}

const SYSTEM_FAILURES: readonly SystemFailure[] = [
  {
    match: /\b(EACCES|EPERM|EROFS)\b/,
    sentence: "error.system.notAllowed",
    reason: "export.failed.readOnly",
  },
  {
    match: /attempt to write a readonly database/,
    sentence: "error.system.notAllowed",
    reason: "export.failed.dataNotWritable",
  },
  {
    match: /\b(ENOSPC|EDQUOT)\b|database or disk is full/,
    sentence: "error.system.full",
    reason: "export.failed.full",
  },
  {
    match: /\bEIO\b|disk I\/O error/,
    sentence: "error.system.diskError",
    reason: "export.failed.diskError",
  },
  {
    match: /database is (?:locked|busy)/,
    sentence: "error.system.busy",
    reason: "export.failed.busy",
  },
  {
    match: /\bEBUSY\b/,
    sentence: "error.system.fileBusy",
    reason: "export.failed.fileBusy",
    namesFile: true,
    unnamed: "export.failed.fileBusyUnnamed",
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
  {
    match: /\bEISDIR\b/,
    sentence: "error.system.isFolder",
    reason: "export.failed.isFolder",
  },
  {
    match: /\b(EMFILE|ENFILE)\b/,
    sentence: "error.system.tooManyFiles",
    reason: "export.failed.tooManyFiles",
  },
  {
    match: /\bEXDEV\b/,
    sentence: "error.system.otherDevice",
    reason: "export.failed.otherDevice",
  },
  {
    match: /\bEFBIG\b/,
    sentence: "error.system.tooBig",
    reason: "export.failed.tooBig",
  },
  {
    match: /SQLITE_CANTOPEN|unable to open database file/i,
    sentence: "error.system.dataFolder",
    reason: "export.failed.dataFolder",
  },
  {
    match: /database disk image is malformed|SQLITE_CORRUPT/i,
    sentence: "error.system.corrupt",
    reason: "export.failed.corrupt",
  },
];

const failureIn = (text: string) => SYSTEM_FAILURES.find(({ match }) => match.test(text));

/** The dictionary's plain words for a system failure's text; null when it names no code. */
export const systemReason = (text: string): MessageKey | null => failureIn(text)?.sentence ?? null;

/** The file the system's own words name, as the save line says it: the last part of its path. */
const fileIn = (text: string): string | null => {
  const path = /['"]([^'"]+)['"]/.exec(text)?.[1];
  const name = path?.split(/[\\/]/).pop()?.trim();
  return name ? name : null;
};

/** Why a file couldn't be written, in a few words, for "Couldn't save: …"; null when it names no code. */
export const saveFailureReason = (text: string): SaveFailureReason | null => {
  const failure = failureIn(text);
  if (!failure) return null;
  if (!failure.namesFile) return { key: failure.reason };
  const file = fileIn(text);
  return file
    ? { key: failure.reason, values: { file } }
    : { key: failure.unnamed ?? failure.reason };
};
