export const MARKER = /\[\^(\d{1,4})\]/g;

/**
 * A sentence ends at one of these, with any markers right after it, followed
 * by a space or the end of its line. CJK ones need no space.
 */
const SENTENCE_END = /[.!?](?:\[\^\d{1,4}\])*(?=["'”’)\]]*(?:\s|$))|[。！？](?:\[\^\d{1,4}\])*/g;
/** Lines no marker goes into. */
const SKIPPED_LINE = /^\s*(?:#{1,6}\s|\||\[\^\d{1,4}\]:|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
export const FENCE = /^\s*(?:```|~~~)/;
const MATH_FENCE = /^\s*\$\$\s*$/;

export interface Span {
  start: number;
  end: number;
}

export interface Paragraph extends Span {
  sentences: Span[];
}

/** The paragraphs a marker may go into, with their sentences, by offset in `text`. */
export function paragraphsOf(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | null = null;
  let fenced = false;
  let math = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const fence = FENCE.test(line);
    const mathFence = !fenced && MATH_FENCE.test(line);
    if (fence) fenced = !fenced;
    if (mathFence) math = !math;
    if (fence || mathFence || fenced || math || line.trim() === "" || SKIPPED_LINE.test(line)) {
      current = null;
      continue;
    }
    if (!current) {
      current = { start, end, sentences: [] };
      paragraphs.push(current);
    }
    current.end = end;
    // Each line ends a sentence (a list item, a line of its own); so does closing punctuation.
    let from = start;
    for (const found of line.matchAll(SENTENCE_END)) {
      const to = start + found.index + found[0].length;
      if (text.slice(from, to).trim()) current.sentences.push({ start: from, end: to });
      from = to;
    }
    if (text.slice(from, end).trim()) current.sentences.push({ start: from, end });
  }
  return paragraphs.filter((paragraph) => paragraph.sentences.length > 0);
}

/**
 * The Answer's sentences, outside code, headings, math and footnote
 * definitions, by offset in `text`: each one's text and the markers in it.
 */
export function answerSentences(
  text: string,
): { start: number; end: number; text: string; markers: number[] }[] {
  return paragraphsOf(text).flatMap((paragraph) =>
    paragraph.sentences.map((span) => {
      const sentence = text.slice(span.start, span.end);
      const markers = [...sentence.matchAll(MARKER)].map((found) => Number(found[1]));
      return { ...span, text: sentence.trim(), markers };
    }),
  );
}
