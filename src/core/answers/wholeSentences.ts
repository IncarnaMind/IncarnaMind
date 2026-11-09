/**
 * The words a found quote is shown with (#2739): the whole sentence, or sentences, of its Units
 * that hold it. A model quotes part of the sentence it states, stopping where a PDF's printed line
 * ends ("…the Norvath Assembly on 22" for "…on 22 July 2022") or at a comma before the clause
 * that holds the claim; the Citation then shows words that don't say what its sentence does. Only
 * the shown words change, to the Document's own around the place the check found the quote.
 */
import { joinUnits, quoteInUnits } from "../../shared/locations";
import { readableQuote } from "../../shared/readableQuote";
import { sentenceSpans } from "../../shared/sentences";
import { foldRadicals, isCjk } from "../../shared/text";
import type { PageText } from "../documents/passages";
import type { Matching } from "./citations";

/** The longest a widened quote may be, in characters: past it, a "sentence" is a table or a list. */
const WIDEST_QUOTE = 500;

/**
 * A wrapped line fills the measure: one that ends this far short of the page's longest lines was
 * ended on purpose, as a heading, a paragraph's last line or a table row is.
 */
const FULL_LINE = 0.7;

const ENDS_SENTENCE = /[.!?。．！？；;:：…]/u;
/** A line that ends at a comma runs on, however short. */
const RUNS_ON = /[,，、]/u;
const HAS_WORDS = /[\p{L}\p{N}]/u;
/**
 * A line that starts a numbered heading or caption ("4.2 Delivery", "Section 4 …", "Table 1: …"): a
 * capital starting the line after it starts a sentence, where a numbered clause wraps to small letters.
 */
const HEADING =
  /^\s*(?:\d+(?:\.\d+)*\.?\s|(?:section|chapter|clause|article|part|table|figure)\s+\d)/iu;
