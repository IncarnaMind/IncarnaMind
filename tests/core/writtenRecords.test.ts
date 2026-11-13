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

describe("A record line holding the quotes of every marker, and a cite call written as code", () => {
  const replying = (evidence: string, line: string) =>
    ["Verdict: supported", `Evidence: ${evidence}`, line].join("\n");
  const TWO =
    'Cite: [1] passage P1, p. 4, quote: "Recurrent O(n d2) O(n) O(n)" and "Weighted keys O(n2 d) O(1) O(1)"';
  const record = (marker: number, quote: string, location: string | null = "p. 4") => ({
    marker,
    passage: "P1",
    document: null,
    location,
    quote,
  });

  // protects=one record line with as many quotes as the reply's Evidence line names markers, its own label the first, joined by "and" or a comma alone, gives one record each in that order with the line's Passage and page, in English and Chinese; a cite call written as code gives its records as one written as JSON does; fails_when=such a line or call is left unread, so the check asks again for records the reply gave; no_claim=whether the quotes are found, which the Citation check decides.
  test("read: the quotes of every marker on one line, and a cite call written as code", () => {
    expect(writtenRecords(replying("[1, 2]", TWO))).toEqual([
      record(1, "Recurrent O(n d2) O(n) O(n)"),
      record(2, "Weighted keys O(n2 d) O(1) O(1)"),
    ]);
    expect(
      writtenRecords(
        replying("[1，2]", "[^1]: 段落 P1，p. 2：“港口的潮水每天都会涨落。”和“港口在黄昏关闭。”"),
      ),
    ).toEqual([
      record(1, "港口的潮水每天都会涨落。", "p. 2"),
      record(2, "港口在黄昏关闭。", "p. 2"),
    ]);
    expect(
      writtenRecords(
        replying(
          "[1, 2]",
          'cite(citations=[{"marker": 1, "passage": "P1", "location": "p. 4", "quote": "Recurrent O(n d2) O(n) O(n)"}, {"marker": 2, "passage": "P1", "location": "p. 4", "quote": "Weighted keys O(n2 d) O(1) O(1)"}])',
        ),
      ),
    ).toEqual([
      record(1, "Recurrent O(n d2) O(n) O(n)"),
      record(2, "Weighted keys O(n2 d) O(1) O(1)"),
    ]);
  });

  // protects=a line with more than one quote stays no record when the Evidence line names another count of markers, one marker, or the line's label isn't its first, and when a quoted Document name, page or Passage text stands beside the quote; a location in quotation marks is never a quote, so a line with it and one quote gives that one record alone, in English and Chinese; fails_when=any of them is read as records, or a location is taken for the second marker's quote; no_claim=lines with one quote each, which the test above holds.
  test.each([
    ["the counts differ", "[1, 2, 3]", TWO],
    ["two quotes where Evidence names one marker", "[1]", TWO],
    ["the line's label isn't the first marker", "[1, 2]", TWO.replace("[1]", "[2]")],
    [
      "a Document's name in quotation marks",
      "[1, 2]",
      'Cite 1: "Demonstrations Not Weights", p. 5 — "training a 220 billion parameter autoregressive language model"',
    ],
    ["a page in quotation marks", "[1, 2]", '[^1]: P4, "p. 38" — Table 4 row: "220 B 210 B 2,740"'],
    [
      "a Passage's text beside the quote",
      "[1, 2]",
      '[1] P2, p. 2: "up to million-length sequences" (passage P2 text: "its performance improves")',
    ],
    [
      "两个引文而依据只列一个标记",
      "[1]",
      "[^1]: 段落 P1，p. 2：“港口的潮水每天都会涨落。”和“港口在黄昏关闭。”",
    ],
  ])("none: %s", (_case, evidence, line) => {
    expect(writtenRecords(replying(evidence, line))).toEqual([]);
  });

  test.each([
    ["English", '- marker 1: passage P1, location "p. 4", quote "Recurrent O(n d2) O(n) O(n)"'],
    ["Chinese", "- marker 1: passage P1, location “p. 4”, quote “港口的潮水每天都会涨落。”"],
  ])("a location in quotation marks is no quote: %s", (_language, line) => {
    const [only, ...more] = writtenRecords(replying("[1, 2]", line));
    expect(only?.marker).toBe(1);
    expect(only?.location).toBe("p. 4");
    expect(more).toEqual([]);
  });
});

