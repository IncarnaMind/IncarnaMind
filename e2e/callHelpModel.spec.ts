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
  removeDataFolder,
  setWindowSize,
} from "./app";

/**
 * The model call help answers on (#2526), in Settings › Meetings › Help during the call: the
 * fastest, the Answers model's provider's quick model, by default, or the same as Answers, each
 * option naming its model; ⌘K opens the row. Set INCARNAMIND_SCREENSHOTS to a folder to also
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

test("call help's model: Fastest names the provider's quick model by default, Same as Answers the Answers model, ⌘K opens it, in English and Chinese", async () => {
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

  const settings = await openSettings(window, "meetings");
  const row = settings.getByTestId("call-help-model-row");
  const button = row.getByTestId("call-help-model");
  await expect(row).toContainText("Model");
  await expect(button).toHaveText("Fastest (Claude Haiku 5.5)");
  await button.click();
  const options = window.getByTestId("call-help-model-menu").getByRole("menuitemradio");
  await expect(options).toHaveText([
    "Fastest (Claude Haiku 5.5)",
    "Same as Answers (Claude Sonnet 5.5)",
  ]);
  await expect(options.first()).toHaveAttribute("aria-checked", "true");
  await shot(window, "call-help-model-menu-en-1100");
  await options.nth(1).click();
  await expect(button).toHaveText("Same as Answers (Claude Sonnet 5.5)");
  await expect
    .poll(() => bridge.evaluate(async (core) => (await core.getSettings()).user.callHelpModel))
    .toBe("answers");
  await shot(settings.getByTestId("help-settings"), "call-help-model-row-en-1100");
  await closeSettings(window);

  // ⌘K opens Settings at the row, its button focused, so Space or ↓ picks again.
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Call help model");
  await window.keyboard.press("Enter");
  await expect(settings).toHaveAttribute("data-page", "meetings");
  await expect(button).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await options.first().click();
  await expect(button).toHaveText("Fastest (Claude Haiku 5.5)");
  await expect
    .poll(() => bridge.evaluate(async (core) => (await core.getSettings()).user.callHelpModel))
    .toBe("fastest");

  // In Chinese, at a narrow window, the row keeps its one line and names the models.
  await bridge.evaluate((core) => core.updateSettings({ user: { language: "zh-CN" } }));
  await setWindowSize(app, window, 900, 700);
  await expect(row).toContainText("模型");
  await expect(button).toHaveText("最快（Claude Haiku 5.5）");
  await button.click();
  await expect(options).toHaveText(["最快（Claude Haiku 5.5）", "与回答相同（Claude Sonnet 5.5）"]);
  await shot(window, "call-help-model-menu-zh-900");
  await window.keyboard.press("Escape");
  await expect(button).toBeFocused();
  const label = await row.getByText("模型", { exact: true }).boundingBox();
  const control = await button.boundingBox();
  if (!label || !control) throw new Error("The row isn't laid out.");
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(Math.abs(middle(label) - middle(control))).toBeLessThan(4);
  await shot(settings.getByTestId("help-settings"), "call-help-model-row-zh-900");
  await app.close();
});
