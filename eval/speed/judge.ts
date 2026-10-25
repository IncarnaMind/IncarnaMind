/**
 * Whether an Answer is right, as a model judges it against the words its Question's expected
 * Passages hold and the set's short answer: one word, so the two arms of a paired run are graded
 * the same way.
 */
import { generateText, type LanguageModel } from "ai";

export type Grade = "right" | "partly" | "wrong" | "unread";

export interface Expectation {
  question: string;
  /** The words of each Passage the answer rests on; none: the Documents don't answer it. */
  quotes: readonly string[];
  /** A short answer, when the set gives one. */
  answer?: string;
  /** What the Question takes for granted that the Documents don't say. */
  premise?: string;
}

const INSTRUCTIONS = [
  "You grade an Answer to a Question about the User's Documents, from what the Documents say.",
  "<expected> holds the Documents' own words the answer rests on, and a short answer when there is one.",
  "Reply with one word and nothing else: right when the Answer gives what <expected> says, in any wording or language; partly when it gives only some of it, or adds something <expected> contradicts; wrong when it gives something else, or misses it.",
  "When <expected> says the Documents don't answer the Question, or that the Question takes something for granted, the Answer is right only when it says so and doesn't answer from elsewhere.",
].join("\n");

export async function gradeAnswer(
  model: LanguageModel,
  expected: Expectation,
  answer: string,
): Promise<Grade> {
  const { text } = await generateText({
    model,
    instructions: INSTRUCTIONS,
    prompt: [
      `<question>${expected.question}</question>`,
      "<expected>",
      ...(expected.quotes.length === 0
        ? ["The Documents don't answer this Question."]
        : expected.quotes.map((quote) => `- “${quote}”`)),
      ...(expected.answer ? [`Short answer: ${expected.answer}`] : []),
      ...(expected.premise
        ? [`The Question takes for granted, and the Documents don't say: ${expected.premise}`]
        : []),
      "</expected>",
      "<answer>",
      answer,
      "</answer>",
      "Grade the Answer: right, partly or wrong? Reply with that one word.",
    ].join("\n"),
    maxOutputTokens: 400,
    maxRetries: 1,
  });
  // A judge that reasons first gives its grade last.
  const word = text
    .toLowerCase()
    .match(/\b(?:right|partly|wrong)\b/g)
    ?.at(-1);
  if (word === "right" || word === "partly" || word === "wrong") return word;
  console.error(`The judge's grade couldn't be read: ${text.slice(0, 200)}`);
  return "unread";
}
