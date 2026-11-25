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

/** The services a route picker offers, without its "Set up…" rows. */
const OFFERED = "option:not([hidden]):not([value^='set-up:'])";

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

test("with a Soniox key and nothing chosen, the first recording's sheet picks Soniox and Start is the consent; it records, and the bar says when Soniox dropped", async () => {
  const { app, window } = await launchApp(dataDir, {
    transcriber: { cloud: { dropAfterMs: 4000 } },
  });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  await acceptPlainTextKeys(window);

  // A Soniox key of its own, kept in Your providers (e2e/transcriptionKeys.spec.ts sets one up
  // from the pickers). Offered, not chosen: this computer stays until the User picks, and the
  // line stays this computer's.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
  });
  const settings = await openSettings(window, "ai");
  const route = settings.getByTestId("meetings-route");
  await expect(route.locator(OFFERED)).toHaveText(["Soniox", "On this computer"]);
  await expect(route).toHaveValue("local");
  const meetings = await showSettingsPage(window, "meetings");
  await expect(meetings.getByTestId("meetings-route-line")).toHaveText("Private and free");
  await shot(window, "settings-meetings-key-en");
  await closeSettings(window);

  // The first Start of a User who never chose (#3305): a cloud service first and already picked,
  // on the key they have, with where the audio goes; this computer is the other choice.
  const start = await recordMeeting(window);
  await start.getByTestId("meeting-start-record").click();
  const sheet = window.getByTestId("meeting-notice");
  await expect(sheet).toBeVisible();
  const choices = sheet.getByTestId("setup-transcription");
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toContainText("A cloud service");
  await expect(choices.first().locator("input")).toBeChecked();
  await expect(choices.last()).toContainText("On this computer");
  await expect(sheet.getByTestId("setup-transcription-service")).toHaveValue("soniox");
  await expect(sheet.getByTestId("setup-transcription-works")).toHaveText("Soniox key works");
  const sends = sheet.getByTestId("setup-transcription-sends");
  await expect(sends).toContainText(
    "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
  );
  await expect(sheet).not.toContainText("Transcribed on this computer");
  const begin = sheet.getByTestId("meeting-notice-start");
  await expect(begin).toHaveText("Start recording");
  await expect(begin).toBeEnabled();
  // Picked, not chosen: nothing is kept and no consent is given before Start.
  const accepted = expect.objectContaining({
    flow: expect.objectContaining({
      id: "transcription",
      service: expect.objectContaining({ name: "Soniox" }),
    }),
    consent: "accepted",
  });
  const before = await core(window);
  expect(before.settings.device.transcriptionRoute).toBeNull();
  expect(before.flows).not.toContainEqual(accepted);
  await shot(window, "route-first-en-1600");

  // In Chinese, at the narrowest width, the same in Chinese, nothing cut.
  await setLanguage(window, "zh-CN");
  await expect(choices.first()).toContainText("云端服务");
  await expect(sheet.getByTestId("setup-transcription-works")).toHaveText("Soniox 密钥可以使用了");
  await setWindowSize(app, window, 900, 720);
  const frame = await sheet.boundingBox();
  const line = await sends.boundingBox();
  expect(frame && line && line.x + line.width <= frame.x + frame.width).toBe(true);
  await shot(window, "route-first-zh-900");
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1600, 900);

  // This computer is one press away and says so. Back on the cloud service, Start is the consent.
  await choices.last().locator("input").check();
  await expect(sheet).toContainText("Transcribed on this computer");
  await expect(sheet.getByTestId("setup-cloud")).toHaveCount(0);
  await choices.first().locator("input").check();
  await expect(sheet).not.toContainText("Transcribed on this computer");
  await begin.click();
  await expect(sheet).toBeHidden();
  const chosen = await core(window);
  expect(chosen.settings.device.transcriptionRoute).toBe("soniox");
  expect(chosen.flows).toContainEqual(accepted);
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

