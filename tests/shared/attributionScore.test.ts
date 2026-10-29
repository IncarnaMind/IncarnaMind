import { describe, expect, test } from "vitest";
import fixture from "../../eval/attribution/cases.json";
import {
  attributionInput,
  scoreAttribution,
  scoreAttributionSet,
} from "../../eval/attribution/scoring";
import type { Citation, ClaimCheckResult, ClaimVerdict } from "../../src/core/api";

const ids = new Map(
  fixture.sources.map((source, index) => [
    source.id,
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function sample(id: string) {
  const found = fixture.cases.find((each) => each.id === id);
  if (!found) throw new Error("The test case is missing.");
  return found;
}

function citation(sourceId: string, quote?: string): Citation {
  const source = fixture.sources.find((each) => each.id === sourceId);
  const documentId = ids.get(sourceId);
  if (!source || !documentId) throw new Error("The test Source is missing.");
  return {
    passageId: "ordinary-passage",
    documentId,
    documentName: source.title,
    contentHash: source.sha256,
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote: quote ?? source.text,
    check: "found",
    checkReason: null,
  };
}

const result = (verdict: ClaimVerdict, evidence: Citation | null): ClaimCheckResult => ({
  verdict,
  evidence,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [],
  excluded: [],
});

describe("attribution input and scoring boundaries", () => {
  test.each(["N01-en", "N01-zh-CN"])("projects only the assertion and real scope: %s", (id) => {
    const each = sample(id);
    const projected = attributionInput(fixture, each, ids);
    const profile = fixture.profiles.find((profile) => profile.id === each.profileId);
    if (!profile) throw new Error("The profile is missing.");
    expect(projected).toEqual({
      language: each.language,
      check: {
        claim: each.text,
        scope: {
          folderIds: [],
          tagIds: [],
          documentIds: profile.inScopeSourceIds.map((sourceId) => ids.get(sourceId)),
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain(each.gold.rationale);
    expect(JSON.stringify(projected)).not.toContain(each.id);
    for (const sourceId of profile.inScopeSourceIds) {
      expect(JSON.stringify(projected)).not.toContain(sourceId);
    }
  });

  test("rejects missing, fixture-id and duplicate Document mappings", () => {
    const each = sample("N01-en");
    expect(() => attributionInput(fixture, each, new Map())).toThrow(/UUID/);
    const wrong = new Map(ids);
    wrong.set("annual-2023-en", "annual-2023-en");
    expect(() => attributionInput(fixture, each, wrong)).toThrow(/UUID/);
    const same = ids.get("annual-2023-en");
    if (!same) throw new Error("The Document is missing.");
    wrong.set("annual-2023-en", same);
    wrong.set("annual-2024-en", same);
    expect(() => attributionInput(fixture, each, wrong)).toThrow(/distinct/);
    const aliased = new Map(ids);
    const oldRate = ids.get("rate-old-en");
    if (!oldRate) throw new Error("The rate Document is missing.");
    aliased.set("rate-new-en", oldRate);
    expect(() => attributionInput(fixture, sample("T03-en"), aliased)).toThrow(/distinct/);
  });

  test("keeps a verdict hit separate from exact identity, scope and physical text", () => {
    const each = sample("T03-en");
    const outside = result("unsupported", citation("rate-new-en"));
    const scored = scoreAttribution(fixture, each, ids, outside);
    expect(scored.native).toBe("hit");
    expect(scored.actual).toBe(outside);
    expect(scored.evidence).toMatchObject({
      scoped: false,
      expectedSource: false,
      physicallyFound: true,
    });
    const forged = result("unsupported", citation("rate-old-en", "The rate is 92%."));
    expect(scoreAttribution(fixture, each, ids, forged).evidence.physicallyFound).toBe(false);
    const notFound = result("unsupported", { ...citation("rate-old-en"), check: "not-found" });
    expect(scoreAttribution(fixture, each, ids, notFound).evidence.physicallyFound).toBe(false);
    const wrongSource = result("supported", citation("annual-2024-en"));
    expect(scoreAttribution(fixture, sample("N01-en"), ids, wrongSource).evidence).toMatchObject({
      scoped: true,
      expectedSource: false,
    });
  });

  test.each(["C01-en", "C01-zh-CN"])("a short found quote alone is no context proof: %s", (id) => {
    const each = sample(id);
    const literal = each.gold.sourceEvidence.find((proof) => proof.role === "literal-quote");
    const decisive = each.gold.sourceEvidence.find(
      (proof) => proof.role === "decisive-surrounding-context",
    );
    if (!literal || !decisive) throw new Error("The context proofs are missing.");
    const short = result("contradicted", citation(literal.sourceId, literal.quote));
    expect(scoreAttribution(fixture, each, ids, short)).toMatchObject({
      native: "hit",
      evidence: { physicallyFound: true, decisiveCovered: false },
    });
    const full = result("contradicted", citation(decisive.sourceId, decisive.quote));
    expect(scoreAttribution(fixture, each, ids, full).evidence.decisiveCovered).toBe(true);
  });

  test("the newer-conflict diagnostic cannot be satisfied by the older Source", () => {
    const each = sample("T02-en");
    const old = result("contradicted", citation("rate-old-en"));
    expect(scoreAttribution(fixture, each, ids, old).evidence.decisiveCovered).toBe(false);
    const newer = result("contradicted", citation("rate-new-en"));
    expect(scoreAttribution(fixture, each, ids, newer).evidence.decisiveCovered).toBe(true);
  });

  test("missing and malformed Core outcomes remain undecided; null evidence stays absent", () => {
    const malformed: ClaimCheckResult = {
      verdict: "not-checked",
      reason: "malformed",
      detail: null,
      versions: [],
      excluded: [],
    };
    for (const actual of [undefined, malformed]) {
      expect(scoreAttribution(fixture, sample("N01-en"), ids, actual).native).toBe("undecided");
    }
    expect(
      scoreAttribution(fixture, sample("N04-en"), ids, result("unsupported", null)),
    ).toMatchObject({
      native: "hit",
      evidence: { present: false, scoped: false, physicallyFound: false },
    });
  });

  test("missing results stay in all denominators and every miss retains its actual outcome", () => {
    const wrong = result("unsupported", null);
    const scored = scoreAttributionSet(fixture, ids, new Map([["N01-en", wrong]]));
    expect(scored.rows).toHaveLength(40);
    expect(scored.nativeMisses).toHaveLength(40);
    expect(scored.undecided).toBe(39);
    expect(scored.nativeMisses.find((row) => row.id === "N01-en")?.actual).toBe(wrong);
    expect(scored.reversedContext).toEqual({ nativeHits: 0, total: 10, decisiveCovered: 0 });
    expect(scored.supportedControls).toEqual({ nativeHits: 0, total: 12 });
    const rejected = scoreAttributionSet(
      fixture,
      ids,
      new Map(fixture.cases.map((each) => [each.id, result("unsupported", null)])),
    );
    expect(rejected.nativeMisses).toHaveLength(24);
    expect(rejected.supportedControls).toEqual({ nativeHits: 0, total: 12 });
    expect(rejected.reversedContext.nativeHits).toBe(0);
  });
});
