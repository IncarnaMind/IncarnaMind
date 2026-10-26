/**
 * Check against Documents (`checkReply`): a sentence that shares
 * three words with a Passage's line is supported, or contradicted when it has a
 * number the line doesn't; otherwise unsupported. A sentence the User cites a
 * quote for that `PARTLY` lists, or one with no Citation that `PARTLY_UNCITED`
 * lists, is unsupported and says what the quote covers and what it doesn't.
 * Offered calculate, a sentence that states a multiple ("1.1x") has it worked
 * out as the line's first number over its second (#707).
 */

import { SEARCH_AGAIN } from "../../core/answers/checks/searchAgain";
import { passagesIn, recordFor } from "./passages";
import { lastUserText, type Prompt, type Reply, toolResults, userText } from "./prompt";

/** A check Run's instructions (#96, src/core/answers/checks/prompt.ts). */
export const CHECK_RUN = /^You check one sentence the User wrote against the User's Documents/m;

/** Words that decide a check: those of four letters or more, and every number. */
const checkWords = (text: string): string[] => [
  ...(text.toLowerCase().match(/[a-z]{4,}|\d+(?:[.,]\d+)?/g) ?? []),
];

/**
 * Sentences the User cites a quote for that the scripted model finds partly
 * supported: what the quote covers, what it doesn't, and the sentence with
 * that part cut, as Cut the unsupported part writes it (./edit, #1111).
 */
export const PARTLY = [
  {
    when: /scaling constraint/,
    covered: "the harbour times",
    uncovered: "the scaling constraint",
    cut: "Harbours publish the times of high water every 12 months.",
  },
  {
    when: /memory needs/,
    covered: "the speed comparison",
    uncovered: "memory and robustness",
    cut: "Experiments usually show quasi-Newton methods are faster than gradient descent, and first-order methods are slower.",
  },
  {
    when: /内存需求/,
    covered: "速度比较",
    uncovered: "内存和鲁棒性",
    cut: "已有实验通常显示，拟牛顿方法比梯度下降更快，一阶优化方法速度较慢。",
  },
];

/**
 * Sentences with no Citation that the scripted model finds partly supported:
 * it records the line it read for them, then says what that line covers and
 * what it doesn't.
 */
export const PARTLY_UNCITED = [
  {
    when: /^Staff /,
    covered: "home working two days a week",
    uncovered: "staff in general",
  },
];

/**
 * A check of one sentence (#96): it searches for the sentence, then takes the
 * Passage line that shares the most words with it. Three shared words or more
 * support it, unless the sentence has a number the line doesn't while the
 * line has numbers: that contradicts it. Fewer leave it unsupported. A
 * sentence with "blank reply" gets an empty reply, one with "refuse" a refusal,
 * and one with "no reason" an unsupported verdict with no reason. Asked to
 * search again before it says a sentence isn't found, it searches the
 * sentence's longer words and numbers alone.
 * Offered calculate, a sentence that states a multiple has it worked out first.
 */
export function checkReply(prompt: Prompt, tools: readonly string[]): Reply {
  // The sentence is in the first message: the check may have been asked to search again since.
  const asked = userText(prompt.find((message) => message.role === "user"));
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(asked)?.[1] ?? "";
  if (/blank reply/i.test(sentence)) return { text: "" };
  if (/\brefuse\b/i.test(sentence)) return { text: "I'm sorry, I can't help with that." };
  const searches = toolResults(prompt, "search_documents");
  const searched = searches.at(-1);
  if (searched === undefined) return { tool: "search_documents", input: { query: sentence } };
  if (searches.length === 1 && lastUserText(prompt).includes(SEARCH_AGAIN)) {
    return { tool: "search_documents", input: { query: checkWords(sentence).join(" ") } };
  }
  const words = checkWords(sentence);
  let best: { record: Record<string, unknown>; line: string; shared: number } | null = null;
  for (const passage of passagesIn(searched)) {
    const found = recordFor(passage, sentence, 1);
    const line = typeof found?.record.quote === "string" ? found.record.quote : "";
    const shared = checkWords(line).filter((word) => words.includes(word)).length;
    if (found && (!best || shared > best.shared)) best = { record: found.record, line, shared };
  }
  if (/\bno reason\b/i.test(sentence)) return { text: "Verdict: unsupported" };
  const cited = /^The User cites this for it/m.test(asked);
  const partly = cited
    ? PARTLY.find((each) => each.when.test(sentence))
    : PARTLY_UNCITED.find((each) => each.when.test(sentence));
  if (partly && !cited && best && toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [best.record] } };
  }
  if (partly) {
    return {
      text: `Verdict: unsupported\nCovered: ${partly.covered}\nNot covered: ${partly.uncovered}`,
    };
  }
  if (!best || best.shared < 3) return { text: "Verdict: unsupported" };
  const lineNumbers = checkWords(best.line).filter((word) => /\d/.test(word));
  const contradicted =
    lineNumbers.length > 0 && words.some((word) => /\d/.test(word) && !lineNumbers.includes(word));
  if (toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [best.record] } };
  }
  const multiple = /\d+(?:\.\d+)?x\b/.exec(sentence)?.[0];
  if (tools.includes("calculate") && multiple && toolResults(prompt, "calculate").length === 0) {
    const inputs = [1, 2].map((position) => ({
      name: `n${position}`,
      label: position === 1 ? "First" : "Second",
      citation: 1,
      position,
    }));
    return {
      tool: "calculate",
      input: {
        figures: [
          {
            marker: 1,
            label: "Multiple",
            inputs,
            formula: "n1 / n2",
            as: "times",
            stated: multiple,
            relation: "equals",
          },
        ],
      },
    };
  }
  // The figure worked out is the only number the sentence has: the rest of it is supported.
  if (multiple && tools.includes("calculate")) {
    return { text: "Verdict: supported\nThe Document's figures give it [^1]." };
  }
  return {
    text: contradicted
      ? `Verdict: contradicted\nThe Document says: ${best.line} [^1]`
      : `Verdict: supported\nThe Document says so [^1].`,
  };
}
