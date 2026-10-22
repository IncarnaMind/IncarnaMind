export const REDACTED = "[redacted]";

/** The most of a message that is kept. */
export const MAX_MESSAGE_LENGTH = 300;

/** Quoted text, in the quote marks of English and Chinese. Single quotes only when not an apostrophe. */
const QUOTED = [
  /"(?:[^"\\\n]|\\.)*"/gu,
  /`[^`\n]*`/gu,
  /(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu,
  /“[^”\n]*”/gu,
  /‘[^’\n]*’/gu,
  /„[^“”\n]*[“”]/gu,
  /「[^」\n]*」/gu,
  /『[^』\n]*』/gu,
  /《[^》\n]*》/gu,
  /«[^»\n]*»/gu,
];
/** Keys, tokens and hashes: long runs of letters and digits with both in them. */
const SECRET_LIKE =
  /(?<![\p{L}\p{N}_-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}(?![\p{L}\p{N}_-])/gu;

/**
 * What a log or a crash report keeps of a message that can quote anything (a provider's, an
 * error's): its first line, without anything quoted or anything like a key or a hash, shortened.
 * Errors quote the text they fail on, which may be Document text, Mind content, a Question or an Answer.
 */
export function redactMessage(message: string): string {
  let result = (message.split(/\r?\n/, 1)[0] ?? "").replace(SECRET_LIKE, REDACTED);
  for (const quoted of QUOTED) result = result.replace(quoted, REDACTED);
  return result.length > MAX_MESSAGE_LENGTH
    ? `${result.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : result;
}
