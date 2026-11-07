import { expect, type Locator, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sizeAssistant,
} from "./app";

/*
 * The composer's chips (#2731): the Search scope is never cut short, and the model chip, which shows
 * the model's short name with its full name in the tooltip, gives way first when room runs out.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** Whether a chip's words are all drawn: no ellipsis cuts them. */
const whole = (chip: Locator) =>
  chip.locator(".truncate").evaluate((span) => span.scrollWidth <= span.clientWidth);

test("the model chip shows the model's short name, its full name in the tooltip and the accessible name", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({
        kind: "deepseek",
        apiKey: "sk-not-a-real-key",
        modelId: "deepseek-flash",
      });
    });
    await newMind(window);
    const chip = window.getByTestId("composer-model");
    await expect(chip).toHaveText("DeepSeek Flash");
    await expect(chip).toHaveAttribute("title", /^DeepSeek V4\.1 Flash · deepseek-flash · /);
    await expect(chip).toHaveAttribute("aria-label", /DeepSeek V4\.1 Flash/);
    await setLanguage(window, "zh-CN");
    await expect(chip).toHaveText("DeepSeek Flash");
    await expect(chip).toHaveAttribute("title", /^DeepSeek V4\.1 Flash · deepseek-flash · /);
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`in the narrowest assistant a long model name is cut before the Search scope is, in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await dismissChatSetup(window);
      await connectLocalChatModel(window, "a-model-with-a-very-long-name-and-tag:latest");
      await newMind(window);
      await sizeAssistant(window, 280);

      const model = window.getByTestId("composer-model");
      const scope = window.getByTestId("composer-scope-all");
      await expect(scope).toBeVisible();
      expect(await whole(scope), "the Search scope is whole").toBe(true);
      expect(await whole(model), "the model's name gives way").toBe(false);
      // Whatever is cut is still said in full: by the tooltip and the accessible name.
      await expect(model).toHaveAttribute("title", /^a-model-with-a-very-long-name-and-tag:latest/);
      await expect(model).toHaveAccessibleName(/a-model-with-a-very-long-name-and-tag:latest/);

      // Both sit inside the composer.
      const composer = await window.getByTestId("composer").boundingBox();
      for (const chip of [model, scope]) {
        const box = await chip.boundingBox();
        if (!box || !composer) throw new Error("The composer isn't showing.");
        expect(box.x).toBeGreaterThanOrEqual(composer.x);
        expect(box.x + box.width).toBeLessThanOrEqual(composer.x + composer.width);
      }
    } finally {
      await app.close();
    }
  });
}
