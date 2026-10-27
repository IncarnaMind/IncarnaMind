/**
 * Placing the Citation markers a model left out. Small local models often
 * give the records of their Citations (through `cite`, or in the
 * structured-output JSON) but write few or none of their markers ("[^1]")
 * into the Answer, and a record without its marker is dropped
 * (docs/research/ollama-integration.md). Once the Answer's text is complete,
 * the engine calls `withMissingMarkers` with the records the core took, and
 * each missing marker is put in:
 *
 * 1. after the sentence the record supports: its `sentence`, when the record
 *    names one, else the Answer sentence that shares the most words with its
 *    quote, if it shares enough (see `matches`);
 * 2. failing that, at the end of the paragraph the record is closest to: the
 *    one that shares the most words with its quote; or, when none shares a
 *    word (an Answer in another language than the Passage), the one holding
 *    the nearest marker by number that the model wrote or step 1 placed; or,
 *    with no such marker, the paragraph at the record's place among the
 *    missing records (the first ones near the top).
 *
 * A marker goes before the sentence's closing punctuation ("a claim[^2].")
 * and after any marker already there. Code, headings, math and footnote
 * definitions are left alone.
 *
 * It reads only a record's marker number and text (`sentence`, `quote`), so a
 * change to how a record says where its quote is (pages, or a Location)
 * doesn't touch it.
 */
import {
  answerSentences,
  FENCE,
  MARKER,
  type Paragraph,
  paragraphsOf,
  type Span,
} from "../../shared/answerSentences";
import { FIGURE_MARKER, figureMarkerEnd, type PlacedFigure } from "../../shared/figureMarkers";
import { delimiterRow, looksLikeTable, tableCellRanges } from "../../shared/markdownTables";
import type { AnswerEngineEvent, AnswerTools } from "./engine";

/** What placing a marker needs of a Citation record. */
export interface MarkerRecord {
  /** The marker's number: 1 for "[^1]". */
  marker: number;
  /** The quote from the Passage. */
  quote: string;
  /** The Answer's sentence the record supports, when the model gives it. */
  sentence?: string | null;
}

/** How a missing marker was placed. */
export interface PlacedMarker {
  marker: number;
  /** "sentence": after the sentence it supports. "paragraph": at the end of the paragraph it is closest to. */
  at: "sentence" | "paragraph";
}

/** Closing punctuation a marker goes before, with the quotes and brackets that close the sentence. */
const CLOSING = /[.!?。！？…:;：；,，]+["'”’」』)）\]]*$/u;

/** The least an Answer sentence must share with a quote to be the one it supports. */
const MIN_SHARED = 2;
const MIN_SIMILARITY = 0.2;

/** Common English words, which say nothing about which sentence a quote supports. */
const STOP_WORDS = new Set(
  "a an and are as at be been but by can do does for from had has have he her his i if in into is it its may more most not of on or our she so such than that the their them then there these they this those to was we were what when which while who will with would you your".split(
    " ",
  ),
);

/** The words of a text for comparing: lower-case words and numbers, and each two neighbouring CJK characters. */
export function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  const plain = text.replace(MARKER, " ").toLowerCase();
  for (const [run] of plain.matchAll(/[\p{L}\p{N}]+/gu)) {
    // A run may mix scripts, e.g. "transformer模型".
    for (const [part] of run.matchAll(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    )) {
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part)) {
        const chars = [...part];
        if (chars.length === 1) words.add(part);
        for (let at = 0; at + 1 < chars.length; at++) words.add(`${chars[at]}${chars[at + 1]}`);
      } else if (!STOP_WORDS.has(part)) {
        words.add(part);
      }
    }
  }
  return words;
}

/** How alike two sets of words are: the shared words, and their Dice similarity. */
export function likeness(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): { shared: number; score: number } {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const total = a.size + b.size;
  return { shared, score: total === 0 ? 0 : (2 * shared) / total };
}

