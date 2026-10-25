/**
 * Dates an Answer gives that its Documents' text doesn't (#1173): a contract
 * whose text gives no date was said to be signed on the day its PDF was made.
 * A date in a sentence that names it as the file's ("file created on …",
 * "文件创建于 …") is the file's, which the Answer may say, and isn't counted.
 * And how many of a summary's sentences outside its headings carry a Citation.
 */
import {
  comparableSentence,
  INLINE_NODE,
  isClaim,
  sentenceSpans,
} from "../../src/shared/sentences";

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;
const MONTH =
  "(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "((?:19|20)\\d{2})";

/** Each way a date is written, with where its year, month and day are in the match. */
const WRITTEN: readonly { pattern: RegExp; year: number; month?: number; day?: number }[] = [
  {
    pattern: new RegExp(`(?<!\\d)${YEAR}[-/](\\d{1,2})(?:[-/](\\d{1,2}))?(?!\\d)`, "g"),
    year: 1,
    month: 2,
    day: 3,
  },
  {
    pattern: new RegExp(`${YEAR}\\s*年(?:\\s*(\\d{1,2})\\s*月(?:\\s*(\\d{1,2})\\s*日)?)?`, "g"),
    year: 1,
    month: 2,
    day: 3,
  },
  { pattern: new RegExp(`\\b${DAY}\\s+${MONTH},?\\s+${YEAR}\\b`, "gi"), year: 3, month: 2, day: 1 },
  { pattern: new RegExp(`\\b${MONTH}\\s+${DAY},?\\s+${YEAR}\\b`, "gi"), year: 3, month: 1, day: 2 },
  { pattern: new RegExp(`\\b${MONTH}\\s+${YEAR}\\b`, "gi"), year: 2, month: 1 },
  { pattern: new RegExp(`(?<![\\d,.])${YEAR}(?![\\d,.]\\d)`, "g"), year: 1 },
];

const two = (value: string) => value.padStart(2, "0");

function monthOf(written: string): string {
  const number = Number(written);
  if (Number.isInteger(number)) return two(written);
  const index = MONTHS.indexOf(written.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
  return two(String(index + 1));
}

/** The dates a text writes, as ISO 8601 at the precision written: "2024-03-12", "2024-03", "2024". */
export function datesIn(text: string): string[] {
  const found: { at: number; date: string }[] = [];
  const taken: [number, number][] = [];
  for (const { pattern, year, month, day } of WRITTEN) {
    for (const match of text.matchAll(pattern)) {
      const from = match.index;
      const to = from + match[0].length;
      if (taken.some(([start, end]) => from < end && to > start)) continue;
      taken.push([from, to]);
      const parts = [match[year] as string];
      const monthWritten = month === undefined ? undefined : match[month];
      if (monthWritten) {
        parts.push(monthOf(monthWritten));
        const dayWritten = day === undefined ? undefined : match[day];
        if (dayWritten) parts.push(two(dayWritten));
      }
      found.push({ at: from, date: parts.join("-") });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ date }) => date);
}

const FILE_INFORMATION =
  /\bfiles?\b[^.!?]*\b(?:created|creation|modified|modification|changed|saved|made)\b|\b(?:created|creation|modified|modification|last changed|saved)\b[^.!?]*\bfiles?\b|文件[^。！？]*(?:创建|修改|生成|保存)|(?:创建|修改|生成|保存)[^。！？]*文件/i;

/** The dates an Answer gives that no Document's text writes, leaving out those named as a file's. */
export function datesNotInText(answer: string, texts: readonly string[]): string[] {
  const written = texts.flatMap(datesIn);
  const stated = (date: string) => written.some((each) => each.startsWith(date));
  const missing: string[] = [];
  for (const line of answer.split("\n")) {
    for (const { from, to } of sentenceSpans(line)) {
      const sentence = line.slice(from, to);
      if (FILE_INFORMATION.test(sentence)) continue;
      for (const date of datesIn(sentence)) {
        if (!stated(date) && !missing.includes(date)) missing.push(date);
      }
    }
  }
  return missing;
}

const MARKERS = /\s?\[\^\d+\]/g;
const BLOCK_MARKUP = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/;
const HEADING = /^\s*#{1,6}\s/;
const FOOTNOTE_LINE = /^\s*\[\^\d+\]:/;

/**
 * An Answer's sentences outside its headings that make a claim (see
 * `isClaim`), and how many of them carry a Citation marker. A line that only
 * introduces a list ("The key terms:") is no claim, nor is a table's ruling.
 */
export function citedClaims(answer: string): { claims: number; cited: number } {
  let claims = 0;
  let cited = 0;
  for (const raw of answer.split("\n")) {
    if (HEADING.test(raw) || FOOTNOTE_LINE.test(raw) || /^\s*\|?[\s:|-]*$/.test(raw)) continue;
    // A marker is one inline node, as in a Mind, so one after a full stop stays with its sentence.
    const line = raw.replace(BLOCK_MARKUP, "").replace(/\|/g, " ").replace(MARKERS, INLINE_NODE);
    if (/[:：]\s*$/.test(line)) continue;
    for (const { from, to } of sentenceSpans(line)) {
      const sentence = line.slice(from, to);
      if (!isClaim(comparableSentence(sentence))) continue;
      claims++;
      if (sentence.includes(INLINE_NODE)) cited++;
    }
  }
  return { claims, cited };
}
