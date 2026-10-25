import { describe, expect, test } from "vitest";
import { closeTitles } from "../../src/shared/closeTitles";

describe("Mind titles close enough to be taken for each other (#1865)", () => {
  // protects=a Mind with a namesake asks which one is meant: the same title (in two Folders), a draft or numbered copy, another year (first or last), a part after a dash, in English and Chinese, whatever the case or width; fails_when=any of them reads as far apart; no_claim=what the ask looks like, which the core tests cover.
  test.each([
    ["Q3 plan", "Q3 plan"],
    ["Q3 plan", "q3  PLAN"],
    ["Q3 plan", "Q3 plan (draft)"],
    ["Q3 plan (draft)", "Q3 plan (final)"],
    ["Q3 plan", "Q3 plan 2"],
    ["Budget 2024", "Budget 2025"],
    ["2024 Budget", "2025 Budget"],
    ["2024年预算", "2025年预算"],
    ["Q3 plan", "Q3 plan – old"],
    ["Launch brief", "Launch brief: v2"],
    ["项目计划", "项目计划（草稿）"],
    ["项目计划", "项目计划2"],
    ["会议纪要", "会议纪要：旧版"],
    ["周报", "周报【10月】"],
    ["【草稿】项目计划", "项目计划"],
    ["[Draft] Q3 plan", "Q3 plan"],
    ["（旧）周报", "周报"],
  ])("“%s” and “%s” are close", (a, b) => {
    expect(closeTitles(a, b)).toBe(true);
    expect(closeTitles(b, a)).toBe(true);
  });

  // protects=Minds whose titles differ in what they name never ask, so #1781's requests across several Minds go on at once; fails_when=any of them reads as close; no_claim=none beyond protects.
  test.each([
    ["Q3 plan", "Q4 plan"],
    ["Harbour plan", "Harbour budget"],
    ["Call: Acme", "Call: Beta"],
    ["Weekly update", "Monthly report"],
    ["项目计划", "项目计划书"],
    ["港口计划", "港口预算"],
    ["2024", "2025"],
    ["Plan Q3", "Plan Q4"],
    ["Report 2025 Q3", "Report 2025 Q4"],
    ["Q3", "Q4"],
    ["读书笔记《三体》", "读书笔记《活着》"],
    // A fiscal year joined to its letters is part of the name, as a quarter is: "FY24" isn't "FY25".
    ["Budget FY24", "Budget FY25"],
    ["FY24 budget", "FY25 budget"],
    ["", ""],
  ])("“%s” and “%s” aren't", (a, b) => {
    expect(closeTitles(a, b)).toBe(false);
    expect(closeTitles(b, a)).toBe(false);
  });
});
