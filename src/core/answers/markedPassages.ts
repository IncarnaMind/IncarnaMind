/**
 * The records of a reply that names its Passages in its markers (#2526): call help on a listed
 * model is offered no `cite`, and each marker holds the number of the Passage it rests on, "[^3]"
 * for P3 (a marker written "[^P3]", the id itself, is read the same). IncarnaMind picks each quote,
 * and call help runs no claim check, so the green mark the Citation check gives a quote is the
 * User's only verdict on it: a quote is taken only from a line that holds the claim, and a marker
 * whose Passage holds nothing that does goes, leaving its claim uncited rather than found.
 *
 * - A claim is the marker's sentence; a marker after the full stop belongs to the sentence before,
 *   as `markedSentence` reads it. It is matched by its words, plurals folded, and by each two
 *   neighbouring CJK characters, so Chinese and mixed text need no spaces. Words of the Passage's
 *   Document name are no evidence: the name heads the Document and is often in its text.
 * - A heading is never quoted: a "#" line, a table's header row, or a short line standing alone
 *   with no closing punctuation.
 * - The first quote is the line holding the most of the claim's figures, then of its words, and
 *   at least two of them. Up to `MAX_QUOTES` in all, a further line is quoted when it adds two of
 *   them, a figure beside one of the claim's words, or a word no other line of the Passage holds,
 *   so a claim resting on several lines is quoted from each; never a line whose figures are all
 *   other than the claim's.
 * - A claim that is a line said again with a "not" more or less (as ./unmarkedQuotes counts them)
 *   gets nothing from that Passage.
 * - Every figure of a sentence is in a quote taken for its markers, or none of them is recorded.
 *   A figure said in the call may stand beside one a quote holds, as in "your Android 10 phones
 *   won't run it: it needs Android 11 or later".
 *
 * A calculation's input that names a Passage the same way ("citation": 3 for P3) quotes its
 * sentence holding the number.
 */
import { answerSentences, MARKER } from "../../shared/answerSentences";
import { sentenceSpans } from "../../shared/sentences";
import type { CitationRecordInput } from "./engine";
import { likeness, wordsOf } from "./markerPlacement";
import { negationsOf, passageSentences } from "./unmarkedQuotes";

/** The most quotes one marker gets from its Passage. */
const MAX_QUOTES = 3;

/** The least of a claim a first quote holds, in words; a CJK character is half of one. */
const MIN_HELD = 2;

/** The most words a line standing alone with no closing punctuation has, to be a heading. */
const MAX_TITLE_WORDS = 8;

/** The least share of a line's own words its claim holds, for one word only it holds to quote it. */
const MIN_LINE_SHARE = 1 / 3;

/**
 * How alike a claim's words and a line's are for the claim to be that line said again, which a
 * "not" turns around. Below it a "no" or "can't" is the reply's own: "No, it costs $0.05 a text".
 */
const RESTATED = 0.9;

