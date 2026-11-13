/**
 * A sentence the assistant wrote that holds a part left out as an opinion is never Supported
 * (#3019): the cited fact may be, but the rest is the assistant's own conclusion, which no Document
 * states. Its parts keep their own results, and the sentence reads Not checked for that reason
 * only when every part judged is supported. A sentence the User wrote keeps today's rule.
 */
import { describe, expect, test } from "vitest";
import type {
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckFailure,
  ClaimCheckPart,
} from "../../src/core";
import { runFailureOf } from "../../src/core/answers/checks/checkResults";
import { asCitedNow, type HeldCitation } from "../../src/shared/citedNow";
import {
  addedCouldChange,
  checkedSentence,
  claimCheckShown,
  readClaimCheck,
} from "../../src/shared/claimChecks";
import {
  checkWithParts,
  leftOutByAssistant,
  partsWrittenBy,
  resultFromParts,
} from "../../src/shared/claimParts";

const CASES = {
  en: {
    fact: "Spring tides come twice a month",
    opinion: "so the harbour should plan for them",
    quote: "Spring tides come twice a month, at new and full moon.",
    join: ", ",
    stop: ".",
  },
  zh: {
    fact: "大潮每月出现两次",
    opinion: "所以港口应当提前安排",
    quote: "大潮每月出现两次，分别在新月和满月。",
    join: "，",
    stop: "。",
  },
} as const;

type Language = keyof typeof CASES;

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

const part = (
  start: number,
  end: number,
  kind: ClaimCheckPart["kind"],
  verdict: ClaimCheckPart["verdict"],
  more: Partial<ClaimCheckPart> = {},
): ClaimCheckPart => ({
  span: { start, end },
  kind,
  verdict,
  evidence: [],
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
});

/** A sentence of a cited fact and a conclusion, in either order, with its parts as a check leaves them. */
function sentenceOf(language: Language, conclusionFirst = false) {
  const { fact, opinion, quote, join, stop } = CASES[language];
  const first = conclusionFirst ? opinion : fact;
  const second = conclusionFirst ? fact : opinion;
  const text = `${first}${join}${second}${stop}`;
  const at = (words: string) => ({
    start: text.indexOf(words),
    end: text.indexOf(words) + words.length,
  });
  const factSpan = at(fact);
  const opinionSpan = at(opinion);
  const factPart = part(factSpan.start, factSpan.end, "fact", "supported", {
    evidence: [passage(quote)],
    decidingEvidence: 0,
  });
  const opinionPart = part(opinionSpan.start, opinionSpan.end, "opinion", null);
  return { text, parts: conclusionFirst ? [opinionPart, factPart] : [factPart, opinionPart] };
}

const checkOf = (text: string, parts: ClaimCheckPart[]): ClaimCheckAttributes =>
  checkWithParts(
    {
      id: "check",
      request: "run",
      action: "check-against-documents",
      state: "checking",
      reason: null,
      detail: null,
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      text,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-11-13T09:00:00.000Z",
    },
    parts,
  );

/** A stored mark as the Note keeps it: its attributes through JSON, read back. */
const stored = (check: ClaimCheckAttributes) => readClaimCheck(JSON.parse(JSON.stringify(check)));

const reads = (check: ClaimCheckAttributes, text: string, citations: HeldCitation[] = []) =>
  claimCheckShown(check, {
    footing: "not-yet-known",
    text,
    citations,
    versions: null,
    folderId: null,
    scope: null,
  });

