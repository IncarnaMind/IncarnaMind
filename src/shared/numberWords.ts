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
}

/** The numbers a run of number words says: "four hundred twelve" is one, "four five" is two. */
export function figuresOf(words: readonly string[]): Figure[] {
  const out: Figure[] = [];
  let total = 0;
  let current = 0;
  let last: Kind | null = null;
  let scaled = false;
  let count = 0;
  let scales = 0;
  let lastScale = "";
  const close = () => {
    if (count > 0) {
      out.push({
        value: total + current,
        word:
          scales === 1 && last === "scale" && (SCALES.get(lastScale) ?? 0) >= 1e6
            ? lastScale
            : null,
        scaled,
        small: count === 1 && last === "unit" && total + current < 10,
      });
    }
    total = 0;
    current = 0;
    last = null;
    scaled = false;
    count = 0;
    scales = 0;
  };
  for (const each of words) {
    const kind = kindOf(each);
    if (!goesOn(last, kind)) close();
    if (kind === "hundred") current = (current || 1) * 100;
    else if (kind === "scale") {
      total += (current || 1) * (SCALES.get(each) ?? 1);
      current = 0;
      scaled = true;
      scales++;
      lastScale = each;
    } else current += TENS.get(each) ?? UNITS.get(each) ?? 0;
    last = kind;
    count++;
  }
  close();
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
