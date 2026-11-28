/**
 * What an edit does to the User's sentences, read from the text before it and after it, never
 * from what the model says it did (#2356): each sentence kept word for word, taken out whole,
 * shortened by words taken out, or rewritten, as when two are joined or one is reworded. The core
 * tells the model so, and an edit the assistant says was asked only to take text out waits for the
 * User when it does more, by this one reading.
 */
import * as Y from "yjs";
import {
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type RemovedParagraphs,
  type SentenceChanges,
} from "../core/api";
import { splitWords } from "../core/proposals/diff";
import { markValueOf } from "./markKeys";
import { readProposalAttribute, readProposalRef, TEXT_BLOCKS } from "./proposals";
import { sentenceSpans } from "./sentences";

/** The most of the User's sentences named of each kind. */
const NAMED = 6;

interface Sentence {
  text: string;
  /** Its words and marks, without the spaces between them. */
  tokens: string[];
}

function sentencesOf(paragraphs: readonly string[]): Sentence[] {
  return paragraphs.flatMap((paragraph) =>
    sentenceSpans(paragraph).flatMap((span) => {
      const text = paragraph.slice(span.from, span.to).replace(/\s+/gu, " ").trim();
      const tokens = splitWords(text).filter((token) => token.trim() !== "");
      return tokens.length > 0 ? [{ text, tokens }] : [];
    }),
  );
}

/** Whether `after` is `before` with tokens taken out, in order, and none written. */
function takenFrom(before: readonly string[], after: readonly string[]): boolean {
  let at = 0;
  for (const token of after) {
    while (at < before.length && before[at] !== token) at++;
    if (at === before.length) return false;
    at++;
  }
  return true;
}

const wordsOf = (sentence: Sentence) =>
  sentence.tokens
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .map((token) => token.toLowerCase());

/**
 * What the change from `before` to `after`, each a list of paragraphs, does to the sentences of
 * `before`. Each sentence after it is one before it (kept), one before it with words or marks taken
 * out (shortened), or new; a sentence before it that none of those is was rewritten when most of
 * its words are in the new ones, else taken out whole.
 */
export function sentenceChanges(
  before: readonly string[],
  after: readonly string[],
): SentenceChanges {
  const was = sentencesOf(before);
  const now = sentencesOf(after);
  const matched = new Set<number>();
  const written: Sentence[] = [];
  let kept = 0;
  let shortened = 0;
  let from = 0;
  for (const sentence of now) {
    let match = -1;
    for (let at = from; at < was.length && match < 0; at++) {
      if (takenFrom(was[at]?.tokens ?? [], sentence.tokens)) match = at;
    }
    if (match < 0) {
      written.push(sentence);
      continue;
    }
    matched.add(match);
    from = match + 1;
    if (was[match]?.tokens.length === sentence.tokens.length) kept++;
    else shortened++;
  }
  const writtenWords = new Set(written.flatMap(wordsOf));
  const takenOut: string[] = [];
  const rewritten: string[] = [];
  was.forEach((sentence, at) => {
    if (matched.has(at)) return;
    const words = wordsOf(sentence);
    const again = words.filter((word) => writtenWords.has(word)).length;
    (words.length > 0 && again / words.length > 0.5 ? rewritten : takenOut).push(sentence.text);
  });
  return {
    kept,
    takenOut: takenOut.length,
    shortened,
    rewritten: rewritten.length,
    written: written.length,
    named: { takenOut: takenOut.slice(0, NAMED), rewritten: rewritten.slice(0, NAMED) },
  };
}

/** The sentences of `before` most of whose words `written` holds: written again, as they were or reworded. */
export function writtenAgain(before: readonly string[], written: readonly string[]): string[] {
  const words = new Set(sentencesOf(written).flatMap(wordsOf));
  return sentencesOf(before).flatMap((sentence) => {
    const own = wordsOf(sentence);
    const again = own.filter((word) => words.has(word)).length;
    return own.length > 0 && again / own.length > 0.5 ? [sentence.text] : [];
  });
}

/** How wide a paragraph's start may be, in screen columns: a Chinese character takes two. */
const START_COLUMNS = 32;

