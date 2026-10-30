import { describe, expect, test } from "vitest";
import type {
  CheckFigure,
  Citation,
  ClaimCheckAttributes,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartPlan,
  FigureCheckResult,
} from "../../src/core/api";
import { claimCheckShown, readClaimCheck, restsOn } from "../../src/shared/claimChecks";
import {
  checkWithParts,
  coverageCount,
  figuresByPart,
  partWithResult,
  pendingPart,
  readClaimParts,
  readPartPlans,
  resultFromParts,
  withFigureFacts,
} from "../../src/shared/claimParts";
import {
  beginFigureCheck,
  emptyFigureFinding,
  settleFigureCheck,
} from "../../src/shared/figureChecks";
import { readFigures } from "../../src/shared/figures";
import { projectInlineText } from "../../src/shared/inlineText";

const source = (id = "source"): Citation => ({
  passageId: `passage-${id}`,
  documentId: id,
  documentName: id,
  contentHash: `hash-${id}`,
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "page", from: 1, to: 1 },
  quote: "Revenue rose.",
  check: "found",
  checkReason: null,
});
const plan: ClaimPartPlan = { span: { start: 0, end: 12 }, kind: "fact" };
const result = (
  verdict: "supported" | "unsupported" | "contradicted" = "supported",
  id = "source",
): Exclude<ClaimCheckResult, { verdict: "not-checked" }> => ({
  verdict,
  evidence: verdict === "unsupported" ? null : source(id),
  says: null,
  unsupported:
    verdict === "unsupported" ? { reason: "Not stated.", covered: null, uncovered: null } : null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [{ documentId: id, contentHash: `hash-${id}` }],
  excluded: [],
});
const part = (verdict: "supported" | "unsupported" | "contradicted" = "supported", id = "source") =>
  partWithResult(plan, result(verdict, id));
const mark = (parts?: ClaimCheckPart[]): ClaimCheckAttributes => ({
  id: "check",
  request: "request",
  action: "check-against-documents",
  state: "supported",
  text: "Revenue rose.",
  evidence: source(),
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  providerId: null,
  modelId: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-28T00:00:00.000Z",
  ...(parts && { parts }),
});

