import { describe, expect, test } from "vitest";
import type { Language } from "../../src/core/language";
import { outsideWallLine } from "../../src/renderer/src/outsideWallLine";
import { translate } from "../../src/shared/i18n";

const line = (language: Language, names: string[]) =>
  outsideWallLine((key, params) => translate(language, key, params), language, {
    names,
    folder: "Matter A",
  });

describe("The line for picked files a walled Question can't search (#2924)", () => {
  // protects=the line says why these files were treated differently from the new ones picked with them: they are Documents already; fails_when=it goes back to saying only where they are not; no_claim=the layout.
  test("names one, two or three files, in English", () => {
    expect(line("en", ["Lease"])).toBe(
      "“Lease” is already in IncarnaMind, outside “Matter A”, so this Question doesn’t search it.",
    );
    expect(line("en", ["Lease", "Charter"])).toBe(
      "“Lease” and “Charter” are already in IncarnaMind, outside “Matter A”, so this Question doesn’t search them.",
    );
    expect(line("en", ["Lease", "Charter", "Tariff"])).toBe(
      "“Lease”, “Charter”, and “Tariff” are already in IncarnaMind, outside “Matter A”, so this Question doesn’t search them.",
    );
  });

  // protects=past three files the line names two and counts the rest; fails_when=it lists every name or drops the count; no_claim=which two.
  test("names two and counts the rest past three files, in English", () => {
    expect(line("en", ["Lease", "Charter", "Tariff", "Survey", "Handbook", "Memo"])).toBe(
      "“Lease”, “Charter” and 4 more are already in IncarnaMind, outside “Matter A”, so this Question doesn’t search them.",
    );
  });

  // protects=the Chinese follows the repo's Chinese guide: 已在 … 中, quotes, and the total with 个; fails_when=a space or quote moves; no_claim=other languages.
  test("says the same in Chinese", () => {
    expect(line("zh-CN", ["Lease"])).toBe(
      "“Lease”已在 IncarnaMind 中，但不在“Matter A”里，这个问题不会搜索它。",
    );
    expect(line("zh-CN", ["Lease", "Charter"])).toBe(
      "“Lease”和“Charter”已在 IncarnaMind 中，但不在“Matter A”里，这个问题不会搜索它们。",
    );
    expect(line("zh-CN", ["Lease", "Charter", "Tariff", "Survey", "Handbook", "Memo"])).toBe(
      "“Lease”、“Charter”等 6 个文件已在 IncarnaMind 中，但不在“Matter A”里，这个问题不会搜索它们。",
    );
  });
});
