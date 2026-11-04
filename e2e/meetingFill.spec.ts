import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setWindowSize,
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
    decisions: "Decisions",
    actions: "Action items",
    notes: ["Launch date", "UK fee"],
  },
  "zh-CN": {
    filled: "已补全笔记",
    undo: "撤销",
    undone: "已撤销补全",
    again: "重新补全",
    summary: "摘要",
    decisions: "决定",
    actions: "待办",
    notes: ["上线日期", "英国费用"],
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  // protects=after Stop, typed lines and an Action items heading are filled in place as cited AI text, Summary and Decisions follow, and one Undo restores the heading and lines in English and Chinese (#142, #2306); fails_when=a section is missing or repeated, typed text changes, additions are uncited or not AI text, or Undo leaves an addition; no_claim=a real model's wording or allocation of facts.
  test(`after Stop, typed lines and an Action items heading are filled in place, sections follow, and one Undo restores them (${language})`, async () => {
    const words = LINES[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1280, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);

    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
    const notes = window.getByTestId("mind-editor");
    await pointAndClick(window, notes);
    await focusSettled(window, notes);
    for (const text of words.notes) {
      await window.keyboard.type(text);
      await window.keyboard.press("Enter");
    }
    await window.keyboard.type(`## ${words.actions}`);
    const heading = notes.locator("h2:not(:has(.generated-text))");
    await expect(heading).toHaveText(words.actions);
    await expect(notes.locator("p")).toHaveText(words.notes);
    const blocks = notes.locator(":scope > *");
    const original = await blocks.allTextContents();

    // The menus above are named in English; what follows Stop is read in the language chosen.
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    const line = window.getByTestId("meeting-fill-line");
    await expect(line).toContainText(words.filled, { timeout: 30_000 });
    await expect(line.getByTestId("meeting-fill-undo")).toHaveText(words.undo);
    const added = notes.locator(".generated-text");
    await expect(notes.locator("h2")).toHaveText([words.actions, words.summary, words.decisions]);
    await expect(heading).toHaveText(words.actions);
    const actions = notes.locator("h2:not(:has(.generated-text)) + ul");
    await expect(actions).toHaveCount(1);
    await expect(actions.locator(".generated-text")).not.toHaveCount(0);
    await expect(actions.getByTestId("citation")).toHaveCount(1);
    await shot(window, `meeting-fill-sections-${language}`);
    const paragraphs = await notes.locator(":scope > p").evaluateAll((all) =>
      all.map((each) => ({
        text: each.textContent,
        generated: each.querySelector(".generated-text") !== null,
        citations: each.querySelectorAll('[data-testid="citation"]').length,
      })),
    );
    for (const text of words.notes) {
      const userAt = paragraphs.findIndex((each) => each.text === text);
      expect(userAt).toBeGreaterThanOrEqual(0);
      expect(paragraphs[userAt]).toMatchObject({ generated: false, citations: 0 });
      expect(paragraphs[userAt + 1]).toMatchObject({ generated: true, citations: 1 });
    }

    await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
    await expect(added).toHaveCount(0);
    await expect(blocks).toHaveText(original);
    await expect(notes.locator("h2")).toHaveText([words.actions]);
    await expect(notes.locator("p")).toHaveText(words.notes);
    await expect(notes.getByTestId("citation")).toHaveCount(0);
    await expect(line).toContainText(words.undone);
    await expect(line.getByTestId("meeting-fill-again")).toHaveText(words.again);
    await app.close();
  });
}
