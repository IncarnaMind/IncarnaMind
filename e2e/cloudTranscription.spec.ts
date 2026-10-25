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
  useOutputLocation,
} from "./app";

/**
 * Cloud transcription with the User's own key (#141), with the pretend cloud service every smoke
 * test's fake transcriber has: it takes any key but one that says it's wrong, and here drops
 * the connection after a few seconds of audio. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const core = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return {
      settings: await bridge.getSettings(),
      meetings: await bridge.listMeetings(),
      flows: await bridge.listDataFlows(),
    };
  });

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

test("with a Soniox key, the first recording's sheet offers it under Other ways…; choosing it records, and the bar says when Soniox dropped", async () => {
  const { app, window } = await launchApp(dataDir, {
    transcriber: { cloud: { dropAfterMs: 4000 } },
  });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  await acceptPlainTextKeys(window);

  // Settings › Meetings: a Soniox key of its own, checked before it is kept.
  const settings = await openSettings(window, "meetings");
  const row = settings.getByTestId("transcription-key-soniox");
  await row.getByTestId("transcription-key-add").click();
  const input = row.getByTestId("transcription-key-input");
  await expect(input).toBeFocused();
  await input.fill("soniox-wrong-key");
  await input.press("Enter");
  await expect(row.getByTestId("transcription-key-problem")).toContainText(
    "Soniox didn’t accept this key.",
  );
  await input.fill("soniox-test-key");
  await row.getByTestId("transcription-key-save").click();
  await expect(row.getByTestId("transcription-key-saved")).toHaveText("Saved");
  // Offered, not chosen: this computer stays until the User picks, and the line says what a pick sends.
  const route = settings.getByTestId("meetings-route");
  await expect(route.locator("option:not([hidden])")).toHaveText(["On this computer", "Soniox"]);
  await expect(route).toHaveValue("");
  await expect(settings.getByTestId("meetings-route-line")).toHaveText(
    "A cloud service gets the meeting’s audio while you record.",
  );
  await shot(window, "settings-meetings-key-en");
  await closeSettings(window);

  // The first Start: one line for this computer, the cloud a quiet link away.
  const start = await recordMeeting(window);
  await start.getByTestId("meeting-start-record").click();
  const sheet = window.getByTestId("meeting-notice");
  await expect(sheet).toBeVisible();
  const line = sheet.getByTestId("meeting-route");
  await expect(line).toContainText("Transcribe on this computer");
  await expect(line).toContainText("Private and free");
  await expect(sheet.getByTestId("meeting-route-ways")).toHaveCount(0);
  await expect(sheet).toContainText("a 1 GB speech model downloads once");
  await shot(window, "route-line-en-1600");
  await line.getByTestId("meeting-route-other").click();
  const ways = sheet.getByTestId("meeting-route-ways");
  await expect(ways).toContainText("Soniox · your key");
  await expect(ways.getByTestId("meeting-route-use-soniox")).toBeFocused();
  await expect(ways).toContainText(
    "Choosing one sends the meeting’s audio to that service while you record.",
  );
  await shot(window, "route-other-ways-en-1600");

  // In Chinese, at the narrowest width, the same in Chinese, nothing cut.
  await setLanguage(window, "zh-CN");
  await expect(line).toContainText("在这台电脑上转写");
  await expect(ways).toContainText("Soniox · 你的密钥");
  await setWindowSize(app, window, 900, 720);
  const use = ways.getByTestId("meeting-route-use-soniox");
  const frame = await sheet.boundingBox();
  const button = await use.boundingBox();
  expect(frame && button && button.x + button.width <= frame.x + frame.width).toBe(true);
  await shot(window, "route-other-ways-zh-900");
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1600, 900);

  // Its own button is the consent, named for Soniox; the line then says where the audio goes.
  await use.click();
  await expect(line).toContainText("Transcribe with Soniox");
  await expect(line).toContainText("Audio goes to Soniox while you record");
  await expect(sheet).not.toContainText("speech model");
  const here = line.getByTestId("meeting-route-here");
  await expect(here).toHaveText("Use this computer");
  await expect(here).toBeFocused();
  // By keyboard, each button that goes hands focus to the one that takes its place.
  await window.keyboard.press("Enter");
  await expect(line.getByTestId("meeting-route-other")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(ways.getByTestId("meeting-route-use-soniox")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(here).toBeFocused();
  const chosen = await core(window);
  expect(chosen.settings.device.transcriptionRoute).toBe("soniox");
  expect(chosen.flows).toContainEqual(
    expect.objectContaining({
      flow: expect.objectContaining({
        id: "transcription",
        service: expect.objectContaining({ name: "Soniox" }),
      }),
      consent: "accepted",
    }),
  );
  await shot(window, "route-chosen-en-1600");
  await sheet.getByTestId("meeting-notice-start").click();
  await expect(sheet).toBeHidden();
  const bar = window.getByTestId("meeting-bar");
  await expect(bar).toHaveAttribute("data-status", "recording");

  // The pretend service drops: this computer takes over, recording goes on, and the bar says when.
  const dropped = bar.getByTestId("meeting-line-cloud");
  await expect(dropped).toContainText(
    /^Transcribing on this computer \(Soniox dropped at \d+:\d\d\)/,
    {
      timeout: 20_000,
    },
  );
  await expect(bar).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-bar-cloud-dropped-en");
  await setLanguage(window, "zh-CN");
  await expect(dropped).toContainText(/^正在这台电脑上转写（Soniox 在 \d+:\d\d 断开）/);
  await shot(window, "meeting-bar-cloud-dropped-zh");
});
