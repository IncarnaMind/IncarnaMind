import { describe, expect, test, vi } from "vitest";
import type { ClaimCalculation } from "../../src/core/api";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  requestEdit: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({ translateNow: (key: string) => key }));

const { figureFix } = await import("../../src/renderer/src/unsupportedFixes");

const calculation = (stated: string, shown: string, agrees = false): ClaimCalculation => ({
  agrees,
  stated,
  figure: {
    label: "Multiple",
    formula: "n1 / n2",
    inputs: [],
    value: 1.31,
    unit: { kind: "times" },
    approximate: false,
    shown,
    show: { language: "en", as: "times", decimals: null, scale: null },
    literals: [],
    engine: 1,
    written: null,
  },
});

describe("Use {figure} (#1247)", () => {
  test("a number the figure disagrees with is the one to change", () => {
    const sentence = "Net debt to EBITDA was 1.1x at the end of 2025.";
    const fix = figureFix(calculation("1.1x", "1.31x"), sentence);
    expect(fix).not.toBeNull();
    expect(sentence.slice(fix?.from, fix?.to)).toBe("1.1x");
    expect(fix?.shown).toBe("1.31x");
  });

  test("a sentence in Chinese is changed in its own number", () => {
    const sentence = "净负债与 EBITDA 之比为 1.1x，截至 2025 年底。";
    const fix = figureFix(calculation("1.1x", "1.31x"), sentence);
    expect(fix).not.toBeNull();
    expect(sentence.slice(fix?.from, fix?.to)).toBe("1.1x");
  });

  test("a figure that agrees is not offered", () => {
    const sentence = "Net debt to EBITDA was 1.3x at the end of 2025.";
    expect(figureFix(calculation("1.3x", "1.31x", true), sentence)).toBeNull();
  });

  test("two numbers written alike can't be told apart, so neither is offered", () => {
    const sentence = "Net debt to EBITDA was 1.1x in 2025 and 1.1x in 2024.";
    expect(figureFix(calculation("1.1x", "1.31x"), sentence)).toBeNull();
  });

  test("one of several different numbers can still be told apart", () => {
    const sentence = "Net debt was $1,234m and EBITDA $942m, a multiple of 1.1x.";
    const fix = figureFix(calculation("1.1x", "1.31x"), sentence);
    expect(sentence.slice(fix?.from, fix?.to)).toBe("1.1x");
  });

  test("a sentence that no longer writes the number offers nothing", () => {
    const sentence = "Net debt to EBITDA was 1.3x at the end of 2025.";
    expect(figureFix(calculation("1.1x", "1.31x"), sentence)).toBeNull();
  });

  test("a check that worked out no figure offers nothing", () => {
    expect(figureFix(null, "Net debt to EBITDA was 1.1x.")).toBeNull();
  });
});
