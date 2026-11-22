import { NOTES_MARK, passagesIn, UNIT_MARK } from "./passages";
import type { GenerateOptions } from "./prompt";

/** A text's words of four letters or more, and its pairs of Chinese characters: what a line shares with it. */
export function wordsAndPairs(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter((word) => /^[a-z0-9]{4,}$/.test(word));
  const pairs: string[] = [];
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    for (let at = 0; at + 1 < run.length; at++) pairs.push(run.slice(at, at + 2));
  }
  return [...new Set([...words, ...pairs])];
}

/**
 * The scripted suggestion as the User writes (#282): of the Passages given,
 * the line that shares the most words with the paragraph and isn't in it
 * already, as the text and as its quote. A paragraph that says "misquote"
 * (or 错引) gets a quote that isn't in the Passage.
 */
export function fakeSuggestion(options: GenerateOptions): string {
  const request = options.prompt
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");
  const paragraph = /<paragraph>\n([\s\S]*?)\n<\/paragraph>/.exec(request)?.[1] ?? "";
  const wanted = wordsAndPairs(paragraph);
  let best: { passage: string; line: string; shared: number } | null = null;
  for (const passage of passagesIn(request)) {
    for (const raw of passage.text.split("\n")) {
      const line = raw.replace(UNIT_MARK, "").replace(NOTES_MARK, "").trim();
      if (!line || paragraph.includes(line)) continue;
      const shared = wanted.filter((word) => line.toLowerCase().includes(word)).length;
      if (shared > (best?.shared ?? 0)) best = { passage: passage.id, line, shared };
    }
  }
  if (!best) return JSON.stringify({ text: "", passage: "", quote: "" });
  // The line's first clauses that the paragraph has already said are left out: it goes on from there.
  const clauses = best.line.split(/(?<=[，,；;])/u);
  while (clauses.length > 1 && paragraph.includes((clauses[0] ?? "").replace(/[，,；;]$/u, ""))) {
    clauses.shift();
  }
  const text = clauses.join("").trim();
  const misquote = /misquote|错引/i.test(paragraph);
  return JSON.stringify({
    text,
    passage: best.passage,
    quote: misquote ? `${text.replace(/[.!?。！？]$/u, "")} and tomorrow.` : text,
  });
}
