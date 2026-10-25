/**
 * A comparison table's cell (#98) cites its Document's line that shares the
 * most words with the Question and answers with its value ("Termination
 * notice: 90 days." gives "90 days"), or NOT_FOUND when no line shares one;
 * a cell whose Question says "busy" is refused with an HTTP 429 the first time,
 * and one whose Question says "rescaled" writes thousands as millions, as a
 * careless model does (#1798), even when told the scale changed.
 */

import { passagesIn, recordFor } from "./passages";
import { type Prompt, type Reply, toolResults, userText } from "./prompt";

const CELL = "one cell of a comparison table";

// A cell told its amount changed scale has that note as its last user message, after its Question's.
const cellMessage = (prompt: Prompt) =>
  prompt
    .filter((message) => message.role === "user")
    .map(userText)
    .find((text) => text.includes(CELL)) ?? null;

/** A comparison table's cell (#98) says so before its Question. */
export const isCell = (prompt: Prompt) => cellMessage(prompt) !== null;

/**
 * A cell: the line of its Document that shares the most words with the
 * Question, cited, then its value ("Termination notice: 90 days." gives "90
 * days"); NOT_FOUND when no line shares a word.
 */
export function cellReply(prompt: Prompt): Reply {
  const question = cellMessage(prompt)?.split("\n\n").at(-1) ?? "";
  const searches = toolResults(prompt, "search_documents");
  if (searches.length === 0) return { tool: "search_documents", input: { query: question } };
  let best: { record: Record<string, unknown>; shared: number } | null = null;
  for (const passage of passagesIn(searches.at(-1) ?? "")) {
    const found = recordFor(passage, question, 1);
    if (found && (!best || found.shared > best.shared)) best = found;
  }
  if (!best || best.shared === 0) return { text: "NOT_FOUND" };
  if (toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [best.record] } };
  }
  const quote = String(best.record.quote);
  const value = (quote.split(": ")[1] ?? quote).replace(/[.。]$/, "");
  const written = /\brescaled\b/i.test(question) ? value.replace("thousands", "million") : value;
  return { text: `${written} [^1]` };
}
