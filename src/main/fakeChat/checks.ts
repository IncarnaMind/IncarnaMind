/**
 * Check against Documents (`checkReply`): a sentence that shares three words with a Passage's line
 * is supported, or contradicted when it has a number the line doesn't while the line has numbers;
 * otherwise unsupported. It replies as a check's Run asks (src/core/answers/checks/prompt.ts).
 */

import { SEARCH_AGAIN } from "../../core/answers/checks/claimCheck";
import { restateInstructions } from "../../core/answers/checks/explanations";
import { sentenceBatchInstructions } from "../../core/answers/checks/sentenceBatch";
import { LANGUAGES } from "../../core/language";
import { outputTokens } from "../../core/providers/outputLimits";
import { LISTED_PROJECTS, LISTS_PROJECTS, SAYS_MORE, THOUGHT_OVER, UNCITED_CLAIM } from "./answers";
import { SAYS_A_VIEW } from "./claims";
import { passagesIn, recordFor } from "./passages";
import {
  type GenerateOptions,
  lastUserText,
  type Prompt,
  type Reply,
  systemOf,
  toolResults,
  userText,
} from "./prompt";

/** A check Run's instructions (#96, src/core/answers/checks/prompt.ts). */
export const CHECK_RUN = /^You check one sentence of the User's Note against the User's Documents/m;

/** Words that decide a check: those of four letters or more, and every number. */
const checkWords = (text: string): string[] => [
  ...(text.toLowerCase().match(/[a-z]{4,}|\d+(?:[.,]\d+)?/g) ?? []),
];

const numbers = (text: string): string[] => text.match(/\d+(?:[.,]\d+)?/g) ?? [];

/**
 * A batch of an Answer's sentences (#2311): each supported by what it cites, as the scripted
 * Answers keep to their quotes, but one that says more than its quote (`BEYOND_ITS_QUOTE`) and one
 * that lists projects its one Citation doesn't name (`LISTS_PROJECTS`, #2809). Of the sentences the
 * Answer cited nothing in (#3410), only the claim no Passage backs (`UNCITED_CLAIM`) gets an
 * entry, not found; the others none, so none of them is marked.
 */
export function fakeSentenceBatch(options: GenerateOptions): string | null {
  const language = LANGUAGES.find((each) =>
    [false, true].some((calls) =>
      [false, true].some(
        (uncited) => systemOf(options.prompt) === sentenceBatchInstructions(each, calls, uncited),
      ),
    ),
  );
  if (!language) return null;
  const chinese = language === "zh-CN";
  const prompt = lastUserText(options.prompt);
  const sentences = [...prompt.matchAll(/<sentence number="(\d+)">\n([\s\S]*?)\n<\/sentence>/g)];
  const uncited = [
    ...prompt.matchAll(/<sentence number="(\d+)" uncited="true">\n([\s\S]*?)\n<\/sentence>/g),
  ].filter(([, , sentence = ""]) => UNCITED_CLAIM.test(sentence));
  return JSON.stringify({
    sentences: [
      ...uncited.map(([, number]) => ({
        number: Number(number),
        kind: "fact",
        verdict: "not found",
        roles: "same",
        time: "same",
        quoted: "other",
        says: chinese
          ? "文档没有写这里的潮水涨多高。"
          : "The Documents don't say how high the tides rise here.",
      })),
      ...sentences.map(([, number, sentence = ""]) => {
        const beyond = SAYS_MORE.test(sentence);
        const lists = LISTS_PROJECTS.test(sentence);
        return {
          number: Number(number),
          kind: "fact",
          verdict: beyond || lists ? "unsupported" : "supported",
          roles: "same",
          time: beyond ? "differs" : "same",
          quoted: "states",
          says: lists
            ? chinese
              ? "引文只提到了其中一个项目。"
              : "The quote names one of the projects, not the others."
            : beyond
              ? chinese
                ? "文档写的是什么时候发生，没有说已经完成。"
                : "The Document says when it happens, not that it is already done."
              : chinese
                ? "文档是这样写的。"
                : "The Document says so.",
        };
      }),
    ],
  });
}

