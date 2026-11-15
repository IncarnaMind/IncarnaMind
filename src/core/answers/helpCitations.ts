/**
 * The lines of a typed call-help reply that the one request for Citations is asked about (#2925),
 * in place of the whole reply. A line is asked about when it is either:
 * - a sentence of fact with no Citation, sharing a figure, or three words (three pairs of
 *   characters in Chinese), with a sentence of the Passages the reply read; or
 * - one of two or more list items whose only Citation is the same one.
 * A marker the model wrote with no record is no Citation, so its line is asked about too.
 * Across languages only a figure is shared, so a line without one isn't reached; it stays as it is.
 *
 * The rule only chooses what is asked: no line loses a Citation by it. The request's answer is
 * taken on these lines alone, and a line that says something wasn't found is never asked about.
 */
import { answerSentences } from "../../shared/answerSentences";
import { likeness, wordsOf } from "./markerPlacement";

export interface AskedLine {
  start: number;
  end: number;
  text: string;
  /** The Citation it shares with other list items, which an answer for it replaces on it alone. */
  replaces?: number;
}

/** A line that says something wasn't found, isn't known or isn't in the Documents. */
const NOT_FOUND =
  /\b(?:isn't|is not|aren't|are not|wasn't|was not)\b[^.]*\b(?:in|found|stated|given|listed|mentioned|known|covered)\b|\b(?:don't|do not|doesn't|does not|didn't|did not|couldn't|could not|can't|cannot)\b[^.]*\b(?:know|find|found|say|state|give|mention|list|cover|see)\b|\bno (?:document|passage|record|mention)s?\b|\bnot (?:known|sure|stated|found)\b|没有|未找到|没找到|找不到|查不到|没查到|不知道|未提及|没提到|没写|未写明|没说|无法确认|不清楚/iu;

/** A figure of two or more characters: a lone digit ("Table 2") says nothing on its own. */
const figuresOf = (text: string): string[] =>
  [...text.replace(/\[\^\d{1,4}\]/g, " ").matchAll(/\d+(?:[.,]\d+)*/g)]
    .map((found) => found[0].replace(/,(?=\d{3}(?!\d))/g, ""))
    .filter((figure) => figure.length > 1);

/** The fewest words a line shares with a Passage's sentence to be taken as stating one of its facts. */
const SHARED_WORDS = 3;

export function helpAskedLines(
  text: string,
  passages: readonly { text: string }[],
  recorded: (marker: number) => boolean,
): AskedLine[] {
  const theirs = passages
    .flatMap((passage) => passage.text.split(/\n+/))
    .map((line) => ({ words: wordsOf(line), figures: new Set(figuresOf(line)) }));
  const ofFact = (sentence: string) => {
    const words = wordsOf(sentence);
    const figures = figuresOf(sentence);
    return theirs.some(
      (line) =>
        figures.some((figure) => line.figures.has(figure)) ||
        likeness(words, line.words).shared >= SHARED_WORDS,
    );
  };
  const units = answerSentences(text).filter(
    (unit) => unit.text !== "" && !unit.text.startsWith("→"),
  );
  const soleCitation = (unit: (typeof units)[number]) => {
    const markers = [...new Set(unit.markers)];
    return markers.length === 1 && recorded(markers[0] as number) ? markers[0] : undefined;
  };
  const sharing = new Map<number, number>();
  for (const unit of units) {
    const sole = soleCitation(unit);
    if (sole !== undefined) sharing.set(sole, (sharing.get(sole) ?? 0) + 1);
  }
  return units.flatMap((unit): AskedLine[] => {
    if (NOT_FOUND.test(unit.text)) return [];
    const line = { start: unit.start, end: unit.end, text: unit.text };
    const sole = soleCitation(unit);
    if (sole !== undefined)
      return (sharing.get(sole) ?? 0) >= 2 ? [{ ...line, replaces: sole }] : [];
    if (unit.markers.some(recorded)) return [];
    return unit.markers.length > 0 || ofFact(unit.text) ? [line] : [];
  });
}