/** A reply's own answer before its claim, "No," or "不，": no negation of what follows. */
const ANSWER = /^[^\p{L}\p{N}]*([\p{L}\p{N}' ]+?)\s*[,，:：;；.。!！—–]/u;

/** A marker as a model may write it: "[^3]", or the Passage's id, "[^P3]". */
const NAMED = /\[\^[Pp]?(\d{1,4})\]/g;
/** A calculated figure's marker, "[=1]": its digits are no figure of the claim. */
const FIGURE_MARKER = /\[=\d{1,4}\]/g;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = new RegExp(`${CJK.source}+`, "gu");
/** A transcript line's time and speaker, "[0:04 Them] ". */
const CUE = /^\[\d{1,2}(?::\d{2}){1,2}\b[^\]]*\]\s*/u;
const LIST_MARK = /^(?:[-*•]|\d+[.)])\s+/u;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}/u;
const CLOSING = /[.!?。！？:：;；,，]["'”’)\]）」』]*$/u;
const DIGITS = /\d+(?:[.,]\d+)*/g;

/** A word as quotes are matched on: "days" and "day" alike. */
const folded = (word: string) =>
  word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

const wordSet = (text: string): Set<string> => new Set([...wordsOf(text)].map(folded));

const isFigure = (word: string) => /^\d/.test(word);

/** The figures a text writes in digits, "$1,200" as "1200"; a number written in words is a word. */
const figuresOf = (text: string): string[] =>
  [...text.replace(MARKER, " ").replace(FIGURE_MARKER, " ").matchAll(DIGITS)].map((found) =>
    found[0].replace(/,(?=\d{3}(?!\d))/g, ""),
  );

/** A sentence as a quote of it is written: no list mark, heading mark or "[0:04 Them]" lead. */
const asQuoted = (sentence: string) =>
  sentence
    .replace(/^(?:[-*•]|\d+[.)]|#+)\s+/u, "")
    .replace(/^\[[^\]]*\]\s*/u, "")
    .trim();

interface Claim {
  /** The sentence without its markers. */
  text: string;
  words: Set<string>;
  /** Its Latin words and figures, as matched. */
  latin: string[];
  /** Its runs of CJK characters. */
  cjk: string[];
  figures: string[];
}

function claimOf(sentence: string): Claim {
  const text = sentence.replace(MARKER, " ").replace(FIGURE_MARKER, " ").trim();
  const words = wordSet(text);
  return {
    text,
    words,
    latin: [...words].filter((word) => !CJK.test(word)),
    cjk: text.match(CJK_RUN) ?? [],
    figures: figuresOf(text),
  };
}

/**
 * How much of a claim `has` holds, in words: a Latin word or figure is one, and a CJK character
 * in a held pair half of one, so "企业版" held whole counts as a word and a half. `figures`: false
 * counts the words only.
 */
function amount(claim: Claim, has: (word: string) => boolean, figures = true): number {
  let held = 0;
  for (const word of claim.latin) if ((figures || !isFigure(word)) && has(word)) held += 1;
  for (const run of claim.cjk) {
    const characters = [...run];
    const covered = new Set<number>();
    if (characters.length === 1 && has(run)) covered.add(0);
    for (let at = 0; at + 1 < characters.length; at++) {
      if (has(`${characters[at]}${characters[at + 1]}`)) covered.add(at).add(at + 1);
    }
    held += covered.size / 2;
  }
  return held;
}

/** A sentence of a Passage a quote may be. */
interface Line {
  quote: string;
  words: Set<string>;
  /** Its figures as written, a transcript line's time among them. */
  figures: Set<string>;
  at: number;
}

const rowAt = (rows: readonly string[], index: number) => rows[index]?.trim() ?? "";

/** About how many words a text has: a CJK character is half of one. */
const wordCount = (text: string) =>
  (text.replace(CJK_RUN, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0) +
  (text.match(CJK_RUN)?.join("").length ?? 0) / 2;

/** Whether a row of a Passage is a heading, which states nothing to quote. */
function isHeading(rows: readonly string[], index: number): boolean {
  const row = rowAt(rows, index);
  if (/^#+\s/u.test(row) || TABLE_SEPARATOR.test(row)) return true;
  if (row.startsWith("|")) return TABLE_SEPARATOR.test(rowAt(rows, index + 1));
  if (CUE.test(row) || LIST_MARK.test(row) || CLOSING.test(row)) return false;
  const alone = rowAt(rows, index - 1) === "" && rowAt(rows, index + 1) === "";
  return alone && wordCount(row) <= MAX_TITLE_WORDS;
}

/** The sentences of a Passage's text a quote may be, headings left out. */
function linesOf(text: string): Line[] {
  const rows = text.split("\n");
  const lines: Line[] = [];
  for (const [index, raw] of rows.entries()) {
    const row = raw.trim();
    if (row === "" || isHeading(rows, index)) continue;
    for (const span of sentenceSpans(row)) {
      const sentence = row.slice(span.from, span.to).trim();
      const quote = asQuoted(sentence);
      if (quote === "") continue;
      lines.push({
        quote,
        words: wordSet(quote),
        figures: new Set(figuresOf(sentence)),
        at: lines.length,
      });
    }
  }
  return lines;
}

/**
 * The records for the markers of `text` that name a Passage the model was given (`passages`) and
 * have none yet (`recorded`), and the text with a marker of its own for each further quote and
 * without the markers whose claims no line holds. A marker naming no Passage is left as it is.
 */
export function markedPassages(
  text: string,
  passages: readonly { id: string; text: string; name?: string }[],
  found: (passage: string, quote: string) => boolean,
  recorded: (marker: number) => boolean,
): { text: string; records: CitationRecordInput[] } {
  const named = text.replace(NAMED, (_, number: string) => `[^${number}]`);
  const shown = new Map(passages.map((passage) => [passage.id.toUpperCase(), passage]));
  const said = new Set(
    passages.flatMap((passage) =>
      passage.text
        .split("\n")
        .filter((row) => CUE.test(row.trim()))
        .flatMap((row) => figuresOf(asQuoted(row.trim()))),
    ),
  );
  let next = Math.max(0, ...[...named.matchAll(MARKER)].map((each) => Number(each[1]))) + 1;
  const fresh = () => {
    while (recorded(next)) next++;
    return next++;
  };
  /** The marker each quote was recorded under: the Passage's own number first. */
  const markerOf = new Map<string, number>();
  const records: CitationRecordInput[] = [];
  const rewritten: { at: number; length: number; markers: number[] }[] = [];

  const sentences = answerSentences(named);
  const marks = sentences.flatMap((sentence, index) =>
    [...named.slice(sentence.start, sentence.end).matchAll(MARKER)].map((each) => {
      const at = sentence.start + each.index;
      const lead = named.slice(sentence.start, at).replace(MARKER, "").trim();
      const before = sentences[index - 1];
      const claimAt = lead === "" && before && wordsOf(before.text).size > 0 ? index - 1 : index;
      return { at, length: each[0].length, number: Number(each[1]), claimAt };
    }),
  );
  for (const claimAt of new Set(marks.map((mark) => mark.claimAt))) {
    const claim = claimOf(sentences[claimAt]?.text ?? "");
    const picked = marks
      .filter((mark) => mark.claimAt === claimAt)
      .flatMap((mark) => {
        const passage = shown.get(`P${mark.number}`);
        return passage && !recorded(mark.number)
          ? [{ ...mark, passage, quotes: quotesFor(passage, claim, found) }]
          : [];
      });
    const held = new Set(
      picked.flatMap((mark) => mark.quotes.flatMap((line) => [...line.figures])),
    );
    const missing = claim.figures.filter((figure) => !held.has(figure));
    const stated =
      missing.length === 0 ||
      (missing.every((figure) => said.has(figure)) &&
        claim.figures.some((figure) => held.has(figure)));
    for (const mark of picked) {
      const markers = (stated ? mark.quotes : []).map((line) => {
        const key = `${mark.passage.id}\n${line.quote}`;
        const taken = markerOf.get(key);
        if (taken !== undefined) return taken;
        const marker = [...markerOf.values()].includes(mark.number) ? fresh() : mark.number;
        markerOf.set(key, marker);
        records.push({ marker, passage: mark.passage.id, quote: line.quote });
        return marker;
      });
      if (markers.length === 0) {
        const space = /\s$/u.test(named.slice(0, mark.at)) ? 1 : 0;
        rewritten.push({ at: mark.at - space, length: mark.length + space, markers });
      } else if (markers.length > 1 || markers[0] !== mark.number) {
        rewritten.push({ at: mark.at, length: mark.length, markers });
      }
    }
  }
  let marked = named;
  for (const { at, length, markers } of rewritten.sort((a, b) => b.at - a.at)) {
    const written = markers.map((marker) => `[^${marker}]`).join("");
    marked = `${marked.slice(0, at)}${written}${marked.slice(at + length)}`;
  }
  return { text: marked, records };
}

/**
 * The lines of `passage` its claim rests on, each one the Citation check finds there: first the
 * one holding the most of the claim's figures, then of its words; then each that adds two of them,
 * a figure of the claim beside one of its words, or a word only it holds of a line mostly about
 * the claim. None when a line says the claim with a "not" more or less.
 */
function quotesFor(
  passage: { id: string; text: string; name?: string },
  claim: Claim,
  found: (passage: string, quote: string) => boolean,
): Line[] {
  const name = wordSet(passage.name ?? "");
  const lines = linesOf(passage.text);
  const answer = ANSWER.exec(claim.text)?.[1] ?? "";
  const negations = negationsOf(claim.text) - (wordCount(answer) <= 2 ? negationsOf(answer) : 0);
  const turned = (line: Line) =>
    likeness(claim.words, line.words).score >= RESTATED && negations !== negationsOf(line.quote);
  if (lines.some(turned)) return [];
  const evidence = (line: Line) => (word: string) => line.words.has(word) && !name.has(word);
  const quotes: Line[] = [];
  const holds = (word: string) => quotes.some((line) => evidence(line)(word));
  const figuresIn = (taken: readonly Line[]) =>
    new Set(claim.figures.filter((figure) => taken.some((line) => line.figures.has(figure)))).size;
  /** Whether the claim holds a word only this line holds, and at least `MIN_LINE_SHARE` of its words. */
  const onlyHere = (line: Line) => {
    const own = [...line.words].filter((word) => !name.has(word));
    return (
      own.filter((word) => claim.words.has(word)).length >= own.length * MIN_LINE_SHARE &&
      own.some(
        (word) =>
          !isFigure(word) &&
          claim.words.has(word) &&
          !holds(word) &&
          lines.every((other) => other === line || !other.words.has(word)),
      )
    );
  };
  /** A line giving figures, none of them the claim's, is about other ones: "$8 from 200 sensors" for "$9". */
  const aboutOtherFigures = (line: Line) =>
    claim.figures.length > 0 &&
    line.figures.size > 0 &&
    claim.figures.every((figure) => !line.figures.has(figure));
  while (quotes.length < MAX_QUOTES) {
    const first = quotes.length === 0;
    const next = lines
      .filter((line) => !quotes.includes(line))
      .map((line) => {
        const has = evidence(line);
        const either = (word: string) => holds(word) || has(word);
        return {
          line,
          figures: figuresIn([...quotes, line]) - figuresIn(quotes),
          gain: amount(claim, either) - amount(claim, holds),
          words: amount(claim, has, false),
          score: likeness(claim.words, line.words).score,
        };
      })
      .filter((each) =>
        first
          ? each.gain >= MIN_HELD
          : !aboutOtherFigures(each.line) &&
            (each.gain >= MIN_HELD || (each.figures > 0 && each.words > 0) || onlyHere(each.line)),
      )
      .sort(
        (a, b) =>
          b.figures - a.figures ||
          b.gain - a.gain ||
          b.words - a.words ||
          b.score - a.score ||
          a.line.at - b.line.at,
      )
      .find((each) => found(passage.id, each.line.quote));
    if (!next) break;
    quotes.push(next.line);
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
