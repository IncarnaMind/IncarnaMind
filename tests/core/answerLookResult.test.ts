/**
 * What an Answer takes from the look in its scope (#3020, #2809), over results shaped as a real
 * model's check gives them: a list sentence read as one part, resting on a Passage for each item.
 */
import { describe, expect, test } from "vitest";
import type {
  Citation,
  ClaimCheckPart,
  ClaimCheckResult,
  MarkedCitation,
  UnsupportedReason,
} from "../../src/core";
import { lookResult } from "../../src/core/answers/checks/answerLook";

const SENTENCE =
  "The kilns are supplied by Hartwell Kilns, were built in Leeds and are due in May.";

const passage = (id: string, page: number, quote: string): Citation => ({
  passageId: id,
  documentId: "doc-1",
  documentName: "Kiln schedule",
  contentHash: "hash-1",
  pageFrom: page,
  pageTo: page,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const SUPPLIER = passage("p-1", 1, "The kilns are supplied by Hartwell Kilns.");
const BUILT = passage("p-2", 2, "Both kilns were built in Leeds.");
const DUE = passage("p-3", 3, "The kilns are due in May.");

const CITED: MarkedCitation[] = [{ marker: 1, ...SUPPLIER }];

const part = (
  verdict: "supported" | "unsupported",
  evidence: Citation[],
  unsupported: UnsupportedReason | null = null,
): ClaimCheckPart => ({
  span: { start: 0, end: SENTENCE.length },
  kind: "fact",
  verdict,
  evidence,
  decidingEvidence: verdict === "supported" && evidence.length > 0 ? 0 : null,
  says: null,
  unsupported,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

const result = (only: ClaimCheckPart, verdict: "supported" | "unsupported"): ClaimCheckResult => ({
  parts: [only],
  versions: [],
  excluded: [],
  verdict,
  evidence: null,
  says: null,
  unsupported: only.unsupported,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

describe("what an Answer takes from the look in its scope", () => {
  // protects=a list sentence the look passes as one part gets a Citation for every Passage its verdict cites that the sentence doesn't cite yet, each Passage once; fails_when=only the first Passage is taken, so the sentence shows ✓ with items no Citation of it holds, or a Passage quoted twice is cited twice, or the Passage already cited is added again; no_claim=which Passages a model cites, which a real-model run shows.
  test("a passed sentence read as one part: every Passage its verdict cites becomes a Citation, once, but the one already cited", () => {
    const again = passage("p-2", 2, "They were built in Leeds in 2011.");
    const looked = lookResult(
      result(part("supported", [SUPPLIER, BUILT, again, DUE]), "supported"),
      SENTENCE,
      CITED,
    );

    expect(looked?.check).toBe("found");
    expect(looked?.found.map((each) => each.citation.quote)).toEqual([BUILT.quote, DUE.quote]);
  });

  // protects=a sentence the look still reads Unsupported as one whole part names no missing words, so its card shows the check's own phrases for what the Documents state and what they don't, never the whole sentence as "not mentioned", and no Passage it found becomes a Citation; fails_when=the whole sentence is given as the missing part, or an Unsupported sentence gains Citations; no_claim=the phrases' wording, which is the model's.
  test("still Unsupported as one whole part: no missing words, the check's phrases kept, nothing found", () => {
    const unsupported: UnsupportedReason = {
      reason: null,
      covered: "the supplier and where the kilns were built",
      uncovered: "that they are due in May",
      found: true,
    };
    const looked = lookResult(
      result(part("unsupported", [SUPPLIER, BUILT], unsupported), "unsupported"),
      SENTENCE,
      CITED,
    );

    expect(looked).toMatchObject({
      check: "unsupported",
      unsupported: {
        covered: unsupported.covered,
        uncovered: unsupported.uncovered,
        missing: [],
      },
      found: [],
    });
  });

  // protects=a part that is some of the sentence's words is still named as missing, in the sentence's own words; fails_when=the rule that drops a whole-sentence part drops a part of it too; no_claim=how a model splits a sentence.
  test("still Unsupported in one of two parts: that part's own words are the missing ones", () => {
    const at = SENTENCE.indexOf("are due in May");
    const stated = { ...part("supported", [SUPPLIER]), span: { start: 0, end: at - 5 } };
    const absent = {
      ...part("unsupported", [], { reason: null, covered: null, uncovered: null }),
      span: { start: at, end: at + "are due in May".length },
    };
    const looked = lookResult(
      { ...result(absent, "unsupported"), parts: [stated, absent] },
      SENTENCE,
      CITED,
    );

    expect(looked?.unsupported?.missing).toEqual(["are due in May"]);
    expect(looked?.found).toEqual([]);
  });
});
