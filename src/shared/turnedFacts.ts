/**
 * A Document's Citation left on an option's line to say or "→" line, in the form whose facts stand
 * apart (#2847), turned into a fact line of its own: the words it quotes, as a fact line shows them.
 */

/** The most a turned line holds: words, or characters in Chinese. */
const MOST_WORDS = 20;
const MOST_HAN = 40;
const HAN = /\p{Script=Han}/u;

/** A line's words for telling two lines apart: no markers, marks, punctuation or case. */
export const sameWordsOf = (line: string): string =>
  line
    .replace(/\[\^\d{1,4}\]|\[=\d{1,4}\]/g, "")
    .replace(/^\s*(?:[-*•]\s+|#+\s+)/, "")
    .replace(/[\s.。!！?？,，;；:：“”"'「」『』]+/gu, " ")
    .trim()
    .toLowerCase();

/** The words two lines can share: Chinese characters, or Latin words of three letters or more. */
function wordsOf(line: string): Set<string> {
  return new Set(
    HAN.test(line)
      ? [...line.replace(/\s+/g, "")].filter((char) => /[\p{L}\p{N}]/u.test(char))
      : line
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((word) => word.length > 2),
  );
}

/**
 * A Document's `quote` as a fact line's words beside the line to say `said`: a list's or a
 * heading's mark comes off, a table row's cells are joined, of two sentences the one sharing the
 * most words with `said` is kept, its closing full stop comes off, and past 20 words (40 Chinese
 * characters) it is cut, with "…". The whole quote stays in the Citation's card.
 */
export function quoteAsFact(quote: string, said: string): string {
  const flat = quote
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.includes("|")
        ? line
            .split("|")
            .map((cell) => cell.trim())
            .filter((cell) => cell !== "" && !/^:?-{2,}:?$/.test(cell))
            .join(" · ")
        : line.replace(/^(?:[-*•]\s+|#+\s+)/, ""),
    )
    .join(" ");
  const sentences = flat
    .split(/(?<=[。！？])|(?<=[.!?])(?=\s)/u)
    .map((each) => each.trim())
    .filter(Boolean);
  const sayWords = wordsOf(said);
  const shared = (sentence: string) =>
    [...wordsOf(sentence)].filter((word) => sayWords.has(word)).length;
  const best = sentences.reduce(
    (kept, sentence) => (shared(sentence) > shared(kept) ? sentence : kept),
    sentences[0] ?? flat,
  );
  const words = best.replace(/[.。]$/u, "");
  if (HAN.test(words)) {
    const chars = [...words];
    return chars.length > MOST_HAN ? `${chars.slice(0, MOST_HAN).join("")}…` : words;
  }
  const split = words.split(/\s+/);
  return split.length > MOST_WORDS ? `${split.slice(0, MOST_WORDS).join(" ")}…` : words;
}
