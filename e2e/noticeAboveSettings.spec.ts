import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Its notice comes from renaming an agent in Settings › Agents, hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * A notice raised while Settings is open is drawn above it, readable and dismissable (#754).
 * Settings is a native modal dialog: it makes everything outside it inert, so the corner notices
 * are drawn inside the dialog while one is open. A failed rename in Settings → Agents raises one.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
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

/** Longer than the 80 characters an agent's name can have. */
const TOO_LONG = "Research agent ".repeat(6);

/** Settings → Agents with one agent connected, then that agent renamed to a name the core refuses. */
async function failToRename(window: Page, language: "en" | "zh-CN"): Promise<Locator> {
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({ name: "Other agent", client: "other" });
  });
  const settings = await openSettings(window, "agents");
  await setLanguage(window, language);
  const row = settings.getByTestId("agent-pairing");
  await row.getByTestId("agent-pairing-name").dblclick();
  await row.getByTestId("agent-pairing-rename").fill(TOO_LONG);
  await window.keyboard.press("Enter");
  return window.getByTestId("error-notice");
}

/** Whether what draws at the middle of `target` is `target` or something in it. */
const drawsAtItsMiddle = (target: Locator) =>
  target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && element.contains(hit);
  });

for (const width of [900, 1600]) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`a failed rename in Settings → Agents shows its notice above Settings, readable and dismissable, at ${width} px in ${language === "en" ? "English" : "Chinese"}`, async () => {
      const { app, window } = await launchApp(dataDir);
      try {
        await setWindowSize(app, window, width, 700);
        const notice = await failToRename(window, language);
        await expect(notice).toBeVisible();
        await expect(notice.getByTestId("error-notice-message")).toContainText(
          language === "en" ? "That didn’t work:" : "无法完成操作：",
        );
        await screenshot(window, `notice-over-settings-${width}-${language}`);

        const box = await notice.boundingBox();
        expect(box).not.toBeNull();
        if (!box) return;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await drawsAtItsMiddle(notice)).toBe(true);
        const dismiss = notice.getByTestId("error-notice-dismiss");
        await expect(dismiss).toHaveText(language === "en" ? "Dismiss" : "关闭");
        expect(await drawsAtItsMiddle(dismiss)).toBe(true);

        await pointAndClick(window, dismiss);
        await expect(notice).toHaveCount(0);
        await expect(window.getByTestId("settings")).toBeVisible();
      } finally {
        await app.close();
      }
    });
  }
}

test("a dialog that opens over Settings leaves the notice readable and dismissable", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 700);
    const notice = await failToRename(window, "en");
    await expect(notice).toBeVisible();

    const settings = window.getByTestId("settings");
    await settings.locator('[data-client="codex"]').getByTestId("agent-connect").focus();
    await window.keyboard.press("Enter");
    const connect = window.getByTestId("connect-agent-dialog");
    await expect(connect).toBeVisible();
    await expect(notice).toBeVisible();
    expect(await drawsAtItsMiddle(notice)).toBe(true);

    await pointAndClick(window, notice.getByTestId("error-notice-dismiss"));
    await expect(notice).toHaveCount(0);
    await expect(connect).toBeVisible();
  } finally {
    await app.close();
  }
});

test("Esc closes Settings first, and the notice is still there to read and dismiss", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 700);
    const notice = await failToRename(window, "en");
    await expect(notice).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings")).toBeHidden();
    await expect(notice).toBeVisible();
    expect(await drawsAtItsMiddle(notice)).toBe(true);

    await window.keyboard.press("Escape");
    await expect(notice).toHaveCount(0);
  } finally {
    await app.close();
  }
});
