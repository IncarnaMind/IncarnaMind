/**
 * The words an Answer puts in quotation marks (#483): a reader takes them for
 * the Document's exact words, so every place that checks a Citation looks for
 * them too, by the one rule here (#2712). This reads the Answer's Markdown:
 * each span in the quotation marks `cleanQuote` knows (but not the
 * apostrophe's "'", which "the firm's partners' vote" would pair), long enough
 * to be a quote and not a term or a name, and the Citation markers of the
 * sentence it is in. `quotedWordsVerdict` then decides whether the words are
 * on the pages their Citations cite.
 */
import { ADDABLE_EXTENSIONS } from "../../shared/addFilesAction";
import { joinUnits, quoteInUnits } from "../../shared/locations";
import { documentWordingIn } from "../../shared/quoteMarks";
import { findQuote, type TextRange } from "../../shared/quoteMatch";
import { INLINE_NODE, sentenceSpans } from "../../shared/sentences";
import { CJK as CJK_SCRIPTS } from "../../shared/text";
import type { QuotedWords } from "../api";
import { holdsFigure } from "../documents/formats/grid";
import type { PageText } from "../documents/passages";
import { writtenInCjk } from "../documents/textLanguage";
import { cleanQuote, type Matching, QUOTE_PAIRS } from "./citations";
import { closestWords } from "./closestWords";

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

/** What may stand between a quote's closing mark and the end of its sentence: closing marks and brackets, emphasis, spaces and Citations. */
const AFTER_THE_QUOTE = /^["'”’)\]）】」』»*_~\s￼]*$/u;
/** A full stop, past its closing marks, Citations and at least one space, before an opening quotation mark. */
const STOP_BEFORE_QUOTE = /\.["'”’)\]）」』»￼]*\s["'”’)\]）」』»￼\s]*?(?=["'“‘「『«„‹])/gu;
/** Opening quotation marks the splitter leaves at the end of a sentence ("增长了。“"). */
const OPENING_AT_END = /[“‘「『«„‹]+$/u;

/** Whether the shared splitter reads on past the full stop that ends `text`, and its closing marks and Citations: an abbreviation or a page reference it lists. */
const readsOnPast = (text: string) => (sentenceSpans(`${text} 1`).at(-1)?.from ?? 0) < text.length;

/**
 * The shared splitter's sentences cut again before each opening quotation mark: after a full
 * stop and a space, though a lowercase word follows ("rose. “the fee…”") and the stop's
 * Citations stand between ("rose.[^1] “…”"), which stay with the sentence before, unless the
 * splitter reads on past the stop ("Mr. “…”"); and where the splitter leaves the mark at the end
 * of the sentence before ("增长了。“").
 */
function cutBeforeQuotes(read: string): Span[] {
  const pieces: Span[] = [];
  for (const { from, to } of sentenceSpans(read)) {
    let start = from;
    for (const stop of read.slice(from, to).matchAll(STOP_BEFORE_QUOTE)) {
      const at = from + stop.index;
      if (readsOnPast(read.slice(start, at + stop[0].trimEnd().length))) continue;
      pieces.push({ start, end: at + stop[0].length });
      start = at + stop[0].length;
    }
    const opening = OPENING_AT_END.exec(read.slice(start, to))?.[0].length ?? 0;
    if (opening > 0 && to - opening > start) {
      pieces.push({ start, end: to - opening });
      pieces.push({ start: to - opening, end: to });
    } else pieces.push({ start, end: to });
  }
  return pieces;
}

/**
 * The sentences of a block of text, as the shared splitter reads a paragraph (#2712), each
 * Citation marker read as the node it becomes, so "Mr. Smith" and "Fig. 2" end none. Quoted words
 * add two rules, both about quotation marks: a sentence starts at an opening quotation mark after
 * a sentence's end (`cutBeforeQuotes`), and it doesn't end inside quotation marks, nor at a full
 * stop inside them, past their closing marks and brackets (`.”)`, `。”）`), unless a line break
 * comes first.
 */
function sentencesOf(text: string, spans: readonly Span[]): Span[] {
  const read = text.replace(MARKER, (marker) => INLINE_NODE.repeat(marker.length));
  const sentences: Span[] = [];
  for (const { start: from, end: to } of cutBeforeQuotes(read)) {
    const previous = sentences.at(-1);
    const held =
      previous !== undefined &&
      spans.some(
        (span) =>
          span.start < previous.end &&
          (span.end > previous.end ||
            (AFTER_THE_QUOTE.test(read.slice(span.end, previous.end)) &&
              !read.slice(span.end, from).includes("\n"))),
      );
    if (previous && held) previous.end = to;
    else sentences.push({ start: from, end: to });
  }
  return sentences;
}

interface QuotedSpan extends QuotedSentence {
  span: Span;
}

