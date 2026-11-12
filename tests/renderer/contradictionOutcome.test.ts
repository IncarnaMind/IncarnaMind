import { describe, expect, test } from "vitest";
import type { ContradictionCheckOutcome } from "../../src/core/api";
import { contradictionOutcomeParts } from "../../src/renderer/src/editor/contradictionOutcome";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const t =
  (language: "en" | "zh-CN") =>
  (key: MessageKey, params?: MessageParams): string =>
    translate(language, key, params);

const run = (counts: Partial<ContradictionCheckOutcome>): ContradictionCheckOutcome => ({
  claims: 12,
  checked: 12,
  contradicted: 0,
  cost: null,
  stop: null,
  smallModel: false,
  ...counts,
});

const both = (outcome: ContradictionCheckOutcome) => [
  contradictionOutcomeParts(outcome, t("en"), "en"),
  contradictionOutcomeParts(outcome, t("zh-CN"), "zh-CN"),
];

describe("What a check for contradictions found, in parts of a line", () => {
  // protects=the line counts cited sentences, one noun in every outcome, as the check card does (#2831); fails_when=one outcome says claims (说法, 条) beside another that says sentences; no_claim=how many are cited.
  test("says what it found, and how many sentences weren't checked", () => {
    expect(both(run({ contradicted: 2 }))).toEqual([
      ["2 of 12 cited sentences contradicted"],
      ["有引用的 12 句中有 2 句与文档矛盾"],
    ]);
    expect(both(run({ checked: 9, contradicted: 2 }))).toEqual([
      ["2 of 12 cited sentences contradicted", "3 not checked"],
      ["有引用的 12 句中有 2 句与文档矛盾", "3 句未核对"],
    ]);
    expect(both(run({ checked: 9 }))).toEqual([
      ["No contradictions in 12 cited sentences", "3 not checked"],
      ["有引用的 12 句都没有发现矛盾", "3 句未核对"],
    ]);
  });

  test("sentences none of which could be checked, offline say, are never called free of contradictions", () => {
    expect(both(run({ checked: 0 }))).toEqual([
      ["None of the 12 cited sentences could be checked"],
      ["有引用的 12 句都未能核对"],
    ]);
    expect(both(run({ claims: 1, checked: 0 }))).toEqual([
      ["The cited sentence couldn’t be checked"],
      ["有引用的这 1 句未能核对"],
    ]);
  });

  test("a run the monthly cap stopped says so after the count", () => {
    expect(
      contradictionOutcomeParts(
        run({ checked: 5, contradicted: 1, stop: { reason: "cost-cap" } }),
        t("en"),
        "en",
      ),
    ).toEqual([
      "1 of 12 cited sentences contradicted",
      "7 not checked",
      "Could pass your monthly cap",
    ]);
  });
});
