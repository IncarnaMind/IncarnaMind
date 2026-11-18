/**
 * A record cite's judgement (#1709): the sentence is unsupported by the exact Passage the cite
 * names when it has a number the Passage's quote doesn't while the quote has numbers, else
 * supported.
 */

import { type GenerateOptions, lastUserText, systemOf } from "./prompt";

const RECORD_RUN = /^Compare a sentence the User wrote with the exact Passage a record cite names/m;

const numbers = (value: string): string[] => value.match(/\d+(?:[.,]\d+)?/g) ?? [];

export function fakeRecordJudgement(options: GenerateOptions): string | null {
  if (!RECORD_RUN.test(systemOf(options.prompt))) return null;
  const text = lastUserText(options.prompt);
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(text)?.[1] ?? "";
  const quote = /<quote>\n([\s\S]*?)\n<\/quote>/.exec(text)?.[1] ?? "";
  const quoted = numbers(quote);
  const differs = quoted.length > 0 && numbers(sentence).some((each) => !quoted.includes(each));
  return `Judgement: ${differs ? "unsupported" : "supported"}`;
}
