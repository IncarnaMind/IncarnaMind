import { describe, expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import {
  defaultRegion,
  regionName,
  regionsListed,
} from "../../src/renderer/src/components/providers/shared";
import { type MessageKey, translate } from "../../src/shared/i18n";

const TWO_REGIONS = ["kimi", "qwen", "glm", "siliconflow"];

describe("a provider with a region in each", () => {
  // protects=the form opens on the region the interface's language makes likelier, for every provider with both; fails_when=one provider keeps opening on its first region whatever the language; no_claim=which region the User's key was made in.
  test.each(TWO_REGIONS)("%s opens on China in Chinese and International otherwise", (id) => {
    expect(defaultRegion(id, "zh-CN")).toBe("cn");
    expect(defaultRegion(id, "en")).toBe("intl");
  });

  // protects=a provider with one region shows no choice, so it gets no default; fails_when=a single-region provider is given a region it doesn't have; no_claim=none beyond protects.
  test.each(["anthropic", "openai", "deepseek", "openai-compatible", "ollama", "nobody"])(
    "%s has no region to open on",
    (id) => {
      expect(defaultRegion(id, "zh-CN")).toBe("");
      expect(defaultRegion(id, "en")).toBe("");
    },
  );

  // protects=the choice reads "International / China", the order the design gives, whatever order the catalog keeps; fails_when=the chips follow the catalog's China-first order; no_claim=none beyond protects.
  test.each(TWO_REGIONS)("%s lists International before China, in both languages", (id) => {
    const endpoints = catalogProvider(id)?.endpoints ?? [];
    const listed = regionsListed(endpoints);
    expect(listed.map((each) => each.id)).toEqual(["intl", "cn"]);
    expect(endpoints.map((each) => each.id)).toContain("cn");
    for (const language of ["en", "zh-CN"] as const) {
      const t = (key: MessageKey) => translate(language, key);
      expect(listed.map((each) => regionName(each, t, language))).toEqual(
        language === "en" ? ["International", "China"] : ["国际", "中国"],
      );
    }
  });
});
