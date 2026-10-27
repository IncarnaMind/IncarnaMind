import { expect, test } from "vitest";
import type { AnswerToolCall } from "../../src/core/api";
import { analysisCallText as textOf } from "../../src/renderer/src/analysisCall";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";

for (const language of ["en", "zh-CN"] as const) {
  const t: Translate = (key, params) => translate(language, key, params);
  test.each(["done", "failed"] as const)(
    `${language}: a %s call without an Analysis is no longer running`,
    (status) => {
      const call: AnswerToolCall = {
        id: "analysis",
        tool: "run_analysis",
        source: "analysis",
        input: {},
        status,
        resultCount: null,
      };
      expect(textOf(t, call)).toBe(
        language === "en" ? "The analysis didn’t run" : "数据分析未运行",
      );
    },
  );
  test(`${language}: a call still running keeps its progress`, () => {
    const call: AnswerToolCall = {
      id: "analysis",
      tool: "run_analysis",
      source: "analysis",
      input: {},
      status: "running",
      resultCount: null,
    };
    expect(textOf(t, call)).toBe(translate(language, "analysis.call.running"));
  });
}
