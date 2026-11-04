/**
 * A claim check that finds a sentence unsupported judges the nearest line it read: another
 * number in it than the sentence's means it says something different (#770). Rewrite with what
 * the Documents say (#1554) changes the sentence's first number the line doesn't write to the
 * line's first.
 */

import { type GenerateOptions, lastUserText, systemOf } from "./prompt";

/** The request to confirm a contradiction, judge the nearest line, or judge a record cite. */
const CONFIRM_RUN = /^Compare a sentence the User wrote with words quoted from a Passage/m;
const RECORD_RUN = /^Compare a sentence the User wrote with the exact Passage a record cite names/m;
/** The request for a rewrite with what the Documents say. */
const REWRITE_RUN =
  /^A sentence the User wrote gives another value for something than words quoted/m;
/** A look at the quote a whole read's window gives for what a sentence says is absent. */
const PRESENCE_RUN = /^A sentence the User wrote says something is absent from their Documents/m;

const numbers = (value: string): string[] => value.match(/\d+(?:[.,]\d+)?/g) ?? [];

/** The scripted rewrite: the sentence's first number the quote doesn't write, as the quote's first. */
export function fakeRewrite(options: GenerateOptions): string | null {
  if (!REWRITE_RUN.test(systemOf(options.prompt))) return null;
  const text = lastUserText(options.prompt);
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(text)?.[1] ?? "";
  const quote = /<quote>\n([\s\S]*?)\n<\/quote>/.exec(text)?.[1] ?? "";
  const quoted = numbers(quote);
  const from = numbers(sentence).find((each) => !quoted.includes(each));
  const to = quoted[0];
  return from && to ? `Change 1: ${from}\nTo 1: ${to}` : "Change 1: none\nTo 1: none";
}

/**
 * The scripted judgement of a sentence beside the words quoted from a Passage: they conflict
 * when the sentence has a number the quote doesn't while the quote has numbers, else they are
 * the same.
 */
export function fakeConfirm(options: GenerateOptions): string | null {
  const system = systemOf(options.prompt);
  // The scripted whole read quotes only the clause itself.
  if (PRESENCE_RUN.test(system)) return "Judgement: there";
  const record = RECORD_RUN.test(system);
  if (!CONFIRM_RUN.test(system) && !record) return null;
  const text = lastUserText(options.prompt);
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(text)?.[1] ?? "";
  const quote = /<quote>\n([\s\S]*?)\n<\/quote>/.exec(text)?.[1] ?? "";
  const quoted = numbers(quote);
  const differs = quoted.length > 0 && numbers(sentence).some((each) => !quoted.includes(each));
  if (record) return `Judgement: ${differs ? "unsupported" : "supported"}`;
  return differs ? "conflict" : "same";
}
