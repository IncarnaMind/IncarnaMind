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

// protects=a Citation added to a Note and checked again where it lands (#2504): pointed at another version or page, it says nothing of the next page the Answer's quoted words ran on to, which was the old place's, and keeps the words not found for a later check; checked in the version it quotes, or landed where it was cited, its place is the same, so the run-on page stays; fails_when=the run-on page outlives a re-point, or is lost where nothing moved, or a re-point drops the words not found, or the quoted version drops the page; no_claim=whether the words are on the new place's page.
describe("what the check of the Answer's quoted words found, where a Citation lands", () => {
  const runOn = { runsOnTo: { kind: "page", from: 2, to: 2 } };
  const notFound = { answer: [{ text: "no fee at all", found: false }], closest: null };
  const held = (quotedWords: unknown) =>
    block({
      documentId: "doc",
      quote: "No fee is charged when goods are",
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "page", from: 1, to: 1 },
      contentHash: "v1",
      check: "found",
      checkReason: null,
      quotedWords,
    });
  const elsewhere: CitationRecheck = {
    check: "found",
    checkReason: null,
    contentHash: "v2",
    passageId: "passage",
    pageFrom: 3,
    pageTo: 3,
    location: { kind: "page", from: 3, to: 3 },
  };

  test.each([
    ["the page they ran on to goes", runOn, undefined],
    ["the words not found stay", notFound, notFound],
  ])("pointed at another place, %s", async (_, quotedWords, kept) => {
    const [landed] = await recheckCitations([held(quotedWords)], async () => elsewhere);
    const attrs = citationOf([landed as NodeJSON]);
    expect(attrs).toMatchObject({ contentHash: "v2", pageFrom: 3 });
    expect(attrs.quotedWords).toEqual(kept);
  });

  test("landed where it was cited, in the same version and page, the page they ran on to stays", async () => {
    const [landed] = await recheckCitations([held(runOn)], async () => ({
      ...elsewhere,
      contentHash: "v1",
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "page", from: 1, to: 1 },
    }));
    expect(citationOf([landed as NodeJSON])).toMatchObject({
      contentHash: "v1",
      quotedWords: runOn,
    });
  });

  test("checked in the version it quotes, the page they ran on to stays", async () => {
    const [landed] = await recheckCitations([held(runOn)], async () => ({
      ...elsewhere,
      inQuotedVersion: { check: "found", checkReason: null },
    }));
    expect(citationOf([landed as NodeJSON])).toMatchObject({
      contentHash: "v1",
      quotedWords: runOn,
    });
  });
});
