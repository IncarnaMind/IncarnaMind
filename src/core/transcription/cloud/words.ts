/**
 * The meeting's words to know as each cloud service's own field takes them (#1031), within the
 * limits its docs give: in the order they come (the User's name and the meeting's own names
 * first), an entry the field can't take skipped so the rest still go, and none past its count or
 * its total. Nothing here fails: a list too long for a field is cut, never refused.
 */
import type { CloudTranscriptionRoute } from "../../api";

interface FieldLimits {
  /** The most entries it takes. */
  count: number;
  /** The longest entry, in characters. */
  length?: number;
  /** The most words an entry may have, counted by spaces. */
  words?: number;
  /** All the entries together, by `measure`, with `separator` between two. */
  total?: { most: number; measure(entry: string): number; separator?: number };
  /** Characters the field refuses in an entry: taken out of it. */
  refused?: RegExp;
}

const HAN = /\p{Script=Han}/u;
const characters = (entry: string) => [...entry].length;

/**
 * About how many tokens a service counts for an entry, counted high: a Han character as two, a
 * run of three other characters as one, and one for the entry's own boundary.
 */
export const tokensOf = (entry: string) => {
  let han = 0;
  let other = 0;
  for (const character of entry) {
    if (HAN.test(character)) han++;
    else other++;
  }
  return 2 * han + Math.ceil(other / 3) + 1;
};

/**
 * Each route's field, as its docs give it (checked 2026-11-09). Where the docs give no limit, the
 * meeting's own 40 is the count (../../meetings/words).
 */
const LIMITS: Record<CloudTranscriptionRoute, FieldLimits> = {
  // `context.terms`: the context is at most 8,000 tokens.
  soniox: { count: 100, total: { most: 6000, measure: tokensOf } },
  // `keyterm`: 500 tokens across every term; the docs advise 20 to 50 terms.
  deepgram: { count: 50, total: { most: 400, measure: tokensOf } },
  // `keyterms_prompt`: 100 terms of up to 50 characters; a longer one is dropped by the service.
  assemblyai: { count: 100, length: 50 },
  // `customVocabulary`: up to 1,000 phrases, best at 100 or fewer.
  gemini: { count: 100 },
  // `keywords`: no limit given, but an entry may hold no `<`, `>` or line break.
  openai: { count: 40, refused: /[<>\r\n]/g },
  // `additional_vocab`: 1,000 entries recommended; one of more than 6 words is dropped.
  speechmatics: { count: 1000, words: 6 },
  // `keyterms`, live: 50 terms of up to 20 characters.
  elevenlabs: { count: 50, length: 20 },
  // `custom_vocabulary_config.vocabulary`: no limit given.
  gladia: { count: 40 },
  // `keyterm`: 100 terms of up to 50 characters.
  xai: { count: 100, length: 50 },
  // `input.context`, as one word list: 400 characters in all, the rest cut from its end.
  qwen: { count: 100, total: { most: 400, measure: characters, separator: 2 } },
};

/** The entries of `words` that `route`'s field takes, in order. */
export function cloudWords(route: CloudTranscriptionRoute, words: readonly string[]): string[] {
  const limits = LIMITS[route];
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const word of words) {
    if (out.length >= limits.count) break;
    const entry = (limits.refused ? word.replace(limits.refused, " ") : word)
      .replace(/\s+/g, " ")
      .trim();
    if (entry === "" || seen.has(entry)) continue;
    if (limits.length !== undefined && characters(entry) > limits.length) continue;
    if (limits.words !== undefined && entry.split(" ").length > limits.words) continue;
    if (limits.total) {
      const size =
        limits.total.measure(entry) + (out.length > 0 ? (limits.total.separator ?? 0) : 0);
      if (total + size > limits.total.most) continue;
      total += size;
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** Qwen's field is one text: the list, as a word list reads. */
export const QWEN_WORDS_SEPARATOR = ", ";
