import { comparableSentence } from "../../../shared/sentences";

/** A stretch of a card's sentence drawn marked, in its part's verdict colours. */
export interface SentenceMark {
  key: string;
  start: number;
  end: number;
  /** The card tone whose colours the mark takes (`citation-card--{tone}`). */
  tone: string;
}

/**
 * Where `words` stand in `sentence`, both read as the card shows them: only where they are found
 * exactly once, so a mark never lands on the wrong words (#2869). Null when they aren't found, or
 * are found more than once.
 */
export function placeWords(sentence: string, words: string): { start: number; end: number } | null {
  const wanted = comparableSentence(words);
  if (wanted === "") return null;
  const start = sentence.indexOf(wanted);
  if (start < 0 || sentence.indexOf(wanted, start + 1) >= 0) return null;
  return { start, end: start + wanted.length };
}

/**
 * The marks a card draws in its sentence: one a placed part, the first of any that overlap, and
 * none for a part that is the whole sentence, which its verdict already names.
 */
export function sentenceMarks(
  sentence: string,
  wanted: readonly { key: string; place: { start: number; end: number } | null; tone: string }[],
): SentenceMark[] {
  const words = sentence.replace(/[\s\p{P}]+$/u, "").replace(/^[\s\p{P}]+/u, "");
  const marks: SentenceMark[] = [];
  for (const { key, place, tone } of wanted) {
    if (!place) continue;
    if (sentence.slice(place.start, place.end).includes(words)) continue;
    if (marks.some((mark) => mark.start < place.end && place.start < mark.end)) continue;
    marks.push({ key, start: place.start, end: place.end, tone });
  }
  return marks;
}

/** The sentence cut into its plain and marked stretches, marks in order and never overlapping. */
export function markedPieces(
  sentence: string,
  marks: readonly SentenceMark[],
): { text: string; mark: SentenceMark | null }[] {
  const pieces: { text: string; mark: SentenceMark | null }[] = [];
  let at = 0;
  for (const mark of [...marks].sort((a, b) => a.start - b.start)) {
    if (mark.start < at || mark.end <= mark.start) continue;
    if (mark.start > at) pieces.push({ text: sentence.slice(at, mark.start), mark: null });
    pieces.push({ text: sentence.slice(mark.start, mark.end), mark });
    at = mark.end;
  }
  if (at < sentence.length) pieces.push({ text: sentence.slice(at), mark: null });
  return pieces;
}

/** The places the two-line cut may start the sentence from, before `before`: each word's start. */
export function cutPlaces(sentence: string, before: number): number[] {
  const places: number[] = [];
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    for (const { index, isWordLike } of new Segmenter(undefined, { granularity: "word" }).segment(
      sentence.slice(0, before),
    ))
      if (isWordLike && index > 0) places.push(index);
  } else {
    for (let index = 1; index < before; index++)
      if (/\s/u.test(sentence[index - 1] ?? "") && !/\s/u.test(sentence[index] ?? ""))
        places.push(index);
  }
  return places;
}