/**
 * Whether a batch's reply reaches its room (#2962): its sentences were thought over, and a limit
 * kept its room below the room for thinking, which they need whole.
 */
export function thinksPastItsRoom(options: GenerateOptions): boolean {
  if (fakeSentenceBatch(options) === null) return false;
  const prompt = lastUserText(options.prompt);
  if (!THOUGHT_OVER.test(prompt)) return false;
  const sentences = [...prompt.matchAll(/<sentence number="\d+">/g)].length;
  return (
    (options.maxOutputTokens ?? Number.POSITIVE_INFINITY) <
    outputTokens("sentence-batch", sentences)
  );
}

/**
 * A check's explanation asked for again in the interface's language (#2081): the scripted model
 * writes no other language, so it quotes the sentence it was given inside one of its own.
 */
export function fakeRestate(options: GenerateOptions): string | null {
  const language = LANGUAGES.find((each) => systemOf(options.prompt) === restateInstructions(each));
  if (!language) return null;
  const said = /<reply>\n([\s\S]*?)\n<\/reply>/.exec(lastUserText(options.prompt))?.[1] ?? "";
  return language === "zh-CN" ? `文档写的是：“${said}”` : `The Document says: “${said}”`;
}

const UNSUPPORTED: Reply = { text: "Verdict: unsupported\nEvidence: []" };
const OWN_VIEW: Reply = { text: "Verdict: own view\nEvidence: []" };

/** A sentence that says more than the line it shares its words with: read whole, it is unsupported. */
const SAYS_MORE_THAN_ITS_LINE = /\bscaling constraint\b/;

const supported = (explanation: string): Reply => ({
  text: `Verdict: supported\nExplanation: ${explanation}\nEvidence: [1]`,
});

/**
 * The figures IncarnaMind worked out itself that a check's message gives with its sentence: the
 * numbers they show, and their inputs' numbers and the quotes those come from.
 */
function workedOut(message: string): { shown: string[]; inputs: string[]; quotes: string[] } {
  const block = /<figures>\n([\s\S]*?)\n<\/figures>/.exec(message)?.[1];
  const figures: unknown = block ? JSON.parse(block) : [];
  const worked = { shown: [] as string[], inputs: [] as string[], quotes: [] as string[] };
  if (!Array.isArray(figures)) return worked;
  for (const figure of figures as {
    shown?: string;
    saved?: { inputs?: { number?: { chars?: string }; citation?: { quote?: string } }[] };
  }[]) {
    worked.shown.push(...numbers(figure.shown ?? ""));
    for (const input of figure.saved?.inputs ?? []) {
      if (input.number?.chars) worked.inputs.push(input.number.chars);
      if (input.citation?.quote) worked.quotes.push(input.citation.quote);
    }
  }
  return worked;
}

/**
 * A check of one sentence (#96): it searches for the sentence, then takes the Passage line that
 * shares the most words with it, among equals the one with the sentence's numbers, and cites it. Three shared words or more support it, unless the
 * sentence has a number the line doesn't while the line has numbers: that contradicts it, and the
 * sentence's first such number changes to the line's first. Fewer leave it unsupported, as does a
 * sentence that says more than its line (`SAYS_MORE_THAN_ITS_LINE`); one it takes for its writer's
 * own view (`SAYS_A_VIEW`) is that instead. One whose every number IncarnaMind worked out itself
 * searches for its figures' inputs and is supported by the line that holds them all. A sentence
 * with "blank reply" gets an empty reply, one with "refuse" a refusal, and one with "no reason" an
 * unsupported verdict. Asked to search again before it says a sentence isn't found, it searches the sentence's
 * longer words and numbers alone.
 */
