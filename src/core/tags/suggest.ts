/**
 * Tags named from what a Document says (#2308): the chat model chooses the Tags that exist where
 * they truly fit and names new ones where none does, with the rules both automatic tagging
 * (./classify) and Organize's chat model (../library/classifier) give it. Decision models only
 * answer yes or no for each Tag, so they keep choosing from the list.
 */
import { writtenInCjk } from "../documents/textLanguage";
import { isRecord } from "../errors";
import { PRESET_TAGS } from "./presets";

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
  `Give the Document up to ${TAGS_PER_DOCUMENT} Tags that would help its owner find it again with others like it. The first says what it is about: its topic, or the project or matter it belongs to, as specific as the text allows ("Kitchen renovation", not "Home"; "Marathon training", not "Notes"). Then, where one clearly applies, what kind of document it is.`,
  "Use an existing Tag only when its description truly fits the Document as a whole. A topic Tag made for other Documents fits only one on that same topic, not one that merely shares a mood, a place or a word with them. A Tag for a kind of document fits only a document of that kind: a quote, an estimate, a price list, an order, a registration or a donation or gift receipt is not an invoice, and notes that mention prices are notes, not an invoice. A kind Tag such as Notes, Report or Contract is never the only Tag of a Document whose text has a clear topic.",
  `When no existing Tag names what the Document is about, name up to ${NEW_TAGS_PER_DOCUMENT} new Tags in newTags: each a short, general name of one to three words (a topic or project other Documents could share, not a sentence, a date, a person's name or the file's format), with a one-line description of what belongs under it. Never name a new Tag that means the same as an existing one in the Document's language: use the existing one.`,
  "Tags are in the language of the Document's own text, not its file name's. Choose an existing Tag only if its name is in that language, or is a proper name or an abbreviation. A Document whose text is Chinese gets a Chinese Tag even when an English Tag with the same meaning exists: one Tag in each language is right.",
  "A Tag says what this Document itself is or is for (a pitch, a budget, a contract), not what the company or person in it sells, makes or does.",
  "No Tag at all is fine only when the excerpt says too little to tell what the Document is about.",
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

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** How wide a name reads: a character of a CJK script counts as two. */
const widthOf = (text: string) =>
  [...text].reduce((width, character) => width + (CJK.test(character) ? 2 : 1), 0);

type Script = "cjk" | "latin";

/** A Tag name's script; null for one that reads the same in any language, such as "NDA" or "Q3". */
const nameScript = (name: string): Script | null =>
  CJK.test(name) ? "cjk" : /\p{Ll}/u.test(name) ? "latin" : null;

const textScript = (text: string): Script | null =>
  writtenInCjk(text) ? "cjk" : /\p{Script=Latin}/u.test(text) ? "latin" : null;

/**
 * The Tags the chat model is offered for a Document whose text is `text`: those named in its
 * script, and those that read the same in any. Told in the prompt alone, the model still chose
 * the English Tags made for English Documents for Chinese ones (#2308); the others stay in the
 * Library, and it names a Tag in the Document's language instead.
 */
export function tagsToOffer<T extends { name: string }>(tags: readonly T[], text: string): T[] {
  const script = textScript(text);
  if (script === null) return [...tags];
  return tags.filter((tag) => {
    const own = nameScript(tag.name);
    return own === null || own === script;
  });
}

const INVOICE_NAMES = new Set(
  PRESET_TAGS.filter((preset) => preset.key === "invoice").flatMap((preset) =>
    Object.values(preset.text).map((text) => tagKey(text.name)),
  ),
);

/**
 * What a bill or a receipt calls itself or carries. An order, a quote or a registration lists
 * items and amounts too, and the model tagged such Documents Invoice whatever its rules said
 * (#2308).
 */
const INVOICE_EVIDENCE =
  /invoice|receipt|\bbill\b|folio|发票|收据|账单|小票|凭证|缴费|税号|增值税|开票/iu;

const isInvoice = (tag: { name: string }) => INVOICE_NAMES.has(tagKey(tag.name));

/** A chat model's Tags for a Document: those it chose from the ones offered, and those it named. */
export interface TagAnswer<T> {
  chosen: T[];
  newTags: NewTag[];
}

/** Added to the instructions of the second request `foundedTags` makes. */
const NOT_A_BILL =
  "This Document is not a bill or a receipt: choose and name no Tag for one, only Tags that say what it is or is about.";

/**
 * The chat model's Tags for a Document from `offered`, without an Invoice Tag where neither its
 * name nor its text says it is a bill or a receipt; a Document with no text, a scan, keeps it.
 * When that Tag was its only one, `ask` is called once more with it left out and `NOT_A_BILL`,
 * so the check doesn't leave the Document with no Tag (#2308); the rest of the answer, such as
 * Organize's Folder, stays the first one's. `untagged`: the second request gave none either.
 */
export async function foundedTags<T extends { name: string }, A extends TagAnswer<T>>(
  excerpt: { name: string; text: string },
  offered: readonly T[],
  ask: (offered: readonly T[], instruction: string | null) => Promise<A>,
): Promise<A & { untagged: boolean }> {
  const first = await ask(offered, null);
  if (!excerpt.text.trim() || INVOICE_EVIDENCE.test(`${excerpt.name}\n${excerpt.text}`))
    return { ...first, untagged: false };
  const held = (answer: TagAnswer<T>) => ({
    chosen: answer.chosen.filter((tag) => !isInvoice(tag)),
    newTags: answer.newTags.filter((tag) => !isInvoice(tag)),
  });
  const count = (answer: TagAnswer<T>) => answer.chosen.length + answer.newTags.length;
  const kept = held(first);
  if (count(kept) > 0 || count(first) === 0) return { ...first, ...kept, untagged: false };
  const again = held(
    await ask(
      offered.filter((tag) => !isInvoice(tag)),
      NOT_A_BILL,
    ),
  );
  return { ...first, ...again, untagged: count(again) === 0 };
}

/** The line logged for a Document `foundedTags` left with no Tag: its id only, never its name or text. */
export const untaggedLine = (documentId: string) =>
  `Document ${documentId} has no Tag: its only one, Invoice, had no bill or receipt wording, and asking again gave none.`;

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
