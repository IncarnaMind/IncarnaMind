/**
 * How a check reads against its sentence's Citations as the Note holds them now (#3019): a ✓ shows
 * only when the Passage it rests on is among them, by the card's own "Already cited" rule.
 */
import { describe, expect, test } from "vitest";
import type { CitationAttributes, ClaimCheckAttributes, ClaimCheckPart } from "../../src/core";
import { asCitedNow, type HeldCitation } from "../../src/shared/citedNow";

const SENTENCE = "Spring tides come twice a month, at new and full moon.";
const FOUND = "Spring tides come twice a month, at new and full moon.";

const passage = (quote: string, more: Partial<CitationAttributes> = {}): CitationAttributes => ({
  passageId: "passage-1",
  documentId: "tides",
  documentName: "Tides",
  contentHash: "v1",
  pageFrom: 2,
  pageTo: 2,
  location: null,
  quote,
  check: "found",
  checkReason: null,
  ...more,
});

const supported = (evidence: CitationAttributes, more: Partial<ClaimCheckPart> = {}) =>
  ({
    span: { start: 0, end: SENTENCE.length - 1 },
    kind: "fact",
    verdict: "supported",
    evidence: [evidence],
    decidingEvidence: 0,
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
    ...more,
  }) satisfies ClaimCheckPart;

const checkOf = (parts: ClaimCheckPart[] | undefined, evidence = passage(FOUND)) =>
  ({
    id: "check",
    request: "run",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text: SENTENCE,
    evidence,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-13T09:00:00.000Z",
    ...(parts && { parts }),
  }) satisfies ClaimCheckAttributes;

const reads = (check: ClaimCheckAttributes, citations: HeldCitation[]) => {
  const now = asCitedNow(check, citations, SENTENCE);
  return now.state === "not-checked" ? `not-checked ${now.reason}` : now.state;
};

const writer = (quote: string, more: Partial<CitationAttributes> = {}): HeldCitation => ({
  ...passage(quote, { passageId: "passage-2", ...more }),
});

describe("A ✓ resting on a Passage the check found", () => {
  // protects=a sentence's ✓ shows when its Passage is one of its Citations, on the same words or within them, beside a part of the clause too, and reads found elsewhere beside a Citation of other words, one on another page, one whose own check says it doesn't hold, or only a part of a clause the sentence says more of; a mark from before parts were kept reads the same, its Passage on a row of its own; fails_when=a ✓ stands beside a Citation whose words don't say it, or one held by the Passage hides; no_claim=what the card offers for each, which tests/renderer/alreadyCited.test.ts holds.
  test.each<[string, HeldCitation[], string]>([
    ["the same words", [writer(FOUND, { passageId: "passage-1" })], "supported"],
    [
      "a Citation of the whole clause it is in",
      [writer(`${FOUND} Neap tides fall between.`)],
      "supported",
    ],
    ["other words", [writer("The harbour closes at dusk.")], "not-checked found-elsewhere"],
    ["another page", [writer(FOUND, { pageFrom: 9, pageTo: 9 })], "not-checked found-elsewhere"],
    [
      "one whose quote isn't found",
      [writer(FOUND, { check: "not-found" })],
      "not-checked found-elsewhere",
    ],
    [
      "a part of a clause the sentence says more of",
      [writer("Spring tides come twice a month")],
      "not-checked found-elsewhere",
    ],
    [
      "that part and a Citation of the same words",
      [writer("Spring tides come twice a month"), writer(FOUND, { passageId: "passage-1" })],
      "supported",
    ],
    [
      "only a Citation the check found",
      [{ ...writer("The harbour closes at dusk."), foundByCheck: true }],
      "supported",
    ],
    ["no Citation", [], "supported"],
  ])("beside %s", (_kind, citations, shown) => {
    expect(reads(checkOf([supported(passage(FOUND))]), citations)).toBe(shown);
    expect(reads(checkOf(undefined), citations)).toBe(shown);
  });

  // protects=found elsewhere is only for a Passage a Note's Citation could quote: a figure worked out, a whole read, a list's members, a file's properties, the Library's facts, a kept view and a check still running read as they are; fails_when=any of them loses its verdict; no_claim=none.
  test.each<[string, ClaimCheckAttributes]>([
    [
      "a file's properties",
      checkOf([
        supported(
          passage("Modified: 2026-06-30", {
            location: { kind: "properties", property: "modified", value: "2026-06-30" },
          }),
        ),
      ]),
    ],
    [
      "a whole read",
      checkOf([
        supported(passage(FOUND), {
          readDocuments: [
            { documentId: "tides", documentName: "Tides", contentHash: "v1", locations: [] },
          ],
        }),
      ]),
    ],
    ["a kept view", { ...checkOf([supported(passage(FOUND))]), kept: true }],
    ["a check still running", { ...checkOf([supported(passage(FOUND))]), state: "checking" }],
  ])("%s reads as it is", (_kind, check) => {
    const now = asCitedNow(check, [writer("The harbour closes at dusk.")], SENTENCE);
    expect(now.state).toBe(check.state);
  });

  // protects=a sentence whose other part is Unsupported stays Unsupported, its found part's row reading found elsewhere; one with a part Not checked for a limit keeps that reason, so the run waits it out (#3027's order); fails_when=found elsewhere hides an Unsupported or a limit; no_claim=none.
  test("ranks with the sentence's other parts", () => {
    const half = SENTENCE.indexOf(",");
    const found = supported(passage(FOUND), { span: { start: 0, end: half } });
    const unsupported = {
      ...supported(passage(FOUND), { span: { start: half + 2, end: SENTENCE.length - 1 } }),
      verdict: "unsupported" as const,
      evidence: [],
      decidingEvidence: null,
    };
    const limited = {
      ...unsupported,
      verdict: "not-checked" as const,
      reason: "rate-limit" as const,
    };
    const other = [writer("The harbour closes at dusk.")];
    const withUnsupported = asCitedNow(
      { ...checkOf([found, unsupported]), state: "unsupported" },
      other,
      SENTENCE,
    );
    expect(withUnsupported.state).toBe("unsupported");
    expect(withUnsupported.parts?.map((each) => each.reason)).toEqual(["found-elsewhere", null]);
    const withLimit = asCitedNow(
      { ...checkOf([found, limited]), state: "not-checked", reason: "rate-limit" },
      other,
      SENTENCE,
    );
    expect([withLimit.state, withLimit.reason]).toEqual(["not-checked", "rate-limit"]);
  });
});
