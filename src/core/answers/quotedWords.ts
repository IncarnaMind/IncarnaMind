/**
 * The words an Answer puts in quotation marks (#483): a reader takes them for
 * the Document's exact words, so the Citation check looks for them too (see
 * `checkQuotedWords` in ./citations). This reads the Answer's Markdown: each
 * span in the quotation marks `cleanQuote` knows (but not the apostrophe's
 * "'", which "the firm's partners' vote" would pair), long enough to be a quote
 * and not a term or a name, and the Citation markers of the sentence it is in.
 */
import { cleanQuote, QUOTE_PAIRS } from "./citations";

/** A span counts as a quote with at least this many words... */
const MIN_WORDS = 4;
/** ...or, in Chinese or Japanese, this many characters. */
const MIN_CJK_CHARACTERS = 6;

/** The longest a quoted span may be, in characters: a longer one is a stray mark paired with a far one. */
const MAX_SPAN = 400;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD = /\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MARKER = /\[\^(\d{1,4})\]/g;
/** The comma or full stop that US and Chinese typography put inside the closing mark: not the Document's words. */
const TRAILING_PUNCTUATION = /[\s,.;:!?，。；：！？、]+$/u;

/** Words quoted in a sentence, and the Citation markers that sentence has. */
export interface QuotedSentence {
  /** What is between the quotation marks, as `cleanQuote` reads it. */
  words: string;
  /** The Citations' markers in the sentence, in order. */
  markers: number[];
}

/** Whether words are long enough to be a quote. */
function isQuote(words: string): boolean {
  const spaced = words.replace(CJK, " ");
  return (
    (spaced.match(WORD)?.length ?? 0) >= MIN_WORDS ||
    (words.match(CJK)?.length ?? 0) >= MIN_CJK_CHARACTERS
  );
}

interface Span {
  start: number;
  /** After the closing mark. */
  end: number;
}

/** Where a quotation mark opens at `at`: an ASCII one needs a space or punctuation before it, and a word after. */
function opensAt(text: string, at: number, open: string, close: string): boolean {
  if (open !== close && open !== "‘") return true;
  const before = text[at - 1];
  const after = text[at + 1];
  return (
    (before === undefined || !LETTER_OR_DIGIT.test(before)) &&
    after !== undefined &&
    !/\s/u.test(after)
  );
}

/** The index of the mark that closes one opened before `from`, or -1. */
function closingFrom(text: string, from: number, open: string, close: string): number {
  const limit = Math.min(text.length, from + MAX_SPAN);
  for (let at = from; at < limit; at++) {
    if (text[at] !== close) continue;
    const next = text[at + 1];
    // A closing ’ is not an apostrophe in a word ("firm’s"); a closing " follows its words, not a space.
    if (open === "‘" && next !== undefined && LETTER_OR_DIGIT.test(next)) continue;
    if (open === close && /\s/u.test(text[at - 1] ?? "")) continue;
    return at;
  }
  return -1;
}

/** The quoted spans of a block of text, in order. */
function spansOf(text: string): Span[] {
  const pairs = new Map(QUOTE_PAIRS.filter(([open]) => open !== "'"));
  const spans: Span[] = [];
  for (let at = 0; at < text.length; at++) {
    const open = text[at] as string;
    const close = pairs.get(open);
    if (close === undefined || !opensAt(text, at, open, close)) continue;
    const end = closingFrom(text, at + 1, open, close);
    if (end === -1) continue;
    spans.push({ start: at, end: end + 1 });
    at = end;
  }
  return spans;
}

