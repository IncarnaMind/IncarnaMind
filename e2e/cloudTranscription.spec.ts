import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  openMeetingSheet,
  openSettings,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  stopMeeting,
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

test("with a Soniox key and nothing chosen, the first recording starts at once on this computer and sends Soniox nothing; chosen in Settings › AI, Soniox records the next, and the sheet says when it dropped", async () => {
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

  // The first recording of a User who never chose starts at once (#3762), on this computer, and
  // says so over its control: no service is picked and no consent given by recording.
  const accepted = expect.objectContaining({
    flow: expect.objectContaining({
      id: "transcription",
      service: expect.objectContaining({ name: "Soniox" }),
    }),
    consent: "accepted",
  });
  await recordMeeting(window);
  const tip = window.getByTestId("meeting-foot-tip");
  await expect(tip).toHaveText("Transcribing on this computer. The Transcript opens here.");
  await setLanguage(window, "zh-CN");
  await expect(tip).toHaveText("正在这台电脑上转写。转写稿在这里打开。");
  await setLanguage(window, "en");
  await firstTranscriptLine(window);
  const first = await core(window);
  expect(first.settings.device.transcriptionRoute).toBeNull();
  expect(first.flows).not.toContainEqual(accepted);
  expect(first.meetings[0]?.transcript?.cloud ?? null).toBeNull();
  await shot(window, "route-first-recording-en-1600");
  await stopMeeting(window);
  const firstTab = window.getByTestId("mind-tab").filter({ hasText: "Meeting" });
  await firstTab.hover();
  await firstTab.getByTestId("tab-close").click();
  await expect(firstTab).toHaveCount(0);

  // Settings › AI says what choosing a cloud service sends; choosing Soniox there is the consent,
  // and then it says where the audio goes, in Chinese too, at the narrowest width, nothing cut.
  const ai = await openSettings(window, "ai");
  const consent = ai.getByTestId("meetings-route-consent");
  await expect(consent).toContainText(
    "Once you choose a cloud service, it gets the meeting’s audio while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
  );
  await ai.getByTestId("meetings-route").selectOption("soniox");
  await expect(consent).toContainText(
    "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
  );
  await expect.poll(async () => (await core(window)).flows).toContainEqual(accepted);
  expect((await core(window)).settings.device.transcriptionRoute).toBe("soniox");
  await shot(window, "route-chosen-en-1600");
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await expect(consent).toContainText("录音期间，音频会发送给 Soniox");
  const frame = await ai.boundingBox();
  const said = await consent.boundingBox();
  expect(frame && said && said.x + said.width <= frame.x + frame.width).toBe(true);
  await shot(window, "route-chosen-zh-900");
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1600, 900);
  await closeSettings(window);

  // The next recording goes to Soniox, and nothing over its control says this computer. The
  // pretend service drops: this computer takes over, recording goes on, and the sheet says when.
  const control = await recordMeeting(window);
  await expect
    .poll(
      async () =>
        (await core(window)).meetings.find((each) => each.status !== "stopped")?.transcript?.cloud,
    )
    .toBe("soniox");
  await expect(tip.filter({ hasText: "on this computer" })).toHaveCount(0);
  const sheet = await openMeetingSheet(window);
  const dropped = sheet.getByTestId("meeting-line-cloud");
  await expect(dropped).toContainText(
    /^Transcribing on this computer \(Soniox dropped at \d+:\d\d\)/,
    {
      timeout: 20_000,
    },
  );
  await expect(control).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-sheet-cloud-dropped-en");
  await setLanguage(window, "zh-CN");
  await expect(dropped).toContainText(/^正在这台电脑上转写（Soniox 在 \d+:\d\d 断开）/);
  await setWindowSize(app, window, 900, 720);
  const sheetBox = await sheet.boundingBox();
  const droppedBox = await dropped.boundingBox();
  expect(
    sheetBox && droppedBox && droppedBox.x + droppedBox.width <= sheetBox.x + sheetBox.width,
  ).toBe(true);
  await shot(window, "meeting-sheet-cloud-dropped-zh");
});

test("with the Qwen key from Models and nothing chosen, the first recording sends Qwen nothing; choosing Qwen says what Alibaba Cloud's agreement says, and a key the service turns away is one problem in the sheet", async () => {
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

  // The first recording starts at once on this computer (#3762): the key from Models is used for
  // nothing more, and Alibaba Cloud gets no audio and no consent.
  const qwenAccepted = expect.objectContaining({
    flow: expect.objectContaining({
      id: "transcription",
      service: expect.objectContaining({ id: "https://dashscope.aliyuncs.com" }),
    }),
    consent: "accepted",
  });
  await recordMeeting(window);
  await firstTranscriptLine(window);
  const first = await core(window);
  expect(first.settings.device.transcriptionRoute).toBeNull();
  expect(first.flows).not.toContainEqual(qwenAccepted);
  expect(first.meetings[0]?.transcript?.cloud ?? null).toBeNull();
  await stopMeeting(window);
  const firstTab = window.getByTestId("mind-tab").filter({ hasText: "Meeting" });
  await firstTab.hover();
  await firstTab.getByTestId("tab-close").click();
  await expect(firstTab).toHaveCount(0);

  // Settings › AI offers Qwen on that key; choosing it is the consent, for the service at the
  // key's region, and says what Alibaba Cloud's agreement says.
  const ai = await openSettings(window, "ai");
  const picker = ai.getByTestId("meetings-route");
  await expect(picker.locator(OFFERED)).toHaveText(["Qwen", "On this computer"]);
  await expect(picker).toHaveValue("local");
  await picker.selectOption("qwen");
  const sends = ai.getByTestId("meetings-route-consent");
  await expect(sends).toContainText(
    "Audio goes to Alibaba Cloud while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
  );
  await expect(sends).toContainText("isn’t used for model training or optimization");
  await expect(sends.getByRole("link", { name: "Agreement" })).toHaveAttribute(
    "href",
    "https://docs.agent.bailian.aliyun.com/en/resources/agreements",
  );
  await expect.poll(async () => (await core(window)).flows).toContainEqual(qwenAccepted);
  expect((await core(window)).settings.device.transcriptionRoute).toBe("qwen");
  await shot(window, "route-qwen-chosen-en-1600");

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await expect(sends).toContainText(
    "录音期间，音频会发送给阿里云，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
  );
  await expect(sends.getByRole("link", { name: "协议" })).toHaveAttribute(
    "href",
    "https://docs.agent.bailian.aliyun.com/zh/resources/agreements",
  );
  const frame = await ai.boundingBox();
  const line = await sends.boundingBox();
  expect(frame && line && line.x + line.width <= frame.x + frame.width).toBe(true);
  await shot(window, "route-qwen-chosen-zh-900");
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1600, 900);
  await closeSettings(window);

  // The next recording goes to Qwen, which turns the key away: one line in the sheet.
  const control = await recordMeeting(window);
  const sheet = await openMeetingSheet(window);
  const refused = sheet.getByTestId("meeting-line-cloud");
  await expect(refused).toContainText(
    "Qwen refused the key (wrong, expired or another region). Transcribing on this computer.",
    { timeout: 20_000 },
  );
  await expect(control).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-sheet-qwen-refused-en");
  await setLanguage(window, "zh-CN");
  await expect(refused).toContainText(
    "通义千问拒绝了这个密钥（有误、已过期或属于其他区域）。正在这台电脑上转写。",
  );
  await shot(window, "meeting-sheet-qwen-refused-zh");
  await refused.getByTestId("meeting-line-change-key").click();
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
