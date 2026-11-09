/**
 * Tag names as tagging reads and compares them (#2308, #2339): the topic a chat model names for
 * a Document, tidied, and the form two names are compared in.
 */
import { isRecord } from "../errors";

/** A Tag named by its name and description, made only once the User confirms it. */
export interface NewTag {
  name: string;
  description: string;
}

/** A new Tag's longest name, a Chinese character counting as two: "Kitchen renovation", "厨房装修". */
export const NEW_TAG_WIDTH = 32;

const NEW_TAG_DESCRIPTION = 200;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** How wide a name reads: a character of a CJK script counts as two. */
const widthOf = (text: string) =>
  [...text].reduce((width, character) => width + (CJK.test(character) ? 2 : 1), 0);

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
 * The new Tags a reply names, tidied: one per name, none blank or longer than `NEW_TAG_WIDTH`.
 * Anything else in the reply is ignored.
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
  }
  return found;
}
