import type { EditorState } from "@tiptap/pm/state";
import { ANSWER_BLOCK, type CitationAttributes, QUESTION_BLOCK } from "../../../core/api";
import { citationSubject, footnoteSubjectKey } from "../../../shared/citations";
import { citationFormOf, citationLiveOf, numberFootnotes } from "./citationNumbers";

/** A paragraph shorter than this gets no suggestion (the core's limit too). */
export const MIN_PARAGRAPH_CHARACTERS = 40;

/** Where a suggestion would go: the end of a paragraph of the User's body text, and its text. */
export interface SuggestionPlace {
  /** The caret's position, at the paragraph's end. */
  pos: number;
  text: string;
}

/** Blocks whose text is never continued: a Question, an Answer, or code. */
const NOT_BODY = new Set<string>([QUESTION_BLOCK, ANSWER_BLOCK, "codeBlock"]);

/**
 * The paragraph the caret ends, when a suggestion could go there: the caret
 * is a cursor (no selection) at the end of a paragraph of body text, not a
 * heading, a code block, a Question or an Answer, and the paragraph is at
 * least `MIN_PARAGRAPH_CHARACTERS` long.
 */
export function suggestionPlace(state: EditorState): SuggestionPlace | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $at = selection.$head;
  const paragraph = $at.parent;
  if (paragraph.type.name !== "paragraph" || $at.parentOffset !== paragraph.content.size) {
    return null;
  }
  for (let depth = $at.depth - 1; depth > 0; depth--) {
    if (NOT_BODY.has($at.node(depth).type.name)) return null;
  }
  const text = paragraph.textContent;
  if ([...text.trim()].length < MIN_PARAGRAPH_CHARACTERS) return null;
  return { pos: $at.pos, text };
}

/** Where a sentence ends, in English or Chinese: a Chinese full stop, or a Latin one before a space. */
const SENTENCE_END = /[。！？]|[.!?](?=\s|$|["'”’)）])/gu;

/** How many sentences a paragraph has: those it finished, and the one being written. */
export function sentencesIn(text: string): number {
  const finished = text.match(SENTENCE_END)?.length ?? 0;
  const rest = text.split(SENTENCE_END).at(-1) ?? "";
  return finished + (/[\p{L}\p{N}]/u.test(rest) ? 1 : 0);
}

const LATIN_END = /[\p{Script=Latin}\p{N}.,;:!?%)\]"'”’]$/u;
const LATIN_START = /^[\p{Script=Latin}\p{N}(["'“‘]/u;

/**
 * What goes between the paragraph and the suggestion: a space when both are
 * Latin script and the paragraph doesn't end in one; nothing in Chinese.
 */
export function joinerFor(paragraph: string, suggestion: string): string {
  return LATIN_END.test(paragraph) && LATIN_START.test(suggestion) ? " " : "";
}

const words = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * The next word of a suggestion's text, with the spaces and punctuation
 * before it, and the punctuation right after it ("They", " come", " moon."):
 * what ⌥→ accepts. Chinese splits into its words.
 */
export function nextWord(text: string): string {
  let end = 0;
  let found = false;
  for (const segment of words.segment(text)) {
    if (found && (segment.isWordLike || /\s/u.test(segment.segment))) break;
    end = segment.index + segment.segment.length;
    if (segment.isWordLike) found = true;
  }
  return text.slice(0, end);
}

/**
 * The number a Citation inserted at `pos` gets: in Numbered, the footnote a Citation of the same
 * Document and place already has, which a later one repeats (#1381); else one more than the
 * numbers the editor has given the Citations, footnotes and figures before it. A Citation inside
 * a footnote has no number of its own.
 */
export function citationNumberAt(
  state: EditorState,
  pos: number,
  attributes?: Partial<CitationAttributes>,
): number {
  const { citations, footnotes, figures } = numberFootnotes(
    state.doc,
    citationFormOf(state),
    citationLiveOf(state),
  );
  if (attributes && citationFormOf(state) === "numbered") {
    const key = footnoteSubjectKey(citationSubject(attributes, citationLiveOf(state)));
    const shared = citations.find(
      (each) =>
        each.pos < pos &&
        footnoteSubjectKey(citationSubject(each.attributes, citationLiveOf(state))) === key,
    );
    if (shared) return shared.number;
  }
  // The next number: two marks of one footnote share a number, so the count is of numbers given.
  const taken = [
    ...citations.filter((each) => each.pos < pos),
    ...footnotes.filter((each) => each.pos < pos && !each.endnote),
    ...figures.filter((each) => each.pos < pos),
  ];
  return taken.reduce((most, each) => Math.max(most, each.number), 0) + 1;
}
