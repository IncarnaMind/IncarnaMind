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

/**
 * What the assistant's model reads when its change takes out the mark with no calculated figure in
 * its place, in the language the mark's words are in. Never shown to the User. `instruction` is for
 * a change it asked Edit with AI for, whose reply can't carry a calculated figure's marker.
 */
export const MISSING_NUMBER_REFUSED: Readonly<
  Record<Language, { content: string; instruction: string }>
> = {
  en: {
    content:
      'This change was not made: it takes out "[number missing]" and puts no calculated figure in its place. "[number missing]" stands for a number that could not be calculated. Either call calculate and write its marker where "[number missing]" is, or keep "[number missing]" exactly as written. Never write the number yourself.',
    instruction:
      'This change was not made: it takes out "[number missing]" and puts no calculated figure in its place. "[number missing]" stands for a number that could not be calculated. A change asked for by instruction cannot carry a calculated figure\'s marker. Call edit_mind again with content, not instruction: write the new text yourself, with the marker calculate returned where "[number missing]" is, in the same sentence. Or keep "[number missing]" exactly as written. Never write the number yourself.',
  },
  "zh-CN": {
    content:
      "这处改动没有做：它去掉了“[缺少数字]”，却没有在原处放入计算得出的数字。“[缺少数字]”表示一个未能算出的数字。请调用 calculate 并把它的标记写在“[缺少数字]”所在的位置，或者原样保留“[缺少数字]”。不要自己写出这个数字。",
    instruction:
      "这处改动没有做：它去掉了“[缺少数字]”，却没有在原处放入计算得出的数字。“[缺少数字]”表示一个未能算出的数字。用 instruction 提出的改动带不了计算数字的标记。请改用 content 再调用一次 edit_mind：自己写出新的文字，在同一句里“[缺少数字]”所在的位置写上 calculate 返回的标记。或者原样保留“[缺少数字]”。不要自己写出这个数字。",
  },
};

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