describe("ordered claim part codec", () => {
  test.each(["Revenue rose. We should wait.", "收入增长。我们应该等待。"])(
    "round trips %s",
    (text) => {
      const start = text.indexOf(text.startsWith("Revenue") ? "We" : "我们");
      const plans: ClaimPartPlan[] = [
        { kind: "fact", span: { start: 0, end: start } },
        { kind: "opinion", span: { start, end: text.length } },
      ];
      const parts = [partWithResult(plans[0] ?? plan, result()), pendingPart(plans[1] ?? plan)];
      expect(readPartPlans(plans, text)).toEqual(plans);
      expect(readClaimParts(JSON.parse(JSON.stringify(parts)), text)).toEqual(parts);
    },
  );

  test.each([
    [{ kind: "fact", span: { start: -1, end: 2 } }],
    [{ kind: "fact", span: { start: 0.5, end: 2 } }],
    [{ kind: "fact", span: { start: 0, end: 20 } }],
    [{ kind: "fact", span: { start: 0, end: 0 } }],
    [
      { kind: "fact", span: { start: 0, end: 5 } },
      { kind: "opinion", span: { start: 4, end: 8 } },
    ],
    [{ kind: "other", span: { start: 0, end: 2 } }],
  ])("rejects malformed plans %j", (...plans) => {
    expect(readPartPlans(plans, "Revenue rose.")).toBeNull();
  });

  test("preserves UTF16 offsets without splitting a surrogate pair", () => {
    expect(readPartPlans([{ kind: "opinion", span: { start: 0, end: 2 } }], "😀好")).not.toBeNull();
    expect(readPartPlans([{ kind: "opinion", span: { start: 0, end: 1 } }], "😀好")).toBeNull();
  });

  test("empty sort plans are structural data, never a completed Supported check", () => {
    expect(readPartPlans([], "Revenue rose.")).toEqual([]);
    expect(readPartPlans([], "")).toEqual([]);
    expect(readClaimCheck(mark([]))).toMatchObject({ state: "not-checked", reason: "malformed" });
  });

  test("pending state is the existing checking state; null facts require a checking owner", () => {
    expect(pendingPart(plan).verdict).toBe("checking");
    const nil = { ...pendingPart(plan), verdict: null };
    expect(readClaimParts([nil], "Revenue rose.")).toBeNull();
    expect(readClaimParts([nil], "Revenue rose.", "checking")).toEqual([nil]);
    expect(resultFromParts([pendingPart(plan)])).toMatchObject({
      verdict: "not-checked",
      reason: "malformed",
    });
    expect(resultFromParts([nil])).toMatchObject({ verdict: "not-checked", reason: "malformed" });
  });

  // protects=a part that couldn't be checked never hides a contradicted or unsupported sibling: the worst result across parts is the sentence's, so it keeps its mark (#2002); fails_when=a rate-limited part turns a contradicted sentence Not checked, with no mark; no_claim=how the card lays the rows out.
  test("the worst result across parts wins over a part that couldn't be checked", () => {
    const second: ClaimPartPlan = { span: { start: 13, end: 25 }, kind: "fact" };
    const limited = partWithResult(second, {
      verdict: "not-checked",
      reason: "rate-limit",
      detail: null,
      versions: [],
      excluded: [],
    });
    expect(resultFromParts([part("contradicted"), limited])).toMatchObject({
      verdict: "contradicted",
      evidence: source(),
      parts: [{ verdict: "contradicted" }, { verdict: "not-checked", reason: "rate-limit" }],
    });
    expect(resultFromParts([limited, part("unsupported")])).toMatchObject({
      verdict: "unsupported",
    });
    expect(resultFromParts([part("supported"), limited])).toMatchObject({
      verdict: "not-checked",
      reason: "rate-limit",
    });
  });

  // protects=a contradicted part shows beside a part stopped or still being checked, and one with no valid evidence never shows as Contradicted, though an unsupported sibling still shows (#2002); fails_when=a stopped or unfinished part hides the contradiction, or a contradiction with nothing behind it gets a mark; no_claim=how the card lays the rows out.
  test.each([
    ["stopped", "stopped" as const],
    ["still being checked", null],
  ])("a contradicted part wins over a part %s", (_, reason) => {
    const second: ClaimPartPlan = { span: { start: 13, end: 25 }, kind: "fact" };
    const other =
      reason === null
        ? pendingPart(second)
        : partWithResult(second, {
            verdict: "not-checked",
            reason,
            detail: null,
            versions: [],
            excluded: [],
          });
    expect(resultFromParts([part("contradicted"), other])).toMatchObject({
      verdict: "contradicted",
    });
    expect(resultFromParts([other, part("contradicted")])).toMatchObject({
      verdict: "contradicted",
    });
  });

  test("a contradicted part with no valid evidence is no contradiction, and an unsupported sibling still shows", () => {
    const empty = { ...part("contradicted"), evidence: [] };
    expect(resultFromParts([empty])).toMatchObject({ verdict: "not-checked" });
    expect(resultFromParts([empty, part("unsupported")])).toMatchObject({
      verdict: "unsupported",
    });
  });

  test("legacy marks retain their existing fields", () => {
    expect(readClaimCheck(mark())).toEqual(mark());
    expect(readClaimCheck({ ...mark(), parts: null })).toEqual(mark());
  });

  test("malformed part evidence cannot preserve an old Supported parent", () => {
    const read = readClaimCheck({
      ...mark(),
      says: "An old conclusion.",
      unsupported: { reason: "An old reason.", covered: null, uncovered: null },
      citedCaseUnchecked: true,
      citedCaseFound: true,
      parts: [{ ...part(), evidence: [{ check: "found" }] }],
    });
    expect(read).toMatchObject({
      state: "not-checked",
      reason: "malformed",
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
    });
  });

  test("parts determine the compatibility result instead of an old scalar", () => {
    expect(readClaimCheck(mark([part("contradicted")]))).toMatchObject({ state: "contradicted" });
  });

  test("an edit that shifts literal part offsets needs a re-check", () => {
    expect(
      claimCheckShown(mark([part()]), {
        text: "Revenue  rose.",
        versions: null,
        folderId: null,
        scope: null,
      }),
    ).toEqual({ state: "needs-recheck", why: "edited" });
  });

  test.each(["forecast-certainty", "unbacked-cause"] as const)(
    "retains typed reason %s",
    (kind) => {
      const rejected = {
        ...part("unsupported"),
        unsupported: { kind, reason: "Not backed.", covered: null, uncovered: null },
      };
      expect(readClaimParts([rejected], "Revenue rose.")?.[0]?.unsupported?.kind).toBe(kind);
      expect(
        readClaimCheck({ ...mark(), unsupported: rejected.unsupported })?.unsupported?.kind,
      ).toBe(kind);
    },
  );
});

