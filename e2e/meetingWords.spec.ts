import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import {
  acceptPlainTextKeys,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  openTranscriptBeside,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  startRecording,
} from "./app";

/** INCARNAMIND_SCREENSHOTS: a folder to also save screenshots in. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/**
 * Words to know in Settings › Meetings (#1031): names the transcriber on this computer is told at
 * each meeting's start, added, renamed in place and removed with Undo, in English and Chinese;
 * and the script Transcripts write Chinese in.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const settingsOf = (window: Page) =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings(),
  );

const rowNames = (section: Locator) => section.getByTestId("meeting-word-name");

async function addWord(window: Page, section: Locator, word: string): Promise<void> {
  const field = section.getByTestId("meeting-words-field");
  await pointAndClick(window, field);
  await window.keyboard.type(word);
  await window.keyboard.press("Enter");
  await expect(field).toHaveValue("");
}

test("Words to know: words are added at the top, renamed by double-click and F2, and removed with Undo, in English and Chinese", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const settings = await openSettings(window, "meetings");
  const section = settings.getByTestId("meeting-words");
  await expect(section.getByRole("heading", { name: "Words to know" })).toBeVisible();
  await expect(section.getByTestId("meeting-words-list")).toHaveCount(0);

  await addWord(window, section, "Lindqvist");
  const field = section.getByTestId("meeting-words-field");
  await pointAndClick(window, field);
  await window.keyboard.type("星河科技");
  await pointAndClick(window, section.getByTestId("meeting-words-add"));
  await expect(rowNames(section)).toHaveText(["星河科技", "Lindqvist"]);

  // A word already there, whatever its case, isn't added twice: it stays typed, to be changed.
  await pointAndClick(window, field);
  await window.keyboard.type("lindqvist");
  await window.keyboard.press("Enter");
  await expect(section.getByTestId("meeting-words-problem")).toHaveText(
    "“lindqvist” is in the list already.",
  );
  await expect(field).toHaveValue("lindqvist");
  await expect(rowNames(section)).toHaveText(["星河科技", "Lindqvist"]);
  await field.fill("");
  await expect(section.getByTestId("meeting-words-problem")).toHaveCount(0);

  // Renamed where it is: a double-click, Enter saves; F2, Esc keeps the name.
  await rowNames(section).nth(1).hover();
  await rowNames(section).nth(1).dblclick();
  const renaming = section.getByTestId("meeting-word-field");
  await expect(renaming).toBeFocused();
  await window.keyboard.type("Sofia Lindqvist");
  await window.keyboard.press("Enter");
  await expect(rowNames(section)).toHaveText(["星河科技", "Sofia Lindqvist"]);
  await expect(section.getByTestId("undo-message")).toHaveText(
    "Renamed “Lindqvist” to “Sofia Lindqvist”",
  );
  await rowNames(section).first().focus();
  await window.keyboard.press("F2");
  await expect(renaming).toBeFocused();
  await window.keyboard.type("星河科技集团");
  await window.keyboard.press("Escape");
  await expect(rowNames(section)).toHaveText(["星河科技", "Sofia Lindqvist"]);
  await rowNames(section).first().focus();
  await window.keyboard.press("F2");
  await window.keyboard.type("星河科技集团");
  await window.keyboard.press("Enter");
  await expect(rowNames(section)).toHaveText(["星河科技集团", "Sofia Lindqvist"]);
  expect((await settingsOf(window)).user.meetingWords).toEqual(["星河科技集团", "Sofia Lindqvist"]);

  // Removed at once, with Undo there, which puts it back where it was.
  const remove = section.getByRole("button", { name: "Remove “Sofia Lindqvist”" });
  await pointAndClick(window, remove);
  await expect(rowNames(section)).toHaveText(["星河科技集团"]);
  await expect(section.getByTestId("undo-message")).toHaveText(
    "Removed “Sofia Lindqvist” from Words to know",
  );
  await pointAndClick(window, section.getByTestId("undo-action"));
  await expect(rowNames(section)).toHaveText(["星河科技集团", "Sofia Lindqvist"]);
  // Delete on a focused word removes it too.
  await rowNames(section).nth(1).focus();
  await window.keyboard.press("Delete");
  await expect(rowNames(section)).toHaveText(["星河科技集团"]);
  await expect(rowNames(section).first()).toBeFocused();

  // In Chinese, the same list in Chinese words.
  await setLanguage(window, "zh-CN");
  await expect(section.getByRole("heading", { name: "要识别的词" })).toBeVisible();
  await addWord(window, section, "王丽");
  await expect(rowNames(section)).toHaveText(["王丽", "星河科技集团"]);
  await pointAndClick(window, section.getByRole("button", { name: "移除“星河科技集团”" }));
  await expect(section.getByTestId("undo-message")).toHaveText(
    "已从要识别的词中移除“星河科技集团”",
  );
  await expect(rowNames(section)).toHaveText(["王丽"]);
  await pointAndClick(window, section.getByTestId("undo-action"));
  await expect(rowNames(section)).toHaveText(["王丽", "星河科技集团"]);
  await rowNames(section).first().dblclick();
  await window.keyboard.type("王丽丽");
  await window.keyboard.press("Enter");
  await expect(rowNames(section)).toHaveText(["王丽丽", "星河科技集团"]);
  await expect(section.getByTestId("undo-message")).toHaveText("已将“王丽”重命名为“王丽丽”");

  // The script follows the interface, Simplified here, until another is chosen.
  const script = settings.getByTestId("meeting-script");
  await expect(script).toHaveValue("simplified");
  await expect(script.locator("option:checked")).toHaveText("简体");
  await script.selectOption("traditional");
  await expect.poll(async () => (await settingsOf(window)).chineseScript).toBe("traditional");
  await expect(script.locator("option:checked")).toHaveText("繁体");
});

test("⌘K opens Words to know with its field ready, and a word told there is written right in a meeting's Transcript", async () => {
  const { window } = await launchApp(dataDir, { transcriber: { mishears: { Dana: "Donna" } } });
  await dismissChatSetup(window);
  await runCommand(window, "settings.meetingWords", "Words to know");
  const section = window.getByTestId("meeting-words");
  await expect(section.getByTestId("meeting-words-field")).toBeFocused();
  await window.keyboard.type("Dana");
  await window.keyboard.press("Enter");
  await expect(section.getByTestId("meeting-word-name")).toHaveText(["Dana"]);
  await closeSettings(window);

  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await openTranscriptBeside(window, bar);
  const transcript = window.getByTestId("viewer-transcript");
  // The other side's third line names Dana, whom the engine hears as Donna unless told.
  await expect(transcript.getByText("Dana is joining us from the Leeds office.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(transcript.getByText(/Donna/)).toHaveCount(0);
});

/** The profile as one that chose Soniox before the words were sent: its consent names the audio alone. */
async function chooseSonioxBeforeWords(): Promise<void> {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await acceptPlainTextKeys(first.window);
  await first.window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
    await bridge.updateSettings({ device: { transcriptionRoute: "soniox" } });
  });
  await first.app.close();
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  db.run(
    `UPDATE data_flow_consents SET data_kinds = '["meeting-audio"]'
     WHERE flow = 'transcription' AND deleted_at IS NULL`,
  );
  db.close();
}