/** Whether a sentence is close enough to a record's text to be the one it supports. */
const matches = (likeness: { shared: number; score: number }) =>
  likeness.shared >= MIN_SHARED && likeness.score >= MIN_SIMILARITY;

/**
 * The rows and cells of the Answer's tables, outside code, by offset in
 * `text`: each one's text and the markers in it. `answerSentences` leaves
 * them out, since no marker is placed in a table.
 */
export function answerTableUnits(
  text: string,
): { start: number; end: number; text: string; markers: number[]; cell: boolean }[] {
  const units: { start: number; end: number; text: string; markers: number[]; cell: boolean }[] =
    [];
  const unit = (start: number, end: number, cell = true) => {
    const found = text.slice(start, end);
    units.push({
      start,
      end,
      text: found.trim(),
      markers: [...found.matchAll(MARKER)].map((each) => Number(each[1])),
      cell,
    });
  };
  let fenced = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || !looksLikeTable(line) || delimiterRow(line)) continue;
    unit(start, start + line.length, false);
    for (const cell of tableCellRanges(line)) unit(start + cell.start, start + cell.end);
  }
  return units;
}

/** A figure ("[=2]") in a sentence or table cell of an Answer, and where its marker ends. */
interface FigureAt {
  figure: number;
  end: number;
}

// A marker that starts the next sentence ("[=1]. [^1]") is this one's, as in `markedSentence`.
const citedAfter = (text: string, end: number): number[] => {
  const marker = /^[ \t\u3000]*\[\^(\d{1,4})\](?!:)/.exec(text.slice(end));
  return marker ? [Number(marker[1])] : [];
};

