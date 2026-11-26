import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  busyOllama,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * What the assistant says it reads (#2245): an empty conversation names the composer's Question,
 * as DESIGN.md has it, and a Question asked inside a Note names that Note in both lines.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/**
 * A model on this computer whose probe the test holds, so a Question stays on
 * its way until the test releases it: a state, never a time.
 */
async function heldModel(window: Page) {
  const model = await busyOllama();
  model.hold();
  await window.evaluate(async (url) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "ollama", baseUrl: url, modelId: "fake-model" });
  }, model.url);
  return model;
}

test("a Note deleted while its Question waits is named no more: the line says what it searches", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  let model: Awaited<ReturnType<typeof heldModel>> | null = null;
  try {
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");
    await dismissChatSetup(window);
    await newMind(window);
    await nameMind(window, "Harbour notes");
    await window.keyboard.type("The harbour master publishes the tide tables.");
    model = await heldModel(window);
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What do the tides do?");
    await window.keyboard.press("Enter");
    const writing = window.getByTestId("assistant-answer-on-its-way").getByTestId("answer-writing");
    await expect(writing).toHaveText("Reading “Harbour notes”…");

    // Deleted while the Question waits, the Note is read no more: the line says what it searches.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = (await bridge.listMinds()).find((each) => each.title === "Harbour notes");
      if (!mind) throw new Error("The Note is not there.");
      await bridge.deleteMind(mind.id);
    });
    await expect(writing).toHaveText("Searching All Documents…");
  } finally {
    // Release the held probe before the app goes, so its last request finishes rather than being
    // cut off; the server closes once nothing uses it.
    model?.release();
    await app.close();
    model?.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a Question asked inside a Note names it on both lines (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    let model: Awaited<ReturnType<typeof heldModel>> | null = null;
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
      model = await heldModel(window);

      // The empty conversation names the Note the composer will read, and the Question asked in
      // it names it too: the same fact, two lines.
      await window.keyboard.press("ControlOrMeta+j");
      const reads = window.getByTestId("assistant-reads");
      await expect(reads).toHaveText(
        language === "en" ? `Reads “${note}” and All Documents` : `读“${note}”和全部文档`,
      );
      await screenshot(window, `2245-note-empty-${language}`);
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
      // Release the held probe before the app goes, so its last request finishes rather than
      // being cut off; the server closes once nothing uses it.
      model?.release();
      await app.close();
      model?.close();
    }
  });
}
