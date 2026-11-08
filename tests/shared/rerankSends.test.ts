/**
 * What the Reranking line says leaves the computer (#2550): a cloud rerank request sends each
 * candidate as its Document's name and a newline before the Passage text (`src/core/providers/
 * rerank.ts`, `candidateText`), so the Settings line names it, in English and Simplified Chinese.
 */
import { expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

const service = { service: "Cohere" };

test("the reranking disclosure names each candidate's Document name", () => {
  for (const language of ["en", "zh-CN"] as const) {
    expect(translate(language, "rerank.settings.sends", service)).toContain(
      language === "en" ? "each with its Document’s name" : "每段都带着所属文档的名称",
    );
  }
});
