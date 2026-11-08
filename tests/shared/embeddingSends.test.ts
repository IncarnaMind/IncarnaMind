/**
 * What the Search model's lines say leaves the computer (#2549): a cloud embedding request sends
 * each passage of a Document with its Document's name before it (`src/core/embedding/active.ts`,
 * `embedPassages`), so the choice's warning and the Settings line both name it, in English and
 * Simplified Chinese.
 */
import { expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

const service = { service: "OpenAI" };

test("the cloud embedding disclosures name each passage's Document name", () => {
  for (const language of ["en", "zh-CN"] as const) {
    expect(translate(language, "embeddingProviders.confirm.cloud", service)).toContain(
      language === "en" ? "each passage with its Document’s name" : "每段都带着所属文档的名称",
    );
    expect(translate(language, "embeddingProviders.settings.sendsTo", service)).toContain(
      language === "en" ? "each passage with its Document’s name" : "每段都带着所属文档的名称",
    );
  }
});
