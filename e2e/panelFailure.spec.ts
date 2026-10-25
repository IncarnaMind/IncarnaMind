import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A part of the window that fails while it draws leaves the rest on screen, and says so with one
 * line and Reload, never a white window (#1500). Reload draws the panel again with what the User
 * had typed; for the whole window it loads the page again, and the conversation and the draft in
 * the assistant come back. The error is in the log with its stack. Set INCARNAMIND_SCREENSHOTS to
 * a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

type Panel = "window" | "sidebar" | "card" | "assistant" | "overlays";
const fail = (window: Page, panel: Panel) =>
  window.evaluate((name) => {
    (
      globalThis as unknown as {
        incarnamindTestHooks: { failPanel(name: string): void };
      }
    ).incarnamindTestHooks.failPanel(name);
  }, panel);

const failed = (window: Page, panel: Panel) =>
  window.locator(`[data-testid="panel-failed"][data-panel="${panel}"]`);

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const NOTE = "The harbour master logs the spring tides.";

async function writeNote(window: Page): Promise<void> {
  await newMind(window);
  await enterContent(window);
  await nameMind(window, "Tide log");
  await window.keyboard.type(NOTE);
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveText([NOTE]);
}

for (const [width, language, line, reload] of [
  [1440, "en", "This panel stopped working", "Reload"],
  [900, "zh-CN", "此面板出错了", "重新加载"],
] as const) {
  test(`a card that fails shows one line with Reload and the sidebar and assistant stay, in ${language} at ${width} px`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 860);
    await writeNote(window);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type("A draft not asked yet");

    await fail(window, "card");

    const card = window.getByTestId("card");
    const notice = failed(window, "card");
    await expect(notice).toBeVisible();
    await expect(card.getByTestId("panel-failed")).toContainText(line);
    await expect(card.getByTestId("panel-reload")).toHaveText(reload);
    await expect(window.getByTestId("sidebar")).toBeVisible();
    await expect(window.getByTestId("assistant")).toBeVisible();
    await screenshot(window, `card-failed-${language}-${width}`);
    // The error is in the log with its stack, as one nothing caught is.
    const readLog = () =>
      readFile(join(dataDir, "logs", "incarnamind.log"), "utf8").catch(() => "");
    await expect
      .poll(readLog)
      .toMatch(
        /ERROR window\.panel-failed panel=card caught=boundary error="Error: The card panel was made to fail\."/,
      );
    await expect.poll(readLog).toContain("component stack:");

    await card.getByTestId("panel-reload").click();

    await expect(notice).toHaveCount(0);
    await expect(window.getByTestId("mind-editor").locator("p")).toHaveText([NOTE]);
    await expect(window.getByTestId("composer-input")).toHaveValue("A draft not asked yet");
    await app.close();
  });
}

test("the sidebar, the overlays and the assistant fail alone; the assistant's conversation and draft stay through Reload", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeNote(window);
  await askInAssistant(window, "Which tide is the highest?");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("A draft for the next Question");

  // The dialogs and ⌘K are drawn apart from the panels: their failure is a line beside the card.
  await fail(window, "overlays");
  await expect(failed(window, "overlays")).toBeVisible();
  await expect(window.getByTestId("card")).toBeVisible();
  await expect(window.getByTestId("sidebar")).toBeVisible();
  // Its line stands where ⌘K's palette would, below the tabs, and covers none of the sidebar, the
  // composer or the tab strip.
  const line = await failed(window, "overlays").boundingBox();
  const tabs = await window.getByTestId("tab-strip").first().boundingBox();
  const footer = await window.getByTestId("sidebar-footer").boundingBox();
  const composer = await window.getByTestId("composer-input").boundingBox();
  if (!line || !tabs || !footer || !composer) throw new Error("Something isn't visible.");
  const apart = (a: typeof line, b: typeof line) =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  expect(apart(line, footer)).toBe(true);
  expect(apart(line, composer)).toBe(true);
  expect(apart(line, tabs)).toBe(true);
  await screenshot(window, "overlays-failed");
  await failed(window, "overlays").getByTestId("panel-reload").click();
  await expect(failed(window, "overlays")).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.press("Escape");

  await fail(window, "sidebar");
  await expect(failed(window, "sidebar")).toBeVisible();
  await expect(window.getByTestId("card")).toBeVisible();
  await expect(assistantAnswers(window)).toHaveCount(1);
  await screenshot(window, "sidebar-failed");
  await failed(window, "sidebar").getByTestId("panel-reload").click();
  await expect(window.getByTestId("sidebar-tree")).toBeVisible();

  await fail(window, "assistant");
  const notice = failed(window, "assistant");
  await expect(notice).toBeVisible();
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveText([NOTE]);
  await screenshot(window, "assistant-failed");
  await notice.getByTestId("panel-reload").click();
  await expect(notice).toHaveCount(0);
  await expect(assistantAnswers(window)).toHaveCount(1);
  await expect(window.getByTestId("composer-input")).toHaveValue("A draft for the next Question");
  await app.close();
});

test("a window that can't draw shows the line and Reload, and the page loads again with the conversation and the draft back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeNote(window);
  await askInAssistant(window, "Which tide is the highest?");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("A draft for the next Question");

  await fail(window, "window");

  const notice = failed(window, "window");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("This window stopped working");
  await expect(notice).not.toContainText("panel");
  await expect(window.getByTestId("sidebar")).toHaveCount(0);
  await screenshot(window, "window-failed");
  await notice.getByTestId("panel-reload").click();

  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveText([NOTE]);
  await expect(assistantAnswers(window)).toHaveCount(1);
  await expect(window.getByTestId("composer-input")).toHaveValue("A draft for the next Question");
  await app.close();
});