describe("one sentence projection", () => {
  test.each(["No Passage is about this detail.", "没有段落谈到这个细节。"])(
    "an off-topic checked quote remains provenance without deciding %s",
    (reason) => {
      const quote = source("off-topic");
      const projected = resultFromParts([
        partWithResult(
          plan,
          { ...result("unsupported"), unsupported: { reason, covered: null, uncovered: null } },
          [quote],
        ),
      ]);
      expect(projected).toMatchObject({ verdict: "unsupported", evidence: null });
      expect(projected.parts?.[0]?.evidence).toEqual([quote]);
      expect(projected.parts?.[0]).toMatchObject({ decidingEvidence: null });
      if (projected.verdict !== "unsupported") throw new Error("Expected Unsupported.");
      expect(projected.unsupported?.found).not.toBe(true);
      const stored = {
        ...mark(projected.parts),
        state: projected.verdict,
        evidence: projected.evidence,
        unsupported: projected.unsupported,
        versions: projected.versions,
      };
      expect(readClaimCheck(stored)).toMatchObject({ evidence: null });
      expect(readClaimCheck(readClaimCheck(stored))).toEqual(readClaimCheck(stored));
    },
  );

  test.each(["The Document gives another value.", "文档给出了另一个数值。"])(
    "an actual nearest deciding quote remains found for %s",
    (reason) => {
      const quote = source("nearest");
      const atomic = {
        ...result("unsupported"),
        evidence: quote,
        unsupported: { reason, covered: "the amount", uncovered: "the period" },
      };
      const checked = partWithResult(plan, atomic);
      expect(checked.unsupported).toEqual(atomic.unsupported);
      expect(checked).toMatchObject({ decidingEvidence: 0 });
      const projected = resultFromParts([checked]);
      expect(projected).toMatchObject({
        verdict: "unsupported",
        evidence: quote,
        unsupported: atomic.unsupported,
      });
      const stored = {
        ...mark(projected.parts),
        state: projected.verdict,
        evidence: quote,
        unsupported: projected.verdict === "unsupported" ? projected.unsupported : null,
      };
      expect(readClaimCheck(stored)).toMatchObject({
        evidence: quote,
        unsupported: atomic.unsupported,
      });
      expect(readClaimCheck(readClaimCheck(stored))).toEqual(readClaimCheck(stored));
    },
  );

  test.each([
    ["the amount, 54,000", "the currency (£)"],
    ["金额 54,000", "币种（£）"],
  ])(
    "partial proof without a quoted field preserves %s / %s without a scalar decider",
    (covered, uncovered) => {
      const quote = source("unit-input");
      const atomic = {
        ...result("unsupported"),
        unsupported: { reason: null, covered, uncovered, found: true as const },
      };
      const projected = resultFromParts([partWithResult(plan, atomic, [quote])]);
      expect(projected).toMatchObject({
        verdict: "unsupported",
        evidence: null,
        unsupported: atomic.unsupported,
        parts: [{ decidingEvidence: null, evidence: [quote] }],
      });
      expect(projected.parts?.[0]?.unsupported?.quoted).toBeUndefined();
      const stored = {
        ...mark(projected.parts),
        state: "unsupported",
        evidence: null,
        unsupported: atomic.unsupported,
      };
      expect(readClaimCheck(stored)).toMatchObject({
        evidence: null,
        unsupported: atomic.unsupported,
      });
      expect(readClaimCheck(readClaimCheck(stored))).toEqual(readClaimCheck(stored));
    },
  );

  test.each([-1, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "0", true])(
    "a deciding evidence index %s outside the checked inventory fails closed",
    (decidingEvidence) => {
      const invalid = { ...part(), decidingEvidence };
      expect(readClaimParts([invalid], "Revenue rose.")).toBeNull();
      expect(readClaimCheck({ ...mark(), parts: [invalid] })).toMatchObject({
        state: "not-checked",
        reason: "malformed",
        evidence: null,
      });
    },
  );

  test("an explicit deciding role must point to a found Citation", () => {
    const invalid = {
      ...part("unsupported"),
      decidingEvidence: 0,
      evidence: [{ ...source(), check: "not-found" as const }],
    };
    expect(readClaimParts([invalid], "Revenue rose.")).toBeNull();
    expect(resultFromParts([invalid])).toMatchObject({
      verdict: "not-checked",
      reason: "malformed",
    });
  });

  test("explicit nonfirst and null deciding roles survive canonical reloads", () => {
    for (const decidingEvidence of [1, null]) {
      const stored = mark([
        {
          ...part("unsupported"),
          decidingEvidence,
          evidence: [source("context"), source("deciding")],
        },
      ]);
      const read = readClaimCheck(stored);
      expect(read?.evidence?.documentId ?? null).toBe(
        decidingEvidence === null ? null : "deciding",
      );
      expect(read?.parts?.[0]).toMatchObject({ decidingEvidence });
      expect(readClaimCheck(read)).toEqual(read);
    }
  });

  test("an old part without a deciding role keeps its legacy projection", () => {
    const old = { ...part("unsupported"), evidence: [source("legacy")] };
    delete old.decidingEvidence;
    const read = readClaimCheck(mark([old]));
    expect(read?.evidence?.documentId).toBe("legacy");
    expect(read?.parts?.[0]).not.toHaveProperty("decidingEvidence");
    expect(readClaimCheck(read)).toEqual(read);
  });

  test("retains complementary sources and unions all versions and exclusions", () => {
    const first = partWithResult(plan, result("supported", "one"), [source("one"), source("two")]);
    const second = {
      ...part("supported", "two"),
      span: { start: 13, end: 20 },
      excluded: [{ documentId: "own", documentName: "Own", reason: "own-file" as const }],
    };
    const projected = resultFromParts([first, second]);
    expect(projected.verdict).toBe("supported");
    expect(projected.parts?.[0]?.evidence).toHaveLength(2);
    expect(projected.versions).toEqual([
      result("supported", "one").versions[0],
      result("supported", "two").versions[0],
    ]);
    expect(projected.excluded).toEqual(second.excluded);
  });

  test("a partial quote is retained without becoming the sentence's deciding evidence", () => {
    const quote = source("partial");
    const partial = {
      ...result("unsupported"),
      unsupported: {
        reason: null,
        covered: "Revenue rose",
        uncovered: "profit rose",
        quoted: quote,
      },
    };
    const projected = resultFromParts([partWithResult(plan, partial, [quote])]);
    expect(projected).toMatchObject({
      verdict: "unsupported",
      evidence: null,
      unsupported: partial.unsupported,
    });
    expect(projected.parts?.[0]?.evidence).toEqual([quote]);
  });

  test("the deciding quote precedes wider calculation input evidence", () => {
    const deciding = { ...source("one"), quote: "Revenue was £131.9m in 2025" };
    const wider = {
      ...deciding,
      quote: "Revenue was £131.9m in 2025, compared with £118.2m in 2024.",
    };
    const projected = resultFromParts([
      partWithResult(plan, { ...result("contradicted", "one"), evidence: deciding }, [wider]),
    ]);
    expect(projected).toMatchObject({ verdict: "contradicted", evidence: deciding });
    expect(projected.parts?.[0]?.evidence).toEqual([deciding, wider]);
  });

  test("contradiction precedes unsupported, a failure and supported; a failure keeps its detail", () => {
    const failed = partWithResult(plan, {
      verdict: "not-checked",
      reason: "failed",
      detail: "Provider stopped.",
      versions: [],
      excluded: [],
    });
    expect(
      resultFromParts([part("supported"), part("unsupported"), part("contradicted"), failed])
        .verdict,
    ).toBe("contradicted");
    expect(resultFromParts([part("supported"), failed])).toMatchObject({
      verdict: "not-checked",
      reason: "failed",
      detail: "Provider stopped.",
    });
    expect(resultFromParts([part("unsupported"), part("contradicted")]).verdict).toBe(
      "contradicted",
    );
    expect(resultFromParts([part("unsupported"), part()]).verdict).toBe("unsupported");
  });

  test("partial factual support makes the parent Unsupported while its missing row stays Not found", () => {
    const missing = partWithResult(plan, result("unsupported"), [source("off-topic")]);
    const projected = resultFromParts([part("supported"), missing]);
    expect(projected).toMatchObject({
      verdict: "unsupported",
      evidence: null,
      unsupported: { found: true },
    });
    expect(projected.parts?.[1]?.evidence).toEqual(missing.evidence);
    expect(missing.unsupported?.found).not.toBe(true);
    const absent = resultFromParts([part("unsupported"), missing]);
    expect(absent.verdict).toBe("unsupported");
    if (absent.verdict === "unsupported") expect(absent.unsupported?.found).not.toBe(true);
  });

  test("coverage outcome proof counts as partial support, domain context alone does not", () => {
    const coverage = {
      unit: "quarters",
      quantifier: "all" as const,
      complete: true,
      members: [{ label: "Q1", verdict: "unsupported" as const, evidence: [] }],
      domainEvidence: [source("domain")],
    };
    const contextOnly = resultFromParts([
      { ...part("unsupported"), evidence: coverage.domainEvidence, coverage },
    ]);
    expect(contextOnly.verdict).toBe("unsupported");
    if (contextOnly.verdict === "unsupported") expect(contextOnly.evidence).toBeNull();
    expect(contextOnly.parts?.[0]?.evidence).toEqual(coverage.domainEvidence);
    if (contextOnly.verdict === "unsupported")
      expect(contextOnly.unsupported?.found).not.toBe(true);
    const partial = resultFromParts([
      {
        ...part("unsupported"),
        coverage: {
          ...coverage,
          members: [
            { label: "Q1", verdict: "supported", evidence: [source("outcome")] },
            ...coverage.members.map((member) => ({ ...member, label: "Q2" })),
          ],
        },
      },
    ]);
    expect(partial).toMatchObject({ verdict: "unsupported", unsupported: { found: true } });
  });

  test("empty or all-omitted inventory is never vacuously Supported", () => {
    expect(resultFromParts([])).toMatchObject({ verdict: "not-checked", reason: "malformed" });
    expect(resultFromParts([pendingPart({ ...plan, kind: "opinion" })])).toMatchObject({
      verdict: "not-checked",
      reason: "malformed",
    });
  });

  test("a Supported child with no found evidence fails closed", () => {
    expect(resultFromParts([{ ...part(), evidence: [], decidingEvidence: null }])).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    expect(
      resultFromParts([
        { ...part(), decidingEvidence: null, evidence: [{ ...source(), documentId: "" }] },
      ]),
    ).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
  });

  test.each([
    ["Revenue rose.", "Costs fell."],
    ["收入增长。", "成本下降。"],
  ])("rejected proof cannot leave a green child beside a valid fact in %s %s", (first, last) => {
    const text = `${first} ${last}`;
    const bad = {
      ...part(),
      span: { start: 0, end: first.length },
      evidence: [],
      decidingEvidence: null,
      says: "An old conclusion.",
      unsupported: { reason: "An old reason.", covered: null, uncovered: null },
      citedCaseUnchecked: true,
      citedCaseFound: true,
    };
    const good = {
      ...part("supported", "neighbor"),
      span: { start: first.length + 1, end: text.length },
    };
    const projected = resultFromParts([bad, good]);
    expect(projected).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(projected.parts?.[0]).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
      detail: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
    });
    expect(projected.parts?.[1]).toEqual(good);
    expect(resultFromParts(projected.parts ?? [])).toEqual(projected);
    const read = readClaimCheck({ ...mark([bad, good]), text, says: "An old conclusion." });
    expect(read?.parts).toEqual(projected.parts);
    expect(read).toMatchObject({
      state: "not-checked",
      reason: "no-evidence",
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
    });
  });

  test("an existing failure keeps its original reason while every other child is normalized", () => {
    const failed = partWithResult(plan, {
      verdict: "not-checked",
      reason: "rate-limit",
      detail: "Provider stopped.",
      versions: [],
      excluded: [],
    });
    const good = part("supported", "neighbor");
    const projected = resultFromParts([
      { ...part(), evidence: [], decidingEvidence: null },
      good,
      failed,
    ]);
    expect(projected).toMatchObject({
      verdict: "not-checked",
      reason: "rate-limit",
      detail: "Provider stopped.",
    });
    expect(projected.parts?.[0]).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(projected.parts?.[1]).toEqual(good);
    expect(projected.parts?.[2]).toEqual(failed);
    expect(resultFromParts(projected.parts ?? [])).toEqual(projected);
  });

  test("coverage names implicit members without invented Note spans, and counts members", () => {
    const coverage = {
      unit: "quarters",
      quantifier: "all" as const,
      complete: true,
      members: [1, 2, 3, 4].map((n) => ({
        label: `Q${n}`,
        verdict: n < 4 ? ("supported" as const) : ("unsupported" as const),
        evidence: n < 4 ? [source(`quarter-${n}`)] : [],
      })),
      domainEvidence: [source("domain")],
    };
    const checked = { ...part(), coverage };
    expect(coverageCount(coverage)).toEqual({ covered: 3, total: 4 });
    expect(resultFromParts([checked]).verdict).toBe("unsupported");
    expect(resultFromParts([checked]).parts?.[0]?.verdict).toBe("unsupported");
    expect(readClaimParts([checked], "Revenue rose.")?.[0]?.coverage).toEqual(coverage);
    expect(restsOn(mark([checked])).map((citation) => citation.documentId)).toContain("domain");
  });

  test("domain context alone cannot prove a member outcome", () => {
    const coverage = {
      unit: "quarters",
      quantifier: "all" as const,
      complete: true,
      members: [{ label: "Q1", verdict: "supported" as const, evidence: [] }],
      domainEvidence: [source("domain")],
    };
    expect(resultFromParts([{ ...part(), coverage }])).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
      parts: [
        {
          verdict: "not-checked",
          reason: "no-evidence",
          coverage: { members: [{ label: "Q1", verdict: "not-checked", evidence: [] }] },
        },
      ],
    });
    expect(coverageCount(coverage)).toEqual({ covered: 0, total: 1 });
  });

  test.each(["not-checked", "checking"] as const)(
    "a %s child cannot retain an unproved green coverage member",
    (verdict) => {
      const projected = resultFromParts([
        {
          ...part(),
          verdict,
          reason: verdict === "not-checked" ? "rate-limit" : null,
          detail: verdict === "not-checked" ? "Provider stopped." : null,
          coverage: {
            unit: "quarters",
            quantifier: "all",
            complete: true,
            members: [{ label: "Q1", verdict: "supported", evidence: [] }],
            domainEvidence: [source("domain")],
          },
        },
      ]);
      expect(projected).toMatchObject({
        verdict: "not-checked",
        reason: verdict === "not-checked" ? "rate-limit" : "malformed",
        detail: verdict === "not-checked" ? "Provider stopped." : null,
        parts: [
          {
            verdict: "not-checked",
            coverage: { members: [{ label: "Q1", verdict: "not-checked", evidence: [] }] },
          },
        ],
      });
    },
  );

  test("found outcomes do not establish an absent or failed domain", () => {
    const coverage = {
      unit: "quarters",
      quantifier: "all" as const,
      complete: true,
      members: [{ label: "Q1", verdict: "supported" as const, evidence: [source("outcome")] }],
      domainEvidence: [],
    };
    expect(resultFromParts([{ ...part(), coverage }])).toMatchObject({
      verdict: "unsupported",
    });
    expect(
      resultFromParts([
        {
          ...part(),
          coverage: { ...coverage, domainEvidence: [{ ...source("domain"), check: "not-found" }] },
        },
      ]),
    ).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
  });

  test("a strict majority differs from all and retains unknown members in its denominator", () => {
    const coverage = {
      unit: "stores",
      quantifier: "most" as const,
      complete: true,
      domainEvidence: [source("domain")],
      members: [1, 2, 3, 4].map((n) => ({
        label: `Store ${n}`,
        verdict: n < 4 ? ("supported" as const) : ("not-checked" as const),
        evidence: n < 4 ? [source(`store-${n}`)] : [],
      })),
    };
    expect(coverageCount(coverage)).toEqual({ covered: 3, total: 4 });
    expect(resultFromParts([{ ...part(), coverage }]).verdict).toBe("supported");
    expect(
      resultFromParts([{ ...part(), coverage: { ...coverage, quantifier: "all" } }]).verdict,
    ).toBe("unsupported");
    expect(
      resultFromParts([{ ...part(), coverage: { ...coverage, complete: false } }]).verdict,
    ).toBe("unsupported");
    const minority = {
      ...coverage,
      members: coverage.members.map((member, index) =>
        index === 2 ? { ...member, verdict: "unsupported" as const, evidence: [] } : member,
      ),
    };
    expect(resultFromParts([{ ...part(), coverage: minority }]).verdict).toBe("unsupported");
    const contrary = {
      ...coverage,
      members: coverage.members.map((member, index) =>
        index === 3
          ? { ...member, verdict: "contradicted" as const, evidence: [source("contrary")] }
          : member,
      ),
    };
    expect(resultFromParts([{ ...part(), coverage: contrary }]).verdict).toBe("supported");
    expect(readClaimParts([{ ...part(), coverage }], "Revenue rose.")?.[0]?.coverage).toEqual(
      coverage,
    );
  });

  test("every declared proof must be found, even beside a good quote", () => {
    expect(
      resultFromParts([
        { ...part(), evidence: [source(), { ...source("missing"), check: "not-found" }] },
      ]),
    ).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
  });

  test("the common closure keeps calculation input and unit sources with part evidence", () => {
    const calculation: NonNullable<ClaimCheckPart["calculation"]> = {
      stated: "10",
      agrees: true,
      figure: {
        label: "Value",
        formula: "a",
        value: 10,
        unit: { kind: "plain" },
        approximate: false,
        shown: "10",
        show: { language: "en", as: null, decimals: 0, scale: null },
        literals: [],
        engine: 1,
        written: null,
        inputs: [
          {
            name: "a",
            label: "Value",
            citation: source("input"),
            cell: null,
            number: {
              chars: "10",
              at: 0,
              value: 10,
              scale: 1,
              scaleWord: null,
              unit: { kind: "plain" },
              decimals: 0,
              approximate: false,
              reading: null,
            },
            unitStatement: { citation: source("units"), scale: 1, scaleWord: null, currency: null },
          },
        ],
      },
    };
    const checked = {
      ...part(),
      calculation,
      unsupported: {
        reason: "Part covered.",
        covered: "value",
        uncovered: "rest",
        quoted: source("covered"),
      },
    };
    const relied = restsOn(mark([checked])).map((citation) => citation.documentId);
    expect(relied).toEqual(expect.arrayContaining(["source", "covered", "input", "units"]));
    expect(resultFromParts([{ ...checked, evidence: [], decidingEvidence: null }]).verdict).toBe(
      "supported",
    );
    const badUnit = {
      ...calculation,
      figure: {
        ...calculation.figure,
        inputs: calculation.figure.inputs.map((input) => ({
          ...input,
          unitStatement: {
            citation: { ...source("units"), check: "not-found" as const },
            scale: 1,
            scaleWord: null,
            currency: null,
          },
        })),
      },
    };
    expect(resultFromParts([{ ...checked, calculation: badUnit }])).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
      parts: [{ verdict: "not-checked", reason: "no-evidence", calculation: null }],
    });
    expect(
      resultFromParts([{ ...checked, calculation: { ...calculation, agrees: false } }]).parts?.[0]
        ?.verdict,
    ).toBe("contradicted");
    expect(
      readClaimCheck({
        ...mark(),
        calculation,
        parts: [{ ...checked, calculation: badUnit }],
      }),
    ).toMatchObject({ state: "not-checked", reason: "no-evidence", calculation: null });
    expect(
      readClaimCheck({ ...mark(), calculation, parts: [{ ...part(), evidence: [null] }] }),
    ).toMatchObject({ state: "not-checked", reason: "malformed", calculation: null });
    expect(
      readClaimParts(
        [
          {
            ...checked,
            calculation: { ...calculation, figure: { ...calculation.figure, inputs: [null] } },
          },
        ],
        "Revenue rose.",
      ),
    ).toBeNull();
  });

  test("part-only Source removal invalidates the same parent Check", () => {
    const child = part("supported", "child-source");
    const checked = readClaimCheck(mark([child]));
    expect(checked).not.toBeNull();
    if (!checked) return;
    expect(
      claimCheckShown(checked, {
        text: checked.text,
        versions: new Map(),
        folderId: null,
        scope: null,
      }),
    ).toEqual({ state: "needs-recheck", why: "document-removed" });
  });
});

