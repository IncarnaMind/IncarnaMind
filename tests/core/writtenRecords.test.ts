/**
 * The records a check's reply writes into its own text instead of calling `cite` (#3019): read
 * only from its record lines, taken only when the Citation check finds each in the Document or
 * Passage it names, and never one that repeats the sentence; the model's Supported stands with the
 * Passage it found, for the Note to read against its Citations.
 */
import { describe, expect, test } from "vitest";
import type { ClaimCheckResult } from "../../src/core";
import { writtenRecords } from "../../src/core/answers/checks/writtenRecords";
import { checkingModel, SAME_DETAIL } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";

const TIDES: SourceFile = {
  name: "Tides.md",
  // A line in each language, so that either sentence's search finds the Passage.
  contents:
    "The tide turns twice a day.\n\n港口的潮水每天都会涨落。\n\nThe harbour closes at dusk.\n",
};
const BOATS: SourceFile = { name: "Boats.md", contents: "Boats leave the harbour at dawn.\n" };
const LINE = "The tide turns twice a day.";

describe("A check reply's own record lines", () => {
  // protects=each record form the saved replies show is read with its marker, Passage or Document, page and one quote, and running prose, a quote in quotation marks for its location, or a record with two quotes is no record; fails_when=an Explanation's quote is read as a record, a location is taken for the quote, or a line with two quotes picks one; no_claim=whether its quote is found.
  test("reads the record forms the replies use, and no quote of running prose", () => {
    const reply = [
      "Verdict: supported",
      'Explanation: Table 1 gives "Weighted keys O(n2 d) O(1) O(1)", which matches.',
      "Evidence: [1, 2]",
      '[^1]: Weighted Keys Shorter Paths, p. 4 — "Weighted keys O(n2 d) O(1) O(1)" [^2]: Weighted Keys Shorter Paths, p. 4, "Recurrent O(n d2) O(n) O(n)"',
      'Cite 3: Demonstrations Not Weights, p. 38, Table 4, quote "220 B 210 B 2,740"',
      'Citations: [^4] Passage P2, p. 4: "Recurrent O(n d2) O(n) O(n)"',
      'cite: - marker 5: passage P1, location "p. 6", quote "Fixed sinusoids were kept"',
      "Citation 6 (Mamba, p. 1): “linear scaling in sequence length”",
      '- marker 7: passage P1, location "p. 4", quote "Weighted keys O(n2 d) O(1) O(1)" and "Recurrent O(n d2) O(n) O(n)"',
      'Cite: <invoke name="cite"> <parameter name="citations">[{"marker":8,"passage":"P6","location":"p. 14","quote":"a shorter route between positions is our explanation"}]</parameter> </invoke>',
      '{"citations":[{"marker":9,"passage":"P2","pageFrom":4,"pageTo":5,"quote":"Recurrent O(n d2) O(n) O(n)"}]}',
    ].join("\n");
    expect(writtenRecords(reply)).toEqual([
      {
        marker: 1,
        passage: null,
        document: "Weighted Keys Shorter Paths",
        location: "p. 4",
        quote: "Weighted keys O(n2 d) O(1) O(1)",
      },
      {
        marker: 2,
        passage: null,
        document: "Weighted Keys Shorter Paths",
        location: "p. 4",
        quote: "Recurrent O(n d2) O(n) O(n)",
      },
      {
        marker: 3,
        passage: null,
        document: "Demonstrations Not Weights",
        location: "p. 38",
        quote: "220 B 210 B 2,740",
      },
      {
        marker: 4,
        passage: "P2",
        document: null,
        location: "p. 4",
        quote: "Recurrent O(n d2) O(n) O(n)",
      },
      {
        marker: 5,
        passage: "P1",
        document: null,
        location: "p. 6",
        quote: "Fixed sinusoids were kept",
      },
      {
        marker: 6,
        passage: null,
        document: "Mamba",
        location: "p. 1",
        quote: "linear scaling in sequence length",
      },
      {
        marker: 8,
        passage: "P6",
        document: null,
        location: "p. 14",
        quote: "a shorter route between positions is our explanation",
      },
      {
        marker: 9,
        passage: "P2",
        document: null,
        location: "pp. 4–5",
        quote: "Recurrent O(n d2) O(n) O(n)",
      },
    ]);
  });
});

