import { describe, expect, test } from "vitest";
import type { ComparisonQuestion } from "../../src/core/api";
import { hiddenColumnsNote } from "../../src/shared/comparisons";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const say = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

const questions: ComparisonQuestion[] = [
  { id: "q1", text: "Margin" },
  { id: "q2", text: "Prepayment terms", label: "Prepayment", hidden: true },
  { id: "q3", text: "Tenor", hidden: true },
];

describe("A comparison export's hidden columns", () => {
  test("names them in each language's own list separator, with their labels", () => {
    expect(hiddenColumnsNote(questions, say("en"))).toBe(
      "Left out 2 hidden columns: “Prepayment”, “Tenor”",
    );
    expect(hiddenColumnsNote(questions, say("zh-CN"))).toBe(
      "已排除 2 个隐藏列：“Prepayment”、“Tenor”",
    );
    expect(hiddenColumnsNote(questions.slice(0, 1), say("en"))).toBeNull();
    expect(hiddenColumnsNote([{ id: "q4", text: "Tenor", hidden: true }], say("en"))).toBe(
      "Left out 1 hidden column: “Tenor”",
    );
  });
});
