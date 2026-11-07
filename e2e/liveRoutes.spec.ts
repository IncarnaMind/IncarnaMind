import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  useOutputLocation,
} from "./app";

/**
 * The live routes with a key of their own (#866), with the pretend services every smoke test's
 * fake transcriber has: Deepgram's server kept with its key in Settings › Meetings, and an
 * account out of credit as one line in the meeting bar. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const settingsNow = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return { settings: await bridge.getSettings(), flows: await bridge.listDataFlows() };
  });

const CLOUDFLARE =
  "https://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3";

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

test("Deepgram's key row takes Cloudflare Workers AI's address too; choosing Deepgram then sends the audio to Cloudflare, as its line says", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);

  const settings = await openSettings(window, "meetings");
  const row = settings.getByTestId("transcription-key-deepgram");
  await row.getByTestId("transcription-key-add").click();
  await expect(row.getByTestId("transcription-key-input")).toBeFocused();
  const server = row.getByRole("textbox", { name: "Server" });
  await expect(server).toHaveAttribute("placeholder", "Deepgram’s own");
  await expect(row).toContainText("Leave it empty for Deepgram.");
  await expect(row).toContainText("Saving it first checks it with Deepgram");
  await server.fill(CLOUDFLARE);
  await expect(row).not.toContainText("Saving it first checks it");
  await row.getByTestId("transcription-key-input").fill("cf-test-token-0123456789");
  await row.getByTestId("transcription-key-save").click();
  await expect(row.getByTestId("transcription-key-saved")).toHaveText("Saved");
  await expect(row.getByTestId("transcription-key-server-saved")).toHaveText(
    "Sent to wss://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
  );
  await expect(row).not.toContainText("Saving it first checks it");

  const route = settings.getByTestId("meetings-route");
  await expect(route.locator("option:not([hidden])")).toHaveText(["On this computer", "Deepgram"]);
  await route.selectOption("deepgram");
  const line = settings.getByTestId("meetings-route-line");
  await expect(line).toContainText("Audio goes to Cloudflare while you record.");
  await expect(line).toContainText(
    "Cloudflare doesn’t train AI models on what Workers AI transcribes",
  );
  const chosen = await settingsNow(window);
  expect(chosen.settings.device.transcriptionRoute).toBe("deepgram");
  expect(chosen.flows).toContainEqual(
    expect.objectContaining({
      flow: expect.objectContaining({
        id: "transcription",
        service: expect.objectContaining({ id: "https://api.cloudflare.com" }),
      }),
      consent: "accepted",
    }),
  );
  await shot(window, "settings-meetings-deepgram-cloudflare-en-1600");

  // In Chinese, at the narrowest width, the address wraps inside its row.
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await expect(line).toContainText("录音期间，音频会发送给 Cloudflare。");
  const saved = row.getByTestId("transcription-key-server-saved");
  await expect(saved).toContainText("发送到 wss://api.cloudflare.com");
  const box = await row.boundingBox();
  const text = await saved.boundingBox();
  expect(box && text && text.x + text.width <= box.x + box.width).toBe(true);
  await shot(window, "settings-meetings-deepgram-cloudflare-zh-900");
  await setLanguage(window, "en");

  // Esc closes the form and keeps what was saved.
  await row.getByTestId("transcription-key-add").click();
  await expect(row.getByRole("textbox", { name: "Server" })).toHaveValue(
    "wss://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
  );
  await row.getByTestId("transcription-key-input").press("Escape");
  await expect(row.getByTestId("transcription-key-input")).toHaveCount(0);
  await expect(row.getByTestId("transcription-key-saved")).toHaveText("Saved");
  await closeSettings(window);
});

test("an AssemblyAI account out of credit is one line in the bar with Add credit, and recording goes on on this computer", async () => {
  const { app, window } = await launchApp(dataDir, { transcriber: { cloud: { noCredit: true } } });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  await acceptPlainTextKeys(window);

  const settings = await openSettings(window, "meetings");
  const row = settings.getByTestId("transcription-key-assemblyai");
  await row.getByTestId("transcription-key-add").click();
  await expect(row.getByRole("textbox", { name: "Server" })).toHaveCount(0);
  await row.getByTestId("transcription-key-input").fill("aai-test-key-0123456789");
  await row.getByTestId("transcription-key-save").click();
  await expect(row.getByTestId("transcription-key-saved")).toHaveText("Saved");
  await settings.getByTestId("meetings-route").selectOption("assemblyai");
  await expect(settings.getByTestId("meetings-route-line")).toContainText(
    "Audio goes to AssemblyAI while you record.",
  );
  await closeSettings(window);

  const start = await recordMeeting(window);
  await start.getByTestId("meeting-start-record").click();
  const sheet = window.getByTestId("meeting-notice");
  await expect(sheet.getByTestId("meeting-route")).toContainText("Transcribe with AssemblyAI");
  await sheet.getByTestId("meeting-notice-start").click();
  await expect(sheet).toBeHidden();
  const bar = window.getByTestId("meeting-bar");
  const credit = bar.getByTestId("meeting-line-cloud");
  await expect(credit).toContainText(
    "AssemblyAI says this account is out of credit. Transcribing on this computer.",
    { timeout: 20_000 },
  );
  await expect(credit.getByTestId("meeting-line-add-credit")).toHaveText("Add credit");
  await expect(bar).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-bar-assemblyai-credit-en");
  await setLanguage(window, "zh-CN");
  await expect(credit).toContainText("提示此账户余额不足，正在这台电脑上转写。");
  await expect(credit.getByTestId("meeting-line-add-credit")).toHaveText("充值");
  await shot(window, "meeting-bar-assemblyai-credit-zh");
});

test("a meeting service's key row says Save checks the key with the service; in Local mode the key is kept, and the row says nothing was sent", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);

  let settings = await openSettings(window, "meetings");
  let row = settings.getByTestId("transcription-key-assemblyai");
  await expect(row).toContainText(
    "Kept on this computer and never shown again. Saving it first checks it with AssemblyAI, by a request that reads nothing of yours.",
  );
  await setLanguage(window, "zh-CN");
  await expect(row).toContainText(
    "保存在这台电脑上，不会再显示。保存时会先请 AssemblyAI 检查这个密钥，这次请求不会读取你的任何内容。",
  );
  await setLanguage(window, "en");

  settings = await showSettingsPage(window, "privacy");
  await settings.getByTestId("local-only").check();
  settings = await showSettingsPage(window, "meetings");
  row = settings.getByTestId("transcription-key-assemblyai");
  await expect(row).toContainText("Kept on this computer and never shown again.");
  await expect(row).not.toContainText("Saving it first checks it");
  await row.getByTestId("transcription-key-add").click();
  await row.getByTestId("transcription-key-input").fill("aai-test-key-0123456789");
  await row.getByTestId("transcription-key-save").click();
  await expect(row.getByTestId("transcription-key-saved")).toHaveText("Saved");
  const unchecked = row.getByTestId("provider-key-not-checked");
  await expect(unchecked).toHaveText("Saved, not checked: nothing was sent to AssemblyAI.");
  await shot(window, "transcription-key-local-mode-en");
  await setLanguage(window, "zh-CN");
  await expect(unchecked).toHaveText("已保存，未验证：没有向 AssemblyAI 发送任何内容。");
  await shot(window, "transcription-key-local-mode-zh");
});