/** A reply that gives its verdict and writes its record into its text, never calling cite. */
const writing = (record: string) => ({
  verdict: "supported" as const,
  judgement: "same" as const,
  reply: {
    text: [
      "Verdict: supported",
      "Absence: no",
      SAME_DETAIL,
      "Explanation: The Document says so.",
      "Evidence: [1]",
      record,
    ].join("\n"),
  },
});

async function checked(
  claim: string,
  record: string,
  citedQuote: string,
): Promise<ClaimCheckResult> {
  const { core, documents } = await setUpWithDocuments(
    checkingModel({ [claim]: writing(record) }, [], '{"passage": null}'),
    [TIDES, BOATS],
  );
  const [tides] = documents;
  if (!tides) throw new Error("Tides.md wasn't added.");
  return core.checkClaim({
    claim,
    cited: [
      {
        documentName: tides.name,
        documentId: tides.id,
        contentHash: tides.contentHash,
        quote: citedQuote,
      },
    ],
  });
}

describe("A record the reply wrote is taken before the check asks for it again", () => {
  // protects=a record line whose quote the Citation check finds in the Document it names is taken, so the model's own Supported stands with that Passage, in English and Chinese; fails_when=the record is ignored and the ask's empty answer leaves it Not checked; no_claim=a record in any other form.
  test.each([
    ["Tides turn twice in a day here.", `[^1]: Tides, “${LINE}”`],
    ["这里的潮水每天都会涨落。", `[^1]: Tides, "${LINE}"`],
  ])("%s", async (claim, record) => {
    const result = await checked(claim, record, LINE);
    expect(result.verdict).toBe("supported");
    if (result.verdict !== "supported") return;
    expect(result.evidence?.quote).toBe(LINE);
    expect(result.evidence?.documentName).toMatch(/^Tides/);
  });

  // protects=a typed quote the Document doesn't hold, one under another Document's name, one that only repeats the sentence, and a quote in running prose are never taken, so the ask goes out as before and its empty answer leaves the sentence Not checked; fails_when=any of them is taken and the sentence reads Supported; no_claim=what a real model's ask answers.
  test.each([
    [
      "a quote the Document doesn't hold",
      "Tides turn twice in a day here.",
      "[^1]: Tides, “The tide turns three times a day.”",
    ],
    [
      "a quote under another Document's name",
      "Tides turn twice in a day here.",
      `[^1]: Boats, “${LINE}”`,
    ],
    ["a quote that only repeats the sentence", LINE, `[^1]: Tides, “${LINE}”`],
    [
      "a quote in running prose",
      "Tides turn twice in a day here.",
      `It says “${LINE}”, as the sentence does.`,
    ],
  ])("not taken: %s", async (_kind, claim, record) => {
    const result = await checked(claim, record, LINE);
    expect(result.verdict).toBe("not-checked");
    if (result.verdict !== "not-checked") return;
    expect(result.reason).toBe("no-evidence");
  });
});

describe("A cited sentence's check backed by a Passage its Citations don't hold", () => {
  // protects=the check gives the model's own Supported with the Passage it found, from a record the reply wrote or a cite call, in English and Chinese, so the Note can read it against its Citations as they stand (#3019); fails_when=the check stores Not checked in its place, which no Add as Citation could bring back without a new request, or loses the Passage; no_claim=how the Note shows it, which tests/core/foundPassageCitation.test.ts holds.
  test.each([["Tides turn twice in a day here."], ["这里的潮水每天都会涨落。"]])(
    "%s, a record the reply wrote",
    async (claim) => {
      const result = await checked(claim, `[^1]: Tides, “${LINE}”`, "The harbour closes at dusk.");
      expect(result.verdict).toBe("supported");
      if (result.verdict !== "supported") return;
      expect(result.evidence?.quote).toBe(LINE);
    },
  );

  test("a cite call", async () => {
    const claim = "Tides turn twice in a day here.";
    const { core, documents } = await setUpWithDocuments(
      checkingModel({ [claim]: { verdict: "supported", quote: LINE, judgement: "same" } }),
      [TIDES, BOATS],
    );
    const [tides] = documents;
    if (!tides) throw new Error("Tides.md wasn't added.");
    const result = await core.checkClaim({
      claim,
      cited: [
        {
          documentName: tides.name,
          documentId: tides.id,
          contentHash: tides.contentHash,
          quote: "The harbour closes at dusk.",
        },
      ],
    });
    expect(result.verdict).toBe("supported");
    if (result.verdict !== "supported") return;
    expect(result.evidence?.quote).toBe(LINE);
  });
});