/** What may follow a sentence's last mark and still belong to it: closing marks and its Citation markers. */
const TRAILING = /^["'”’)\]」』»）]*(?:\s*\[\^\d{1,4}\])*/u;
/** Whether a full stop, "!" or "?" ends a sentence: a space or the end follows it, past markers and closing marks. */
const ENDS_BEFORE_SPACE = /^(?:\[\^\d{1,4}\])*["'”’)\]]*(?:\s|$)/u;

/** The sentences of a block of text: a line ends one, and so does a full stop outside quotation marks. */
function sentencesOf(text: string, spans: readonly Span[]): Span[] {
  const sentences: Span[] = [];
  let start = 0;
  let span = 0;
  for (let at = 0; at < text.length; at++) {
    while (spans[span] && at >= (spans[span] as Span).end) span++;
    const inside = spans[span];
    if (inside && at >= inside.start) {
      at = inside.end - 1;
      continue;
    }
    const char = text[at] as string;
    if (char === "\n") {
      sentences.push({ start, end: at });
      start = at + 1;
    } else if (
      "。！？".includes(char) ||
      (".!?".includes(char) && ENDS_BEFORE_SPACE.test(text.slice(at + 1)))
    ) {
      const end = at + 1 + (TRAILING.exec(text.slice(at + 1))?.[0].length ?? 0);
      sentences.push({ start, end });
      start = end;
      at = end - 1;
    }
  }
  sentences.push({ start, end: text.length });
  return sentences;
}

interface QuotedSpan extends QuotedSentence {
  span: Span;
}

function quotedSpansIn(text: string, citedOnly = true): QuotedSpan[] {
  const spans = spansOf(text);
  if (spans.length === 0) return [];
  const found: QuotedSpan[] = [];
  for (const sentence of sentencesOf(text, spans)) {
    const markers = [...text.slice(sentence.start, sentence.end).matchAll(MARKER)].map((match) =>
      Number(match[1]),
    );
    if (citedOnly && markers.length === 0) continue;
    for (const span of spans) {
      if (span.start < sentence.start || span.end > sentence.end) continue;
      const words = cleanQuote(
        text
          .slice(span.start + 1, span.end - 1)
          .replace(MARKER, "")
          .replace(/[*`]+/g, ""),
      )
        .replace(/\s+/g, " ")
        .replace(TRAILING_PUNCTUATION, "");
      if (isQuote(words)) found.push({ words, markers, span });
    }
  }
  return found;
}

const FENCE = /^\s*(?:```|~~~)/;
const MATH_FENCE = /^\s*\$\$\s*$/;
const SKIPPED_LINE = /^\s*(?:\[\^\d{1,4}\]:|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^:?-{3,}:?$/;

// `change` must return as many lines as it is given.
function mapBlocks(markdown: string, change: (text: string) => string): string {
  const out: string[] = [];
  let paragraph: { prefix: string; text: string }[] = [];
  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    const lines = change(paragraph.map((line) => line.text).join("\n")).split("\n");
    for (const [at, line] of paragraph.entries()) out.push(`${line.prefix}${lines[at] ?? ""}`);
    paragraph = [];
  };
  let fenced = false;
  let math = false;
  for (const line of markdown.split("\n")) {
    const fence = FENCE.test(line);
    const mathFence = !fenced && MATH_FENCE.test(line);
    if (fence) fenced = !fenced;
    if (mathFence) math = !math;
    if (fence || mathFence || fenced || math || SKIPPED_LINE.test(line) || line.trim() === "") {
      closeParagraph();
      out.push(line);
    } else if (TABLE_ROW.test(line)) {
      closeParagraph();
      out.push(
        line
          .split("|")
          .map((cell) => {
            const trimmed = cell.trim();
            return trimmed === "" || TABLE_RULE.test(trimmed)
              ? cell
              : cell.replace(trimmed, () => change(trimmed));
          })
          .join("|"),
      );
    } else {
      const heading = /^\s*#{1,6}\s+/.exec(line)?.[0] ?? "";
      paragraph.push({ prefix: heading, text: line.slice(heading.length) });
    }
  }
  closeParagraph();
  return out.join("\n");
}

/**
 * The words an Answer's Markdown puts in quotation marks, each with the
 * Citation markers of its sentence; none in code, and none in a sentence
 * without a marker. A table's cell is a sentence of its own, and a quote may
 * run across a line break.
 */
export function quotedWordsIn(markdown: string): QuotedSentence[] {
  const found: QuotedSentence[] = [];
  mapBlocks(markdown, (text) => {
    for (const { words, markers } of quotedSpansIn(text)) found.push({ words, markers });
    return text;
  });
  return found;
}

/** Quoted facts, including sentences with no Citation marker (#1445). */
export function quotedFactsIn(markdown: string): QuotedSentence[] {
  const found: QuotedSentence[] = [];
  mapBlocks(markdown, (text) => {
    for (const { words, markers } of quotedSpansIn(text, false)) found.push({ words, markers });
    return text;
  });
  return found;
}

export function withoutQuotationMarks(markdown: string, words: ReadonlySet<string>): string {
  return mapBlocks(markdown, (text) => {
    let changed = text;
    for (const { words: quoted, span } of quotedSpansIn(text).reverse()) {
      if (!words.has(quoted)) continue;
      changed = `${changed.slice(0, span.start)}${changed.slice(span.start + 1, span.end - 1)}${changed.slice(span.end)}`;
    }
    return changed;
  });
}
