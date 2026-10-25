/**
 * What a comparison table's cell asks its model (#98): the column's Question,
 * framed as one cell of a table about one Document. The framing goes before
 * the Question in the User's message, so the Question alone is what a model
 * without Tools searches for and what decides the Answer's language.
 */

import type { QuestionContext } from "../answers/context";
import type { MarkedCitation } from "../api";

/** What a cell's model replies when its Document doesn't answer the Question. */
export const NOT_FOUND = "NOT_FOUND";

export function cellContext(
  question: string,
  documentName: string,
  instruction: string | null,
): QuestionContext {
  const framing = [
    `This is one cell of a comparison table: its row is the Document "${documentName}", its column the Question below. Answer from that Document alone.`,
    "- Answer the way a table's cell holds a value: the figure, period, date, name or short phrase alone (a few words, like a period of notice given as its length), then its citation marker. No preamble, no conditions or who it applies to unless they change the answer, and no sentence around it.",
    '- Write a negative amount as the Document does: "(12,500)" is negative, so it stays in brackets in the cell.',
    '- Write each amount with the currency and scale its Document states for it ("GBP 310 million", "3.1亿元", not a bare "310,000"); never add a currency or scale the Document doesn\'t state.',
    `- If the Document doesn't answer the Question, reply with exactly ${NOT_FOUND} and nothing else.`,
    ...(instruction ? [`- The User asked the table to show this too: ${instruction}`] : []),
  ].join("\n");
  return { messages: [{ role: "user", content: `${framing}\n\n${question}` }], question };
}

/**
 * Whether a cell's reply says its Document doesn't answer: `NOT_FOUND`, or
 * an Answer with no Citation, which a comparison table of cited Answers can't show.
 */
export function saysNotFound(markdown: string, citations: readonly MarkedCitation[]): boolean {
  return citations.length === 0 || isNotFoundReply(markdown);
}

/** The reply is `NOT_FOUND` alone: "NOT_FOUND", "Not found.", "**NOT FOUND**" [^1]… */
export function isNotFoundReply(markdown: string): boolean {
  return markdown.replace(/\[\^\d+\]|[\s*_`"'“”.。!！-]/g, "").toUpperCase() === "NOTFOUND";
}

// Streaming keeps a marker at the end of the text out of the Blocks, so the text itself says whether a reply cites.
export const hasMarker = (markdown: string): boolean => /\[\^\d{1,4}\]/.test(markdown);
