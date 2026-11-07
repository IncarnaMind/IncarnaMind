import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
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

/**
 * A write the model marks done ends the Answer with its line and no reply after it (#1635). The
 * scripted model (src/main/fakeChat/minds.ts) adds "Note down X" (记下 X) marked done, and "add X"
 * (添加 X) as before, replying with what it did. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const CASES = [
  {
    language: "en" as const,
    title: "Q3 review",
    note: "The quarter was good.",
    replied: "add The supplier is late",
    done: "Note down The office opens in May.",
    line: /Added 1 paragraph to “Q3 review”/,
  },
  {
    language: "zh-CN" as const,
    title: "三季度回顾",
    note: "这个季度不错。",
    replied: "添加 供应商延迟了",
    done: "记下 办公室五月开业。",
    line: /三季度回顾/,
  },
];

for (const each of CASES) {
  test(`${each.language}: a write marked done ends with its line and no reply; one not marked replies as before`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, each.language);
    await setWindowSize(app, window, 1280, 820);
    await newMind(window);
    await enterContent(window);
    await nameMind(window, each.title);
    await window.keyboard.type(each.note);
    const editor = window.getByTestId("mind-editor");
    await expect(editor.locator("p")).toHaveText([each.note]);

    const replied = await askInAssistant(window, each.replied);
    await expect(replied.getByTestId("assistant-answer-text")).not.toBeEmpty();
    await expect(replied.getByTestId("mind-changes-title")).toHaveText(each.line);
    await screenshot(window, `write-replies-${each.language}`);

    const ended = await askInAssistant(window, each.done);
    await expect(editor.locator("p").last()).toHaveText(each.done.replace(/^(Note down |记下 )/, ""));
    await expect(ended.getByTestId("mind-changes-title")).toHaveText(each.line);
    await expect(ended.getByTestId("assistant-answer-text")).toHaveCount(0);
    await screenshot(window, `write-ends-turn-${each.language}`);
  });
}
