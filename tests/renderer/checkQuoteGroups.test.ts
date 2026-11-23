/**
 * A check card groups its quotes by what they do, as the check said (#3715): those that say
 * otherwise first, then those that say so; where it said nothing, no label is made up.
 */
import { describe, expect, it } from "vitest";
import type { CitationAttributes } from "../../src/core/api";
import { quoteGroups } from "../../src/renderer/src/editor/quoteGroups";

const quote = (words: string): CitationAttributes => ({
  passageId: `passage-${words.length}`,
  documentId: "transcript",
  documentName: "Kestrel Bay Harbour Board meeting transcript",
  contentHash: "v1",
  pageFrom: null,
  pageTo: null,
  location: { kind: "lines", from: 5, to: 5 },
  quote: words,
  check: "found",
  checkReason: null,
});

const PONTOON = quote("The new pontoon opens to the public in May, once the last pile is driven.");
const SPRING = quote(
  "Half-hourly sailings are possible only on spring tides, and only in July and August.",
);
const PROMISE = quote("We can't promise a boat every 30 minutes.");

describe("a check card's groups of quotes (#3715)", () => {
  // protects=the reason for the verdict comes first: the quotes that say otherwise, then those that say so; fails_when=a quote the check said says otherwise shows under Says so, or the order flips
  it("puts the quotes that say otherwise first, then those that say so", () => {
    expect(
      quoteGroups({ otherwise: [SPRING.quote ?? "", PROMISE.quote ?? ""] }, "unsupported", [
        PONTOON,
        SPRING,
        PROMISE,
      ]),
    ).toEqual([
      { role: "otherwise", quotes: [SPRING, PROMISE] },
      { role: "so", quotes: [PONTOON] },
    ]);
  });

  // protects=a check that named no roles is shown as it was given: a contradicted sentence's one quote contradicts it, anything else has no label; fails_when=code makes up which quote backs the sentence
  it("labels nothing the check didn't say, but a contradicted sentence's one quote", () => {
    expect(quoteGroups({}, "contradicted", [SPRING])).toEqual([
      { role: "otherwise", quotes: [SPRING] },
    ]);
    expect(quoteGroups({}, "contradicted", [SPRING, PONTOON])).toEqual([
      { role: null, quotes: [SPRING, PONTOON] },
    ]);
    expect(quoteGroups({}, "unsupported", [PONTOON])).toEqual([{ role: null, quotes: [PONTOON] }]);
  });

  // protects=a ✓ card shows its quote with no label at all; fails_when=a supported sentence's quotes are split or labelled
  it("leaves a supported sentence's quotes in one group with no label", () => {
    expect(
      quoteGroups({ otherwise: [SPRING.quote ?? ""] }, "supported", [PONTOON, SPRING]),
    ).toEqual([{ role: null, quotes: [PONTOON, SPRING] }]);
    expect(quoteGroups({}, "supported", [])).toEqual([]);
  });
});
