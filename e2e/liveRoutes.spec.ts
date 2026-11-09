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
 * fake transcriber has: Deepgram's server kept with its key in Settings › AI, and an
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

test("Deepgram's row in Your providers names the server it sends to; Change key opens with it, and Esc keeps it", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async (server) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setTranscriptionKey({
      route: "deepgram",
      apiKey: "cf-test-token-0123456789",
      server,
    });
  }, CLOUDFLARE);

  // Choosing Deepgram in Settings › AI sends the audio to Cloudflare, as Meetings' line says.
  let settings = await openSettings(window, "ai");
  const route = settings.getByTestId("meetings-route");
  await expect(route.locator("option:not([hidden]):not([value^='set-up:'])")).toHaveText([
    "Deepgram",
    "On this computer",
  ]);
  await route.selectOption("deepgram");
  await expect(route).toHaveValue("deepgram");
  settings = await showSettingsPage(window, "meetings");
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

  settings = await showSettingsPage(window, "ai");
  const row = settings.locator('[data-testid="transcription-key-row"][data-host="deepgram"]');
  const status = row.getByTestId("transcription-key-status");
  await expect(status).toHaveText(
    "Your key · Used for meeting transcription · sent to wss://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
  );

  // In Chinese, at the narrowest width, the address wraps inside its row, whole in its tooltip too.
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await expect(status).toContainText("用于会议转写 · 发送到 wss://api.cloudflare.com");
  await expect(status).toHaveAttribute("title", /nova-3$/);
  const box = await row.boundingBox();
  const text = await status.boundingBox();
  const change = await row.getByTestId("transcription-key-change").boundingBox();
  expect(text && change && text.x + text.width <= change.x).toBe(true);
  expect(box && change && change.x + change.width <= box.x + box.width).toBe(true);
  await shot(window, "settings-models-deepgram-cloudflare-zh-900");
  settings = await showSettingsPage(window, "meetings");
  await expect(line).toContainText("录音期间，音频会发送给 Cloudflare。");
  await setLanguage(window, "en");

  // Change key opens with the server saved; Esc closes the form and keeps what was saved.
  await showSettingsPage(window, "ai");
  await row.getByTestId("transcription-key-change").click();
  await expect(row.getByTestId("transcription-key-input")).toBeFocused();
  await expect(row.getByRole("textbox", { name: "Server" })).toHaveValue(
    "wss://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
  );
  await expect(row).not.toContainText("Saving it first checks it");
  await row.getByTestId("transcription-key-input").press("Escape");
  await expect(row.getByTestId("transcription-key-input")).toHaveCount(0);
  await expect(status).toContainText("sent to wss://api.cloudflare.com");
  await closeSettings(window);
});

test("an AssemblyAI account out of credit is one line in the bar with Add credit, and recording goes on on this computer", async () => {
  const { app, window } = await launchApp(dataDir, { transcriber: { cloud: { noCredit: true } } });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  await acceptPlainTextKeys(window);

  // AssemblyAI set up from Meeting transcription's picker: Use this keeps the key and chooses it.
  let settings = await openSettings(window, "ai");
  await settings.getByTestId("meetings-route").selectOption("set-up:assemblyai");
  const form = settings.getByTestId("transcription-key-form-assemblyai");
  await expect(form.getByRole("textbox", { name: "Server" })).toHaveCount(0);
  await form.getByTestId("transcription-key-input").fill("aai-test-key-0123456789");
  await form.getByTestId("transcription-key-save").click();
  await expect(form).toHaveCount(0);
  await expect(settings.getByTestId("meetings-route")).toHaveValue("assemblyai");
  settings = await showSettingsPage(window, "meetings");
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

test("each service set up from the picker says whether Save checks its key; Gladia, which can't be checked, chosen names what it does with the audio", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);

  let settings = await openSettings(window, "ai");
  const row = settings.getByTestId("model-default-row-transcription");
  const picker = row.getByTestId("meetings-route");
  for (const name of ["ElevenLabs", "Speechmatics", "AssemblyAI"]) {
    await picker.selectOption(`set-up:${name.toLowerCase()}`);
    const form = row.getByTestId(`transcription-key-form-${name.toLowerCase()}`);
    await expect(form.getByTestId("transcription-key-kept")).toHaveText(
      `Kept on this computer and never shown again. Saving it first checks it with ${name}, by a request that reads nothing of yours. Get a key ↗`,
    );
    await form.getByTestId("transcription-key-cancel").click();
    await expect(form).toHaveCount(0);
    await expect(picker).toBeFocused();
  }
  await setLanguage(window, "zh-CN");
  await picker.selectOption("set-up:assemblyai");
  await expect(row.getByTestId("transcription-key-kept")).toContainText(
    "保存在这台电脑上，不会再显示。保存时会先请 AssemblyAI 检查这个密钥，这次请求不会读取你的任何内容。",
  );
  await row.getByTestId("transcription-key-cancel").click();
  await setLanguage(window, "en");

  await picker.selectOption("set-up:gladia");
  const form = row.getByTestId("transcription-key-form-gladia");
  await expect(form.getByTestId("transcription-key-kept")).toHaveText(
    "Kept on this computer and never shown again. Get a key ↗",
  );
  await expect(form.getByRole("textbox", { name: "Server" })).toHaveCount(0);
  await form.getByTestId("transcription-key-input").fill("gladia-test-key-0123456789");
  await form.getByTestId("transcription-key-save").click();
  await expect(form).toHaveCount(0);
  await expect(picker).toHaveValue("gladia");
  const chosen = await settingsNow(window);
  expect(chosen.flows).toContainEqual(
    expect.objectContaining({
      flow: expect.objectContaining({
        id: "transcription",
        service: expect.objectContaining({ id: "https://api.gladia.io" }),
      }),
      consent: "accepted",
    }),
  );

  settings = await showSettingsPage(window, "meetings");
  const meetings = settings.getByTestId("meetings-settings");
  const line = meetings.getByTestId("meetings-route-line");
  await expect(line).toContainText("Audio goes to Gladia while you record.");
  await expect(line).toContainText(
    "Gladia trains its models on the audio unless you opt out in your account",
  );
  await line.scrollIntoViewIfNeeded();
  await shot(window, "after-settings-meetings-gladia-line-en-1600");

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await expect(line).toContainText("录音期间，音频会发送给 Gladia。");
  await expect(line).toContainText("除非你在 Gladia 账户中选择退出，否则它会用音频训练模型");
  const box = await meetings.boundingBox();
  const text = await line.boundingBox();
  expect(box && text && text.x + text.width <= box.x + box.width).toBe(true);
  await line.scrollIntoViewIfNeeded();
  await shot(window, "after-settings-meetings-gladia-line-zh-900");
});
