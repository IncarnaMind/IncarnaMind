import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  nameMind,
  newMind,
  ollamaListing,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  welcomeStep as step,
} from "./app";

/**
 * What the assistant says it reads (#2245): the first Question about the
 * User's own Document names that Document on the line while it waits, and an
 * empty conversation names the same Question it will ask; a Question asked
 * inside a Note names that Note in both lines.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** Marks the first open's steps done, as the User doing them would. */
async function markSteps(window: Page, done: object): Promise<void> {
  await window.evaluate(async (patch) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { device } = await bridge.getSettings();
    await bridge.updateSettings({
      device: { gettingStarted: { ...device.gettingStarted, ...patch } },
    });
  }, done);
}

/** A model on this computer, its probe slow enough to keep the Question on its way on screen. */
async function slowModel(window: Page): Promise<void> {
  const listing = await ollamaListing(["fake-model"], { delayMs: 15_000 });
  await window.evaluate(async (url) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "ollama", baseUrl: url, modelId: "fake-model" });
  }, listing.url);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the first Question about the User's own Document names it, never the Note it is asked beside (${language})`, async () => {
    const file = join(sources, "Harbour times.md");
    await writeFile(
      file,
      "# Harbour times\n\nHarbours publish the times of high water every 12 months.\n",
    );
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await dismissChatSetup(window);
      await expectReadyDocuments(window, 2);
      await slowModel(window);
      await window.getByTestId("add-documents-input").setInputFiles([file]);
      await markSteps(window, { indexed: true });
      const ready = step(window, "question").getByTestId("first-open-ready");
      await expect(ready).toHaveAttribute("title", /Harbour times/, { timeout: 30_000 });

      // The empty conversation names what the next Question reads, as the line while it waits
      // will: the Document the card's Question is about, and never the example Note.
      await window.keyboard.press("ControlOrMeta+j");
      const reads = window.getByTestId("assistant-reads");
      await expect(reads).toBeVisible();
      await screenshot(window, `2245-empty-${language}-1440`);
      await setWindowSize(app, window, 900, 900);
      await screenshot(window, `2245-empty-${language}-900`);
      await setWindowSize(app, window, 1440, 900);
      await expect(reads).toHaveText(
        language === "en" ? "Searches “Harbour times”" : "搜索“Harbour times”",
      );
      await expect(reads).not.toContainText(language === "en" ? "Draft" : "授信");

      // The card's Question is about their Document: the line names it, and never the example Note.
      await pointAndClick(window, ready);
      const writing = window
        .getByTestId("assistant-answer-on-its-way")
        .getByTestId("answer-writing");
      await expect(writing).toBeVisible();
      await screenshot(window, `2245-line-${language}-1440`);
      await setWindowSize(app, window, 900, 900);
      await screenshot(window, `2245-line-${language}-900`);
      await expect(writing).toHaveText(
        language === "en" ? "Searching Harbour times…" : "正在搜索“Harbour times”…",
      );
      await expect(writing).not.toContainText(language === "en" ? "Draft" : "授信");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Question asked inside a Note names it on both lines (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await dismissChatSetup(window);
      const note = language === "en" ? "Harbour notes" : "港口笔记";
      await newMind(window);
      await nameMind(window, note);
      await window.keyboard.type(
        language === "en"
          ? "The harbour master publishes the tide tables."
          : "港口管理员发布潮汐表。",
      );
      await slowModel(window);

      // The empty conversation names the Note it reads, and the Question asked in it names it too.
      await window.keyboard.press("ControlOrMeta+j");
      const reads = window.getByTestId("assistant-reads");
      await expect(reads).toBeVisible();
      await screenshot(window, `2245-note-empty-${language}`);
      await expect(reads).toHaveText(
        language === "en"
          ? `Reads “${note}” · searches All Documents`
          : `正在读“${note}” · 搜索全部文档`,
      );
      await window.keyboard.type(language === "en" ? "What do the tides do?" : "潮汐是什么？");
      await window.keyboard.press("Enter");
      const writing = window
        .getByTestId("assistant-answer-on-its-way")
        .getByTestId("answer-writing");
      await expect(writing).toBeVisible();
      await screenshot(window, `2245-note-line-${language}`);
      await expect(writing).toHaveText(
        language === "en" ? `Reading “${note}”…` : `正在读“${note}”…`,
      );
    } finally {
      await app.close();
    }
  });
}
