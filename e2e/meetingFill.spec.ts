import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  recordMeeting,
  removeDataFolder,
  startRecording,
  useLocalChatModel,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LINES = {
  en: { filled: "Note filled in", undo: "Undo", undone: "Fill-in undone", again: "Fill in again" },
  "zh-CN": { filled: "已补全笔记", undo: "撤销", undone: "已撤销补全", again: "重新补全" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  // protects=after Stop, with no click, the line the User typed during the call gets what the call said under it, as AI text with a Citation, the line says so with Undo, and Undo takes it back, leaving the User's line, in English and Chinese (#142); fails_when=nothing is filled in, the User's line changes, the addition isn't AI text or uncited, or Undo leaves it; no_claim=a real model's wording, which the unit tests and a hand check cover.
  test(`after Stop, the User's line is filled in under it, cited, and Undo takes it back (${language})`, async () => {
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
    // Right under the User's line: AI text, with its Citation.
    const added = notes.locator("p:has(.generated-text)");
    await expect(added).toHaveCount(1);
    await expect(added.getByTestId("citation")).toHaveCount(1);
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
