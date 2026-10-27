/**
 * A voice memo's note (#1568), written after Stop: what the User said, tidied into paragraphs
 * under a title line, in their own words with nothing added, each paragraph citing its time in
 * the Transcript. With no model to tidy it, or when the tidied note had words that weren't said,
 * the Transcript goes in as it is, a line a paragraph, each with its time.
 */
import { citationNode, type NodeJSON } from "../../shared/blockJson";
import { formatDay } from "../../shared/dates";
import { translate } from "../../shared/i18n";
import { matchingTerms } from "../answers/citing";
import type { QuestionContext } from "../answers/context";
import { type Citation, GENERATED_MARK } from "../api";
import { isStopword, keywordText } from "../documents/keywords";
import type { Language } from "../language";
import { citedOnly, textOf } from "./fillPrompt";

/** "Voice memo, 12 October": its name until its note names it, and its title line without a model. */
export const memoTitle = (language: Language, at: number): string =>
  translate(language, "memos.title", { date: formatDay(at, language) });

/** What tidying a memo asks its model, after the Transcript, which goes with the Question. */
export function memoContext(question: string): QuestionContext {
  const framing = [
    "The transcript above is of a voice memo the User just recorded alone, thinking out loud: each line starts with its time ([0:42]).",
    "Tidy it into a note, in their own words:",
    '- Start with a short title as a level-1 heading ("# …"), made only of words they said.',
    "- Then what they said, in paragraphs: a paragraph for each thought, in the order they said it.",
    '- Keep their words. Leave out only fillers ("um", "you know"), false starts and repeats. Never add a word, a fact or a thought they didn\'t say, and never summarise.',
    "- Every paragraph ends with its citation marker, citing the transcript line it starts with.",
    "- Write in the language of the memo.",
  ].join("\n");
  return { messages: [{ role: "user", content: `${framing}\n\n${question}` }], question };
}

/** The note in the model's reply: its first heading as the title, and the paragraphs that cite. */
export function tidiedNote(blocks: readonly NodeJSON[]): { title: string; paragraphs: NodeJSON[] } {
  const heading = blocks.find((block) => block.type === "heading");
  return {
    title: heading
      ? textOf(heading)
          .replace(/[*_`#]/g, "")
          .trim()
      : "",
    paragraphs: citedOnly(blocks.filter((block) => block.type !== "heading")),
  };
}

/**
 * The words of `written` that `said` doesn't hold, as keyword search reads words, stopwords left
 * out: a Chinese word counts as said when its characters are, however the words split there.
 */
export function wordsAdded(written: string, said: string): string[] {
  const words = [...new Set(keywordText(written).split(" "))].filter(
    (word) => word !== "" && !isStopword(word),
  );
  const held = new Set(matchingTerms(words, said));
  return words.filter((word) => !held.has(word));
}

const aiText = (text: string): NodeJSON => ({
  type: "text",
  text,
  marks: [{ type: GENERATED_MARK }],
});

export const memoBlocks = (title: string, paragraphs: readonly NodeJSON[]): NodeJSON[] => [
  { type: "heading", attrs: { level: 1 }, content: [aiText(title)] },
  ...paragraphs,
];

/** A cue of the Transcript, as the Transcript's Document holds it: its text, Unit and place. */
export interface MemoCue {
  text: string;
  passageId: string;
  page: number;
  at: { start: number; end: number };
}

export function asItIs(
  title: string,
  cues: readonly MemoCue[],
  cite: (
    passageId: string,
    quote: string,
    page: number,
    at: { start: number; end: number },
  ) => Citation | null,
): NodeJSON[] {
  return memoBlocks(
    title,
    cues.map(({ passageId, text, page, at }) => {
      const citation = cite(passageId, text, page, at);
      return {
        type: "paragraph",
        content: citation ? [aiText(`${text} `), citationNode(citation)] : [aiText(text)],
      };
    }),
  );
}
