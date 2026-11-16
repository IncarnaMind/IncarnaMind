/**
 * Whether the User's own words ask to take text out (#2333). An edit in the User's words that
 * quotes a whole paragraph as taken out is read as the User's wish only when their words ask for
 * it: "Delete the second paragraph", 把第二段删掉, never "Make it shorter", 把它改短一些。 A
 * model that quotes a paragraph for those would take the User's words out for a wish they never
 * had, and the words can't tell the two apart for code, in English or Chinese, so the model that
 * the User chose for small calls is asked, once, and only when a reply quotes a whole paragraph. A
 * failure to ask or to decide counts as no: the removal then waits for the User, never applies
 * on no answer.
 */
import { jsonSchema } from "ai";
import { fieldsOf, judge, structured, word } from "../answers/judge";
import type { PromptTag } from "../promptData";
import type { ChatLanguageModel } from "../providers/models";

/** How long the question may take before the removal waits for the User. */
export const REMOVAL_ASKED_TIME_LIMIT_MS = 20_000;

export const REMOVAL_ASKED_INSTRUCTIONS = [
  "You read a request a User wrote about a passage of their own Note, in English or Chinese. It is between <question> and </question>. Say whether the request asks to take text out of the passage.",
  'Reply "yes" when it asks to delete, remove, drop or cut out something that is there: a paragraph, a line, a sentence, a list item, a section or some words, however it asks: as an order, as a polite question, as a remark, or together with other changes.',
  'Reply "no" when it asks only to change text that stays: to shorten, tighten, simplify, improve, reword, correct, translate, reformat or summarise it. Making text shorter or clearer is not taking text out.',
  "When in doubt, reply no.",
  'Reply with one JSON object: {"asks_to_remove":"no"}.',
].join("\n");

const TAGS: readonly PromptTag[] = ["question"];

const schema = jsonSchema<{ asks_to_remove: "yes" | "no" }>({
  type: "object",
  properties: { asks_to_remove: { type: "string", enum: ["yes", "no"] } },
  required: ["asks_to_remove"],
});

const verdict = word("yes", "no");

export const removalAskedReply = structured(
  schema,
  "removal",
  (value) => fieldsOf(value, { asks_to_remove: verdict })?.asks_to_remove ?? null,
);

/** True only when the model readably says the request asks to take text out. */
export async function asksToRemove(
  model: ChatLanguageModel,
  request: string,
  signal: AbortSignal,
): Promise<boolean> {
  const judged = await judge({
    model,
    question: { id: "removal-asked", instructions: REMOVAL_ASKED_INSTRUCTIONS },
    parts: [{ tag: "question", text: request }],
    data: TAGS,
    reply: removalAskedReply,
    retries: 0,
    signal,
    timeoutMs: REMOVAL_ASKED_TIME_LIMIT_MS,
  });
  if (judged.ok) return judged.value === "yes";
  if (judged.reason !== "stopped") {
    console.error(
      `Whether an edit's request asks to take text out wasn't decided: ${judged.error?.message ?? `the reply was ${judged.reason}`}`,
    );
  }
  return false;
}