const AUDIO_ONLY_LINES = {
  en: {
    audio: "Audio goes to Soniox while you record.",
    paused: "Paused: “Keep everything on this computer” is on.",
    told: "Each meeting’s transcriber is told your name, your Words to know,",
    cloud: "A cloud service you transcribe with gets them with the audio.",
  },
  "zh-CN": {
    audio: "录音期间，音频会发送给 Soniox。",
    paused: "已暂停：已开启“所有内容都留在这台电脑上”。",
    told: "每场会议的转写会用到你的名字、要识别的词、",
    cloud: "用云服务转写时，这些词会随音频一起发送给该服务。",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`A route chosen before the words were sent: Local mode pauses its line in Settings › AI and Settings › Meetings, and turning it off brings the audio-only line back (${language})`, async () => {
    const said = AUDIO_ONLY_LINES[language];
    await chooseSonioxBeforeWords();
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1440, 900);
      const localMode = (on: boolean) =>
        window.evaluate(
          (value) =>
            (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(value),
          on,
        );
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const consent = settings
        .getByTestId("model-default-row-transcription")
        .getByTestId("meetings-route-consent");
      await expect(consent).toHaveText(said.audio);

      await localMode(true);
      await expect(consent).toHaveText(said.paused);
      await showSettingsPage(window, "meetings");
      const routeLine = settings.getByTestId("meetings-route-line");
      await expect(routeLine).toContainText(said.paused);
      await expect(routeLine).not.toContainText(said.audio);
      const words = settings.getByTestId("meeting-words");
      await expect(words).toContainText(said.told);
      await expect(words).not.toContainText(said.cloud);
      await expect(settings.getByTestId("meeting-words-waiting")).toHaveCount(0);
      await words.scrollIntoViewIfNeeded();
      await shot(window, `words-local-mode-${language}-1440`);

      await localMode(false);
      await expect(routeLine).toContainText(said.audio);
      await expect(routeLine).not.toContainText(said.paused);
      await expect(settings.getByTestId("meeting-words-waiting")).toBeVisible();
      await showSettingsPage(window, "ai");
      await expect(consent).toHaveText(said.audio);
      expect((await settingsOf(window)).device.transcriptionRoute).toBe("soniox");
    } finally {
      await app.close();
    }
  });
}

