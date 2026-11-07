/**
 * False Supported in an Answer or a cell (README.md › Paired runs): a sentence shown with a found
 * Citation, so as checked, that states something the Citation's quoted words don't say. A judge
 * reads each found Citation's sentence against its quote; a Citation that wasn't found shows as
 * not checked, so it can't make a false Supported. A sentence with several found Citations is
 * judged once, against all their quotes together, and counts once.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { generateText, type LanguageModel } from "ai";
import type { CitationAttributes } from "../../src/core";
import { citationAttributesOf } from "../../src/shared/citations";

export interface CitedSentence {
  /** Where the sentence (or a cell's line) is: Citations at the same place are on one sentence. */
  at: number;
  /** The sentence (or a cell's line) the Citation is on, without its Citations. */
  sentence: string;
  quote: string;
  found: boolean;
}

const JUDGE = [
  "You read sentences from an Answer, each with the words its Citations quote from Documents.",
  "List the number of each sentence that states as so something its quoted words, taken together, don't say: a figure, a date, a period, a name, a term, a yes or a no, or a claim the words don't make. A sentence that says less than its quotes, or says it in other words or another language, is stated.",
  'Reply with JSON and nothing else: {"unstated": [n, ...]}',
].join("\n");

/** The numbers the judge listed, digits as numbers or strings; null when anything else is in the list. */
function readUnstated(text: string): number[] | null {
  try {
    const read: unknown = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
    if (typeof read !== "object" || read === null || !("unstated" in read)) return null;
    if (!Array.isArray(read.unstated)) return null;
    const numbers = read.unstated.map((each: unknown) =>
      typeof each === "number"
        ? each
        : typeof each === "string" && /^\s*\d+\s*$/.test(each)
          ? Number(each)
          : null,
    );
    return numbers.every((each): each is number => each !== null) ? numbers : null;
  } catch {
    return null;
  }
}

/**
 * How many sentences shown with a found Citation their quotes don't state, each sentence judged
 * once against all its found quotes; null when the judge's reply couldn't be read twice, which
 * the item reports as a failure rather than as none.
 */
export async function falseSupportedIn(
  judge: LanguageModel,
  cited: readonly CitedSentence[],
): Promise<number | null> {
  // By place, not by words: two sentences that read the same are each judged on their own quotes.
  const bySentence = new Map<number, { sentence: string; quotes: string[] }>();
  for (const each of cited) {
    if (!each.found) continue;
    const quotes = bySentence.get(each.at)?.quotes ?? [];
    bySentence.set(each.at, { sentence: each.sentence, quotes: [...quotes, each.quote] });
  }
  const sentences = [...bySentence.values()].map(
    ({ sentence, quotes }) => [sentence, quotes] as const,
  );
  if (sentences.length === 0) return 0;
  const prompt = sentences
    .map(
      ([sentence, quotes], index) =>
        `[${index + 1}] Sentence: ${sentence}\n${quotes.map((quote) => `    Quote: “${quote}”`).join("\n")}`,
    )
    .join("\n");
  const first = await generateText({
    model: judge,
    instructions: JUDGE,
    prompt,
    maxOutputTokens: 300,
    maxRetries: 1,
  });
  const read =
    readUnstated(first.text) ??
    readUnstated(
      (
        await generateText({
          model: judge,
          instructions: JUDGE,
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: first.text },
            { role: "user", content: "Now give only the JSON object, as the instructions say." },
          ],
          maxOutputTokens: 200,
          maxRetries: 1,
        })
      ).text,
    );
  if (read === null) {
    console.error(
      `The false-Supported judge's reply couldn't be read: ${first.text.slice(0, 200)}`,
    );
    return null;
  }
  return new Set(read.filter((n) => n >= 1 && n <= sentences.length)).size;
}

/** The text as the page shows it, each Citation by its number, and the Citations in that order. */
export function citedText(doc: ProseMirrorNode): {
  text: string;
  citations: Partial<CitationAttributes>[];
} {
  const lines: string[] = [];
  const citations: Partial<CitationAttributes>[] = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    let line = "";
    node.descendants((child) => {
      if (child.isText) line += child.text ?? "";
      else if (child.type.name === "citation") {
        citations.push(citationAttributesOf(child.attrs));
        line += `[${citations.length}]`;
      }
      return true;
    });
    if (line.trim()) lines.push(node.type.name === "heading" ? `## ${line}` : line);
    return false;
  });
  return { text: lines.join("\n"), citations };
}
