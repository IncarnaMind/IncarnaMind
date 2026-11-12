/**
 * The mark where a figure couldn't be calculated (#2577): "[number missing]" in the text, a node of
 * its own that nothing reads as a number or a figure marker. A model reads it as those words in the
 * language the figure footnotes use, and the words a model writes back, in either language, become
 * the mark again; what the User types stays text. Pure: the core and the window share it.
 */
import { MISSING_NUMBER_NODE } from "../core/api";
import { LANGUAGES, type Language } from "../core/language";
import { type NodeJSON, replaceMarkers } from "./blockJson";
import { translate } from "./i18n";

export const missingNumberNode = (): NodeJSON => ({ type: MISSING_NUMBER_NODE });

export const missingNumberWords = (language: Language): string =>
  translate(language, "missingNumber.words");

/** The mark's words in any language, as a model writes them back. */
export const MISSING_NUMBER_WORDS = new RegExp(
  LANGUAGES.map((language) => missingNumberWords(language).replace(/[[\]]/g, "\\$&")).join("|"),
  "g",
);

/** Blocks a model wrote, with the mark's words made the mark again. Code keeps its words. */
export const withMissingNumbers = (blocks: readonly NodeJSON[]): NodeJSON[] =>
  replaceMarkers(blocks, MISSING_NUMBER_WORDS, (_, before) => ({
    before,
    put: missingNumberNode(),
  }));