describe.each(["Revenue 10. Profit 10. We should wait.", "收入10。利润10。我们应该等待。"])(
  "native figures owned by literal parts: %s",
  (sentence) => {
    const split = sentence.indexOf(sentence.startsWith("Revenue") ? "Profit" : "利润");
    const opinion = sentence.indexOf(sentence.startsWith("Revenue") ? "We" : "我们");
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: split } },
      { kind: "fact", span: { start: split, end: opinion } },
      { kind: "opinion", span: { start: opinion, end: sentence.length } },
    ];
    const first = plans[0] ?? plan;
    const second = plans[1] ?? plan;
    const omitted = plans[2] ?? plan;
    const projection = projectInlineText([
      { kind: "text", text: sentence, from: 0, to: sentence.length },
    ]);
    const native = (
      id: string,
      start: number,
      verdict: "supported" | "contradicted" = "supported",
    ): FigureCheckResult => {
      const reading = readFigures("10", { language: "en" })[0];
      if (!reading) throw new Error("Missing fixture reading");
      return {
        ...emptyFigureFinding({
          id,
          reading,
          calculated: null,
          locator: {
            kind: "text",
            from: { blockId: "block", offset: start },
            to: { blockId: "block", offset: start + 2 },
          },
        }),
        source: source(id),
        result: result(verdict, id),
      };
    };
    const a = native("first", sentence.indexOf("10"));
    const b = native("second", sentence.indexOf("10", sentence.indexOf("10") + 2), "contradicted");
    const checked = () => [
      partWithResult(first, { ...result(), figures: [a], remainder: null }),
      partWithResult(second, { ...result("contradicted"), figures: [b], remainder: null }),
      pendingPart(omitted),
    ];
    const owner = (parts = checked()) => checkWithParts({ ...mark(), text: sentence }, parts);

    test("partitions repeated values by exact occurrence and round trips canonical native results", () => {
      expect(
        figuresByPart(sentence, plans, [a, b], projection)?.map((figures) =>
          figures.map(({ id }) => id),
        ),
      ).toEqual([["first"], ["second"], []]);
      expect(figuresByPart(sentence, [first], [b])).toBeNull();
      const written = owner();
      expect(written.state).toBe("contradicted");
      expect(written.figures?.map(({ id, locator }) => ({ id, locator }))).toEqual(
        [a, b].map(({ id, locator }) => ({ id, locator })),
      );
      expect(written.remainder).toBeNull();
      expect(readClaimCheck(JSON.parse(JSON.stringify(written)))).toEqual(written);
      expect(restsOn(written).some((citation) => citation.documentId === "second")).toBe(true);
    });

    test("keeping a numerical owner preserves the independent factual remainder and omitted opinion", () => {
      const parts = [
        partWithResult(first, { ...result(), figures: [a], remainder: null }),
        partWithResult(second, result("unsupported", "qualitative")),
        pendingPart(omitted),
      ];
      const numeric = parts[0];
      if (!numeric?.figures) throw new Error("Missing fixture owner");
      numeric.figures = numeric.figures.map((figure) => ({
        ...figure,
        result: { ...figure.result, kept: true },
      }));
      const written = owner(parts);
      expect(written.state).toBe("unsupported");
      expect(written.remainder?.state).toBe("unsupported");
      expect(written.parts?.[2]?.verdict).toBeNull();
      expect(written.remainder?.text).toBe(sentence);
    });

    test("all kept figures have no stale scalar remainder", () => {
      const numeric = partWithResult(
        { kind: "fact", span: { start: 0, end: sentence.length } },
        {
          ...result(),
          figures: [a, b].map((figure) => ({
            ...figure,
            result: { ...figure.result, kept: true },
          })),
          remainder: null,
        },
      );
      const written = owner([numeric]);
      expect(written.kept).toBe(true);
      expect(written.remainder).toBeNull();
      expect(
        claimCheckShown(written, {
          text: sentence,
          versions: new Map(),
          folderId: null,
          scope: null,
        }).state,
      ).toBe("kept");
    });

    test("a found neighbor never supplies the missing proof of another native figure", () => {
      const absent = {
        ...b,
        source: null,
        result: { ...result("supported", "second"), evidence: null },
      };
      const projected = resultFromParts([
        partWithResult(first, { ...result(), figures: [a, absent], remainder: null }),
      ]);
      expect(projected).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
      expect(projected.figures?.find(({ id }) => id === "second")?.result).toMatchObject({
        verdict: "not-checked",
        reason: "no-evidence",
      });
    });

    test("one selected pending figure settles without changing a kept sibling or other factual outcome", () => {
      const prior = owner();
      const priorParts =
        prior.parts?.map((part) => ({
          ...part,
          ...(part.figures && {
            figures: part.figures.map((figure) =>
              figure.id === "first"
                ? { ...figure, result: { ...figure.result, kept: true as const } }
                : figure,
            ),
          }),
        })) ?? [];
      const kept = checkWithParts(prior, priorParts);
      const basis = {
        ...kept,
        request: "next",
        checkedAt: "2026-10-29T00:00:00.000Z",
        providerId: "next-provider",
        modelId: "next-model",
        action: "find-support" as const,
        scope: {
          folderId: "next-folder",
          widened: false,
          chosen: { folderIds: ["next-folder"], tagIds: [], documentIds: [] },
        },
        state: "checking" as const,
        parts: kept.parts?.map((part) => ({
          ...part,
          ...(part.kind === "fact" && { verdict: "checking" as const }),
        })),
      };
      const pending = beginFigureCheck(kept, basis, [a, b], new Set(["second"]), projection);
      expect(pending.figures?.find(({ id }) => id === "first")?.kept).toBe(true);
      expect(pending.figures?.find(({ id }) => id === "first")).toMatchObject({
        request: "request",
        checkedAt: "2026-10-28T00:00:00.000Z",
        providerId: null,
        modelId: null,
      });
      expect(pending.figures?.find(({ id }) => id === "second")).toMatchObject({
        request: "next",
        checkedAt: "2026-10-29T00:00:00.000Z",
        providerId: "next-provider",
        modelId: "next-model",
      });
      expect(pending.figures?.find(({ id }) => id === "second")?.state).toBe("checking");
      expect(resultFromParts(pending.parts ?? [])).toMatchObject({
        verdict: "not-checked",
        reason: "malformed",
      });
      const stopped = settleFigureCheck(pending, (check) => ({
        ...check,
        state: "not-checked",
        reason: "stopped",
        detail: null,
      }));
      expect(stopped.figures?.find(({ id }) => id === "first")?.kept).toBe(true);
      expect(stopped.figures?.find(({ id }) => id === "second")).toMatchObject({
        state: "not-checked",
        reason: "stopped",
      });
      expect(stopped.parts?.[2]?.verdict).toBeNull();
      expect(stopped.figures?.find(({ id }) => id === "first")).toEqual(
        kept.figures?.find(({ id }) => id === "first"),
      );
      expect(readClaimCheck(JSON.parse(JSON.stringify(stopped)))).toEqual(stopped);
    });
  },
);

