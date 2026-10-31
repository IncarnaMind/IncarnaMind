import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  recordMeeting,
  removeDataFolder,
  startRecording,
  useLocalChatModel,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LINES = {
  en: {
    filled: "Note filled in",
    undo: "Undo",
    undone: "Fill-in undone",
    again: "Fill in again",
    summary: "Summary",
  },
  "zh-CN": {
    filled: "已补全笔记",
    undo: "撤销",
    undone: "已撤销补全",
    again: "重新补全",
    summary: "摘要",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  // protects=after Stop, with no click, the line the User typed during the call gets what the call said under it, as AI text with a Citation, the sections the notes don't cover follow (#2306), the line says so with Undo, and Undo takes all of it back, leaving the User's line, in English and Chinese (#142); fails_when=nothing is filled in, no section follows, the User's line changes, the addition isn't AI text or uncited, or Undo leaves any of it; no_claim=a real model's wording, which the unit tests and a hand check cover.
  test(`after Stop, the User's line is filled in under it, cited, the sections follow, and Undo takes it back (${language})`, async () => {
    const words = LINES[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);

    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
    const notes = window.getByTestId("mind-editor");
    await notes.click();
    await window.keyboard.type("Launch date");
    const typed = notes.locator("p").filter({ hasText: /^Launch date$/ });
    await expect(typed).toBeVisible();

    // The menus above are named in English; what follows Stop is read in the language chosen.
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    await bar.getByTestId("meeting-stop").click();
    const line = window.getByTestId("meeting-fill-line");
    await expect(line).toContainText(words.filled, { timeout: 30_000 });
    await expect(line.getByTestId("meeting-fill-undo")).toHaveText(words.undo);
    // Right under the User's line: AI text, with its Citation; then the sections follow.
    const added = notes.locator(".generated-text");
    const lineAdded = notes.locator("p:has(.generated-text)").first();
    await expect(lineAdded.getByTestId("citation")).toHaveCount(1);
    await expect(notes.locator("h2:has(.generated-text)").first()).toHaveText(words.summary);
    await shot(window, `meeting-fill-sections-${language}`);
    const order = await notes
      .locator("p")
      .evaluateAll((all) => all.map((each) => each.querySelector(".generated-text") !== null));
    const userAt = await notes
      .locator("p")
      .evaluateAll((all) => all.findIndex((each) => each.textContent === "Launch date"));
    expect(order[userAt + 1]).toBe(true);
    await expect(typed).toHaveText("Launch date");

    await line.getByTestId("meeting-fill-undo").click();
    await expect(added).toHaveCount(0);
    await expect(typed).toHaveText("Launch date");
    await expect(line).toContainText(words.undone);
    await expect(line.getByTestId("meeting-fill-again")).toHaveText(words.again);
    await app.close();
  });
}

// protects=Settings › Meetings › "Fill sections my notes don't cover" is on by default, in English and Chinese, and turned off there, Stop fills out only the User's line, with no section below it (#2306); fails_when=the switch is missing or off by default, or a section is written with it off; no_claim=the sections' wording, which the unit tests cover.
test("with Fill sections my notes don't cover off in Settings, only the User's line is filled out", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const language = (chosen: "en" | "zh-CN") =>
    window.evaluate(async (each) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: each } });
    }, chosen);

  const settings = await openSettings(window, "meetings");
  const row = settings.getByTestId("meeting-fill-settings");
  const fillSwitch = row.getByTestId("meeting-fill-uncovered");
  await expect(row).toContainText("Fill sections my notes don’t cover");
  await expect(fillSwitch).toBeChecked();
  await row.scrollIntoViewIfNeeded();
  await shot(window, "meeting-fill-setting-en");
  await language("zh-CN");
  await expect(row).toContainText("补全笔记没写到的部分");
  await shot(window, "meeting-fill-setting-zh-CN");
  await language("en");
  await expect(row).toContainText("Fill sections my notes don’t cover");
  await fillSwitch.click();
  await expect(fillSwitch).not.toBeChecked();
  await closeSettings(window);

  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
  const notes = window.getByTestId("mind-editor");
  await notes.click();
  await window.keyboard.type("Launch date");
  await expect(notes.locator("p").filter({ hasText: /^Launch date$/ })).toBeVisible();
  await bar.getByTestId("meeting-stop").click();
  await expect(window.getByTestId("meeting-fill-line")).toContainText("Note filled in", {
    timeout: 30_000,
  });
  const lineAdded = notes.locator("p:has(.generated-text)");
  await expect(lineAdded).toHaveCount(1);
  await expect(lineAdded.getByTestId("citation")).toHaveCount(1);
  await expect(notes.locator("h2")).toHaveCount(0);
  await app.close();
});
