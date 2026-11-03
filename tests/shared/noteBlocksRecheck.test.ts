import { describe, expect, test, vi } from "vitest";
import { CITATION_NODE, type CitationRecheck } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { recheckCitations } from "../../src/shared/noteBlocks";

const AREA = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

const block = (attrs: Record<string, unknown>): NodeJSON => ({
  type: "paragraph",
  content: [{ type: CITATION_NODE, attrs }],
});

const citationOf = (blocks: NodeJSON[]): Record<string, unknown> =>
  (blocks[0]?.content?.[0]?.attrs ?? {}) as Record<string, unknown>;

const removed: CitationRecheck = {
  check: "cant-check",
  checkReason: "document-removed",
  contentHash: null,
  passageId: null,
  pageFrom: 1,
  pageTo: 1,
  location: null,
};

describe("a Citation checked again where it lands", () => {
  test("an area with no words keeps the check it was picked with, and isn't checked", async () => {
    const recheck = vi.fn(async () => removed);
    const attrs = {
      documentId: "doc",
      quote: "",
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "page", from: 1, to: 1, area: AREA },
      check: "cant-check",
      checkReason: "picture",
    };
    const [landed] = await recheckCitations([block(attrs)], recheck);
    expect(recheck).not.toHaveBeenCalled();
    expect(citationOf([landed as NodeJSON])).toMatchObject({
      check: "cant-check",
      checkReason: "picture",
    });
  });

  test("a Citation with words keeps its check when its Document is gone", async () => {
    const recheck = vi.fn(async () => removed);
    const [landed] = await recheckCitations(
      [
        block({
          documentId: "doc",
          quote: "Margins recover within two quarters.",
          pageFrom: 1,
          pageTo: 1,
          location: { kind: "page", from: 1, to: 1 },
          check: "found",
          checkReason: null,
        }),
      ],
      recheck,
    );
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(citationOf([landed as NodeJSON])).toMatchObject({
      check: "found",
      checkReason: null,
    });
  });

  test("a Citation with no words and no area is checked, and a deleted Document says so", async () => {
    const recheck = vi.fn(async () => removed);
    const [landed] = await recheckCitations(
      [
        block({
          documentId: "doc",
          quote: "",
          pageFrom: 1,
          pageTo: 1,
          location: { kind: "page", from: 1, to: 1 },
          check: "found",
          checkReason: null,
        }),
      ],
      recheck,
    );
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(citationOf([landed as NodeJSON])).toMatchObject({
      check: "cant-check",
      checkReason: "document-removed",
    });
  });
});
