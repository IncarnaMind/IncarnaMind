/**
 * The numbers a sentence writes, each as it writes it (#3118): what the decision model is asked
 * about before it backs the sentence. Whether a number is the Passage's amount (its form, scale,
 * unit and period) is the model's to say, never read in code.
 */

/**
 * A number: digits grouped in threes by a separator (so "in 2023 12 rose" stays two numbers), or a
 * plain run of digits, with an optional decimal part.
 */
const NUMBER = /(?:\d{1,3}(?:[,，'’\u2009\u202f _]\d{3}(?!\d))+|\d+)(?:\.\d+)?/gu;

export const numbersWritten = (sentence: string): string[] => [
  ...new Set([...sentence.normalize("NFKC").matchAll(NUMBER)].map((match) => match[0].trim())),
];
