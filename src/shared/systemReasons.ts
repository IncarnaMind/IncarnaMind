/**
 * Plain words for a failure of the system's, by its code or the database's own words (a full
 * disk, a name too long), for the window's notices and the main process's sheets alike; and the
 * few words a save's line gives after "Couldn't save:", the same failure with less room.
 */
import type { MessageKey } from "./i18n";

export interface SaveReason {
  key: MessageKey;
  values?: Readonly<Record<string, string>>;
}

interface SystemFailure {
  code?: RegExp;
  /** The system's own words, for a message that names no code. */
  words?: RegExp;
  /** What a notice or the quit sheet says: a sentence. */
  sentence: MessageKey;
  /** What a save's line says after "Couldn't save:". */
  reason: MessageKey;
  namesFile?: boolean;
  unnamed?: MessageKey;
}

const SYSTEM_FAILURES: readonly SystemFailure[] = [
  {
    code: /^E(?:ACCES|PERM|ROFS):/,
    sentence: "error.system.notAllowed",
    reason: "export.failed.readOnly",
  },
  {
    words: /attempt to write a readonly database/,
    sentence: "error.system.notAllowed",
    reason: "export.failed.dataNotWritable",
  },
  {
    code: /^E(?:NOSPC|DQUOT):/,
    words: /database or disk is full/,
    sentence: "error.system.full",
    reason: "export.failed.full",
  },
  {
    code: /^EIO:/,
    words: /disk I\/O error/,
    sentence: "error.system.diskError",
    reason: "export.failed.diskError",
  },
  {
    words: /database is (?:locked|busy)/,
    sentence: "error.system.busy",
    reason: "export.failed.busy",
  },
  {
    code: /^EBUSY:/,
    sentence: "error.system.fileBusy",
    reason: "export.failed.fileBusy",
    namesFile: true,
    unnamed: "export.failed.fileBusyUnnamed",
  },
  {
    code: /^E(?:NOENT|NOTDIR):/,
    sentence: "error.system.gone",
    reason: "export.failed.gone",
  },
  {
    code: /^ENAMETOOLONG:/,
    sentence: "error.system.nameTooLong",
    reason: "export.failed.nameTooLong",
  },
  {
    code: /^EEXIST:/,
    sentence: "error.system.exists",
    reason: "export.failed.exists",
  },
  {
    code: /^EISDIR:/,
    sentence: "error.system.isFolder",
    reason: "export.failed.isFolder",
  },
  {
    code: /^E(?:MFILE|NFILE):/,
    sentence: "error.system.tooManyFiles",
    reason: "export.failed.tooManyFiles",
  },
  {
    code: /^EXDEV:/,
    sentence: "error.system.otherDevice",
    reason: "export.failed.otherDevice",
  },
  {
    code: /^EFBIG:/,
    sentence: "error.system.tooBig",
    reason: "export.failed.tooBig",
  },
  {
    words: /SQLITE_CANTOPEN|unable to open database file/i,
    sentence: "error.system.dataFolder",
    reason: "export.failed.dataFolder",
  },
  {
    words: /database disk image is malformed|SQLITE_CORRUPT/i,
    sentence: "error.system.corrupt",
    reason: "export.failed.corrupt",
  },
];

const LEADING_CODE = /^E[A-Z]+:/;

// A message that starts with an error code is about that code: a path may hold another
// failure's words (#2237).
const failureIn = (text: string) => {
  const named = LEADING_CODE.test(text);
  return SYSTEM_FAILURES.find(({ code, words }) => (named ? code : words)?.test(text));
};

/** The dictionary's plain words for a system failure's text; null when no failure here matches. */
export const systemReason = (text: string): MessageKey | null => failureIn(text)?.sentence ?? null;

/**
 * The file the system's own words name. A path may hold the quote its message wraps it in, so it
 * is what sits between the first and the last quote; a rename names where the file goes last, so
 * its name is the last segment.
 */
const fileIn = (text: string): string | null => {
  const quoted = /(['"])([\s\S]*)\1/.exec(text);
  const path = quoted?.[2]?.trim();
  if (!path) return null;
  const name = path
    .split(path.startsWith("/") ? "/" : /[\\/]/)
    .pop()
    ?.trim();
  return name ? name : null;
};

/** Why a file couldn't be written, in a few words, for "Couldn't save: …"; null when no failure here matches. */
export const saveFailureReason = (text: string): SaveReason | null => {
  const failure = failureIn(text);
  if (!failure) return null;
  if (!failure.namesFile) return { key: failure.reason };
  const file = fileIn(text);
  return file
    ? { key: failure.reason, values: { file } }
    : { key: failure.unnamed ?? failure.reason };
};
