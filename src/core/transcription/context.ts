/**
 * The words a Meeting's speech may hold (#1031), as Qwen3-ASR takes them: a short text at the head
 * of its prompt that it leans towards, so a name it has been told is written as the User writes it.
 * sherpa-onnx puts them in the system part of the model's prompt (its `hotwords` option), separated
 * by spaces. Told them, the model also changes other words, so a stretch is read once without them
 * and once with, and the first reading takes only the told names from the second
 * (`withToldWords`).
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

/** A text's units: a Han character, a run of other letters and digits, or any other character. */
const UNIT = /\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}])+|[\s\S]/gu;
const WORDLIKE = /^[\p{L}\p{N}]/u;

const unitsOf = (text: string) => text.match(UNIT) ?? [];
const fold = (unit: string) => unit.normalize("NFKC").toLowerCase();

type Step = "same" | "changed" | "plainOnly" | "toldOnly";

/** A word never stands in for a space or a mark: that costs more than dropping one and adding the other. */
const changeCost = (a: string, b: string) =>
  fold(a) === fold(b) ? 0 : WORDLIKE.test(a) === WORDLIKE.test(b) ? 1 : 3;

/** How the told text's units line up with the plain text's, fewest edits first. */
function alignUnits(plain: readonly string[], told: readonly string[]): Step[] {
  const n = plain.length;
  const m = told.length;
  const cost = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 0; i <= n; i++) cost[at(i, 0)] = i;
  for (let j = 0; j <= m; j++) cost[at(0, j)] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[at(i, j)] = Math.min(
        (cost[at(i - 1, j - 1)] as number) +
          changeCost(plain[i - 1] as string, told[j - 1] as string),
        (cost[at(i - 1, j)] as number) + 1,
        (cost[at(i, j - 1)] as number) + 1,
      );
    }
  }
  const steps: Step[] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const here = cost[at(i, j)] as number;
    if (i > 0 && j > 0) {
      const change = changeCost(plain[i - 1] as string, told[j - 1] as string);
      if (here === (cost[at(i - 1, j - 1)] as number) + change) {
        steps.push(change === 0 ? "same" : "changed");
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && here === (cost[at(i - 1, j)] as number) + 1) {
      steps.push("plainOnly");
      i--;
    } else {
      steps.push("toldOnly");
      j--;
    }
  }
  return steps.reverse();
}

/** Where each word is written in the units, as its first and last unit, longest words first, none overlapping. */
function writtenAt(
  units: readonly string[],
  words: readonly { word: string; capitalised: boolean }[],
): { first: number; last: number; word: string }[] {
  const taken = new Uint8Array(units.length);
  const found: { first: number; last: number; word: string }[] = [];
  const keys = words
    .map(({ word, capitalised }) => ({
      word,
      key: unitsOf(word)
        .filter((unit) => WORDLIKE.test(unit))
        .map((unit) => (capitalised ? unit : fold(unit))),
      capitalised,
    }))
    .filter(({ key }) => key.length > 0)
    .sort((a, b) => b.key.length - a.key.length);
  for (const { word, key, capitalised } of keys) {
    for (let start = 0; start < units.length; start++) {
      let k = 0;
      let end = start;
      for (let at = start; at < units.length && k < key.length; at++) {
        const unit = units[at] as string;
        if (taken[at]) break;
        if ((capitalised ? unit : fold(unit)) === key[k]) {
          k++;
          end = at;
        } else if (!(k > 0 && /^\s$/u.test(unit))) {
          break;
        }
      }
      if (k < key.length) continue;
      for (let at = start; at <= end; at++) taken[at] = 1;
      found.push({ first: start, last: end, word });
    }
  }
  return found;
}

const lettersIn = (units: readonly string[]) =>
  units.reduce((sum, unit) => sum + (WORDLIKE.test(unit) ? [...unit].length : 0), 0);

/**
 * The plain text, with the told words the model wrote when it was told them put in their places
 * (#1031): every other word stays as the model heard it without the list, which a told list can
 * change for the worse (on a Chinese call it dropped words mid-sentence). A told word goes in only
 * where the two texts line up and the plain one heard something about as long in its place, never
 * where it heard nothing.
 */
/**
 * The told words, and the capitalised parts of a name of several words: a call says "Priya" as
 * often as "Priya Raman". A part counts only where the model wrote it capitalised too: "harbor"
 * alone is a place for ships, not Harbor Logistics.
 */
function namesAndParts(words: readonly string[]): { word: string; capitalised: boolean }[] {
  const parts = words.flatMap((word) => {
    const each = word.split(/\s+/u);
    return each.length > 1 ? each.filter((part) => /^\p{Lu}\p{L}{2,}$/u.test(part)) : [];
  });
  return [
    ...words.map((word) => ({ word, capitalised: false })),
    ...parts.map((word) => ({ word, capitalised: true })),
  ];
}

export function withToldWords(plain: string, told: string, words: readonly string[]): string {
  if (words.length === 0 || echoes(told, words)) return plain;
  const plainUnits = unitsOf(plain);
  const toldUnits = unitsOf(told);
  // The plain unit each told unit lines up with, or -1 where the plain text has none.
  const linedUp: number[] = [];
  let i = 0;
  for (const step of alignUnits(plainUnits, toldUnits)) {
    if (step === "plainOnly") i++;
    else if (step === "toldOnly") linedUp.push(-1);
    else linedUp.push(i++);
  }
  const swaps: { from: number; to: number; units: string[] }[] = [];
  for (const { first, last, word } of writtenAt(toldUnits, namesAndParts(words))) {
    const heard = linedUp
      .slice(first, last + 1)
      .filter((at, k) => at >= 0 && WORDLIKE.test(toldUnits[first + k] as string));
    if (heard.length === 0) continue;
    const from = Math.min(...heard);
    const to = Math.max(...heard);
    // Written as the User writes it, which the model may not have: "harbor logistics".
    const said = unitsOf(word);
    const was = plainUnits.slice(from, to + 1);
    if (was.join("") === word) continue;
    const ratio = lettersIn(was) / Math.max(1, lettersIn(said));
    if (ratio < 0.5 || ratio > 2) continue;
    if (swaps.some((swap) => swap.from <= to && from <= swap.to)) continue;
    swaps.push({ from, to, units: said });
  }
  const out = [...plainUnits];
  for (const swap of swaps.sort((a, b) => b.from - a.from)) {
    out.splice(swap.from, swap.to - swap.from + 1, ...swap.units);
  }
  return out.join("");
}
