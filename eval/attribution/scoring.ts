import type { CheckClaimInput, ClaimCheckResult, ClaimVerdict } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { findQuote } from "../../src/shared/quoteMatch";
import { meetsExpected } from "../repeats/score";
import type frozen from "./cases.json";

export type AttributionFixture = typeof frozen;
export type AttributionCase = AttributionFixture["cases"][number];

export interface AttributionScore {
  id: string;
  family: string;
  expected: ClaimVerdict;
  native: "hit" | "miss" | "undecided";
  actual: ClaimCheckResult | null;
  evidence: {
    present: boolean;
    scoped: boolean;
    expectedSource: boolean;
    physicallyFound: boolean;
    decisiveCovered: boolean | null;
  };
}

export function attributionInput(
  fixture: AttributionFixture,
  sample: AttributionCase,
  documentIds: ReadonlyMap<string, string>,
): { language: Language; check: CheckClaimInput } {
  if (new Set(documentIds.values()).size !== documentIds.size) {
    throw new Error("Source fixtures need distinct imported Documents.");
  }
  const profile = fixture.profiles.find((each) => each.id === sample.profileId);
  if (!profile) throw new Error("The attribution case has no scope profile.");
  if (sample.language !== "en" && sample.language !== "zh-CN") {
    throw new Error("The attribution case has an unknown language.");
  }
  const ids = profile.inScopeSourceIds.map((id) => {
    const actual = documentIds.get(id);
    if (!actual || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(actual)) {
      throw new Error("An in-scope Source has no imported Document UUID.");
    }
    return actual;
  });
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("The attribution scope needs distinct imported Documents.");
  }
  return {
    language: sample.language,
    check: { claim: sample.text, scope: { folderIds: [], tagIds: [], documentIds: ids } },
  };
}

export function scoreAttribution(
  fixture: AttributionFixture,
  sample: AttributionCase,
  documentIds: ReadonlyMap<string, string>,
  actual: ClaimCheckResult | null | undefined,
): AttributionScore {
  const { check } = attributionInput(fixture, sample, documentIds);
  const expected = sample.gold.nativeVerdict;
  if (expected !== "supported" && expected !== "unsupported" && expected !== "contradicted") {
    throw new Error("The attribution case has an unknown expected verdict.");
  }
  const verdict = actual?.verdict;
  const evidence = actual && actual.verdict !== "not-checked" ? actual.evidence : null;
  const source = evidence
    ? fixture.sources.find((each) => documentIds.get(each.id) === evidence.documentId)
    : undefined;
  const scoped = Boolean(evidence && check.scope?.documentIds.includes(evidence.documentId));
  const physicallyFound = Boolean(
    evidence?.check === "found" &&
      source &&
      evidence.quote.trim() &&
      findQuote(source.text, evidence.quote),
  );
  const decisive = sample.gold.sourceEvidence.filter(
    (proof) =>
      proof.role === "newer-current-conflict" || proof.role === "decisive-surrounding-context",
  );
  return {
    id: sample.id,
    family: sample.family,
    expected,
    native:
      verdict === undefined || verdict === "not-checked"
        ? "undecided"
        : meetsExpected({ expected, outcome: verdict })
          ? "hit"
          : "miss",
    actual: actual ?? null,
    evidence: {
      present: evidence !== null,
      scoped,
      expectedSource: Boolean(
        evidence &&
          sample.gold.sourceEvidence.some(
            (proof) => documentIds.get(proof.sourceId) === evidence.documentId,
          ),
      ),
      physicallyFound,
      decisiveCovered:
        decisive.length === 0
          ? null
          : Boolean(
              scoped &&
                physicallyFound &&
                evidence &&
                decisive.every(
                  (proof) =>
                    documentIds.get(proof.sourceId) === evidence.documentId &&
                    findQuote(evidence.quote, proof.quote),
                ),
            ),
    },
  };
}

export function scoreAttributionSet(
  fixture: AttributionFixture,
  documentIds: ReadonlyMap<string, string>,
  results: ReadonlyMap<string, ClaimCheckResult>,
) {
  const rows = fixture.cases.map((sample) =>
    scoreAttribution(fixture, sample, documentIds, results.get(sample.id)),
  );
  const reversed = rows.filter(
    (row) => row.family === "out-of-context" && row.expected === "contradicted",
  );
  const supported = rows.filter((row) => row.expected === "supported");
  return {
    rows,
    nativeMisses: rows.filter((row) => row.native !== "hit"),
    undecided: rows.filter((row) => row.native === "undecided").length,
    reversedContext: {
      nativeHits: reversed.filter((row) => row.native === "hit").length,
      total: reversed.length,
      decisiveCovered: reversed.filter((row) => row.evidence.decisiveCovered).length,
    },
    supportedControls: {
      nativeHits: supported.filter((row) => row.native === "hit").length,
      total: supported.length,
    },
  };
}
