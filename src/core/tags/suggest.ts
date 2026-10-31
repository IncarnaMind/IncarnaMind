/**
 * Tags named from what a Document says (#2308): the chat model chooses the Tags that exist where
 * they truly fit and names new ones where none does, with the rules both automatic tagging
 * (./classify) and Organize's chat model (../library/classifier) give it. Decision models only
 * answer yes or no for each Tag, so they keep choosing from the list.
 */
import { isRecord } from "../errors";

/** A Tag the model names for a Document, which no Tag in the list matched. */
export interface NewTag {
  name: string;
  description: string;
}

/** The most Tags automatic tagging gives one Document, chosen and new together. */
export const TAGS_PER_DOCUMENT = 3;

/** The most new Tags one Document brings. */
export const NEW_TAGS_PER_DOCUMENT = 2;

/** A new Tag's longest name, a Chinese character counting as two: "Kitchen renovation", "厨房装修". */
export const NEW_TAG_WIDTH = 32;

const NEW_TAG_DESCRIPTION = 200;

/**
 * Past this many live Tags no new one is made: the list the model reads stays short enough to
 * choose from, and the sidebar's Tags stay a vocabulary rather than one per Document.
 */
export const NEW_TAG_LIMIT = 60;

/** What the model is told about Tags, wherever it chooses them. */
export const TAG_RULES = [
  `Give the Document up to ${TAGS_PER_DOCUMENT} Tags that would help its owner find it again with others like it: what it is about (its topic, or the project or matter it belongs to) and, where one clearly applies, what kind of document it is.`,
  "Use an existing Tag only when its description truly fits the Document as a whole. A Tag for a kind of document fits only a document of that kind: a quote, an estimate, a price list, an order or a registration is not an invoice, and notes that mention prices are notes, not an invoice.",
  `When no existing Tag fits what the Document is about, name up to ${NEW_TAGS_PER_DOCUMENT} new Tags in newTags: each a short, general name of one to three words (a topic or project other Documents could share, not a sentence, a date, a person's name or the file's format), written in the language of the Document's text, with a one-line description of what belongs under it. Never name a new Tag that means the same as an existing one, in any language: use the existing one.`,
  "No Tag at all is fine when the excerpt says too little.",
].join("\n");

/** The schema of `newTags`, closed and fully required as every reply schema is. */
export const NEW_TAGS_SCHEMA = {
  type: "array",
  description: "New Tags, only where no existing Tag fits. May be empty.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "One to three words." },
      description: { type: "string", description: "One line: what belongs under this Tag." },
    },
    required: ["name", "description"],
    additionalProperties: false,
  },
} as const;

/** How wide a name reads: a character of a CJK script counts as two. */
const widthOf = (text: string) =>
  [...text].reduce(
    (width, character) =>
      width +
      (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
        ? 2
        : 1),
    0,
  );

/** A Latin word without its plural ending: "invoices" and "invoice", "studies" and "study". */
function singular(word: string): string {
  if (!/^[a-z]{4,}$/.test(word)) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * The form two Tag names are compared in: full-width and half-width the same, case, spacing and
 * the punctuation around them ignored, and English plurals as their singular.
 */
export function tagKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .map(singular)
    .join(" ");
}

/** A new Tag's name as stored: one line, its spacing and surrounding punctuation tidied. */
const tidyName = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .trim();

/**
 * The new Tags a reply names, tidied: one per name, none blank or longer than `NEW_TAG_WIDTH`,
 * at most `NEW_TAGS_PER_DOCUMENT`. Anything else in the reply is ignored.
 */
export function newTagsOf(value: unknown): NewTag[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const found: NewTag[] = [];
  for (const each of value) {
    if (!isRecord(each) || typeof each.name !== "string") continue;
    const name = tidyName(each.name);
    const key = tagKey(name);
    if (!key || widthOf(name) > NEW_TAG_WIDTH || seen.has(key)) continue;
    seen.add(key);
    const description =
      typeof each.description === "string"
        ? each.description.replace(/\s+/g, " ").trim().slice(0, NEW_TAG_DESCRIPTION)
        : "";
    found.push({ name, description });
    if (found.length === NEW_TAGS_PER_DOCUMENT) break;
  }
  return found;
}
