/**
 * The records of a reply that names its Passages in its markers (#2526): call help on a listed
 * model is offered no `cite`, and each marker holds the number of the Passage it rests on, "[^3]"
 * for P3. Its quote is the sentence of that Passage most like the sentence the marker is in, of
 * those the Citation check finds there, so each record is taken and checked as any other. A claim
 * that rests on more of the Passage than that sentence (a price, its discount and its fee, one
 * line each) gets a quote for each, up to `MAX_QUOTES`, each under a marker of its own, as a model
 * citing by records gives them; so does a Passage named by claims resting on different sentences
 * of it. A marker written "[^P3]", the id itself, is read as "[^3]". A calculation's input that
 * names a Passage the same way ("citation": 3 for P3) quotes its sentence holding the number.
 */
import { answerSentences, MARKER } from "../../shared/answerSentences";
import type { CitationRecordInput } from "./engine";
import { likeness, wordsOf } from "./markerPlacement";
import { passageSentences } from "./unmarkedQuotes";

/** The most quotes one marker gets from its Passage. */
const MAX_QUOTES = 3;

/** The fewest of a claim's words a further quote must add to be taken. */
const MIN_ADDED_WORDS = 2;

/** A marker as a model may write it: "[^3]", or the Passage's id, "[^P3]". */
const NAMED = /\[\^[Pp]?(\d{1,4})\]/g;

/** A word as the quotes are matched on: "days" and "day" alike. */
const folded = (word: string) =>
  word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

const claimWords = (text: string): Set<string> => new Set([...wordsOf(text)].map(folded));

/** A sentence as a quote of it is written: no list mark, heading mark or "[0:04 Them]" lead. */
const asQuoted = (sentence: string) =>
  sentence
    .replace(/^(?:[-*•]|\d+[.)]|#+)\s+/u, "")
    .replace(/^\[[^\]]*\]\s*/u, "")
    .trim();

/**
 * The records for the markers of `text` that name a Passage the model was given (`passages`) and
 * have none yet (`recorded`), and the text with a marker of its own wherever a named Passage is
 * quoted by another of its sentences. A marker naming no Passage is left as it is, to go as an
 * unbacked marker goes; one naming a Passage that has nothing like its claim goes.
 */
export function markedPassages(
  text: string,
  passages: readonly { id: string; text: string }[],
  found: (passage: string, quote: string) => boolean,
  recorded: (marker: number) => boolean,
): { text: string; records: CitationRecordInput[] } {
  const named = text.replace(NAMED, (_, number: string) => `[^${number}]`);
  const shown = new Map(passages.map((passage) => [passage.id.toUpperCase(), passage]));
  let next = Math.max(0, ...[...named.matchAll(MARKER)].map((each) => Number(each[1]))) + 1;
  /** The marker each Passage's quote was recorded under: the Passage's own number first. */
  const markerOf = new Map<string, number>();
  const records: CitationRecordInput[] = [];
  const rewritten: { at: number; length: number; markers: number[] }[] = [];
  const sentences = answerSentences(named);
  for (const [index, sentence] of sentences.entries()) {
    const own = claimWords(sentence.text);
    // A marker that starts a sentence ("A claim. [^2]") belongs to the one before, as
    // `markedSentence` reads it.
    const before = claimWords(sentences[index - 1]?.text ?? "");
    for (const each of named.slice(sentence.start, sentence.end).matchAll(MARKER)) {
      const lead = named.slice(sentence.start, sentence.start + each.index).replace(MARKER, "");
      const claim = lead.trim() === "" && before.size > 0 ? before : own;
      const number = Number(each[1]);
      const passage = shown.get(`P${number}`);
      if (!passage || recorded(number)) continue;
      const markers = quotesFor(passage, claim, found).map((quote) => {
        const key = `${passage.id}\n${quote}`;
        const own = [...markerOf.values()].includes(number);
        const marker = markerOf.get(key) ?? (own ? next++ : number);
        if (!markerOf.has(key)) {
          markerOf.set(key, marker);
          records.push({ marker, passage: passage.id, quote });
        }
        return marker;
      });
      const at = sentence.start + each.index;
      if (markers.length === 0) {
        // Nothing of the Passage is like the claim: the marker goes, rather than stand on the
        // Citation its number has from another sentence.
        const space = /\s$/u.test(named.slice(0, at)) ? 1 : 0;
        rewritten.push({ at: at - space, length: each[0].length + space, markers });
      } else if (markers.length > 1 || markers[0] !== number) {
        rewritten.push({ at, length: each[0].length, markers });
      }
    }
  }
  let marked = named;
  for (const { at, length, markers } of rewritten.reverse()) {
    const written = markers.map((marker) => `[^${marker}]`).join("");
    marked = `${marked.slice(0, at)}${written}${marked.slice(at + length)}`;
  }
  return { text: marked, records };
}