/** A table's row: three numbers or more on one line. */
const ROW_OF_FIGURES = /(?:\d[\d,.]*%?\D+){2,}\d/u;
const MONTH = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\p{Ll}*\b`;
/**
 * A line that starts a note, a footnote or a list's item: "*", "†", a superscript digit, a bullet
 * or dash, "[1]", "(a)", "①", "（一）", "一、", "注："; a number before a bracket, a quotation mark or
 * another number ("1 [2019] EWCA Civ 1", "1 （2019）最高法民终 1 号", "1 28 U.S.C."); or a number
 * before a capitalised word, spaced or not ("1 The respondent", "1The", not "22 July" or "23 GB").
 */
const NOTE_OR_ITEM = new RegExp(
  String.raw`^\s*(?:[*†‡§¶•·▪◦–—-]|[⁰¹²³⁴⁵⁶⁷⁸⁹①-⑳]|\[\d{1,3}\]|\(?[a-z0-9]{1,3}\)\s|[(（][一二三四五六七八九十\d]{1,3}[)）]|[一二三四五六七八九十]{1,3}、|注[：:]|\d{1,3}(?:\.?\s+[\[(“"‘'「『《\d]|\s*[（［【〔])|\d{1,3}\.?\s*(?!${MONTH})\p{Lu}\p{Ll})`,
  "u",
);
const CAPITAL = /\p{Lu}/u;
/**
 * A sentence's end, with the closing marks and bracketed reference marks after it ("…提出的。[2]"):
 * text that ends otherwise, a decimal's digits included, is likely a table's rows, a list or a
 * heading, and the quote stays as given.
 */
const ENDS_PROSE = /[.!?。．！？…](?:["'”’»」』)）\]】]|\[\d{1,3}\])*\s*$/u;
const TRAILING_OPENERS = /[\s[（(「『“‘《]+$/u;
/** A reference mark the sentence before closes ("…提出的。[2]"), which the segmenter gives the next. */
const LEADING_REFERENCES = /^(?:\[?\d{1,3}\]\s*)+/u;

/** The length a page's full lines reach: the 90th percentile of its lines' lengths. */
function fullLength(lines: readonly string[]): number {
  const lengths = lines.map((line) => line.trim().length).filter((length) => length > 0);
  if (lengths.length === 0) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.ceil((lengths.length - 1) * 0.9)] ?? 0;
}

/**
 * `text` with each newline a PDF page wrapped at read as a space, so the sentences run on across
 * it, and each tab between a table's cells as a newline, so they don't; same length, so offsets
 * hold. The measure is the page's lines as printed, tabs and all. One after a comma always wraps.
 * Chinese and Japanese wraps were joined when the page was read, so a newline beside them was
 * printed on purpose; so was one after a sentence's end, a line well short of the measure, a table's
 * row or cells, a numbered heading or caption, or one before a note, a footnote, a list's item or a
 * table's cells. Other kinds of Units break their lines on purpose.
 */
function wrapsAsSpaces(text: string, units: readonly PageText[]): string {
  const cells = (line: string) => line.replaceAll("\t", "\n");
  if (!units.every((unit) => (unit.kind ?? "page") === "page")) return cells(text);
  const lines = text.split("\n");
  const full = fullLength(lines) * FULL_LINE;
  return lines
    .map((line, index) => {
      const next = lines[index + 1];
      if (next === undefined) return cells(line);
      const before = line.trimEnd().at(-1) ?? "";
      const after = next.trimStart()[0] ?? "";
      const wraps =
        before !== "" &&
        after !== "" &&
        !line.includes("\t") &&
        !next.includes("\t") &&
        !NOTE_OR_ITEM.test(next) &&
        !(HEADING.test(line) && CAPITAL.test(after)) &&
        !ROW_OF_FIGURES.test(line) &&
        (RUNS_ON.test(before) ||
          (!ENDS_SENTENCE.test(before) &&
            !isCjk(before) &&
            !isCjk(after) &&
            line.trim().length >= full));
      return wraps ? `${cells(line)} ` : `${cells(line)}\n`;
    })
    .join("");
}

/**
 * The quote widened to the whole sentences of `units` it is in, read as a card shows a quote; the
 * quote as given when it is whole sentences already, when the check doesn't find it in one place,
 * in a sheet's rows or a Transcript's lines, in text that doesn't end a sentence there (a table, a
 * list, a sentence that runs on past its page), or when the sentences would be longer than
 * `WIDEST_QUOTE`. A PDF's heading with no number that fills a line can still read as the start of
 * the sentence after it. What it gives is always found where the quote is.
 */
export function wholeSentences(
  units: readonly PageText[],
  quote: string,
  matching: Matching = {},
): string {
  if (!quote || units.length === 0) return quote;
  if (units.some((unit) => unit.kind === "rows" || unit.kind === "cues")) return quote;
  const ranges = quoteInUnits(units, quote, { ...matching, unique: true });
  const first = ranges?.[0];
  const last = ranges?.at(-1);
  if (!first || !last) return quote;
  const { text } = joinUnits(units);
  const holding = sentenceSpans(wrapsAsSpaces(text, units)).filter(
    (span) => span.from < last.end && span.to > first.start,
  );
  let from = Math.min(first.start, holding[0]?.from ?? first.start);
  from += LEADING_REFERENCES.exec(text.slice(from, first.start))?.[0].length ?? 0;
  let to = Math.max(last.end, holding.at(-1)?.to ?? last.end);
  to = from + text.slice(from, to).replace(TRAILING_OPENERS, "").length;
  if (!ENDS_PROSE.test(text.slice(from, to))) return quote;
  const added = text.slice(from, first.start) + text.slice(Math.max(last.end, from), to);
  if (!HAS_WORDS.test(added) || to - from > WIDEST_QUOTE) return quote;
  const widened = foldRadicals(readableQuote(text, [{ start: from, end: to }]));
  return quoteInUnits(units, widened, { ...matching, unique: true }) ? widened : quote;
}
