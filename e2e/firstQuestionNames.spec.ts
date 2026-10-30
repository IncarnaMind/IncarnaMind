import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  busyOllama,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  welcomeStep as step,
} from "./app";

/**
 * What the assistant says it reads (#2245): the first Question about the
 * User's own Document names that Document on the line while it waits, and an
 * empty conversation names the composer's Question, as DESIGN.md has it; a
 * Question asked inside a Note names that Note in both lines.
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

for (const language of ["en", "zh-CN"] as const) {
  const example = language === "en" ? "Draft: credit committee paper" : "授信委员会报告（草稿）";
  test(`the first Question about the User's own Document names it, never the Note it is asked beside (${language})`, async () => {
    const file = join(sources, "Harbour times.md");
    await writeFile(
      file,
      "# Harbour times\n\nHarbours publish the times of high water every 12 months.\n",
    );
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    let model: Awaited<ReturnType<typeof heldModel>> | null = null;
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await dismissChatSetup(window);
      await expectReadyDocuments(window, 2);
      model = await heldModel(window);
      await window.getByTestId("add-documents-input").setInputFiles([file]);
      await markSteps(window, { indexed: true });
      const ready = step(window, "question").getByTestId("first-open-ready");
      await expect(ready).toHaveAttribute("title", /Harbour times/, { timeout: 30_000 });

      // The empty conversation describes the composer's Question: the Note in focus and its
      // scope, as DESIGN.md has it, not the card's Question beside it.
      await window.keyboard.press("ControlOrMeta+j");
      const reads = window.getByTestId("assistant-reads");
      await expect(reads).toHaveText(
        language === "en"
          ? `Reads “${example}” · searches All Documents`
          : `正在读“${example}” · 搜索全部文档`,
      );
      await screenshot(window, `2245-empty-${language}-1440`);
      await setWindowSize(app, window, 900, 900);
      await screenshot(window, `2245-empty-${language}-900`);
      await setWindowSize(app, window, 1440, 900);

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
        language === "en" ? "Searching “Harbour times”…" : "正在搜索“Harbour times”…",
      );
      await expect(writing).not.toContainText(language === "en" ? example : "授信");
    } finally {
      await app.close();
      model?.release();
      model?.close();
    }
  });
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
    await app.close();
    model?.release();
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
        language === "en"
          ? `Reads “${note}” · searches All Documents`
          : `正在读“${note}” · 搜索全部文档`,
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
      await app.close();
      model?.release();
      model?.close();
    }
  });
}