export function checkReply(prompt: Prompt): Reply {
  // The sentence is in the first message: the check may have been asked to search again since.
  const first = userText(prompt.find((message) => message.role === "user"));
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(first)?.[1] ?? "";
  if (/blank reply/i.test(sentence)) return { text: "" };
  if (/\brefuse\b/i.test(sentence)) return { text: "I'm sorry, I can't help with that." };
  // Each number IncarnaMind worked out is taken as right, as the check asks; a sentence of only
  // such numbers rests on the line its figures' inputs are quoted from.
  const worked = workedOut(first);
  const own = numbers(sentence);
  const ownFigures =
    worked.inputs.length > 0 && own.length > 0 && own.every((each) => worked.shown.includes(each));
  const searches = toolResults(prompt, "search_documents");
  const searched = searches.at(-1);
  if (searched === undefined)
    return {
      tool: "search_documents",
      input: { query: ownFigures ? worked.quotes.join(" ") : sentence },
    };
  const cited = toolResults(prompt, "cite").length > 0;
  if (ownFigures) {
    const holdsInputs = (line: string) => worked.inputs.every((input) => line.includes(input));
    const record = passagesIn(searched)
      .map((passage) => recordFor(passage, sentence, 1, holdsInputs)?.record)
      .find((each) => typeof each?.quote === "string" && holdsInputs(each.quote));
    if (!record) return UNSUPPORTED;
    if (!cited) return { tool: "cite", input: { citations: [record] } };
    return supported("The Document's numbers give these figures [^1].");
  }
  if (searches.length === 1 && lastUserText(prompt).includes(SEARCH_AGAIN)) {
    return { tool: "search_documents", input: { query: checkWords(sentence).join(" ") } };
  }
  // A listed project named in Chinese has no words the count below reads: the Passage line that
  // holds its name supports it (#2809).
  const named = LISTED_PROJECTS["zh-CN"].held.find((each) => sentence.includes(each));
  if (named) {
    const holding = passagesIn(searched).find((passage) => passage.text.includes(named));
    const record = holding && recordFor(holding, sentence, 1, (line) => line.includes(named));
    if (!record) return UNSUPPORTED;
    if (!cited) return { tool: "cite", input: { citations: [record.record] } };
    return supported("文档是这样写的 [^1]。");
  }
  if (/\bno reason\b/i.test(sentence) || SAYS_MORE_THAN_ITS_LINE.test(sentence)) return UNSUPPORTED;
  const words = checkWords(sentence);
  // Lines that differ only in their numbers ("Revenue in Q2 was €2 million.") tie on words: the
  // one with the sentence's own numbers is the line it is about, as a model reading it whole takes.
  const sameNumbers = (line: string) =>
    numbers(sentence).some((number) => numbers(line).includes(number));
  let best: { record: Record<string, unknown>; line: string; shared: number } | null = null;
  for (const passage of passagesIn(searched)) {
    const found = recordFor(passage, sentence, 1, sameNumbers);
    const line = typeof found?.record.quote === "string" ? found.record.quote : "";
    const shared = checkWords(line).filter((word) => words.includes(word)).length;
    if (found && (!best || shared > best.shared)) best = { record: found.record, line, shared };
  }
  if (!best || best.shared < 3) return SAYS_A_VIEW.test(sentence) ? OWN_VIEW : UNSUPPORTED;
  if (!cited) return { tool: "cite", input: { citations: [best.record] } };
  const lineNumbers = numbers(best.line);
  const from = numbers(sentence).find((each) => !lineNumbers.includes(each));
  const to = lineNumbers[0];
  if (!from || !to) return supported("The Document says so [^1].");
  return {
    text: [
      "Verdict: contradicted",
      `Explanation: The Document says: ${best.line} [^1]`,
      "Evidence: [1]",
      `Change 1: ${from}`,
      `To 1: ${to} [^1]`,
    ].join("\n"),
  };
}