test("an expanded atom cannot be split between literal owners", () => {
  const projection = projectInlineText([{ kind: "atom", from: 0, to: 1, shown: "10.0%" }]);
  expect(
    figuresByPart(
      projection.text,
      [
        { kind: "fact", span: { start: 0, end: 2 } },
        { kind: "fact", span: { start: 2, end: 5 } },
      ],
      [],
      projection,
    ),
  ).toBeNull();
});

describe("a figure the sort leaves outside a fact", () => {
  const plain = (sentence: string) =>
    projectInlineText([{ kind: "text", text: sentence, from: 0, to: sentence.length }]);
  const figure = (sentence: string, words: string, from = 0): CheckFigure => {
    const start = sentence.indexOf(words, from);
    const reading = readFigures(words, {
      language: /\p{Script=Han}/u.test(words) ? "zh-CN" : "en",
    })[0];
    if (start < 0 || !reading) throw new Error(`No figure ${words} in the fixture.`);
    return {
      id: `${words}@${start}`,
      reading,
      calculated: null,
      locator: {
        kind: "text",
        from: { blockId: "block", offset: start },
        to: { blockId: "block", offset: start + words.length },
      },
    };
  };
  const span = (sentence: string, words: string) => {
    const start = sentence.indexOf(words);
    return { start, end: start + words.length };
  };
  const words = (sentence: string, plans: readonly ClaimPartPlan[]) =>
    plans.map(({ kind, span }) => [kind, sentence.slice(span.start, span.end)]);

  test.each([
    ["Sadly the £5m and £6m deals are a disaster.", "£5m", "£6m"],
    ["可惜500万英镑和600万英镑的交易是一场灾难。", "500万英镑", "600万英镑"],
  ])("keeps one opinion whole around its numbers, each a fact inside it: %s", (sentence, a, b) => {
    const opinion = sentence.slice(0, -1);
    const plans = withFigureFacts(
      sentence,
      [{ kind: "opinion", span: span(sentence, opinion) }],
      [figure(sentence, a), figure(sentence, b)],
      plain(sentence),
    );
    expect(words(sentence, plans)).toEqual([
      ["opinion", opinion],
      ["fact", a],
      ["fact", b],
    ]);
    expect(readPartPlans(plans, sentence)).toEqual(plans);
    expect(
      figuresByPart(
        sentence,
        plans,
        [figure(sentence, a), figure(sentence, b)],
        plain(sentence),
      )?.map((owned) => owned.map(({ reading }) => reading.chars)),
    ).toEqual([[], [a], [b]]);
    expect(withFigureFacts(sentence, plans, [figure(sentence, a)], plain(sentence))).toEqual(plans);
  });

  test("a figure between parts is a fact of its own, and one already in a fact stays there", () => {
    const sentence = "Costs rose by £5m and we like it.";
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: span(sentence, "Costs rose") },
      { kind: "opinion", span: span(sentence, "we like it") },
    ];
    expect(
      words(sentence, withFigureFacts(sentence, plans, [figure(sentence, "£5m")], plain(sentence))),
    ).toEqual([
      ["fact", "Costs rose"],
      ["fact", "£5m"],
      ["opinion", "we like it"],
    ]);
    const whole: ClaimPartPlan[] = [{ kind: "fact", span: span(sentence, "Costs rose by £5m") }];
    expect(withFigureFacts(sentence, whole, [figure(sentence, "£5m")], plain(sentence))).toEqual(
      whole,
    );
  });

  test.each([
    ["I think £5m was raised.", "I think £5", "m was raised", "£5m", "I think", "£5m was raised"],
    [
      "我认为筹集了500万英镑。",
      "我认为筹集了500",
      "万英镑",
      "500万英镑",
      "我认为筹集了",
      "500万英镑",
    ],
  ])(
    "a figure across an opinion's edge joins the fact, and the opinion keeps only its own words: %s",
    (sentence, opinion, fact, number, kept, checked) => {
      const plans: ClaimPartPlan[] = [
        { kind: "opinion", span: span(sentence, opinion) },
        { kind: "fact", span: span(sentence, fact) },
      ];
      expect(
        words(
          sentence,
          withFigureFacts(sentence, plans, [figure(sentence, number)], plain(sentence)),
        ),
      ).toEqual([
        ["opinion", kept],
        ["fact", checked],
      ]);
    },
  );

  test("a figure that can't be placed leaves the facts as they are, and makes an opinion one fact", () => {
    const sentence = "We think the £5m rise is impressive.";
    const opinion: ClaimPartPlan[] = [
      { kind: "opinion", span: span(sentence, "We think the £5m rise is impressive") },
    ];
    expect(withFigureFacts(sentence, opinion, [figure(sentence, "£5m")])).toEqual([
      { kind: "fact", span: { start: 0, end: sentence.length } },
    ]);
    const mixed: ClaimPartPlan[] = [
      { kind: "opinion", span: span(sentence, "We think") },
      { kind: "fact", span: span(sentence, "the £5m rise is impressive") },
    ];
    expect(withFigureFacts(sentence, mixed, [figure(sentence, "£5m")])).toEqual(mixed);
  });

  test("only a fact may sit inside the opinion before it, shorter than it and apart from the others", () => {
    const sentence = "Sadly the £5m and £6m deals are a disaster.";
    const opinion = {
      kind: "opinion",
      span: span(sentence, "Sadly the £5m and £6m deals are a disaster"),
    };
    const five = { kind: "fact", span: span(sentence, "£5m") };
    expect(readPartPlans([opinion, five], sentence)).toEqual([opinion, five]);
    for (const plans of [
      [opinion, { kind: "opinion", span: span(sentence, "£5m") }],
      [opinion, { ...five, span: opinion.span }],
      [opinion, { kind: "fact", span: span(sentence, "£5m and") }, five],
      [{ kind: "fact", span: opinion.span }, five],
      [five, opinion],
    ])
      expect(readPartPlans(plans, sentence)).toBeNull();
  });
});
