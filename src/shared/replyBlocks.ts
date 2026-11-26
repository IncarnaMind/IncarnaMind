/**
 * A reply of the User's own AI in a Note's conversation as Blocks (#3765): the Markdown it wrote
 * made into the node types of Notes, and each Citation IncarnaMind gave its connection the Citation
 * a Note holds, so its card and its Document's place are the Note's own. Any other `[cite:…]` is
 * left out, never drawn as a Citation.
 */

import { markdownToBlocks } from "../core/answers/markdown";
import type { NoteCitation } from "../core/api";
import { citationNode, type NodeJSON, withCitations } from "./blockJson";

const TOKEN = /\s?\[cite:([a-z0-9]{1,32})\]/g;

export function replyBlocks(text: string, citations: readonly NoteCitation[]): NodeJSON[] {
  const tokens: string[] = [];
  // A footnote mark the AI wrote stays its words: a joiner keeps it from reading as a Citation's.
  const own = text.replace(/\[\^/g, "[⁠^");
  const marked = own.replace(TOKEN, (_, token: string) => {
    if (!citations.some((each) => each.token === token)) return "";
    if (!tokens.includes(token)) tokens.push(token);
    return `[^${tokens.indexOf(token) + 1}]`;
  });
  return withCitations(markdownToBlocks(marked), (marker) => {
    const cited = citations.find((each) => each.token === tokens[marker - 1]);
    return cited ? citationNode(cited.citation) : null;
  });
}
