import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  motionSettled,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Where a figure couldn't be calculated (#2577): the assistant writes a Note whose sentence, list
 * item and table cell each place a figure marker no figure was recorded for. Each reads
 * "[number missing]" ([缺少数字]) in the can't-check look, the pointer resting on one shows the
 * shared tip, and so does selecting it with a click; the change line says so, and the finished
 * Answer in the panel shows the same mark. With INCARNAMIND_SCREENSHOTS set to a folder, each
 * step is kept as a picture there, in light and in dark, with the Note's Word export beside them.
 */

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const shot = async (window: Page, name: string) => {
  if (!SHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const [language, width, scheme] of [
  ["en", 1440, "light"],
  ["zh-CN", 900, "light"],
  ["en", 1440, "dark"],
  ["zh-CN", 900, "dark"],
] as const) {
  test(`a figure that couldn't be calculated reads as the mark, with its tip and its change line (${language}, ${width}px, ${scheme})`, async () => {
    test.skip(scheme === "dark" && !SHOTS, "Dark is for the pictures; light covers the behaviour.");
    test.setTimeout(180_000);
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, width, 900);
      await window.emulateMedia({ colorScheme: scheme });
      await dismissChatSetup(window);
      // A model measured to use calculate (ADR-0021): the scripted model answers in its place.
      await acceptPlainTextKeys(window);
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-haiku-5-5",
        });
      });
      await setLanguage(window, language);
      const title = language === "en" ? "Growth" : "增长";

      const answer = await askInAssistant(
        window,
        language === "en" ? "Write the growth note" : "写增长笔记",
      );
      await expect(frontMindName(window)).toHaveText(title);
      await expect(answer.getByTestId("mind-changes-kept")).toContainText(
        t("mindChanges.figuresLeft", { count: 3 }),
      );
      const panelMark = answer.getByTestId("assistant-answer-text").getByTestId("missing-number");
      await expect(panelMark).toHaveText(t("missingNumber.words"));
      await shot(window, `answer-and-change-line-${language}-${scheme}`);

      const editor = window.getByTestId("mind-editor");
      const marks = editor.getByTestId("missing-number");
      await expect(marks).toHaveCount(3);
      await expect(marks).toHaveText(Array(3).fill(t("missingNumber.words")));
      // In a sentence, a list item and a table cell.
      await expect(editor.locator("p").first().getByTestId("missing-number")).toHaveCount(1);
      await expect(editor.locator("li").getByTestId("missing-number")).toHaveCount(1);
      await expect(editor.locator("td").getByTestId("missing-number")).toHaveCount(1);
      // The can't-check look: its words softer than the sentence's, on the chip wash.
      const [markInk, textInk] = await Promise.all([
        marks.first().evaluate((element) => getComputedStyle(element).color),
        editor
          .locator("p")
          .first()
          .evaluate((element) => getComputedStyle(element).color),
      ]);
      expect(markInk).not.toBe(textInk);
      await shot(window, `note-${language}-${scheme}`);

      // The pointer resting on it opens the shared tip; passing over opens nothing.
      const tip = window.getByRole("tooltip").filter({ hasText: t("missingNumber.tip") });
      await pointAt(window, marks.first());
      await expect(tip).toBeVisible();
      await shot(window, `tip-${language}-${scheme}`);
      await window.mouse.move(5, 5);
      await expect(tip).toHaveCount(0);

      // Selected with a click, it shows the tip at once, and typing over it replaces it.
      await pointAndClick(window, marks.nth(1));
      await expect(tip).toBeVisible();
      await window.keyboard.type("4,120");
      await expect(marks).toHaveCount(2);
      await expect(editor.locator("li")).toContainText("4,120");
      await window.keyboard.press("ControlOrMeta+z");
      await expect(marks).toHaveCount(3);

      if (SHOTS) {
        const data = await window.evaluate(async (named) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const mind = (await bridge.listMinds()).find((each) => each.title === named);
          if (!mind) throw new Error("No Note.");
          const file = await bridge.exportMind(mind.id, { format: "docx" });
          return Array.from(file.data);
        }, title);
        await writeFile(join(SHOTS, `export-${language}-${scheme}.docx`), Buffer.from(data));
      }
    } finally {
      await app.close();
    }
  });
}