/** A reply that gives its verdict and writes its record into its text, never calling cite. */
const writing = (record: string, evidence = "[1]") => ({
  verdict: "supported" as const,
  judgement: "same" as const,
  reply: {
    text: [
      "Verdict: supported",
      "Absence: no",
      SAME_DETAIL,
      "Explanation: The Document says so.",
      `Evidence: ${evidence}`,
      record,
    ].join("\n"),
  },
});

async function checked(
  claim: string,
  record: string,
  citedQuote: string,
  evidence?: string,
): Promise<ClaimCheckResult> {
  const { core, documents } = await setUpWithDocuments(
    checkingModel({ [claim]: writing(record, evidence) }, [], '{"passage": null}'),
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

describe("The two record forms, through the core's check", () => {
  const BOTH = "The tide turns twice a day, and the harbour closes at dusk.";
  const BOTH_ZH = "港口的潮水每天都会涨落，港口在黄昏关闭。";
  const CLOSES = "The harbour closes at dusk.";
  const ZH_LINE = "港口的潮水每天都会涨落。";

  // protects=a check reply that writes the quotes of both its markers on one record line, or its records as a cite call written as code, has both records taken when the Citation check finds each in the Document named, so its own Supported stands with them and no ask goes out, in English and Chinese; fails_when=such records are left unread and the sentence reads Not checked; no_claim=what a real model writes.
  test.each([
    ["a line, English", BOTH, `[^1]: Tides: "${LINE}" and "${CLOSES}"`],
    ["a line, Chinese", BOTH_ZH, `[^1]: Tides：“${ZH_LINE}”和“${CLOSES}”`],
    [
      "a cite call written as code",
      BOTH,
      `cite(citations=[{"marker": 1, "passage": "P1", "quote": "${LINE}"}, {"marker": 2, "passage": "P1", "quote": "${CLOSES}"}])`,
    ],
  ])("taken: %s", async (_case, claim, record) => {
    const result = await checked(claim, record, LINE, "[1, 2]");
    expect(result.verdict).toBe("supported");
    if (result.verdict !== "supported") return;
    expect([LINE, ZH_LINE]).toContain(result.evidence?.quote);
  });

  // protects=every record asked for is taken or none: two quotes where the Evidence line names another count, two where it names one, a second quote the Document doesn't hold, a quote that only repeats the sentence, and a location in quotation marks beside one quote all leave the ask to go out as before, whose empty answer leaves the sentence Not checked, in English and Chinese; fails_when=any of them is taken and the sentence reads Supported; no_claim=what a real model's ask answers.
  test.each([
    ["the counts differ", BOTH, `[^1]: Tides: "${LINE}" and "${CLOSES}"`, "[1, 2, 3]"],
    ["Evidence names one marker", BOTH, `[^1]: Tides: "${LINE}" and "${CLOSES}"`, "[1]"],
    [
      "a quote the Document doesn't hold",
      BOTH,
      `[^1]: Tides: "${LINE}" and "The harbour closes at noon."`,
      "[1, 2]",
    ],
    ["a quote that repeats the sentence", LINE, `[^1]: Tides: "${LINE}" and "${CLOSES}"`, "[1, 2]"],
    [
      "a location in quotation marks",
      BOTH_ZH,
      `- marker 1: passage P1, location “p. 1”, quote “${ZH_LINE}”`,
      "[1, 2]",
    ],
  ])("none: %s", async (_case, claim, record, evidence) => {
    const result = await checked(claim, record, LINE, evidence);
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
