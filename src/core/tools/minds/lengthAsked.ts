/**
 * How long `edit_mind`'s new text came out, against the length the User asked for (#1385). The
 * size is measured here, from the text before and after, in words, a Chinese or Japanese
 * character counting as one, as the Note's own count counts: a model told only the two counts
 * worked out "about twice as long" for 3.6 times, and one asked for "a bit longer" wrote twice
 * as much. So the Tool holds new text to the multiple the model read from the User's words, and
 * the model is told the multiple to state, never left to work one out.
 */
import { INLINE_NODE, isClaim, sentenceSpans } from "../../../shared/sentences";
import { countFor, countText, mostlyCjk } from "../../../shared/wordCount";
import { tokensOf } from "./words";

interface Size {
  count: number;
  unit: "words" | "characters";
}

/** Citation markers, a rewrite's paragraph names, and a calculated figure's marker, which reads as one number. */
const NOT_WORDS = /\[\^?\d+\]|¶(?:\d+\+*|\++\d*)/g;
const FIGURE = /\[=\d+\]/g;

function sizeOf(text: string): Size {
  const count = countText(text.replace(NOT_WORDS, "").replace(FIGURE, "0"));
  return { count: countFor(count, "words"), unit: mostlyCjk(count) ? "characters" : "words" };
}

/** The most a model may ask for: past it, a multiple is taken for a count of words. */
const MOST_TIMES = 10;

/** The multiple of the text's length `times_as_long` asks for; null when it asks for none, as 1 does. */
export function timesAsked(value: unknown): number | null {
  const times =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(times) && times > 0 && times <= MOST_TIMES && times !== 1 ? times : null;
}

/**
 * The sizes new text may come to for `times` the size `was`: from a fifth under to a tenth over
 * "about" that, and never on the wrong side of the size now.
 */
function sizesAsked(was: number, times: number): { least: number; most: number } {
  const least = Math.ceil(was * times * 0.8);
  const most = Math.floor(was * times * 1.1);
  return times > 1
    ? { least: Math.max(least, was + 1), most: Math.max(most, was + 1) }
    : { least: Math.min(least, Math.max(was - 1, 0)), most: Math.min(most, Math.max(was - 1, 0)) };
}

const multipleOf = (was: number, now: number) => Math.round((now / was) * 10) / 10;

/**
 * How the text's length went, as the model is told it and may say it: both sizes, and the multiple
 * of the old one the new one is, with the multiple asked for when it is off by more than "about".
 */
export function lengthSaid(before: string, after: string, times: number | null = null): string {
  const was = sizeOf(before);
  const now = sizeOf(after);
  if (was.unit !== now.unit || was.count === 0) {
    return `from ${was.count} ${was.unit} to ${now.count} ${now.unit}`;
  }
  const multiple = multipleOf(was.count, now.count);
  const said = `from ${was.count} to ${now.count} ${now.unit}${now.count >= was.count ? ", not shorter" : ""}: ${multiple === 1 ? "about as long as before" : `${multiple} times as long`}`;
  if (times === null) return said;
  const { least, most } = sizesAsked(was.count, times);
  return now.count >= least && now.count <= most
    ? said
    : `${said}, where the User asked for about ${times} times`;
}

/**
 * Why `markdown` is not the length asked for, as the model is told it, with the sizes to write
 * it at; null when it is, or nothing can be measured.
 */
export function offLength(before: string, markdown: string, times: number): string | null {
  const was = sizeOf(before);
  const now = sizeOf(markdown);
  if (was.count === 0 || was.unit !== now.unit) return null;
  const { least, most } = sizesAsked(was.count, times);
  if (now.count >= least && now.count <= most) return null;
  // Sizes alone, no multiple: a reply repeated the multiple of the text refused.
  return `the new text is ${now.count} ${now.unit}, where the text there now is ${was.count}, and times_as_long asks for ${times} times. Write it again at ${least} to ${most} ${now.unit}, keeping each Citation it needs, then call edit_mind again with it.`;
}

/** The length a rewrite is asked to write `before` at, for `times` its size, said to it after its instruction. */
export function lengthToWrite(before: string, times: number): string {
  const was = sizeOf(before);
  if (was.count === 0) return "";
  const { least, most } = sizesAsked(was.count, times);
  return `Make the whole passage ${least} to ${most} ${was.unit} long: it is ${was.count} ${was.unit} now.`;
}

/** A sentence that shares less than this much of its words with the old text says something new. */
const RESTATED = 0.6;

const MARKER = /\[\^\d+\]|\[=\d+\]/g;

/**
 * The sentences `markdown` adds to `before` that make a claim with no Citation or calculated
 * figure: ones that don't restate the old text. Headings and tables are left out: a heading
 * claims nothing, and a table's cells are cited apart.
 */
export function addedUncited(before: string, markdown: string): string[] {
  const old = tokensOf(before);
  return markdown
    .split(/\n+/)
    .filter((line) => !/^\s*(?:#{1,6}\s|\|)/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*•>]|\d+[.)])\s+/u, ""))
    .flatMap((line) => {
      // A marker after a sentence's full stop is that sentence's, as sentenceSpans reads it.
      const marked = line.replace(MARKER, INLINE_NODE);
      return sentenceSpans(marked).map((span) => marked.slice(span.from, span.to));
    })
    .filter((sentence) => !sentence.includes(INLINE_NODE))
    .map((sentence) => sentence.replace(/\*\*|__|\*/g, "").trim())
    .filter((sentence) => {
      if (!isClaim(sentence)) return false;
      const tokens = tokensOf(sentence);
      if (tokens.size === 0) return false;
      let shared = 0;
      for (const token of tokens) if (old.has(token)) shared++;
      return shared / tokens.size < RESTATED;
    });
}
