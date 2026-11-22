import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  closeFirstFillPopover,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  film,
  firstTranscriptLine,
  launchApp,
  motionSettled,
  recordMeeting,
  removeDataFolder,
  useLocalChatModel as selectLocalChatModel,
  setLanguage,
  setWindowSize,
  startRecording,
} from "./app";

const COPY = {
  en: {
    first: "Customer priorities",
    second: "Open commitments",
    again: "Fill in again",
    width: 1440,
  },
  "zh-CN": { first: "客户重点", second: "未完承诺", again: "重新补全", width: 900 },
} as const;

async function shot(window: Page, name: string): Promise<void> {
  const directory = process.env.INCARNAMIND_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(directory, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Meeting template leaves the live Note blank and a saved Note refills with one Undo and Redo (${language})`, async () => {
    const dir = await createDataFolder();
    const { app, window } = await launchApp(dir, { fakeChat: true });
    const words = COPY[language];
    try {
      await setWindowSize(app, window, words.width, 850);
      await dismissChatSetup(window);
      await selectLocalChatModel(window);
      await setLanguage(window, language);
      const bridge = await coreOf(window);
      const ids = await bridge.evaluate(async (core, titles) => {
        const first = await core.createSkill({
          name: "fixture-first",
          description: "A fixture Meeting template.",
          steps: `## Sections\n\n- ${titles.first}`,
          meetingTemplate: true,
        });
        const second = await core.createSkill({
          name: "fixture-second",
          description: "A different fixture Meeting template.",
          steps: `## Sections\n\n- ${titles.second}`,
          meetingTemplate: true,
        });
        if (!first.ok || !second.ok) throw new Error("Couldn't create the fixture templates.");
        return [first.skill.id, second.skill.id];
      }, words);
      await film(window, async () => {
        const bar = await startRecording(window, await recordMeeting(window), { notice: true });
        const template = bar.getByTestId("meeting-writeup-template");
        if (await template.isVisible()) await template.click();
        else await bar.getByTestId("meeting-more").click();
        await expect(window.getByTestId("meeting-writeup-fixture-first")).toBeVisible();
        await shot(window, `meeting-template-live-${language}`);
        await window.getByTestId("meeting-writeup-fixture-first").click();

        const editor = window.getByTestId("mind-editor");
        await expect(editor.locator("h2")).toHaveCount(0);
        await firstTranscriptLine(window);
        await bar.getByTestId("meeting-stop").click();
        await expect(editor.locator("h2")).toHaveText([words.first], { timeout: 30_000 });
        await expect(editor.getByTestId("citation")).toHaveCount(1);
        await closeFirstFillPopover(window);

        await window.getByTestId("meeting-view-chip").click();
        await window.getByTestId("meeting-writeup-saved").click();
        await expect(window.getByTestId("meeting-writeup-fixture-first")).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await expect(window.getByTestId("meeting-writeup-again")).toHaveText(words.again);
        await shot(window, `meeting-template-saved-${language}`);
        await window.keyboard.press("Escape");
        await expect(window.getByTestId("meeting-view-menu")).toBeHidden();

        await editor.locator(":scope > p[data-id]").last().click();
        await window.keyboard.type("/fixture-second");
        const option = window.getByTestId("slash-item-meeting-template-fixture-second");
        await expect(option).toBeVisible();
        await option.click();
        await expect(editor.locator("h2")).toHaveText([words.second], { timeout: 30_000 });
        await expect(editor.getByTestId("citation")).toHaveCount(1);

        const selected = () =>
          bridge.evaluate(async (core) => (await core.listMeetings())[0]?.writeupTemplateId);
        await expect.poll(selected).toBe(ids[1]);
        await editor.focus();
        await window.keyboard.press("ControlOrMeta+z");
        await expect(editor.locator("h2")).toHaveText([words.first]);
        await expect.poll(selected).toBe(ids[0]);
        await window.keyboard.press("ControlOrMeta+Shift+z");
        await expect(editor.locator("h2")).toHaveText([words.second]);
        await expect.poll(selected).toBe(ids[1]);
      });
    } finally {
      await app.close();
      await removeDataFolder(dir);
    }
  });
}
