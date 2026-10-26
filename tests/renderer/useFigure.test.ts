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
const { translate } = await import("../../src/shared/i18n");

const calculation = (
  stated: string,
  shown: string,
  agrees = false,
  approximate = false,
): ClaimCalculation => ({
  agrees,
  stated,
  figure: {
    label: "Multiple",
    formula: "n1 / n2",
    inputs: [],
    value: 1.31,
    unit: { kind: "times" },
    approximate,
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

  // protects=a limit the figure breaks is the sentence's own number, so the card offers no Use {figure} for it (#1908); fails_when="inside the 3.25x covenant" is offered "Use 3.5x"; no_claim=none beyond protects.
  test("a limit the figure breaks is not offered", () => {
    const sentence = "Leverage should still be inside the 3.25x covenant.";
    const broken = { ...calculation("3.25x", "3.5x"), relation: "at most" as const };
    expect(figureFix(broken, sentence)).toBeNull();
  });

  // protects=the card and the exports say a limit as one ("at most 3.25x", "不超过 3.25x"), not as the figure; fails_when=a broken limit reads "The sentence says 3.25x"; no_claim=none beyond protects.
  test("a limit is said as one, in English and Chinese", () => {
    const says = (language: "en" | "zh-CN") =>
      translate(language, "claim.calculated.stated.at most", { stated: "3.25x" });
    expect(says("en")).toBe("The sentence says at most 3.25x.");
    expect(says("zh-CN")).toBe("这句话写的是不超过 3.25x。");
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

  test('an approximate figure is written as its number, not a second "about"', () => {
    const sentence = "Net debt to EBITDA was about 1.1x at the end of 2025.";
    const fix = figureFix(calculation("1.1x", "about 1.31x", false, true), sentence);
    expect(fix?.shown).toBe("1.31x");
    expect(sentence.slice(fix?.from, fix?.to)).toBe("1.1x");
  });

  test("a check that worked out no figure offers nothing", () => {
    expect(figureFix(null, "Net debt to EBITDA was 1.1x.")).toBeNull();
  });
});