/** The sentences and table cells of an Answer that show figures, with the markers each has. */
function figurePlaces(
  text: string,
): { span: Span; figures: FigureAt[]; cell: boolean; markers: number[] }[] {
  const places = [
    ...answerSentences(text).map((sentence) => ({ ...sentence, cell: false })),
    ...answerTableUnits(text).filter((unit) => unit.cell),
  ];
  return places.flatMap(({ start, end, markers, cell }) => {
    const words = text.slice(start, end);
    // A marker in code ("`[=1]`") is the text's own, not a figure.
    const code = [...words.matchAll(/`[^`]*`/g)].map((each) => [
      each.index,
      each.index + each[0].length,
    ]);
    const figures = [...words.matchAll(FIGURE_MARKER)]
      .filter((each) => !code.some(([from = 0, to = 0]) => each.index >= from && each.index < to))
      .map((each) => ({ figure: Number(each[1]), end: start + each.index + each[0].length }));
    const cited = cell ? markers : [...markers, ...citedAfter(text, end)];
    return figures.length > 0 ? [{ span: { start, end }, figures, cell, markers: cited }] : [];
  });
}

/**
 * `text` with Citation markers put in where it shows figures without their inputs' (#1831):
 * right after each figure, past a scale or unit written after its marker ("[=1] million"), or
 * at the end of its table cell. `citationsOf` gives the markers a figure still needs, given
 * those its sentence or cell has; one that several figures of a place share goes after the last
 * of them. `figureOf` gives a figure, for the words after its marker.
 */
export function withFigureCitations(
  text: string,
  citationsOf: (figure: number, cited: readonly number[]) => readonly number[],
  figureOf: (figure: number) => PlacedFigure | null,
): string {
  const at = new Map<number, number[]>();
  for (const place of figurePlaces(text)) {
    const after = new Map<number, number>();
    for (const { figure, end } of place.figures) {
      const shown = figureOf(figure);
      const where = place.cell ? place.span.end : shown ? figureMarkerEnd(text, end, shown) : end;
      for (const marker of citationsOf(figure, place.markers)) after.set(marker, where);
    }
    for (const [marker, where] of after) at.set(where, [...(at.get(where) ?? []), marker]);
  }
  let cited = text;
  for (const [where, markers] of [...at].sort((a, b) => b[0] - a[0])) {
    const label = markers.map((marker) => `[^${marker}]`).join("");
    cited = `${cited.slice(0, where)}${label}${cited.slice(where)}`;
  }
  return cited;
}

/**
 * Where a marker goes in a sentence or paragraph ending at `end`: after any
 * markers there, before its closing punctuation, without trailing space.
 */
function insertionPoint(text: string, span: Span): number {
  let end = span.end;
  while (end > span.start && /\s/.test(text[end - 1] as string)) end--;
  const body = text.slice(span.start, end);
  // Markers the model wrote after the punctuation ("a claim.[^1]"): after them.
  if (/\[\^\d{1,4}\]$/.test(body)) return end;
  const closing = CLOSING.exec(body);
  return closing ? span.start + closing.index : end;
}

/**
 * The Answer with each record's marker placed, for records whose marker
 * isn't in it, and how each was placed.
 */
export function placeMissingMarkers(
  answer: string,
  records: readonly MarkerRecord[],
): { text: string; placed: PlacedMarker[] } {
  const present = new Set([...answer.matchAll(MARKER)].map((found) => Number(found[1])));
  const missing = [...new Map(records.map((record) => [record.marker, record])).values()]
    .filter((record) => !present.has(record.marker))
    .sort((a, b) => a.marker - b.marker);
  const paragraphs = paragraphsOf(answer);
  if (missing.length === 0 || paragraphs.length === 0) return { text: answer, placed: [] };

  const sentences = paragraphs.flatMap((paragraph, index) =>
    paragraph.sentences.map((span) => ({
      span,
      paragraph: index,
      words: wordsOf(answer.slice(span.start, span.end)),
    })),
  );
  const paragraphWords = paragraphs.map((paragraph) =>
    wordsOf(answer.slice(paragraph.start, paragraph.end)),
  );
  /**
   * Markers by paragraph that say what a paragraph is about: those the model
   * wrote, and those placed after the sentence they support.
   */
  const markersIn = paragraphs.map(
    (paragraph) =>
      new Set(
        [...answer.slice(paragraph.start, paragraph.end).matchAll(MARKER)].map((found) =>
          Number(found[1]),
        ),
      ),
  );

  const insertions: { at: number; marker: number }[] = [];
  const placed: PlacedMarker[] = [];
  missing.forEach((record, rank) => {
    // 1. The sentence it supports: the record's own, else the one most like its quote.
    let sentence: (typeof sentences)[number] | null = null;
    for (const probe of [record.sentence, record.quote]) {
      if (!probe?.trim()) continue;
      const words = wordsOf(probe);
      let bestScore = 0;
      for (const each of sentences) {
        const alike = likeness(words, each.words);
        if (matches(alike) && alike.score > bestScore) {
          bestScore = alike.score;
          sentence = each;
        }
      }
      if (sentence) break;
    }
    if (sentence) {
      insertions.push({ at: insertionPoint(answer, sentence.span), marker: record.marker });
      markersIn[sentence.paragraph]?.add(record.marker);
      placed.push({ marker: record.marker, at: "sentence" });
      return;
    }
    // 2. The paragraph it is closest to.
    const words = wordsOf(`${record.sentence ?? ""} ${record.quote}`);
    let paragraph = -1;
    let most = 0;
    paragraphWords.forEach((each, index) => {
      const { shared } = likeness(words, each);
      if (shared > most) {
        most = shared;
        paragraph = index;
      }
    });
    if (paragraph === -1) {
      // The paragraph with the nearest marker by number, before it if tied.
      let nearest = Number.POSITIVE_INFINITY;
      markersIn.forEach((markers, index) => {
        for (const marker of markers) {
          const distance = Math.abs(marker - record.marker) + (marker > record.marker ? 0.5 : 0);
          if (distance < nearest) {
            nearest = distance;
            paragraph = index;
          }
        }
      });
    }
    if (paragraph === -1) {
      paragraph = Math.min(
        paragraphs.length - 1,
        Math.floor((rank * paragraphs.length) / missing.length),
      );
    }
    const target = paragraphs[paragraph] as Paragraph;
    insertions.push({ at: insertionPoint(answer, target), marker: record.marker });
    placed.push({ marker: record.marker, at: "paragraph" });
  });

  // From the end, so earlier offsets hold; markers at one place in order.
  insertions.sort((a, b) => b.at - a.at || b.marker - a.marker);
  let text = answer;
  for (const { at, marker } of insertions) {
    text = `${text.slice(0, at)}[^${marker}]${text.slice(at)}`;
  }
  return { text, placed: placed.sort((a, b) => a.marker - b.marker) };
}

/**
 * The Answer with the markers of `records` that are missing from it placed,
 * for the records the core accepted (`accepted`): a marker without a valid
 * record would only be removed again. A record whose quote (and sentence)
 * has no word, such as an empty one or "…", is left to be dropped: nothing
 * says where it goes. The engine calls this once the text is complete.
 */
export function withMissingMarkers(
  answer: string,
  records: readonly MarkerRecord[],
  accepted: (marker: number) => boolean,
): { text: string; placed: PlacedMarker[] } {
  const usable = records.filter(
    (record) =>
      Number.isInteger(record.marker) &&
      record.marker >= 1 &&
      // With no word in its quote or its sentence (empty, or only "…" or quotation marks),
      // nothing says where it goes, or what the check would find.
      (wordsOf(record.quote).size > 0 || wordsOf(record.sentence ?? "").size > 0) &&
      accepted(record.marker),
  );
  return usable.length === 0 ? { text: answer, placed: [] } : placeMissingMarkers(answer, usable);
}

/** Engine events that change the Answer's text from `from` to `to`: what follows their common start is replaced. */
export function* textEdits(from: string, to: string): Generator<AnswerEngineEvent> {
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  if (from.length > common) yield { type: "text-retracted", length: from.length - common };
  if (to.length > common) yield { type: "text-delta", text: to.slice(common) };
}

/**
 * Where the engine handles a finished Answer's records: the edits that put in
 * the markers the model left out of `text` for records the core took (see
 * `AnswerTools.hasRecord`), and how many it put in. Returns the text with them.
 */
export function* missingMarkerEvents(
  text: string,
  records: readonly MarkerRecord[],
  tools: Pick<AnswerTools, "hasRecord">,
): Generator<AnswerEngineEvent, string> {
  const { text: placed, placed: markers } = withMissingMarkers(
    text,
    records,
    (marker) => tools.hasRecord?.(marker) ?? false,
  );
  if (markers.length === 0) return text;
  yield* textEdits(text, placed);
  yield { type: "markers-placed", count: markers.length };
  return placed;
}

/**
 * The sentence of `text` a marker ("[^2]") is in, without its markers: the
 * first place it is, outside code, headings and math. A marker that starts a
 * sentence ("A claim. [^2]") belongs to the one before. Null when it isn't there.
 */
export function markedSentence(text: string, marker: number): string | null {
  const label = `[^${marker}]`;
  for (const paragraph of paragraphsOf(text)) {
    const at = text.slice(paragraph.start, paragraph.end).indexOf(label);
    if (at === -1) continue;
    const offset = paragraph.start + at;
    const index = paragraph.sentences.findIndex(
      (span) => offset >= span.start && offset < span.end,
    );
    if (index === -1) continue;
    const span = paragraph.sentences[index] as Span;
    const leading = text.slice(span.start, offset).replace(MARKER, "").trim() === "";
    const own = leading && index > 0 ? (paragraph.sentences[index - 1] as Span) : span;
    const sentence = text
      .slice(own.start, own.end)
      .replace(/\s*\[\^\d{1,4}\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return sentence || null;
  }
  return null;
}
