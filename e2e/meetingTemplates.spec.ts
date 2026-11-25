import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  film,
  firstTranscriptLine,
  launchApp,
  motionSettled,
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  useLocalChatModel as selectLocalChatModel,
  setLanguage,
  setWindowSize,
  stopMeeting,
} from "./app";

const COPY = {
  en: {
    first: "Customer priorities",
    second: "Open commitments",
    width: 1440,
  },
  "zh-CN": { first: "客户重点", second: "未完承诺", width: 900 },
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
        await recordMeeting(window);
        // While it records, the template is one of the Transcript sheet's ⋯ rows (#3762).
        const sheet = await openMeetingSheet(window);
        await pointAndClick(window, sheet.getByTestId("meeting-sheet-more"));
        const first = window.getByTestId("meeting-writeup-fixture-first");
        await expect(first).toBeVisible();
        await expect(window.getByTestId("meeting-writeup-default")).toHaveAttribute(
          "aria-checked",
          "true",
        );
        // Fill in again is for a saved Note only.
        await expect(window.getByTestId("meeting-writeup-again")).toHaveCount(0);
        await shot(window, `meeting-template-live-${language}`);
        await pointAndClick(window, first);
        await expect(first).toBeHidden();
        const selected = () =>
          bridge.evaluate(async (core) => (await core.listMeetings())[0]?.writeupTemplateId);
        await expect.poll(selected).toBe(ids[0]);
        await pointAndClick(window, sheet.getByTestId("meeting-sheet-hide"));
        await expect(sheet).toBeHidden();

        const editor = window.getByTestId("mind-editor");
        await expect(editor.locator("h2")).toHaveCount(0);
        await firstTranscriptLine(window);
        await stopMeeting(window);
        await expect(editor.locator("h2")).toHaveText([words.first], { timeout: 30_000 });
        await expect(editor.getByTestId("citation")).toHaveCount(1);
        await expect.poll(selected).toBe(ids[0]);
        await shot(window, `meeting-template-saved-${language}`);

        await editor.locator(":scope > p[data-id]").last().click();
        await window.keyboard.type("/fixture-second");
        const option = window.getByTestId("slash-item-meeting-template-fixture-second");
        await expect(option).toBeVisible();
        await option.click();
        await expect(editor.locator("h2")).toHaveText([words.second], { timeout: 30_000 });
        await expect(editor.getByTestId("citation")).toHaveCount(1);
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
