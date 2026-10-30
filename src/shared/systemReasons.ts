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
  match: RegExp;
  /** What a notice or the quit sheet says: a sentence. */
  sentence: MessageKey;
  /** What a save's line says after "Couldn't save:". */
  reason: MessageKey;
  namesFile?: boolean;
  unnamed?: MessageKey;
}

const SYSTEM_FAILURES: readonly SystemFailure[] = [
  {
    match: /^E(?:ACCES|PERM|ROFS):/,
    sentence: "error.system.notAllowed",
    reason: "export.failed.readOnly",
  },
  {
    match: /attempt to write a readonly database/,
    sentence: "error.system.notAllowed",
    reason: "export.failed.dataNotWritable",
  },
  {
    match: /^E(?:NOSPC|DQUOT):|database or disk is full/,
    sentence: "error.system.full",
    reason: "export.failed.full",
  },
  {
    match: /^EIO:|disk I\/O error/,
    sentence: "error.system.diskError",
    reason: "export.failed.diskError",
  },
  {
    match: /database is (?:locked|busy)/,
    sentence: "error.system.busy",
    reason: "export.failed.busy",
  },
  {
    match: /^EBUSY:/,
    sentence: "error.system.fileBusy",
    reason: "export.failed.fileBusy",
    namesFile: true,
    unnamed: "export.failed.fileBusyUnnamed",
  },
  {
    match: /^E(?:NOENT|NOTDIR):/,
    sentence: "error.system.gone",
    reason: "export.failed.gone",
  },
  {
    match: /^ENAMETOOLONG:/,
    sentence: "error.system.nameTooLong",
    reason: "export.failed.nameTooLong",
  },
  {
    match: /^EEXIST:/,
    sentence: "error.system.exists",
    reason: "export.failed.exists",
  },
  {
    match: /^EISDIR:/,
    sentence: "error.system.isFolder",
    reason: "export.failed.isFolder",
  },
  {
    match: /^E(?:MFILE|NFILE):/,
    sentence: "error.system.tooManyFiles",
    reason: "export.failed.tooManyFiles",
  },
  {
    match: /^EXDEV:/,
    sentence: "error.system.otherDevice",
    reason: "export.failed.otherDevice",
  },
  {
    match: /^EFBIG:/,
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

/**
 * The file the system's own words name. A rename names the source first and where the file goes
 * second, and a path may hold the quote its message wraps it in, so the path is what sits between
 * the first and the last quote of its segment.
 */
const fileIn = (text: string): string | null => {
  const arrow = text.lastIndexOf(" -> ");
  const target = (arrow >= 0 ? text.slice(arrow + 4) : text).trim();
  const quoted = /(['"])([\s\S]*)\1/.exec(target);
  const path = quoted?.[2]?.trim();
  if (!path) return null;
  const name = path
    .split(path.startsWith("/") ? "/" : /[\\/]/)
    .pop()
    ?.trim();
  return name ? name : null;
};

/** Why a file couldn't be written, in a few words, for "Couldn't save: …"; null when it names no code. */
export const saveFailureReason = (text: string): SaveReason | null => {
  const failure = failureIn(text);
  if (!failure) return null;
  if (!failure.namesFile) return { key: failure.reason };
  const file = fileIn(text);
  return file
    ? { key: failure.reason, values: { file } }
    : { key: failure.unnamed ?? failure.reason };
};
