export const REDACTED = "[redacted]";

export const MAX_MESSAGE_LENGTH = 300;

/** A shorter secret isn't taken out: it would clip ordinary words. */
const MIN_SECRET_LENGTH = 6;

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
/**
 * A quote mark still open once the pairs are gone: its text runs past the first line, or has an
 * apostrophe inside (Ollama's raw='Acme's …'). All that follows it is cut.
 */
const OPEN_QUOTE = /(?:["`“‘„「『《«]|(?<![\p{L}\p{N}])').*$/u;
/** Keys, tokens and hashes: long runs of letters and digits with both in them. */
const SECRET_LIKE =
  /(?<![\p{L}\p{N}_-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}(?![\p{L}\p{N}_-])/gu;

/**
 * What a log or a crash report keeps of a message that can quote anything (a provider's, an
 * error's): its first line, without anything quoted or anything like a key or a hash, shortened.
 * Errors quote the text they fail on, which may be Document text, Mind content, a Question or an Answer.
 * `secrets` are values the run has handled (API keys): they go wherever they appear, however short
 * or plain, which the shape of a key can't promise.
 */
export function redactMessage(message: string, secrets: readonly string[] = []): string {
  let result = message.split(/\r?\n/, 1)[0] ?? "";
  // Longest first, so a secret inside another doesn't leave the rest of the outer one behind.
  const known = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  for (const secret of known.toSorted((a, b) => b.length - a.length)) {
    result = result.split(secret).join(REDACTED);
  }
  result = result.replace(SECRET_LIKE, REDACTED);
  for (const quoted of QUOTED) result = result.replace(quoted, REDACTED);
  result = result.replace(OPEN_QUOTE, REDACTED);
  return result.length > MAX_MESSAGE_LENGTH
    ? `${result.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : result;
}
