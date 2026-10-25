/**
 * The measure of cited sentences in the everyday requests
 * (eval/everyday/support.ts): which sentences of an Answer carry a Citation,
 * what the app's own claim check is asked about each, and the share it judges
 * supported.
 */
import { describe, expect, test } from "vitest";
import {
  checkCitedSentences,
  citedSentences,
  supportedShare,
  supportRates,
} from "../../eval/everyday/support";
import type { CheckClaimInput, ClaimCheckResult } from "../../src/core";

const citation = (marker: number, quote: string) => ({
  marker,
  documentName: "Attention Is All You Need",
  documentId: `doc-${marker}`,
  contentHash: `hash-${marker}`,
  quote,
});

const CITATIONS = [
  citation(1, "self-attention layers are faster than recurrent layers"),
  citation(2, "O(n^2 · d)"),
];

const verdict = (kind: "supported" | "unsupported"): ClaimCheckResult => ({
  verdict: kind,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [],
  excluded: [],
});

describe("The cited sentences of an Answer", () => {
  // protects=only the sentences that carry a Citation are checked, each with the quotes its own markers cite; fails_when=an uncited inference is checked, or a sentence is held to a quote beside it; no_claim=how the check judges.
  test("a sentence is held to the quotes its own markers cite, and an uncited one isn't checked", () => {
    const found = citedSentences(
      "Self-attention layers are faster than recurrent ones when the sequence is short [^1]. Its cost grows with the square of the length [^2]. This suggests long inputs stay costly.",
      CITATIONS,
    );
    expect(found.map((each) => each.sentence)).toEqual([
      "Self-attention layers are faster than recurrent ones when the sequence is short.",
      "Its cost grows with the square of the length.",
    ]);
    expect(found.map((each) => each.cited.map((quote) => quote.quote))).toEqual([
      ["self-attention layers are faster than recurrent layers"],
      ["O(n^2 · d)"],
    ]);
  });

  // protects=a marker after the full stop, two markers in a row, a list item and a Chinese sentence belong to the sentence they follow; fails_when=a marker is credited to the next sentence or a list's bullet lands in the claim; no_claim=none beyond protects.
  test("a marker after a full stop, a list item and a Chinese sentence are read as a reader reads them", () => {
    const found = citedSentences(
      [
        "- Short inputs are cheap.[^1] Long ones are not.",
        "自注意力的代价随序列长度的平方增长[^1][^2]。这意味着长输入仍然昂贵。",
        "[^1]: Attention Is All You Need, page 6.",
      ].join("\n"),
      CITATIONS,
    );
    expect(found.map((each) => each.sentence)).toEqual([
      "Short inputs are cheap.",
      "自注意力的代价随序列长度的平方增长。",
    ]);
    expect(found.map((each) => each.cited.length)).toEqual([1, 2]);
    expect(found[0]?.context).toBe("Short inputs are cheap. Long ones are not.");
  });

  // protects=what a model leaves of a malformed marker, or a lone "Yes", is no claim to check; fails_when=a stray "^{3}]" or a one-word sentence is sent to the check; no_claim=none beyond protects.
  test("a leftover of a malformed marker, or a sentence that claims nothing, isn't checked", () => {
    expect(
      citedSentences("Short inputs are cheap.[^{3}][^2] Yes[^1].", CITATIONS).map(
        (each) => each.sentence,
      ),
    ).toEqual([]);
  });

  // protects=a calculated figure's marker is written as the figure the Answer shows, so the check isn't asked about "[=1]"; fails_when=a claim reaches the check with its figure marker; no_claim=none beyond protects.
  test("a calculated figure is read as the number the Answer shows", () => {
    const [found] = citedSentences("The gap is [=1] points [^1].", CITATIONS, [
      { marker: 1, shown: "17.2" },
    ]);
    expect(found?.sentence).toBe("The gap is 17.2 points.");
  });

  // protects=a marker the Answer has no Citation for leaves its sentence uncited; fails_when=a sentence with a dropped marker is checked against nothing; no_claim=none beyond protects.
  test("a marker with no Citation doesn't make its sentence cited", () => {
    expect(citedSentences("It is quadratic [^9].", CITATIONS)).toEqual([]);
  });
});

describe("Checking the cited sentences", () => {
  // protects=each cited sentence is sent to the app's claim check with its paragraph and what it cites, and the verdicts come back in order; fails_when=the check is handed the markers, no quote, or the uncited sentence; no_claim=none beyond protects.
  test("each cited sentence goes to the app's own check with what it cites", async () => {
    const asked: CheckClaimInput[] = [];
    const support = await checkCitedSentences(
      {
        checkClaim: async (input) => {
          asked.push(input);
          return verdict(asked.length === 1 ? "supported" : "unsupported");
        },
      },
      {
        text: "Cost is quadratic [^2]. That makes it a poor fit for books [^1]. Overall it is a trade-off.",
        citations: CITATIONS,
      },
    );
    expect(support).toEqual([
      { sentence: "Cost is quadratic.", verdict: "supported" },
      { sentence: "That makes it a poor fit for books.", verdict: "unsupported" },
    ]);
    expect(asked.map((input) => input.claim)).toEqual([
      "Cost is quadratic.",
      "That makes it a poor fit for books.",
    ]);
    expect(asked[0]?.cited).toEqual([
      {
        documentName: "Attention Is All You Need",
        documentId: "doc-2",
        contentHash: "hash-2",
        quote: "O(n^2 · d)",
      },
    ]);
  });

  // protects=the check runs on the model it is given, so two rounds on different models can share one checker; fails_when=the model is dropped and the default chat model checks instead; no_claim=none beyond protects.
  test("the check runs on the model it is given, and on the default without one", async () => {
    const asked: CheckClaimInput[] = [];
    const core = {
      checkClaim: async (input: CheckClaimInput) => {
        asked.push(input);
        return verdict("supported");
      },
    };
    const answer = { text: "Cost is quadratic [^2].", citations: CITATIONS };
    const checker = { providerId: "provider-1", modelId: "claude-sonnet-5-5" };
    await checkCitedSentences(core, answer, checker);
    await checkCitedSentences(core, answer);
    expect(asked.map((input) => input.model)).toEqual([checker, null]);
  });
});

describe("The share of cited sentences supported", () => {
  // protects=the share counts only sentences the check gave a verdict for, so a failed check isn't an unsupported sentence, and none judged is not a failure; fails_when=a not-checked sentence lowers the share; no_claim=none beyond protects.
  test("sentences the check couldn't judge don't count against the Answer", () => {
    expect(
      supportedShare([
        { sentence: "a", verdict: "supported" },
        { sentence: "b", verdict: "unsupported" },
        { sentence: "c", verdict: "not-checked" },
      ]),
    ).toBe(0.5);
    expect(supportedShare([{ sentence: "a", verdict: "not-checked" }])).toBe(1);
    expect(supportedShare([])).toBe(1);
  });

  // protects=the report's counts per model and language; fails_when=languages or models are summed together; no_claim=none beyond protects.
  test("the rates are counted per model and language", () => {
    expect(
      supportRates([
        {
          model: "m",
          language: "en",
          support: [
            { sentence: "a", verdict: "supported" },
            { sentence: "b", verdict: "contradicted" },
          ],
        },
        { model: "m", language: "zh-CN", support: [{ sentence: "c", verdict: "not-checked" }] },
      ]),
    ).toEqual([
      { model: "m", language: "en", supported: 1, judged: 2, notChecked: 0 },
      { model: "m", language: "zh-CN", supported: 0, judged: 0, notChecked: 1 },
    ]);
  });
});
