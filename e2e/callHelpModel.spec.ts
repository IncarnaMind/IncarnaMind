import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  paletteFound,
  removeDataFolder,
  setWindowSize,
} from "./app";

/**
 * The model call help answers on (#2526), in Settings › Meetings › Help during the call: the
 * same as Answers by default, or, where it is offered, the fastest, the Answers model's provider's
 * quick model, each option naming its model and the row saying what Fastest trades; ⌘K opens it. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(page: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const bridgeOf = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

test("call help's model: Same as Answers by default, Fastest offered on Anthropic with what it trades, ⌘K opens it, in English and Chinese, and no choice for a provider not offered", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 800);
  const bridge = await bridgeOf(window);
  await bridge.evaluate((core) =>
    core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-5-5",
    }),
  );
  await dismissChatSetup(window);
  const chosen = () =>
    bridge.evaluate(async (core) => (await core.getSettings()).user.callHelpModel);

  const settings = await openSettings(window, "meetings");
  const row = settings.getByTestId("call-help-model-row");
  const button = row.getByTestId("call-help-model");
  await expect(row).toContainText("Model");
  await expect(row).toContainText("Fastest replies in about a second, but cites less carefully.");
  await expect(button).toHaveText("Same as Answers (Claude Sonnet 5.5)");
  await button.click();
  const options = window.getByTestId("call-help-model-menu").getByRole("menuitemradio");
  await expect(options).toHaveText([
    "Same as Answers (Claude Sonnet 5.5)",
    "Fastest (Claude Haiku 5.5)",
  ]);
  await expect(options.first()).toHaveAttribute("aria-checked", "true");
  await shot(window, "call-help-model-menu-en-1100");
  await options.nth(1).click();
  await expect(button).toHaveText("Fastest (Claude Haiku 5.5)");
  await expect.poll(chosen).toBe("fastest");
  await shot(settings.getByTestId("help-settings"), "call-help-model-row-en-1100");
  await closeSettings(window);

  // ⌘K opens Settings at the row, its button focused, so ↓ opens its menu.
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Call help model");
  await window.keyboard.press("Enter");
  await expect(settings).toHaveAttribute("data-page", "meetings");
  await expect(button).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await options.first().click();
  await expect(button).toHaveText("Same as Answers (Claude Sonnet 5.5)");
  await expect.poll(chosen).toBe("answers");

  // In Chinese, at a narrow window, the row names the models and keeps its button in view.
  await bridge.evaluate((core) => core.updateSettings({ user: { language: "zh-CN" } }));
  await setWindowSize(app, window, 900, 700);
  await expect(row).toContainText("模型");
  await expect(row).toContainText("“最快”约 1 秒回复，但引用没那么严谨。");
  await expect(button).toHaveText("与回答相同（Claude Sonnet 5.5）");
  await button.click();
  await expect(options).toHaveText(["与回答相同（Claude Sonnet 5.5）", "最快（Claude Haiku 5.5）"]);
  await shot(window, "call-help-model-menu-zh-900");
  await window.keyboard.press("Escape");
  await expect(button).toBeFocused();
  const rowBox = await row.boundingBox();
  const control = await button.boundingBox();
  if (!rowBox || !control) throw new Error("The row isn't laid out.");
  expect(control.x + control.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  await shot(settings.getByTestId("help-settings"), "call-help-model-row-zh-900");
  await closeSettings(window);

  // A provider not offered yet: no row and no command.
  await bridge.evaluate((core) => core.updateSettings({ user: { language: "en" } }));
  await bridge.evaluate((core) =>
    core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6.1-sol" }),
  );
  await openSettings(window, "meetings");
  await expect(settings.getByTestId("help-settings")).toBeVisible();
  await expect(row).toHaveCount(0);
  await closeSettings(window);
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Call help model");
  await expect(paletteFound(window).filter({ hasText: "Call help model" })).toHaveCount(0);
  await window.keyboard.press("Escape");
  await app.close();
});