function quotedSpansIn(text: string): QuotedSpan[] {
  const spans = spansOf(text);
  if (spans.length === 0) return [];
  const found: QuotedSpan[] = [];
  for (const sentence of sentencesOf(text, spans)) {
    const markers = [...text.slice(sentence.start, sentence.end).matchAll(MARKER)].map((match) =>
      Number(match[1]),
    );
    if (markers.length === 0) continue;
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

/** A Document's name or quoted words as they are compared (#2504): NFKC, lower case, one space. */
const nameText = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** A character a file name can't hold on macOS, Windows or Linux. */
const UNHELD = /[/\\:*?"<>|]/u;
const DIGIT = /\p{N}/u;

/**
 * Whether words in quotation marks are a name as `nameText` reads both (#2504). Every character
 * is the same, signs, dashes and figures included, so no other figure or words equal the name. One
 * a file name can't hold may stand for a space or for nothing in the name, as a title's colon does
 * ("Gradient Descent: The Ultimate Optimizer"), unless it touches a digit ("3:1", "1/2", "<5%"),
 * where only a colon or question mark that ends a title before a space goes ("Part 2: Results").
 */
function isNameOf(words: string, name: string): boolean {
  const chars = [...nameText(words)];
  const pattern = chars
    .map((char, at) => {
      const escaped = char.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
      if (!UNHELD.test(char)) return escaped;
      const after = chars[at + 1] ?? "";
      const endsTitle = (char === ":" || char === "?") && (after === " " || after === "");
      const figure = DIGIT.test(after) || (DIGIT.test(chars[at - 1] ?? "") && !endsTitle);
      return figure ? escaped : `(?:${escaped}| )?`;
    })
    .join("");
  return new RegExp(`^${pattern}$`, "u").test(nameText(name));
}

/**
 * The ways a Document's name, as the app shows it, is read for a name in quotation marks (#2504):
 * whole, and each whole part at a separator. An extension the app adds files by is taken off,
 * and it splits at " - ", " – ", " — ", "|", "｜", "－", "—", "―" and "_", and at "-" or "–" next
 * to a CJK character, never inside a Latin word ("Cooling-off") and never at a dash a digit
 * follows, even across a space or a point, which is a minus sign ("同比-5%", "同比－ 5%"). A middle
 * dot doesn't split: it joins a name ("安娜·米勒").
 */
function nameForms(name: string): string[] {
  const extension = name.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase();
  const bare =
    extension && ADDABLE_EXTENSIONS.includes(extension)
      ? name.slice(0, -extension.length - 1)
      : name;
  return [name, bare, ...bare.split(NAME_SEPARATOR)].filter((form) => nameText(form) !== "");
}
const NAME_SEPARATOR = new RegExp(
  `\\s[-–—―]\\s|[|｜_]|[－—―](?![ .]?\\p{N})|(?<=[${CJK_SCRIPTS}])[-–](?![ .]?\\p{N})|[-–](?=[${CJK_SCRIPTS}])`,
  "u",
);

/**
 * The text of a sheet's title rows, above its header, in a Document version's Units: the rows
 * that name the table a Citation's rows are in, which an Answer may quote as the table's title
 * while citing one of its rows (#2358). A title row that holds a figure names nothing (#2373). A
 * sheet read in one block keeps its title rows in the cited Unit itself.
 */
export function titleRowsOf(units: readonly PageText[], sheet: string | null): string {
  const rowsOfSheet = units.filter(
    (unit) => unit.kind === "rows" && (unit.label?.sheet ?? null) === sheet,
  );
  const header = rowsOfSheet.find((unit) => unit.label?.header)?.label?.rows?.[0] ?? null;
  const first = rowsOfSheet.reduce<PageText | null>(
    (earliest, unit) =>
      !earliest || (unit.label?.from ?? 0) < (earliest.label?.from ?? 0) ? unit : earliest,
    null,
  );
  const rows = first?.label?.rows ?? [];
  if (header === null || !first) return "";
  return first.text
    .split("\n")
    .filter((line, at) => {
      const row = rows[at] ?? 0;
      return row > 0 && row < header && !line.split("\t").some((cell) => holdsFigure(cell));
    })
    .join("\n");
}

/** What the check of quoted words reads of one Citation the sentence holds (#2712). */
export interface QuotedWordsPlace {
  /** The stored text of the Units it cites, of the version it quotes. */
  units: readonly PageText[];
  /** How quotes are matched in that version's text. */
  matching: Matching;
  /** Where its Units state the words, looked for as its own quote is: in a Transcript, at its time. */
  find(words: string): readonly TextRange[] | null;
  /** Its Document's name as the app shows it; null when it isn't known. */
  documentName: string | null;
  /** When it cites one Unit: that Unit and the next one of its Document, in order; else null. */
  throughNextUnit(): readonly PageText[] | null;
  /** The text of the title rows of a sheet of its Document (`titleRowsOf`). */
  titleRows(sheet: string | null): string;
  /** Its own check couldn't be made, so nothing it cites can be said to lack the words. */
  cantCheck: boolean;
}

/**
 * What the check of quoted words found, and through which of the sentence's Citations: "stated"
 * by their cited Units, a "name" of a Document (the cited ones it names, maybe none), words that
 * "run-on" from the one page cited to the next, a sheet's "title" rows, a "translation" into
 * another language than every page cited, "not-checked" with a Citation that couldn't be, or
 * "not-found" anywhere a rule looks.
 */
export type QuotedWordsVerdict<T> =
  | { kind: "stated"; by: T[] }
  | { kind: "name"; by: T[] }
  | { kind: "run-on"; by: T; next: PageText }
  | { kind: "title"; by: T[] }
  | { kind: "translation" }
  | { kind: "not-checked" }
  | { kind: "not-found" };

/**
 * Whether the words start on the one page a place cites and run on to the next page: a
 * record's quote ends where its page does, as a Passage may, and the Answer may quote on
 * (#2504). Only a document's pages run on; a slide or a section is a place of its own.
 */
function nextPageRunOn(place: QuotedWordsPlace, words: string): PageText | null {
  const units = place.throughNextUnit();
  if (!units) return null;
  const first = units[0];
  const next = units.findIndex((unit) => first?.page != null && unit.page === first.page + 1);
  if (next <= 0 || !units.every((unit) => (unit.kind ?? "page") === "page")) return null;
  const found = quoteInUnits(units, words, place.matching);
  const nextStarts = joinUnits(units).starts[next] ?? 0;
  return found?.every((range) => range.start < nextStarts) === true
    ? (units[next] as PageText)
    : null;
}

/** Whether the words are the title rows of the sheet a place's rows are in (#2358). */
function titledBy(place: QuotedWordsPlace, words: string): boolean {
  const rows = place.units.find((unit) => unit.kind === "rows");
  if (!rows) return false;
  const text = place.titleRows(rows.label?.sheet ?? null);
  return text !== "" && findQuote(text, words, { ...place.matching, numbers: true }) !== null;
}

/**
 * The one rule for words in quotation marks (#483, #2712), wherever a Citation is checked:
 * looked for with the Citation check's own matching in the Units each Citation of the sentence
 * cites; else a Document's name in quotation marks, as an Answer gives a title, is a name and not
 * a quote, where a part of a name counts only for a Document the sentence cites and `names` are
 * other Documents' whole names; else words that start on the one page a Citation cites may run
 * on to the next page (#2504); else a sheet's title rows (#2358); else words in another language
 * than every page cited are a translation, not checked. Where a Citation of the sentence couldn't
 * be checked, the words aren't either.
 */
export function quotedWordsVerdict<T extends QuotedWordsPlace>(
  words: string,
  cited: readonly T[],
  names: readonly string[],
): QuotedWordsVerdict<T> {
  if (cited.some((place) => place.cantCheck)) return { kind: "not-checked" };
  const stating = cited.filter((place) => place.find(words) !== null);
  if (stating.length > 0) return { kind: "stated", by: stating };
  const named = cited.filter(
    ({ documentName }) =>
      documentName !== null && nameForms(documentName).some((form) => isNameOf(words, form)),
  );
  if (named.length > 0 || names.some((name) => isNameOf(words, name))) {
    return { kind: "name", by: named };
  }
  for (const place of cited) {
    const next = nextPageRunOn(place, words);
    if (next) return { kind: "run-on", by: place, next };
  }
  const titled = cited.filter((place) => titledBy(place, words));
  if (titled.length > 0) return { kind: "title", by: titled };
  const inCjk = writtenInCjk(words);
  if (
    cited.length > 0 &&
    cited.every(({ units }) => writtenInCjk(units.map((unit) => unit.text).join("\n")) !== inCjk)
  ) {
    return { kind: "translation" };
  }
  return { kind: "not-found" };
}

/**
 * The place whose Units hold the words nearest the ones not found, for its card: the Answer's
 * words and the Document's nearest, with the Document's own words where only the kind of their
 * quotation marks differs, for the card to offer them (#2605). Null for no place.
 */
export function nearestPlace<T extends QuotedWordsPlace>(
  words: string,
  cited: readonly T[],
): { place: T; shown(): QuotedWords } | null {
  let nearest: { place: T; closest: ReturnType<typeof closestWords> } | undefined;
  for (const place of cited) {
    const closest = closestWords(place.units, words, place.matching);
    if (!nearest || closest.near > nearest.closest.near) nearest = { place, closest };
  }
  if (!nearest) return null;
  const { place, closest } = nearest;
  return {
    place,
    shown: () => {
      const wording = documentWordingIn(words, joinUnits(place.units).text);
      return wording ? { ...closest.shown, documentWording: wording } : closest.shown;
    },
  };
}
