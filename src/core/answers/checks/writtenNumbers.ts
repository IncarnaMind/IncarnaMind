/**
 * Whether each number a sentence writes is in a Passage as written, digit for digit once
 * thousands separators are taken out (#3118). The one test of numbers made in code: anything else
 * about an amount (another form, scale, unit or period) is asked of the decision model.
 */

/**
 * A number: digits grouped in threes by a separator (so "in 2023 12 rose" stays two numbers), or a
 * plain run of digits, with an optional decimal part.
 */
const NUMBER = /(?:\d{1,3}(?:[,，'’\u2009\u202f _]\d{3}(?!\d))+|\d+)(?:\.\d+)?/gu;

/** Thousands separators: commas (also full-width), apostrophes and thin or plain spaces between digits. */
const SEPARATORS = /[,，'’\u2009\u202f _]/gu;

const digitStrings = (text: string): string[] =>
  [...text.normalize("NFKC").matchAll(NUMBER)].map((match) => match[0].replace(SEPARATORS, ""));

/** The sentence's numbers, as it writes them, that the Passage doesn't write as its own numbers. */
export function numbersNotWritten(sentence: string, passage: string): string[] {
  const written = new Set(digitStrings(passage));
  const missing: string[] = [];
  for (const match of sentence.normalize("NFKC").matchAll(NUMBER)) {
    const digits = match[0].replace(SEPARATORS, "");
    if (!written.has(digits) && !missing.includes(match[0].trim())) missing.push(match[0].trim());
  }
  return missing;
}
