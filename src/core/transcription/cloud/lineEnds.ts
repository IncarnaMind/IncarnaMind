import { UNSPACED } from "./live";

/**
 * Where a line of a Transcript ends on a route that gives words as they are said: at the speaker's
 * change or the service's pause, as each route says, and here at each sentence's end, so a
 * Citation's time is its sentence's. Never by a clock: a sentence still going after
 * `CLAUSE_CUT_MS` ends at its next clause mark, and after `WORD_CUT_MS` at its next word, never
 * inside one.
 */
export const CLAUSE_CUT_MS = 30_000;
export const WORD_CUT_MS = 45_000;

const CLOSING = /["'”’）)」』\]]+$/u;
const SENTENCE_END = /[。！？!?…]$/u;
const CLAUSE_END = /[，,；;：:、]$/u;
const SHORTENED = /(?:^|[\s(])(?:mr|mrs|ms|dr|st|prof|vs|etc|e\.g|i\.e|no|jr|sr)\.$/iu;

/**
 * Whether a line reading `text`, `ms` long, ends after its last word. A full stop ends it only once
 * the word it closes is whole (`whole`): a route of subword pieces knows that from the piece after
 * it ("3." of "3.5" isn't an end), and not after a shortened word ("Dr.").
 */
export function endsAfter(text: string, ms: number, whole: boolean): boolean {
  const end = text.trimEnd().replace(CLOSING, "");
  if (SENTENCE_END.test(end)) return true;
  if (whole && end.endsWith(".") && !SHORTENED.test(end)) return true;
  return ms >= CLAUSE_CUT_MS && CLAUSE_END.test(end);
}

/** Whether a line `ms` long with the next piece ends before it: past `WORD_CUT_MS`, at a word's start. */
export const endsBefore = (ms: number, atWordStart: boolean): boolean =>
  ms >= WORD_CUT_MS && atWordStart;

/** Whether a subword piece `next` after a line reading `text` starts a word: after a space, or by a Chinese character. */
export const startsWord = (text: string, next: string): boolean =>
  /^\s/u.test(next) ||
  UNSPACED.test(next.trimStart()[0] ?? "") ||
  UNSPACED.test(text.trimEnd().at(-1) ?? "");
