/**
 * The records of a reply that names its Passages in its markers (#2526): call help on a listed
 * model is offered no `cite`, and each marker holds the number of the Passage it rests on, "[^3]"
 * for P3. Its quote is the sentence of that Passage most like the marked sentence, of those the
 * Citation check finds there, so each record is taken and checked as any other.
 */
import { MARKER } from "../../shared/answerSentences";
import type { CitationRecordInput } from "./engine";
import { likeness, markedSentence, wordsOf } from "./markerPlacement";
import { passageSentences } from "./unmarkedQuotes";

/** A sentence as a quote of it is written: no list mark, heading mark or "[0:04 Them]" lead. */
const asQuoted = (sentence: string) =>
  sentence
    .replace(/^(?:[-*•]|\d+[.)]|#+)\s+/u, "")
    .replace(/^\[[^\]]*\]\s*/u, "")
    .trim();

/**
 * A record for each marker in `text` that names a Passage the model was given (`passages`) and
 * has none yet (`recorded`); a marker naming none is left as it is, to go as an unbacked marker
 * goes.
 */
export function markedRecords(
  text: string,
  passages: readonly { id: string; text: string }[],
  found: (passage: string, quote: string) => boolean,
  recorded: (marker: number) => boolean,
): CitationRecordInput[] {
  const shown = new Map(passages.map((passage) => [passage.id.toUpperCase(), passage]));
  const markers = [...new Set([...text.matchAll(MARKER)].map((each) => Number(each[1])))];
  return markers.flatMap((marker): CitationRecordInput[] => {
    const passage = shown.get(`P${marker}`);
    if (!passage || recorded(marker)) return [];
    const claim = wordsOf(markedSentence(text, marker) ?? "");
    const quote = passageSentences(passage.text)
      .map((sentence, at) => ({
        quote: asQuoted(sentence),
        at,
        score: likeness(claim, wordsOf(sentence)).score,
      }))
      .filter((each) => each.quote !== "")
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .find((each) => found(passage.id, each.quote))?.quote;
    return quote ? [{ marker, passage: passage.id, quote }] : [];
  });
}