/** Characters that stand alone as their own word, as written without spaces: Chinese, Japanese, Korean and full-width marks. */
const SOLO =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff00-\\uffef";
const SOLO_CHARACTER = new RegExp(`[${SOLO}]`, "u");
/** A word: one such character, or a run of the others between spaces, so "07:40" and "1,240" are one. */
const WORD = new RegExp(`[${SOLO}]|[^\\s${SOLO}]+`, "gu");
/** What a cut start doesn't end on: the comma or colon its next words would have followed. */
const DANGLING = /[\s,;:，；：、\-–—([（“‘"']+$/u;

const columns = (text: string): number =>
  [...text].reduce((sum, each) => sum + (SOLO_CHARACTER.test(each) ? 2 : 1), 0);

/** The first characters of `text` that fit `START_COLUMNS`. */
function fitting(text: string): string {
  let kept = "";
  for (const each of text) {
    if (columns(kept) + columns(each) > START_COLUMNS) break;
    kept += each;
  }
  return kept;
}

/**
 * The start of `text` as whole words that fit `START_COLUMNS`, and whether that is all of it. The
 * first word is always taken, though a run with no space that is far wider than the room (a link)
 * is cut at the room.
 */
function firstOf(text: string): { start: string; whole: boolean } {
  let used = 0;
  let end = 0;
  for (const word of text.matchAll(WORD)) {
    const at = word.index ?? 0;
    const next = used + columns(text.slice(end, at)) + columns(word[0]);
    if (end > 0 && next > START_COLUMNS) return { start: text.slice(0, end), whole: false };
    if (end === 0 && next > START_COLUMNS * 2) return { start: fitting(word[0]), whole: false };
    used = next;
    end = at + word[0].length;
  }
  return { start: text, whole: true };
}

/**
 * How a paragraph is named where its change is said: its label without the colon ("Parking"), or
 * its first words, as many whole words as fit `START_COLUMNS`, with "…" only where something was
 * cut. A word or number ("07:40", "1,240") is never cut, and a colon inside one never ends a label.
 */
export function paragraphStart(text: string): string {
  const plain = text.replace(/\s+/gu, " ").trim();
  const label = /^([^:：]+)(?:：|:(?=\s))\s*\S/u.exec(plain)?.[1]?.trim();
  if (label && firstOf(label).whole) return label;
  const { start, whole } = firstOf(plain);
  if (whole) return start;
  const cut = start.replace(DANGLING, "");
  return `${cut === "" ? start : cut}…`;
}

/** What removing these whole paragraphs takes out, as the line and the card say it. */
export function paragraphsRemoved(paragraphs: readonly string[]): RemovedParagraphs {
  return {
    paragraphs: paragraphs.length,
    sentences: sentencesOf(paragraphs).length,
    start: paragraphStart(paragraphs[0] ?? ""),
  };
}

/** Whether a change only takes text out: some of the User's, and nothing rewritten or written. */
export const takesOnlyOut = (changes: SentenceChanges): boolean =>
  changes.rewritten === 0 && changes.written === 0 && changes.takenOut + changes.shortened > 0;

interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

/** The text `requests`' Proposals write, wherever they write it: Blocks added whole, and words added. */
export function writtenBy(blocks: Y.XmlFragment, requests: ReadonlySet<string>): string[] {
  const written: string[] = [];
  const ours = (value: unknown) => {
    const ref = readProposalRef(value);
    return ref !== null && requests.has(ref.request);
  };
  const visit = (parent: Y.XmlFragment | Y.XmlElement, added: boolean) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
      const whole = added || (proposal?.kind === "insert" && requests.has(proposal.request));
      if (!TEXT_BLOCKS.has(child.nodeName)) {
        visit(child, whole);
        continue;
      }
      let text = "";
      for (const part of child.toArray()) {
        if (!(part instanceof Y.XmlText)) continue;
        for (const run of part.toDelta() as Run[]) {
          if (typeof run.insert !== "string") continue;
          if (whole || ours(markValueOf(PROPOSAL_INSERT_MARK, run.attributes))) text += run.insert;
        }
      }
      if (text !== "") written.push(text);
    }
  };
  visit(blocks, false);
  return written;
}

/**
 * The paragraphs and headings `request`'s Proposals touch, wherever they are (a list item, a table
 * cell), as they read now and as they will read once its changes are accepted.
 */
export function changedText(
  blocks: Y.XmlFragment,
  request: string,
): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  const ours = (value: unknown) => readProposalRef(value)?.request === request;
  const visit = (parent: Y.XmlFragment | Y.XmlElement, whole: "insert" | "delete" | null) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
      const own = whole ?? (proposal?.request === request ? proposal.kind : null);
      if (!TEXT_BLOCKS.has(child.nodeName)) {
        visit(child, own);
        continue;
      }
      let was = "";
      let will = "";
      let touched = own !== null;
      for (const part of child.toArray()) {
        if (!(part instanceof Y.XmlText)) continue;
        for (const run of part.toDelta() as Run[]) {
          if (typeof run.insert !== "string") continue;
          const adds = ours(markValueOf(PROPOSAL_INSERT_MARK, run.attributes));
          const removes = ours(markValueOf(PROPOSAL_DELETE_MARK, run.attributes));
          touched ||= adds || removes;
          if (!adds) was += run.insert;
          if (!removes) will += run.insert;
        }
      }
      if (!touched) continue;
      if (own !== "insert") before.push(was);
      if (own !== "delete") after.push(will);
    }
  };
  visit(blocks, null);
  return { before, after };
}