test("A route chosen before the words were sent says so under Words to know and on the Privacy row; Send sends them alone, in English and Chinese", async () => {
  await chooseSonioxBeforeWords();
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    let settings = await openSettings(window, "meetings");
    // While the words wait, the route's line says the audio goes alone, and the list is said once.
    const routeLine = settings.getByTestId("meetings-route-line");
    await expect(routeLine).toContainText("Audio goes to Soniox while you record.");
    await expect(routeLine).not.toContainText("your name");
    const waiting = settings.getByTestId("meeting-words-waiting");
    await expect(waiting).toContainText(
      "Soniox gets the audio but not these words: you chose it before they were sent. Send them, and with each meeting it also gets your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    );
    await expect(settings.getByTestId("meeting-words")).toContainText(
      "Each meeting’s transcriber is told your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    );
    await expect(settings.getByTestId("meeting-words")).not.toContainText(
      "A cloud service you transcribe with",
    );
    await waiting.scrollIntoViewIfNeeded();
    await shot(window, "words-waiting-en-1440");
    await setWindowSize(app, window, 900, 720);
    await waiting.scrollIntoViewIfNeeded();
    await shot(window, "words-waiting-en-900");

    await setLanguage(window, "zh-CN");
    await expect(routeLine).toContainText("录音期间，音频会发送给 Soniox。");
    await expect(routeLine).not.toContainText("你的名字");
    await expect(waiting).toContainText(
      "Soniox 目前只收到音频，没有收到这些词：你在开始发送这些词之前就选择了它。发送后，每场会议它还会收到你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
    );
    await expect(waiting.getByTestId("meeting-words-send")).toHaveText("发送给 Soniox");
    await waiting.scrollIntoViewIfNeeded();
    await shot(window, "words-waiting-zh-CN-900");
    await setWindowSize(app, window, 1440, 900);
    await waiting.scrollIntoViewIfNeeded();
    await shot(window, "words-waiting-zh-CN-1440");

    // The Privacy row says what isn't sent until the User allows it.
    settings = await showSettingsPage(window, "privacy");
    const row = settings.locator(
      '[data-testid="data-service"][data-service-id="https://stt-rt.soniox.com"]',
    );
    await expect(row.getByTestId("data-service-decision")).toContainText(
      "允许之后才会发送：你的名字、要识别的词、每场会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词",
    );
    await row.scrollIntoViewIfNeeded();
    await shot(window, "privacy-sends-more-zh-CN-1440");
    await setLanguage(window, "en");
    await expect(row.getByTestId("data-service-decision")).toContainText(
      "Not sent until you allow it: Your name, your Words to know, each meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents",
    );
    await row.scrollIntoViewIfNeeded();
    await shot(window, "privacy-sends-more-en-1440");
    await setWindowSize(app, window, 900, 720);
    await row.scrollIntoViewIfNeeded();
    await shot(window, "privacy-sends-more-en-900");
    await setWindowSize(app, window, 1440, 900);

    // Send allows the words alone: the line goes, the route stays, and the flow is allowed whole.
    settings = await showSettingsPage(window, "meetings");
    const send = settings.getByTestId("meeting-words-send");
    await expect(send).toHaveText("Send to Soniox");
    await pointAndClick(window, send);
    await expect(settings.getByTestId("meeting-words-waiting")).toHaveCount(0);
    await expect(settings.getByTestId("meeting-words-field")).toBeFocused();
    await expect(routeLine).toContainText(
      "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    );
    await expect(settings.getByTestId("meeting-words")).toContainText(
      "A cloud service you transcribe with gets them with the audio.",
    );
    await shot(window, "words-sent-en-1440");
    const after = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return { settings: await bridge.getSettings(), flows: await bridge.listDataFlows() };
    });
    expect(after.settings.device.transcriptionRoute).toBe("soniox");
    expect(after.flows.find((each) => each.flow.id === "transcription")).toMatchObject({
      consent: "accepted",
      flow: { sends: ["meeting-audio", "meeting-words"] },
    });

    // Deepgram's price with its key terms, as the cap counts it while the words go.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setTranscriptionKey({ route: "deepgram", apiKey: "deepgram-test-key" });
      await bridge.updateSettings({ device: { transcriptionRoute: "deepgram" } });
    });
    await expect(routeLine).toContainText("About $0.75 an hour");
    await shot(window, "words-deepgram-price-en-1440");
  } finally {
    await app.close();
  }
});
