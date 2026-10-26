import { describe, expect, test } from "vitest";
import { BUILT_IN_SKILL_NAMES } from "../../src/core/usageEvents";
import { skillDescription, skillShortLine, skillTitle } from "../../src/renderer/src/skillText";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const LANGUAGES = ["en", "zh-CN"] as const;

describe("A built-in Skill's name in the interface", () => {
  test.each(BUILT_IN_SKILL_NAMES)(
    "%s has a title, a short line and a description in both languages",
    (name) => {
      for (const language of LANGUAGES) {
        const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
        expect(skillTitle(name, t), `${language}: ${name} title`).not.toBe(name);
        expect(
          skillShortLine({ name, builtIn: true }, t),
          `${language}: ${name} short`,
        ).toBeTruthy();
        expect(
          skillDescription({ name, description: "raw description", builtIn: true }, t),
          `${language}: ${name} description`,
        ).not.toBe("raw description");
      }
    },
  );
});