/**
 * The sentences of `passage` a claim rests on, each one the Citation check finds there and none a
 * heading: the one most like `claim`, if it shares a word with it, then each that adds most of the
 * claim's words not yet quoted, while it adds `MIN_ADDED_WORDS` or more.
 */
function quotesFor(
  passage: { id: string; text: string },
  claim: ReadonlySet<string>,
  found: (passage: string, quote: string) => boolean,
): string[] {
  const candidates = passageSentences(passage.text)
    .filter((sentence) => !/^#+\s/u.test(sentence))
    .map((sentence, at) => ({ quote: asQuoted(sentence), at, words: claimWords(sentence) }))
    .filter((each) => each.quote !== "");
  const quotes: string[] = [];
  const quoted = new Set<string>();
  const added = (words: ReadonlySet<string>) =>
    [...words].filter((word) => claim.has(word) && !quoted.has(word)).length;
  while (quotes.length < MAX_QUOTES) {
    const next = candidates
      .filter((each) => !quotes.includes(each.quote))
      .map((each) => ({
        ...each,
        added: added(each.words),
        score: likeness(claim, each.words).score,
      }))
      .filter((each) => each.added >= (quotes.length === 0 ? 1 : MIN_ADDED_WORDS))
      .sort((a, b) =>
        quotes.length === 0
          ? b.score - a.score || a.at - b.at
          : b.added - a.added || b.score - a.score || a.at - b.at,
      )
      .find((each) => found(passage.id, each.quote));
    if (!next) break;
    quotes.push(next.quote);
    for (const word of next.words) if (claim.has(word)) quoted.add(word);
  }
  return quotes;
}

const fieldsOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * `calculate`'s figures with each input that names a Passage by its number as a marker ("citation"
 * 3 for P3, with no record 3) given that Passage and its first sentence holding the input's number
 * as its quote instead; every other input as it was.
 */
export function namedInputs(
  figures: readonly unknown[],
  passages: readonly { id: string; text: string }[],
  recorded: (marker: number) => boolean,
): unknown[] {
  const shown = new Map(passages.map((passage) => [passage.id.toUpperCase(), passage]));
  const named = (value: unknown): unknown => {
    const input = fieldsOf(value);
    const citation = input.citation;
    if (typeof citation !== "number" || recorded(citation) || input.passage !== undefined) {
      return value;
    }
    const passage = shown.get(`P${citation}`);
    const digits = /\d[\d,.]*\d|\d/.exec(String(input.number ?? input.value ?? ""))?.[0];
    if (!passage || !digits) return value;
    const holds = new RegExp(`(?<![\\d.,])${digits.replace(/[.,]/g, "\\$&")}(?!\\d)`);
    const quote = passageSentences(passage.text)
      .map(asQuoted)
      .find((sentence) => holds.test(sentence));
    if (!quote) return value;
    const { citation: _, ...rest } = input;
    return { ...rest, passage: passage.id, quote };
  };
  return figures.map((value) => {
    const figure = fieldsOf(value);
    return Array.isArray(figure.inputs) ? { ...figure, inputs: figure.inputs.map(named) } : value;
  });
}
