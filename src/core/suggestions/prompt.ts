/**
 * What the model is asked for a suggestion, and how its reply is read: the
 * paragraph the User is writing, the Passages found for it, and back the
 * words to add, the Passage they rest on and a quote from it.
 */
import { jsonSchema } from "ai";
import { englishPlace } from "../../shared/locations";
import { normaliseText } from "../../shared/text";
import type { FoundPassage } from "../answers/citing";

/** The most words a suggestion may have, and the most CJK characters: one short sentence. */
export const MAX_WORDS = 30;
export const MAX_CJK_CHARACTERS = 60;
/** A reply longer than this, after its first sentence, is not taken: the model ignored the limit. */
const TOLERANCE = 1.5;

export const SUGGESTION_INSTRUCTIONS = [
  "You help the User write. They paused at the end of the paragraph they are writing. Suggest how it goes on, using only the Passages from their Documents below.",
  "- Your text is added right after the paragraph's last character. If the paragraph stops in the middle of a sentence, your text finishes that very sentence: read the sentence's start and your text together, and make sure they form one grammatical sentence (after “…the report found that”, a whole clause, such as “most delays came from one supplier.”; after “…调查发现，大多数居民”, the rest, such as “每天步行上班。”). If the paragraph ends with a full sentence, write the next one. Never repeat the paragraph's words.",
  `- One sentence at most: no more than ${MAX_WORDS} words, or ${MAX_CJK_CHARACTERS} Chinese characters.`,
  "- Write in the paragraph's language and tone, as the User would go on.",
  "- Rest it on one Passage, and say nothing that Passage doesn't say. Copy from it a short quote that supports what you wrote, character for character.",
  "- If no Passage supports a way on, give empty text.",
  'Reply with JSON only: {"text": the words to add after the paragraph, "passage": the id of the Passage, such as P1, "quote": the quote}.',
].join("\n");

/** A number as written: digits, with the points and commas between them. */
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** The numbers in a text, compared without thousands separators ("1,240,000" is 1240000). */
const numbersIn = (text: string) =>
  (normaliseText(text).match(NUMBER) ?? []).map((number) =>
    number.replace(/,(?=\d{3}(?!\d))/g, ""),
  );

/**
 * Whether every number in a suggestion is in its quote, or in the User's own
 * paragraph: the quote is found on the page, but nothing else checks the
 * words around it, and a figure the model got wrong would read as cited.
 */
export function numbersBacked(text: string, quote: string, paragraph: string): boolean {
  const backed = new Set([...numbersIn(quote), ...numbersIn(paragraph)]);
  return numbersIn(text).every((number) => backed.has(number));
}

/** The fewest characters a reply must repeat of the paragraph's end before they are taken off it. */
const MIN_OVERLAP = 8;

/**
 * The reply's words without the end of the paragraph they start with, when
 * the model repeated it (as models do, despite being told not to).
 */
export function continuationOf(paragraph: string, text: string): string {
  const end = paragraph.trimEnd().toLowerCase();
  const start = text.toLowerCase();
  for (let length = Math.min(end.length, start.length); length >= MIN_OVERLAP; length--) {
    if (end.endsWith(start.slice(0, length))) return text.slice(length).trim();
  }
  return text;
}

export interface SuggestionReply {
  text: string;
  passage: string;
  quote: string;
}

export const suggestionSchema = jsonSchema<SuggestionReply>({
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "The words to add after the paragraph; empty if no Passage supports any.",
    },
    passage: { type: "string", description: "The id of the Passage it rests on, such as P1." },
    quote: {
      type: "string",
      description: "A short quote from that Passage, copied character for character.",
    },
  },
  required: ["text", "passage", "quote"],
  additionalProperties: false,
});

const attribute = (value: string) => value.replace(/"/g, "'").replace(/\s+/g, " ");

/** The Passages' short ids, as the model sees them: P1, P2… in the order given. */
const passageHandle = (index: number) => `P${index + 1}`;

/** The request: the paragraph, then each Passage with its id, Document and Location. */
export function suggestionPrompt(paragraph: string, passages: readonly FoundPassage[]): string {
  const shown = passages.map((passage, index) => {
    const place = englishPlace(passage.location);
    const where = place ? ` location="${attribute(place)}"` : "";
    return `<passage id="${passageHandle(index)}" document="${attribute(passage.documentName)}"${where}>\n${passage.text}\n</passage>`;
  });
  // Named on its own, small models finish the sentence rather than start another.
  const unfinished = unfinishedSentence(paragraph);
  const task = unfinished
    ? `The paragraph's last sentence is unfinished: “${unfinished}”. Your text finishes it.`
    : "The paragraph ends with a full sentence. Your text is the next one.";
  return [`<paragraph>\n${paragraph}\n</paragraph>`, task, ...shown].join("\n\n");
}

/** The sentence a paragraph stops in the middle of, or "" when it ends with a full stop. */
export function unfinishedSentence(paragraph: string): string {
  const text = paragraph.trimEnd();
  if (/[.!?。！？]["'”’)）」]?$/u.test(text)) return "";
  return (text.split(/(?<=[.!?。！？])\s*/u).at(-1) ?? text).trim();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/** Where the first sentence ends: after its full stop, in English or Chinese. */
const FIRST_SENTENCE = /^[\s\S]*?(?:[。！？]|[.!?](?=\s|$|["'”’)）]))["'”’)）」]?/u;

/** How long a text is, as a suggestion's limit counts it: words, or CJK characters. */
function tooLong(text: string): boolean {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").split(/\s+/).filter(Boolean).length;
  return cjk > MAX_CJK_CHARACTERS * TOLERANCE || words > MAX_WORDS * TOLERANCE;
}

/**
 * The model's reply, read: the words (their first sentence, without quotation
 * marks around them), the index of the Passage it names among those given
 * ("P2", or "2"), and its quote. Null when it gives no words, names no
 * Passage it was given, or runs far past the limit.
 */
export function readReply(
  value: unknown,
  passageCount: number,
): { text: string; passage: number; quote: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { text, passage, quote } = value as Record<string, unknown>;
  if (typeof text !== "string" || typeof passage !== "string" || typeof quote !== "string") {
    return null;
  }
  const words = text
    .trim()
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
  // A "sentence" shorter than this is an abbreviation's full stop ("Dr.", "e.g."): kept whole.
  const first = FIRST_SENTENCE.exec(words)?.[0]?.trim();
  const sentence = first && first.length >= 12 ? first : words;
  if (sentence === "" || tooLong(sentence) || quote.trim() === "") return null;
  const number = /^\s*\[?\s*(?:passage\s*)?P?\s*(\d{1,3})\s*\]?\s*$/i.exec(passage)?.[1];
  const index = number === undefined ? -1 : Number(number) - 1;
  if (index < 0 || index >= passageCount) return null;
  return { text: sentence, passage: index, quote };
}
