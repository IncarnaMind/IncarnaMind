import { describe, expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { dotAfter } from "../../src/renderer/src/components/metaDot";
import { translate } from "../../src/shared/i18n";
import { modelName } from "../../src/shared/modelName";

/** The line as the key form draws it: the model, then Change after the dot its language sets. */
function line(language: "en" | "zh-CN") {
  const modelId = catalogProvider("anthropic")?.roles.answers ?? "";
  const named = translate(language, "providers.form.modelLine", {
    model: modelName(modelId, { kind: "anthropic" }),
  });
  return `${named}${dotAfter(named)}${translate(language, "providers.form.change")}`;
}

describe("The key form's model line (#1575)", () => {
  // protects=the key form names the model it will save, Anthropic's default, by its name, as one line with Change: "Model: Claude Haiku 5.5 · Change", "模型：Claude Haiku 5.5 · 更改"; fails_when=the line shows the model's id, the Chinese puts a space after its full-width colon, or a placeholder is left in; no_claim=where the line sits and what Change does, e2e/keyForm.spec.ts.
  test.each([
    ["en", "Model: Claude Haiku 5.5 · Change"],
    ["zh-CN", "模型：Claude Haiku 5.5 · 更改"],
  ] as const)("in %s: “%s”", (language, expected) => {
    expect(line(language)).toBe(expected);
  });

  // protects=Change's spoken name starts with the word the button shows, in English and Chinese, so a voice command that says what it sees works (WCAG 2.5.3) and a screen reader hears what it changes; fails_when=the name no longer starts with the button's word, or doesn't name the model; no_claim=the name is set on the button, e2e/keyForm.spec.ts.
  test.each(["en", "zh-CN"] as const)(
    "in %s Change is spoken as changing the model",
    (language) => {
      const spoken = translate(language, "providers.form.changeModel");
      expect(spoken.startsWith(translate(language, "providers.form.change"))).toBe(true);
      expect(spoken).toContain(translate(language, "providers.form.model").toLowerCase());
    },
  );
});