describe("An opinion left out of a sentence the assistant wrote", () => {
  // protects=a sentence the assistant wrote whose cited fact is supported and whose conclusion was left out as an opinion reads Not checked for its own reason, in English and Chinese, the conclusion after the fact or before it; its parts keep their rows (the fact Supported, the opinion left out, unjudged); fails_when=the sentence reads Supported, a part's own result changes, or the opinion reads judged; no_claim=what the card draws.
  test.each([
    ["en", false],
    ["en", true],
    ["zh", false],
    ["zh", true],
  ] as const)("%s, conclusion first: %s", (language, conclusionFirst) => {
    const { text, parts } = sentenceOf(language, conclusionFirst);
    const written = partsWrittenBy(parts, true);
    const result = resultFromParts(written);
    expect(result.verdict).toBe("not-checked");
    expect(result.verdict === "not-checked" && result.reason).toBe("assistant-conclusion");
    expect(
      result.parts?.map((each) => [each.kind, each.verdict, each.byAssistant ?? null]),
    ).toEqual(
      written.map((each) => [each.kind, each.verdict, each.kind === "opinion" ? true : null]),
    );
    const check = stored(checkOf(text, written));
    expect(check?.state).toBe("not-checked");
    expect(check?.reason).toBe("assistant-conclusion");
    expect(check && reads(check, text)).toEqual({
      state: "not-checked",
      reason: "assistant-conclusion",
    });
  });

  // protects=the same parts in a sentence the User wrote read exactly as before this rule: the flag is never set, the parts are the very same objects, and the stored mark reads Supported; fails_when=a User's sentence loses its ✓ or its parts change; no_claim=whose a sentence is, which the Note's text decides (tests/core/assistantConclusion.test.ts).
  test.each(["en", "zh"] as const)("the User's own sentence keeps today's rule: %s", (language) => {
    const { text, parts } = sentenceOf(language);
    const theirs = partsWrittenBy(parts, false);
    expect(theirs.every((each, index) => each === parts[index])).toBe(true);
    expect(resultFromParts(theirs)).toEqual(resultFromParts(parts));
    expect(resultFromParts(theirs).verdict).toBe("supported");
    const check = stored(checkOf(text, theirs));
    expect(check?.state).toBe("supported");
    expect(JSON.stringify(checkOf(text, theirs))).toBe(JSON.stringify(checkOf(text, parts)));
  });

  // protects=a sentence the assistant wrote with no opinion part is unchanged by the rule, part for part and result for result, whatever its parts' verdicts; fails_when=the rule changes any sentence without an opinion left out; no_claim=the verdicts themselves.
  test("a sentence with no opinion left out is unchanged", () => {
    const quote = passage(CASES.en.quote);
    const sets: ClaimCheckPart[][] = [
      [part(0, 10, "fact", "supported", { evidence: [quote], decidingEvidence: 0 })],
      [
        part(0, 10, "fact", "supported", { evidence: [quote], decidingEvidence: 0 }),
        part(12, 20, "fact", "unsupported"),
      ],
      [part(0, 10, "fact", "not-checked", { reason: "no-evidence" })],
      [part(0, 10, "fact", "contradicted", { evidence: [quote], decidingEvidence: 0 })],
      [
        part(0, 10, "fact", "supported", { evidence: [quote], decidingEvidence: 0 }),
        part(12, 20, "opinion", "unsupported"),
      ],
    ];
    for (const parts of sets) {
      const written = partsWrittenBy(parts, true);
      expect(written.every((each, index) => each === parts[index])).toBe(true);
      expect(resultFromParts(written)).toEqual(resultFromParts(parts));
    }
  });

  // protects=words about the note itself, set aside as an opinion is, never count as the assistant's conclusion: such a sentence keeps its ✓; fails_when=a sentence about the note loses its ✓; no_claim=how the sort names such words.
  test("a sentence about the note itself keeps its ✓", () => {
    const { parts } = sentenceOf("en");
    const [fact, opinion] = parts;
    if (!fact || !opinion) throw new Error("The sentence has two parts.");
    const itself = [fact, { ...opinion, itself: true as const }];
    const written = partsWrittenBy(itself, true);
    expect(written[1]?.byAssistant).toBeUndefined();
    expect(written.some(leftOutByAssistant)).toBe(false);
    expect(resultFromParts(written).verdict).toBe("supported");
  });

  // protects=Check anyway judges the conclusion as any part, and the sentence then takes its parts' worst result as before: supported when the Documents state it, unsupported when they don't; the flag only ever stands on a part with no verdict; fails_when=a judged conclusion still reads as the assistant's own, or the flag stays on it; no_claim=the request Check anyway sends.
  test.each([
    ["supported", "supported"],
    ["unsupported", "unsupported"],
  ] as const)("Check anyway judges the conclusion %s", (verdict, sentence) => {
    const { parts } = sentenceOf("en");
    const [fact, opinion] = partsWrittenBy(parts, true);
    if (!fact || !opinion) throw new Error("The sentence has two parts.");
    const judged = {
      ...opinion,
      verdict,
      ...(verdict === "supported" && {
        evidence: [passage(CASES.en.quote)],
        decidingEvidence: 0,
      }),
    };
    expect(leftOutByAssistant(judged)).toBe(false);
    const landed = partsWrittenBy([fact, judged], true);
    expect(landed[1]?.byAssistant).toBeUndefined();
    expect(resultFromParts(landed).verdict).toBe(sentence);
  });

  // protects=a part that couldn't be checked for a limit (the provider's rate limit, the monthly cap, a plan's limit) or any other reason, and a part found unsupported or contradicted, is still the sentence's result beside the assistant's conclusion, so a run still waits or stops as before; the conclusion's own reason, whose words say the cited fact is supported, shows only when every part judged is; fails_when=the conclusion's reason hides a limit, a failure or an adverse verdict on another part; no_claim=how the run waits.
  test.each<[string, Partial<ClaimCheckPart>, string]>([
    ["rate-limit", { verdict: "not-checked", reason: "rate-limit" }, "not-checked rate-limit"],
    ["cost-cap", { verdict: "not-checked", reason: "cost-cap" }, "not-checked cost-cap"],
    ["plan-limit", { verdict: "not-checked", reason: "plan-limit" }, "not-checked plan-limit"],
    ["no-evidence", { verdict: "not-checked", reason: "no-evidence" }, "not-checked no-evidence"],
    [
      "found-elsewhere",
      { verdict: "not-checked", reason: "found-elsewhere" },
      "not-checked found-elsewhere",
    ],
    ["unsupported", { verdict: "unsupported" }, "unsupported"],
    [
      "contradicted",
      {
        verdict: "contradicted",
        evidence: [passage("Spring tides come once a month.")],
        decidingEvidence: 0,
      },
      "contradicted",
    ],
  ])("beside a part %s", (_kind, other, expected) => {
    const { parts } = sentenceOf("en");
    const written = partsWrittenBy([...parts, part(40, 50, "fact", null, other)], true);
    const result = resultFromParts(written);
    expect(result.verdict === "not-checked" ? `not-checked ${result.reason}` : result.verdict).toBe(
      expected,
    );
    const limit = (["rate-limit", "cost-cap", "plan-limit"] as ClaimCheckFailure[]).find(
      (reason) => reason === other.reason,
    );
    expect(runFailureOf(result)?.kind ?? null).toBe(limit ?? null);
  });

  // protects=beside a fact the Documents back at a Passage the sentence doesn't cite, the sentence reads Supported, not yet cited, with that Passage to add, and once it is cited the sentence reads Not checked for the assistant's conclusion; never a ✓ either way; fails_when=the conclusion's reason, which says the cited fact is supported, shows before the fact is cited, or a ✓ shows after; no_claim=what Add as Citation writes.
  test("beside a fact backed by a Passage the sentence doesn't cite yet", () => {
    const { text, parts } = sentenceOf("en");
    const check = checkOf(text, partsWrittenBy(parts, true));
    const elsewhere: HeldCitation = {
      ...passage("The harbour closes at dusk."),
      passageId: "passage-2",
      pageFrom: 5,
      pageTo: 5,
    };
    expect(asCitedNow(check, [elsewhere], text)).toMatchObject({
      state: "not-checked",
      reason: "found-elsewhere",
    });
    expect(reads(check, text, [elsewhere])).toEqual({
      state: "not-checked",
      reason: "found-elsewhere",
    });
    const cited: HeldCitation = passage(CASES.en.quote);
    expect(reads(check, text, [elsewhere, cited])).toEqual({
      state: "not-checked",
      reason: "assistant-conclusion",
    });
  });

  // protects=such a sentence counts as checked, so it neither holds back the Note's count of what is left to check nor asks Documents added since for a new check; fails_when=Check this Note or Check the rest sends it again, or adding a Document marks it to check; no_claim=the badge's own rows.
  test("it counts as checked", () => {
    const { text, parts } = sentenceOf("en");
    const check = checkOf(text, partsWrittenBy(parts, true));
    const shown = reads(check, text);
    expect(checkedSentence({ text, check: shown, skipped: false, kept: false })).toEqual({
      kind: "covered",
    });
    expect(addedCouldChange(check, shown)).toBe(false);
  });

  // protects=a mark stored before this rule has no flag and keeps its result until its sentence is checked again, whoever wrote it; one stored with the flag reads it back, and the flag stands only on an opinion part; fails_when=a stored result is reread as the assistant's, or the flag is lost or read onto a fact; no_claim=what an older version shows, which reads the parts it knows and so shows today's result.
  test("stored marks", () => {
    const { text, parts } = sentenceOf("zh");
    expect(stored(checkOf(text, parts))?.state).toBe("supported");
    const written = stored(checkOf(text, partsWrittenBy(parts, true)));
    expect(written?.parts?.map((each) => each.byAssistant ?? null)).toEqual([null, true]);
    const onAFact = JSON.parse(JSON.stringify(checkOf(text, parts)));
    onAFact.parts[0].byAssistant = true;
    expect(readClaimCheck(onAFact)?.parts?.[0]?.byAssistant).toBeUndefined();
    expect(readClaimCheck(onAFact)?.state).toBe("supported");
  });
});
