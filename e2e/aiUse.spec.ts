import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setWindowSize,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const TEXTS = {
  en: {
    settings: "Settings",
    title: "AI use record",
    stays: "never sent",
    cleared: "Cleared the AI use record.",
    entries: (count: number) => `Entries: ${count}`,
  },
  "zh-CN": {
    settings: "设置",
    title: "AI 使用记录",
    stays: "绝不发送",
    cleared: "已清除 AI 使用记录。",
    entries: (count: number) => `共 ${count} 条`,
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings → Privacy says the AI use record stays on this computer, and Clear can be undone (${language})`, async () => {
    const text = TEXTS[language];
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 900, 700);
      await window.evaluate(async (chosen) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.updateSettings({ user: { language: chosen } });
        const mind = await bridge.createMind({ title: "Essay" });
        await bridge.recordAiUse([
          {
            mindId: mind.id,
            kind: "suggestion-accepted",
            characters: 24,
            providerId: "p",
            modelId: "m",
          },
          { mindId: mind.id, kind: "assistant-change-rejected", characters: 40 },
        ]);
      }, language);

      await window.getByRole("button", { name: text.settings }).click();
      await window.getByTestId("settings-nav-privacy").click();
      const record = window.getByTestId("ai-use-record");
      await record.scrollIntoViewIfNeeded();
      await expect(record).toContainText(text.title);
      await expect(record).toContainText(text.stays);
      await expect(record.getByTestId("ai-use-entries")).toHaveText(text.entries(2));

      // Clear happens at once, with no question, and says how to take it back.
      await record.getByTestId("ai-use-clear").click();
      await expect(record.getByTestId("ai-use-cleared")).toHaveText(text.cleared);
      await expect(record.getByTestId("ai-use-entries")).toHaveText(text.entries(0));
      await expect(record.getByTestId("ai-use-clear")).toBeDisabled();
      // The line and its Undo fit inside the section at the narrowest window.
      const section = await record.boundingBox();
      const undo = await record.getByTestId("ai-use-undo").boundingBox();
      expect(section && undo && undo.x + undo.width <= section.x + section.width + 1).toBe(true);

      await record.getByTestId("ai-use-undo").click();
      await expect(record.getByTestId("ai-use-entries")).toHaveText(text.entries(2));
      await expect(record.getByTestId("ai-use-cleared")).toHaveCount(0);
      expect(
        await window.evaluate(() =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAiUseStatus(),
        ),
      ).toEqual({ entries: 2 });
    } finally {
      await app.close();
    }
  });
}
