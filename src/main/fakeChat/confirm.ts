/**
 * A claim check that finds a sentence unsupported judges the nearest line it read: another
 * number in it than the sentence's means it says something different (#770).
 */

import { type GenerateOptions, lastUserText, systemOf } from "./prompt";

/** The request to confirm a contradiction, judge the nearest line, or judge a record cite. */
const CONFIRM_RUN = /^Compare a sentence the User wrote with words quoted from a Passage/m;
const RECORD_RUN = /^Compare a sentence the User wrote with the exact Passage a record cite names/m;

/**
 * The scripted judgement of a sentence beside the words quoted from a Passage: they conflict
 * when the sentence has a number the quote doesn't while the quote has numbers, else they are
 * the same.
 */
export function fakeConfirm(options: GenerateOptions): string | null {
  const system = systemOf(options.prompt);
  if (!CONFIRM_RUN.test(system) && !RECORD_RUN.test(system)) return null;
  const text = lastUserText(options.prompt);
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(text)?.[1] ?? "";
  const quote = /<quote>\n([\s\S]*?)\n<\/quote>/.exec(text)?.[1] ?? "";
  const numbers = (value: string): string[] => value.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const quoted = numbers(quote);
  return quoted.length > 0 && numbers(sentence).some((each) => !quoted.includes(each))
    ? "conflict"
    : "same";
}
