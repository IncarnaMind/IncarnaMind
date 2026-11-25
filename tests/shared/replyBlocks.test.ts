import { describe, expect, test } from "vitest";
import { type Citation, CITATION_NODE, type NoteCitation } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { replyBlocks } from "../../src/shared/replyBlocks";

const citation = (quote: string): Citation => ({
  passageId: `passage-${quote.length}`,
  documentId: "document-1",
  documentName: "Ferry interview 1",
  contentHash: "hash",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const cited = (token: string, quote: string): NoteCitation => ({
  token,
  documentName: "Ferry interview 1",
  quote,
  citation: citation(quote),
});

const inline = (blocks: readonly NodeJSON[]): NodeJSON[] =>
  blocks.flatMap((block) => (block.content ? inline(block.content) : [block]));

describe("a reply's Citations, as a Note holds them (#3765)", () => {
  test("each token IncarnaMind gave is the Note's Citation, kept with the word before it", () => {
    const blocks = replyBlocks("The ferry runs late. [cite:abc12345] It waits [cite:def67890].", [
      cited("abc12345", "runs late"),
      cited("def67890", "waits"),
    ]);
    const parts = inline(blocks);
    const citations = parts.filter((part) => part.type === CITATION_NODE);
    expect(citations.map((part) => part.attrs?.quote)).toEqual(["runs late", "waits"]);
    expect(parts.find((part) => part.type === "text")?.text).toBe("The ferry runs late.");
  });

  test("a token it didn't give, and a footnote the AI wrote, are no Citation", () => {
    const parts = inline(replyBlocks("Late [cite:zzz99999] and [^1] noted.", []));
    expect(parts.some((part) => part.type === CITATION_NODE)).toBe(false);
    expect(parts.map((part) => part.text ?? "").join("")).toContain("^1");
  });
});
