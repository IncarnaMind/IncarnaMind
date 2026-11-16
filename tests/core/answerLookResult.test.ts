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

  // protects=a sentence the look passes on a file's own properties (its Created date for "was written in 2026") gets no verdict from the look, so it stays as its batch read it and gains no Citation: a file's date never passes an Answer's sentence about what a Document says; fails_when=the look's Supported stands on a properties or Library Citation; no_claim=what the Note's own check makes of such a sentence, which is that check's.
  test.each<[string, Citation["location"]]>([
    ["own properties", { kind: "properties", property: "created", value: "2026-05-12T09:00:00Z" }],
    [
      "Library's facts",
      { kind: "library", source: { kind: "library" }, fact: { kind: "documents", count: 4 } },
    ],
  ])("a sentence passed on a file's %s gives the Answer no verdict", (_name, location) => {
    const fileFacts: Citation = {
      ...passage("p-9", 1, "Created: 2026-05-12T09:00:00Z"),
      location,
    };

    expect(
      lookResult(result(part("supported", [fileFacts]), "supported"), SENTENCE, CITED),
    ).toBeNull();
    expect(
      lookResult(result(part("supported", [BUILT, fileFacts]), "supported"), SENTENCE, CITED),
    ).toBeNull();
  });

  // protects=an Answer's sentence whose fact the Passage states but which adds a conclusion of the assistant's own gets no green check from the look: the check leaves the conclusion out and passes the rest, as a real model's reply did for "…, which shows the authors think so too"; fails_when=the look takes the fact's Supported as the whole sentence's, so the Citation shows a check over an inference no Document states (#3019); no_claim=whether a model names such a clause an opinion
  test("a sentence passed but for a conclusion of the assistant's own gives the Answer no verdict", () => {
    const sentence = "The kilns are due in May, which shows the supplier is on schedule.";
    const fact = { ...part("supported", [DUE]), span: { start: 0, end: 24 } };
    const conclusion: ClaimCheckPart = {
      ...part("supported", []),
      span: { start: 26, end: sentence.length - 1 },
      kind: "opinion",
      verdict: null,
      decidingEvidence: null,
    };

    expect(
      lookResult({ ...result(fact, "supported"), parts: [fact, conclusion] }, sentence, [
        { marker: 1, ...DUE },
      ]),
    ).toBeNull();
    expect(lookResult(result(fact, "supported"), sentence, [{ marker: 1, ...DUE }])).toMatchObject({
      check: "found",
      found: [],
    });
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
