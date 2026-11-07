/**
 * The records of a reply that names its Passages in its markers (#2526): call help on a listed
 * model is offered no `cite`, and each marker holds the number of the Passage it rests on, "[^3]"
 * for P3. Its quote is the sentence of that Passage most like the sentence the marker is in, of
 * those the Citation check finds there, so each record is taken and checked as any other. A
 * Passage named in two sentences that rest on different sentences of it gets a marker for each.
 */
import { answerSentences, MARKER } from "../../shared/answerSentences";
import type { CitationRecordInput } from "./engine";
import { likeness, wordsOf } from "./markerPlacement";
import { passageSentences } from "./unmarkedQuotes";

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
 * unbacked marker goes.
 */
export function markedPassages(
  text: string,
  passages: readonly { id: string; text: string }[],
  found: (passage: string, quote: string) => boolean,
  recorded: (marker: number) => boolean,
): { text: string; records: CitationRecordInput[] } {
  const shown = new Map(passages.map((passage) => [passage.id.toUpperCase(), passage]));
  let next = Math.max(0, ...[...text.matchAll(MARKER)].map((each) => Number(each[1]))) + 1;
  /** The marker each Passage's quote was recorded under: the Passage's own number first. */
  const markerOf = new Map<string, number>();
  const records: CitationRecordInput[] = [];
  const renumbered: { at: number; length: number; marker: number }[] = [];
  for (const sentence of answerSentences(text)) {
    const claim = wordsOf(sentence.text);
    for (const each of text.slice(sentence.start, sentence.end).matchAll(MARKER)) {
      const named = Number(each[1]);
      const passage = shown.get(`P${named}`);
      if (!passage || recorded(named)) continue;
      const quote = closestQuote(passage, claim, found);
      if (!quote) continue;
      const key = `${passage.id}\n${quote}`;
      const taken = [...markerOf.values()].includes(named);
      const marker = markerOf.get(key) ?? (taken ? next++ : named);
      if (!markerOf.has(key)) {
        markerOf.set(key, marker);
        records.push({ marker, passage: passage.id, quote });
      }
      if (marker !== named) {
        renumbered.push({ at: sentence.start + each.index, length: each[0].length, marker });
      }
    }
  }
  let marked = text;
  for (const { at, length, marker } of renumbered.reverse()) {
    marked = `${marked.slice(0, at)}[^${marker}]${marked.slice(at + length)}`;
  }
  return { text: marked, records };
}

/** The sentence of `passage` most like `claim` that the Citation check finds there; null for none. */
function closestQuote(
  passage: { id: string; text: string },
  claim: ReadonlySet<string>,
  found: (passage: string, quote: string) => boolean,
): string | null {
  return (
    passageSentences(passage.text)
      .map((sentence, at) => ({
        quote: asQuoted(sentence),
        at,
        score: likeness(claim, wordsOf(sentence)).score,
      }))
      .filter((each) => each.quote !== "")
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .find((each) => found(passage.id, each.quote))?.quote ?? null
  );
}
