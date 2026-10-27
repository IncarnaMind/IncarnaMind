import { describe, expect, test } from "vitest";
import type {
  ClaimCheckAttributes,
  ClaimCheckBasis,
  FigureCheckAttributes,
} from "../../src/core/api";
import { type ClaimCheckNow, claimCheckShown, readClaimCheck } from "../../src/shared/claimChecks";
import { aggregateFigureStates, readFigureFinding } from "../../src/shared/figureChecks";
import { readFigures } from "../../src/shared/figures";

const sentence = "Revenue was 10 and profit was 2. / 收入10，利润2。";
function basis(state: ClaimCheckBasis["state"] = "supported"): ClaimCheckBasis {
  return {
    id: "sentence",
    request: "request",
    action: "check-against-documents",
    state,
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text: sentence,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-27T00:00:00.000Z",
  };
}
function figure(id: string, state: ClaimCheckBasis["state"] = "supported"): FigureCheckAttributes {
  const reading = readFigures("10", { language: "en" })[0];
  if (!reading) throw new Error("No fixture figure.");
  return {
    ...basis(state),
    id,
    locator: {
      kind: "text",
      from: { blockId: "block", offset: 12 },
      to: { blockId: "block", offset: 14 },
    },
    reading,
    calculated: null,
    sourceInput: null,
    roundedFrom: null,
    difference: null,
    footing: [],
  };
}
const now: ClaimCheckNow = { text: sentence, versions: new Map(), folderId: null, scope: null };
const check = (
  figures: FigureCheckAttributes[],
  remainder?: ClaimCheckBasis | null,
): ClaimCheckAttributes => ({
  ...basis("contradicted"),
  figures,
  ...(remainder !== undefined && { remainder }),
});

describe("one sentence's numerical results", () => {
  test("one bad figure keeps its sentence needing a look", () => {
    expect(
      claimCheckShown(check([figure("revenue"), figure("profit", "contradicted")], null), now),
    ).toEqual({ state: "contradicted" });
  });
  test("keeping the bad figure does not carry the old whole-sentence contradiction into the rest", () => {
    expect(
      claimCheckShown(
        check([figure("revenue"), { ...figure("profit", "contradicted"), kept: true }], null),
        now,
      ),
    ).toEqual({ state: "supported" });
  });
  test("a separately unsupported qualitative assertion survives keeping every numerical problem", () => {
    expect(
      claimCheckShown(
        check([{ ...figure("profit", "contradicted"), kept: true }], basis("unsupported")),
        now,
      ),
    ).toEqual({ state: "unsupported" });
  });
  test("a missing remainder never becomes proof that there is no other assertion", () => {
    expect(claimCheckShown(check([figure("revenue")]), now)).toEqual({
      state: "not-checked",
      reason: "malformed",
    });
    expect(claimCheckShown(check([figure("revenue")], null), now)).toEqual({ state: "supported" });
    expect(aggregateFigureStates([], null)).toEqual({ state: "not-checked", reason: "malformed" });
  });
  test("checking one figure again leaves its kept sibling kept", () => {
    const sibling = { ...figure("revenue"), kept: true as const };
    const selected = figure("profit", "checking");
    const current = check([sibling, selected], null);
    expect(claimCheckShown(current, now)).toEqual({ state: "checking" });
    expect(current.figures?.[0]).toEqual(sibling);
  });
  test("source agreement and a failed footing remain independent facts", () => {
    const total = {
      ...figure("total"),
      footing: [
        {
          axis: "row" as const,
          id: "total",
          role: "total" as const,
          componentIds: ["revenue", "profit"],
          excludedIds: [],
          sum: 12,
          difference: 2,
          agrees: false,
        },
      ],
    };
    expect(claimCheckShown(check([total], null), now)).toEqual({ state: "unsupported" });
    expect(total.state).toBe("supported");
    expect(claimCheckShown(check([total], null), { ...now, text: "Changed / 已修改" })).toEqual({
      state: "needs-recheck",
      why: "edited",
    });
  });
  test("the same stored check survives decoding without losing child results or the explicit remainder", () => {
    const original = check([figure("revenue"), figure("profit", "contradicted")], null);
    expect(readClaimCheck(original)).toEqual(original);
    expect(readClaimCheck(check([figure("revenue")]))).not.toHaveProperty("remainder");
  });
  test("malformed, duplicate or non-finite children cannot leave a supported parent", () => {
    expect(readClaimCheck(check([figure("duplicate"), figure("duplicate")], null))).toBeNull();
    const malformed = figure("revenue");
    malformed.reading.value = Number.NaN;
    expect(readFigureFinding(malformed)).toBeNull();
    expect(readClaimCheck(check([malformed], null))).toBeNull();
  });
});

for (const context of ["Revenue | FY 2025 | £m", "收入 | 2025年 | 百万元"]) {
  test(`a header or unit edit invalidates its figure: ${context}`, () => {
    const child = { ...figure("revenue"), context };
    const marked = check([child], null);
    expect(
      claimCheckShown(marked, { ...now, figureContexts: new Map([[child.id, context]]) }),
    ).toEqual({ state: "supported" });
    expect(
      claimCheckShown(marked, {
        ...now,
        figureContexts: new Map([[child.id, `${context} changed`]]),
      }),
    ).toEqual({ state: "needs-recheck", why: "edited" });
    expect(claimCheckShown(marked, now)).toEqual({ state: "needs-recheck", why: "edited" });
    expect(claimCheckShown(check([{ ...child, kept: true }], null), now)).toEqual({
      state: "kept",
    });
  });
}
