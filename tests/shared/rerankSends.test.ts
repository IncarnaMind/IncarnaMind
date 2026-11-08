/**
 * What the Reranking line says leaves the computer (#2550): a cloud rerank request sends each
 * candidate as its Document's name and a newline before the Passage text (`src/core/providers/
 * rerank.ts`, `candidateText`), so the Settings line, the privacy page and both data pages name it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const service = { service: "Cohere" };

test("the reranking disclosure names each candidate's Document name", () => {
  for (const language of ["en", "zh-CN"] as const) {
    expect(translate(language, "rerank.settings.sends", service)).toContain(
      language === "en" ? "each with its Document’s name" : "每段都带着所属文档的名称",
    );
  }
});

test("the data pages' reranking row names it too, in both languages", () => {
  expect(read("docs/where-your-data-goes.md")).toContain(
    "With a Cohere or Voyage AI key: each query and its candidates, each with its Document's name.",
  );
  expect(read("docs/where-your-data-goes.zh-CN.md")).toContain(
    "保存了 Cohere 或 Voyage AI 密钥时：每次搜索词和候选项（每段都带着所属文档的名称）。",
  );
});

test("the privacy page's reranking row names it too", () => {
  expect(read("docs/privacy.md")).toContain(
    "each search query and its candidate Passages, each with its Document's name.",
  );
});