test("with the Qwen key from Models and nothing chosen, the sheet picks Qwen and says what Alibaba Cloud's agreement says; a key the service turns away is one problem in the bar", async () => {
  const { app, window } = await launchApp(dataDir, { transcriber: { cloud: { refuse: true } } });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "qwen",
      apiKey: "sk-qwen-test",
      modelId: "qwen3.7-plus",
    });
  });

  const start = await recordMeeting(window);
  await start.getByTestId("meeting-start-record").click();
  const sheet = window.getByTestId("meeting-notice");
  const choices = sheet.getByTestId("setup-transcription");
  await expect(choices.first()).toContainText("Uses the key you already added");
  await expect(choices.first().locator("input")).toBeChecked();
  await expect(sheet.getByTestId("setup-transcription-service")).toHaveCount(0);
  await expect(sheet.getByTestId("setup-transcription-works")).toContainText("Qwen");
  const sends = sheet.getByTestId("setup-transcription-sends");
  await expect(sends).toContainText(
    "Audio goes to Alibaba Cloud while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
  );
  await expect(sends).toContainText("isn’t used for model training or optimization");
  await expect(sends.getByRole("link", { name: "Agreement" })).toHaveAttribute(
    "href",
    "https://docs.agent.bailian.aliyun.com/en/resources/agreements",
  );
  await shot(window, "route-qwen-first-en-1600");

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await expect(sends).toContainText(
    "录音期间，音频会发送给阿里云，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
  );
  await expect(sends.getByRole("link", { name: "协议" })).toHaveAttribute(
    "href",
    "https://docs.agent.bailian.aliyun.com/zh/resources/agreements",
  );
  const frame = await sheet.boundingBox();
  const line = await sends.boundingBox();
  expect(frame && line && line.x + line.width <= frame.x + frame.width).toBe(true);
  await shot(window, "route-qwen-first-zh-900");
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1600, 900);

  // Start is the consent, for the service at the key's region; the pretend service turns the key away.
  await sheet.getByTestId("meeting-notice-start").click();
  await expect(sheet).toBeHidden();
  const chosen = await core(window);
  expect(chosen.settings.device.transcriptionRoute).toBe("qwen");
  expect(chosen.flows).toContainEqual(
    expect.objectContaining({
      flow: expect.objectContaining({
        id: "transcription",
        service: expect.objectContaining({ id: "https://dashscope.aliyuncs.com" }),
      }),
      consent: "accepted",
    }),
  );
  const bar = window.getByTestId("meeting-bar");
  const refused = bar.getByTestId("meeting-line-cloud");
  await expect(refused).toContainText(
    "Qwen refused the key (wrong, expired or another region). Transcribing on this computer.",
    { timeout: 20_000 },
  );
  await expect(bar).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-bar-qwen-refused-en");
  await setLanguage(window, "zh-CN");
  await expect(refused).toContainText(
    "通义千问拒绝了这个密钥（有误、已过期或属于其他区域）。正在这台电脑上转写。",
  );
  await shot(window, "meeting-bar-qwen-refused-zh");
  await bar.getByTestId("meeting-line-change-key").click();
  await expect(window.getByTestId("settings")).toBeVisible();
});

test("Settings › Meetings' line describes the route chosen in Settings › AI: this computer's line with cloud keys saved and in Local mode, a cloud service's line once chosen (#2661)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);

    // No key saved: this computer, and its own line, in both languages.
    let settings = await openSettings(window, "meetings");
    let line = settings.getByTestId("meetings-route-line");
    await expect(line).toHaveText("Private and free");
    await setLanguage(window, "zh-CN");
    await expect(line).toHaveText("私密、免费");
    await setLanguage(window, "en");
    await closeSettings(window);

    // With a cloud key saved this computer is still chosen, and the line still describes this computer.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
    });
    settings = await openSettings(window, "ai");
    const route = settings.getByTestId("meetings-route");
    await expect(route.locator(OFFERED)).toHaveText(["Soniox", "On this computer"]);
    await expect(route).toHaveValue("local");
    line = (await showSettingsPage(window, "meetings")).getByTestId("meetings-route-line");
    await expect(line).toHaveText("Private and free");
    await shot(window, "route-line-key-saved-en-1600");
    await setWindowSize(app, window, 900, 720);
    await shot(window, "route-line-key-saved-en-900");
    await setWindowSize(app, window, 1600, 900);

    // Choosing the cloud service shows where the audio goes, and back is this computer's line.
    const choose = async (value: string) => {
      await (await showSettingsPage(window, "ai"))
        .getByTestId("meetings-route")
        .selectOption(value);
      return (await showSettingsPage(window, "meetings")).getByTestId("meetings-route-line");
    };
    line = await choose("soniox");
    await expect(line).toContainText(
      "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    );
    await shot(window, "route-line-cloud-en-1600");
    await setLanguage(window, "zh-CN");
    line = await choose("local");
    await expect(line).toHaveText("私密、免费");
    await shot(window, "route-line-key-saved-zh-1600");
    await setWindowSize(app, window, 900, 720);
    await shot(window, "route-line-key-saved-zh-900");
    line = await choose("soniox");
    await expect(line).toContainText(
      "录音期间，音频会发送给 Soniox，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
    );
    await shot(window, "route-line-cloud-zh-900");
    await setWindowSize(app, window, 1600, 900);

    // Local mode, with the key saved: this computer's line again, in both languages.
    await setLanguage(window, "en");
    await choose("local");
    await (await showSettingsPage(window, "ai")).getByTestId("local-only").check();
    settings = await showSettingsPage(window, "meetings");
    await expect(settings.getByTestId("meetings-route-line")).toHaveText("Private and free");
    await shot(window, "route-line-local-mode-en-1600");
    await setWindowSize(app, window, 900, 720);
    await setLanguage(window, "zh-CN");
    await expect(settings.getByTestId("meetings-route-line")).toHaveText("私密、免费");
    await shot(window, "route-line-local-mode-zh-900");
  } finally {
    await app.close();
  }
});
