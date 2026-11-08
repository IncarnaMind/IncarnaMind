/**
 * "Write a detailed summary of A and B into this note, with a section for each" (为 A 和 B 各写一节),
 * asked beside a Mind: the assistant searches, cites a line of each Document the request names,
 * writes a section of each into the Mind in focus, and says so in a reply that cites nothing, as
 * models did (#2768).
 */
import { passagesIn, UNIT_MARK } from "./passages";
import { lastResult, type Prompt, type Reply, toolResults } from "./prompt";

const SECTION_EACH = /\bwith a section for each\b|各写一节/i;

/** A Passage's longest line, its Unit's mark taken off: the sentence a section quotes. */
const longestLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(UNIT_MARK, "").trim())
    .reduce((longest, line) => (line.length > longest.length ? line : longest), "");

export function sectionsReply(prompt: Prompt, asked: string): Reply | null {
  if (!SECTION_EACH.test(asked)) return null;
  const chinese = /\p{Script=Han}/u.test(asked);
  if (lastResult(prompt, "add_to_mind") !== undefined) {
    return {
      text: chinese
        ? "我在这个笔记里为两份文件各写了一节。"
        : "I added a section for each to this Note.",
    };
  }
  const [searched] = toolResults(prompt, "search_documents");
  if (searched === undefined) return { tool: "search_documents", input: { query: asked } };
  const lower = asked.toLocaleLowerCase();
  const named = passagesIn(searched).filter(
    (passage, at, all) =>
      lower.includes(passage.document.toLocaleLowerCase()) &&
      all.findIndex((each) => each.document === passage.document) === at,
  );
  const quoted = named.map((passage) => ({ passage, quote: longestLine(passage.text) }));
  if (toolResults(prompt, "cite").length === 0) {
    const citations = quoted.map(({ passage, quote }, at) => ({
      marker: at + 1,
      passage: passage.id,
      quote,
    }));
    return { tool: "cite", input: { citations } };
  }
  const cited = (quote: string, marker: number) =>
    chinese
      ? `${quote.replace(/。$/u, "")}[^${marker}]。`
      : `${quote.replace(/\.$/u, "")} [^${marker}].`;
  const content = quoted
    .map(({ passage, quote }, at) => `## ${passage.document}\n\n${cited(quote, at + 1)}`)
    .join("\n\n");
  return { tool: "add_to_mind", input: { content } };
}
