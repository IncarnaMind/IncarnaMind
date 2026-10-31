/**
 * The words a Meeting's speech may hold (#1031), as Qwen3-ASR takes them: a short text at the head
 * of its prompt that it leans towards, so a name it has been told is written as the User writes it.
 * sherpa-onnx puts them in the system part of the model's prompt (its `hotwords` option), separated
 * by spaces.
 */

/**
 * Qwen3-ASR holds its prompt, the audio and what it writes in 512 tokens: a stretch of 20 seconds
 * is about 265 of them and a line up to 128 more, so the words get what is left, with room to spare.
 */
const CONTEXT_TOKENS = 64;

const HAN = /\p{Script=Han}/gu;

/** About how many tokens a word takes, erring high: a Han character is one, about three letters another. */
function tokensOf(word: string): number {
  const han = word.match(HAN)?.length ?? 0;
  const rest = word.replace(HAN, "").replace(/\s/gu, "").length;
  return han + Math.ceil(rest / 3) + 1;
}

/** A word as the engine compares it: case folded, with no punctuation or space. */
const plain = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");

/**
 * The words the engine is told, in the order given: each once whatever its case, on one line, an
 * ASCII comma (which sherpa-onnx splits on) as a space, and only as many as fit.
 */
export function contextWords(words: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  for (const given of words) {
    const word = given.replace(/[,\s]+/gu, " ").trim();
    const key = plain(word);
    if (!key || seen.has(key)) continue;
    const cost = tokensOf(word);
    if (tokens + cost > CONTEXT_TOKENS) break;
    seen.add(key);
    kept.push(word);
    tokens += cost;
  }
  return kept;
}

/** The words as sherpa-onnx's `hotwords` option reads them. */
export const hotwordsOf = (words: readonly string[]) => words.join(",");

/**
 * Whether the engine wrote out the words it was told instead of, or before, what was said: a run
 * of three of them (two, of two) in their order, with nothing but punctuation between. Seen on a
 * Chinese stretch whose first word was the first of the list ("陈经理，星河科技，王丽，王总，李明。").
 * One word alone can't be told from that word being said.
 */
export function echoes(text: string, words: readonly string[]): boolean {
  if (words.length < 2) return false;
  const run = Math.min(3, words.length);
  const said = plain(text);
  const keys = words.map(plain);
  for (let at = 0; at + run <= keys.length; at++) {
    if (said.includes(keys.slice(at, at + run).join(""))) return true;
  }
  return false;
}
