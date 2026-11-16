/**
 * Whether the User's own words ask for all of what a reply takes out (#2333, #3178). An edit in
 * the User's words that quotes whole paragraphs as taken out is the User's wish only when their
 * words name all of that text: "Delete the second paragraph", 把第二段删掉, never "Make it
 * shorter", 把它改短一些, nor "Delete the sentence about the ferry" when the paragraph the model
 * took out holds more than that sentence. The words can't tell these apart for code, in English or
 * Chinese, so the model that the User chose for small calls is asked, once, with the request and
 * the paragraphs taken out, and only when a reply quotes a whole paragraph. A failure to ask or to
 * decide counts as no: the removal then waits for the User, never applies on no answer.
 */
import { jsonSchema } from "ai";
import { fieldsOf, judge, structured, word } from "../answers/judge";
import type { PromptTag } from "../promptData";
import type { ChatLanguageModel } from "../providers/models";

/** How long the question may take before the removal waits for the User. */
export const REMOVAL_ASKED_TIME_LIMIT_MS = 20_000;

/**
 * The most characters of the paragraphs taken out that the question is shown. More than that waits
 * for the User unasked: an answer about the text shown can't speak for text that isn't.
 */
export const TAKEN_OUT_SHOWN = 6_000;

export const REMOVAL_ASKED_INSTRUCTIONS = [
  "You read a request a User wrote about a passage of their own Note, in English or Chinese. It is between <question> and </question>. An edit took out the text between <taken-out> and </taken-out>. Say whether the request asks for all of what was taken out: whether every part of that text is something the request asks to remove or replace.",
  "When a paragraph taken out starts with its place in the passage, ¶1 being its first paragraph, a request that names a paragraph by its number is matched to its place.",
  'Reply "yes" when all of the text taken out is within what the request names: that paragraph, section or list item, everything in the selection, a part or bit about a topic when the text taken out is about that topic, a sentence or line when that sentence or line is all the text taken out, or text to be replaced by something else (the request may name more than was taken out); however it asks: as an order, as a polite question, as a remark, or together with other changes.',
  'Reply "no" when some of the text taken out is not named by the request: it names one sentence, some words or one item of several, and more was taken out; it names something the text does not hold; or it asks only to change text that stays: to shorten, tighten, simplify, improve, reword, correct, translate, reformat or summarise it. Making text shorter or clearer is not taking text out.',
  "When in doubt, reply no.",
  'Reply with one JSON object: {"asks_for_all":"no"}.',
].join("\n");

const TAGS: readonly PromptTag[] = ["question", "taken-out"];

const schema = jsonSchema<{ asks_for_all: "yes" | "no" }>({
  type: "object",
  properties: { asks_for_all: { type: "string", enum: ["yes", "no"] } },
  required: ["asks_for_all"],
});

const verdict = word("yes", "no");

export const removalAskedReply = structured(
  schema,
  "removal",
  (value) => fieldsOf(value, { asks_for_all: verdict })?.asks_for_all ?? null,
);

/**
 * True only when the model readably says the request asks to take out all of `taken`, the
 * paragraphs taken out one to a line, each starting with its place. False without asking when
 * they are more than the question shows.
 */
export async function asksForAll(
  model: ChatLanguageModel,
  request: string,
  taken: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  const shown = taken.join("\n");
  if ([...shown].length > TAKEN_OUT_SHOWN) return false;
  const judged = await judge({
    model,
    question: { id: "removal-asked", instructions: REMOVAL_ASKED_INSTRUCTIONS },
    parts: [
      { tag: "question", text: request },
      { tag: "taken-out", text: shown },
    ],
    data: TAGS,
    reply: removalAskedReply,
    retries: 0,
    signal,
    timeoutMs: REMOVAL_ASKED_TIME_LIMIT_MS,
  });
  if (judged.ok) return judged.value === "yes";
  if (judged.reason !== "stopped") {
    console.error(
      `Whether an edit's request asks to take out all it took out wasn't decided: ${judged.error?.message ?? `the reply was ${judged.reason}`}`,
    );
  }
  return false;
}
