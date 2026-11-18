import type { SortWord } from "../../src/core/answers/checks/claims";

/** A sentence a sort's prompt lists; in a table's cell, with the row's label and the column's heading. */
export interface ListedSentence {
  number: number;
  text: string;
  row?: string;
  column?: string;
}

export function listedSentences(prompt: string): ListedSentence[] {
  const parsed: unknown = JSON.parse(prompt);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sentences" in parsed) ||
    !Array.isArray(parsed.sentences)
  )
    throw new Error("Invalid synthetic sentence input.");
  const out: ListedSentence[] = [];
  for (const value of parsed.sentences) {
    if (typeof value !== "object" || value === null) throw new Error("Invalid synthetic sentence.");
    const { number, text, row, column } = value as Record<string, unknown>;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < 1 ||
      typeof text !== "string" ||
      out.some((sentence) => sentence.number === number)
    )
      throw new Error("Invalid synthetic sentence identity.");
    out.push({
      number,
      text,
      ...(typeof row === "string" && { row }),
      ...(typeof column === "string" && { column }),
    });
  }
  return out;
}

/** A sort's reply to the sentences a prompt lists, each with the word `wordOf` gives it; one it gives none is left out. */
export function sortReply(
  prompt: string,
  wordOf: (text: string, sentence: ListedSentence) => SortWord | undefined = () => "claim",
): string {
  const words: Record<string, SortWord> = {};
  for (const sentence of listedSentences(prompt)) {
    const word = wordOf(sentence.text, sentence);
    if (word) words[sentence.number] = word;
  }
  return JSON.stringify(words);
}
