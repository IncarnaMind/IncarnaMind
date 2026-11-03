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
  test("says what it found, and how many claims weren't checked", () => {
    expect(both(run({ contradicted: 2 }))).toEqual([
      ["2 of 12 cited claims contradicted"],
      ["12 条引用的说法中有 2 条与文档矛盾"],
    ]);
    expect(both(run({ checked: 9, contradicted: 2 }))).toEqual([
      ["2 of 12 cited claims contradicted", "3 not checked"],
      ["12 条引用的说法中有 2 条与文档矛盾", "3 条未核对"],
    ]);
    expect(both(run({ checked: 9 }))).toEqual([
      ["No contradictions in 12 cited claims", "3 not checked"],
      ["12 条引用的说法中没有发现矛盾", "3 条未核对"],
    ]);
  });

  test("claims none of which could be checked, offline say, are never called free of contradictions", () => {
    expect(both(run({ checked: 0 }))).toEqual([
      ["None of the 12 cited claims could be checked"],
      ["12 条引用的说法都未能核对"],
    ]);
    expect(both(run({ claims: 1, checked: 0 }))).toEqual([
      ["The cited claim couldn’t be checked"],
      ["这 1 条引用的说法未能核对"],
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
      "1 of 12 cited claims contradicted",
      "7 not checked",
      "Could pass your monthly cap",
    ]);
  });
});
