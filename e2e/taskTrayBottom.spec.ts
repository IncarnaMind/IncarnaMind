import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  moveAssistant,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  startScriptedTask,
} from "./app";

/**
 * At the bottom dock the conversation keeps room to read while the Task tray
 * shows an ask (#678): the thread is at least 120px high, the tray gives way
 * (its ask scrolls inside) and the buttons stay in view and reachable by
 * keyboard, in English and Chinese. Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let folder: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  folder = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(folder);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`at the bottom dock an ask in the tray leaves the thread 120px or more, its buttons in view and reachable (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      scriptedTasks: true,
      home: folder,
    });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await setLanguage(window, language);
    await newMind(window);
    await nameMind(window, "Credit memo");
    await askInAssistant(window, "First");
    const mind = await window.evaluate(
      async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).find(
          (each) => each.title === "Credit memo",
        )?.id ?? "",
    );
    await startScriptedTask(app, mind, { folder, files: ["a.txt"] });
    const tray = window.getByTestId("task-tray");
    await expect(tray).toBeVisible();
    await moveAssistant(window, "bottom");
    await expect(window.getByTestId("assistant")).toHaveAttribute("data-dock", "bottom");

    const thread = window.getByTestId("assistant-thread");
    await expect
      .poll(() => thread.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThanOrEqual(120);

    // The buttons are inside the tray, which is inside the assistant, and Tab reaches them.
    const allow = tray.getByTestId("approval-allow-once");
    // In view: inside the tray and inside the ask card that scrolls in it, not scrolled out of it.
    const inside = async (target: typeof allow) =>
      target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const card = (el.closest(".approval-card") as HTMLElement).getBoundingClientRect();
        const view = (
          document.querySelector('[data-testid="task-tray"]') as HTMLElement
        ).getBoundingClientRect();
        return (
          box.top >= Math.max(view.top, card.top) - 1 &&
          box.bottom <= Math.min(view.bottom, card.bottom) + 1
        );
      });
    // What it asks is in view too.
    await expect(tray.locator(".approval-title")).toBeInViewport();
    await expect.poll(() => inside(allow)).toBe(true);
    await expect.poll(() => inside(tray.getByTestId("approval-deny"))).toBe(true);
    await allow.focus();
    await expect(allow).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(tray.locator(".approval-actions button:focus")).toHaveCount(1);
    if (SCREENSHOTS) {
      await window
        .getByTestId("assistant")
        .screenshot({ path: join(SCREENSHOTS, `tray-bottom-${language}.png`) });
    }
    await app.close();
  });
}
