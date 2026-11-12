export const UNITS: ReadonlyMap<string, number> = new Map(
  [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ].map((word, value) => [word, value]),
);
export const TENS: ReadonlyMap<string, number> = new Map(
  ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map((word, at) => [
    word,
    (at + 2) * 10,
  ]),
);
export const SCALES: ReadonlyMap<string, number> = new Map([
  ["thousand", 1e3],
  ["million", 1e6],
  ["billion", 1e9],
  ["trillion", 1e12],
]);

export const START_WORD = `${[...UNITS.keys()].join("|")}|${[...TENS.keys()].join("|")}`;
export const NUMBER_WORD = `${START_WORD}|hundred|${[...SCALES.keys()].join("|")}`;
export const INTEGER_WORDS = `(?:${START_WORD})(?:[ -](?:${NUMBER_WORD})|(?<=hundred|thousand|million|billion|trillion) and (?:${NUMBER_WORD}))*`;

type Kind = "unit" | "teen" | "tens" | "hundred" | "scale";
const kindOf = (each: string): Kind =>
  each === "hundred"
    ? "hundred"
    : SCALES.has(each)
      ? "scale"
      : TENS.has(each)
        ? "tens"
        : (UNITS.get(each) ?? 0) >= 10
          ? "teen"
          : "unit";

/** Whether `next` goes on the number `last` ended with, as "twenty" goes before "eight" and "eight" before "hundred". */
function goesOn(last: Kind | null, next: Kind): boolean {
  if (last === null || last === "scale") return true;
  if (last === "tens") return next === "unit" || next === "hundred" || next === "scale";
  if (last === "unit" || last === "teen") return next === "hundred" || next === "scale";
  return next !== "hundred";
}

interface Figure {
  value: number;
  /** The one million, billion or trillion the number ends with, kept as a word: "18.4 million". */
  word: string | null;
  scaled: boolean;
  /** The number words are exactly "one" to "nine", which running speech uses as words. */
  small: boolean;
  /** Which of the words it starts at. */
  from: number;
}

/** The one number that `words[from]` to `words[to - 1]` say. */
function figureOf(words: readonly string[], from: number, to: number): Figure {
  let total = 0;
  let current = 0;
  let scales = 0;
  for (const each of words.slice(from, to)) {
    const kind = kindOf(each);
    if (kind === "hundred") current = (current || 1) * 100;
    else if (kind === "scale") {
      total += (current || 1) * (SCALES.get(each) ?? 1);
      current = 0;
      scales++;
    } else current += TENS.get(each) ?? UNITS.get(each) ?? 0;
  }
  const end = words[to - 1] ?? "";
  return {
    value: total + current,
    word: scales === 1 && (SCALES.get(end) ?? 0) >= 1e6 ? end : null,
    scaled: scales > 0,
    small: to - from === 1 && kindOf(end) === "unit" && total + current < 10,
    from,
  };
}

/**
 * The numbers a run of number words says, in turn: "four hundred twelve" is one, "four five" is
 * two. A number takes every word that can go on with it and still leave the next number a start:
 * "three hundred fifty four hundred" is 350 and 400.
 */
export function figuresOf(words: readonly string[]): Figure[] {
  const out: Figure[] = [];
  let from = 0;
  let last: Kind | null = null;
  // Of the number being read: whether it has a "hundred" since its last scale, and that scale.
  let hundred = false;
  let scale = 0;
  for (let at = 0; at < words.length; at++) {
    const each = words[at] ?? "";
    const kind = kindOf(each);
    // A second "hundred", or a scale no smaller than the last, is another number's, with the word
    // or two it multiplies: "three hundred four hundred" is 300 and 400, and "two thousand three
    // hundred thousand" 2,000 and 300,000.
    const another =
      (kind === "hundred" && hundred) ||
      (kind === "scale" && scale > 0 && (SCALES.get(each) ?? 0) >= scale);
    const twoBack = kindOf(words[at - 2] ?? "hundred");
    const multiplied =
      last === "scale"
        ? 0
        : last === "hundred" && twoBack !== "hundred" && twoBack !== "scale"
          ? 2
          : 1;
    const start = !goesOn(last, kind) ? at : another ? at - multiplied : from;
    if (start > from) {
      out.push(figureOf(words, from, start));
      from = start;
      last = null;
      hundred = false;
      scale = 0;
      at = start - 1;
      continue;
    }
    if (kind === "hundred") hundred = true;
    else if (kind === "scale") {
      scale = SCALES.get(each) ?? 0;
      hundred = false;
    }
    last = kind;
  }
  if (words.length > from) out.push(figureOf(words, from, words.length));
  return out;
}

export function wholeNumberWords(text: string): number | null {
  if (!new RegExp(`^${INTEGER_WORDS}$`, "i").test(text)) return null;
  const figures = figuresOf(
    text
      .toLowerCase()
      .split(/[ -]+/)
      .filter((each) => each !== "and"),
  );
  const value = figures.length === 1 ? figures[0]?.value : undefined;
  return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}
