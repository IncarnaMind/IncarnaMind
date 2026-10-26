import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge, MeetingTranscript } from "../src/core/api";
import {
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  emit,
  frontMindName,
  launchApp,
  leaveText,
  newMind,
  openSettings,
  paletteFound,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * "Record a meeting" is offered from the first run, with nothing to turn on, and
 * after the recording notice has been read it records in one action: in the
 * Folder of the Mind in view; while a Meeting records it opens that Meeting.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const core = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

const meetings = async (window: Page) =>
  (await core(window)).evaluate((bridge) => bridge.listMeetings());

const mindsOf = async (window: Page) =>
  (await core(window)).evaluate((bridge) => bridge.listMinds());

const readNotice = async (window: Page) =>
  (await core(window)).evaluate((bridge) =>
    bridge.updateSettings({ device: { meetingNoticeAccepted: true } }),
  );

const RECORD = { en: "Record a meeting", "zh-CN": "录制会议" } as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`Record a meeting is at the top level of the + menu and in ⌘K on a fresh data folder, and Settings › Meetings has no switch for it (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 720);
    await setLanguage(window, language);

    // At the top level, not folded under More, with nothing to switch on first (#763).
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await expect(window.getByTestId("plus-record-meeting")).toHaveText(RECORD[language]);
    await expect(window.getByTestId("plus-record-meeting")).toBeVisible();
    await window.keyboard.press("Escape");

    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(RECORD[language]);
    await expect(paletteFound(window).filter({ hasText: RECORD[language] })).toHaveCount(1);
    await window.keyboard.press("Escape");

    // Words people look for: "transcribe" and "call", 录音 and 转写.
    for (const word of language === "en" ? ["transcribe", "call"] : ["录音", "转写"]) {
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(word);
      await expect(paletteFound(window).filter({ hasText: RECORD[language] })).toHaveCount(1);
      await window.keyboard.press("Escape");
    }

    await setLanguage(window, "en");
    const settings = await openSettings(window, "meetings");
    await expect(settings.getByTestId("meetings-settings")).toContainText("What is recorded");
    await expect(settings.getByTestId("meetings-enabled")).toHaveCount(0);
    await closeSettings(window);
    await app.close();
  });
}

test("once the recording notice is read, Record records in one action, with the cursor in the notes", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await readNotice(window);

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-record-meeting"));
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
  await expect(window.getByTestId("meeting-start")).toHaveCount(0);
  expect((await meetings(window)).map((each) => each.status)).toEqual(["recording"]);
  expect(await mindsOf(window)).toHaveLength(1);

  await window.keyboard.type("First note");
  await expect(window.getByTestId("mind-editor")).toContainText("First note");
  await app.close();
});

test("the first time, Record makes a Mind with no line, and ⌘Z right after it doesn't take it back: Delete does", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-record-meeting"));
  await expect(window.getByTestId("meeting-start")).toBeVisible();
  expect(await mindsOf(window)).toHaveLength(1);

  await expect(window.getByTestId("undo-message")).toHaveCount(0);
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  expect(await mindsOf(window)).toHaveLength(1);
  await app.close();
});

test("a Record that has begun a recording says nothing, and ⌘Z right after it doesn't take the Mind back", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await readNotice(window);

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-record-meeting"));
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
  await expect(window.getByTestId("undo-message")).toHaveCount(0);

  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  expect(await mindsOf(window)).toHaveLength(1);
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
  await app.close();
});

for (const width of [900, 1100, 1440]) {
  test(`Record moves nothing on the new Mind's page, from the click to a settled bar, at ${width}px`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, width, 900);
    await dismissChatSetup(window);
    await readNotice(window);
    await window.evaluate(() => {
      const frames: { top: number; stage: string }[] = [];
      (globalThis as unknown as { frames: typeof frames }).frames = frames;
      const tick = () => {
        const editor = document.querySelector('[data-testid="mind-editor"]');
        const stage = document.querySelector('[data-testid="meeting-bar"]')
          ? "bar"
          : document.querySelector('[data-testid="meeting-bar-room"]')
            ? "room"
            : document.querySelector('[data-testid="meeting-start"]')
              ? "start"
              : "";
        if (editor && stage)
          frames.push({ top: Math.round(editor.getBoundingClientRect().top), stage });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-record-meeting"));
    await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
    await expect(window.getByTestId("meeting-bar-room")).toHaveCount(0);
    // The engine's "starting" line is done by now, or still hanging below the bar.
    await expect(window.getByTestId("meeting-transcript-line")).toHaveCount(0);

    const frames = await window.evaluate(
      () => (globalThis as unknown as { frames: { top: number; stage: string }[] }).frames,
    );
    expect(frames.some((frame) => frame.stage === "room")).toBe(true);
    expect(frames.filter((frame) => frame.stage === "start")).toEqual([]);
    const tops = frames.map((frame) => frame.top);
    expect(Math.max(...tops) - Math.min(...tops), JSON.stringify(frames)).toBeLessThanOrEqual(1);
    await app.close();
  });
}

const SPEECH_MODEL_FAILURE =
  "Couldn’t reach huggingface.co: getaddrinfo ENOTFOUND huggingface.co, and the proxy at proxy.corp.example.invalid:8080 refused the connection.";

for (const language of ["en", "zh-CN"] as const) {
  test(`a status line hangs on the bar's own surface, and a speech-model problem keeps a row of the bar, whole and clear of the notes, at 1100px (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await readNotice(window);
      await pointAndClick(window, window.getByTestId("plus-menu"));
      await pointAndClick(window, window.getByTestId("plus-record-meeting"));
      const bar = window.getByTestId("meeting-bar");
      await expect(bar).toHaveAttribute("data-status", "recording");
      // Paused, so no event of the engine's replaces what the test shows.
      await pointAndClick(window, window.getByTestId("meeting-pause"));
      await expect(bar).toHaveAttribute("data-status", "paused");

      const [meeting] = await meetings(window);
      const show = (transcript: Partial<MeetingTranscript>) =>
        emit(app, "meetings.changed", [
          {
            ...meeting,
            transcript: {
              documentId: null,
              state: "preparing",
              lines: 0,
              partial: null,
              model: null,
              cloud: null,
              fellBack: null,
              savedPath: null,
              problem: null,
              ...transcript,
            },
          },
        ]);
      const line = window.getByTestId("meeting-transcript-line");

      await show({});
      await expect(line).toHaveClass(/meeting-line-over/);
      const surfaces = await line.evaluate((element) => ({
        line: getComputedStyle(element).backgroundColor,
        bar: getComputedStyle(element.closest('[data-testid="meeting-bar"]') ?? element)
          .backgroundColor,
      }));
      expect(surfaces.bar).not.toBe("rgba(0, 0, 0, 0)");
      expect(surfaces.line).toBe(surfaces.bar);

      await show({ problem: { kind: "download", message: SPEECH_MODEL_FAILURE } });
      await expect(line).toContainText(SPEECH_MODEL_FAILURE);
      await expect(line).not.toHaveClass(/meeting-line-over/);
      const retry = line.getByTestId("meeting-transcript-retry");
      await expect(retry).toBeVisible();
      const place = await line.evaluate((element) => {
        const rect = (target: Element | null) => target?.getBoundingClientRect();
        return {
          clipped:
            element.scrollWidth > element.clientWidth ||
            element.scrollHeight > element.clientHeight,
          bar: rect(element.closest('[data-testid="meeting-bar"]')),
          retry: rect(element.querySelector('[data-testid="meeting-transcript-retry"]')),
          notes: rect(document.querySelector('[data-testid="mind-editor"]')),
        };
      });
      expect(place.clipped).toBe(false);
      expect(place.retry?.bottom).toBeLessThanOrEqual(place.bar?.bottom ?? 0);
      expect(place.retry?.right).toBeLessThanOrEqual(place.bar?.right ?? 0);
      expect(place.bar?.bottom).toBeLessThanOrEqual(place.notes?.top ?? 0);
    } finally {
      await app.close();
    }
  });
}

test("once a recording has run and stopped, ⌘Z never takes its Meeting or audio back", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await readNotice(window);

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-record-meeting"));
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
  await pointAndClick(window, window.getByTestId("meeting-stop"));
  await expect
    .poll(async () => (await meetings(window))[0]?.status, { timeout: 30_000 })
    .toBe("stopped");
  const [stopped] = await meetings(window);

  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await window.keyboard.press("ControlOrMeta+z");
  // The core answers in the order it was asked: a deletion Undo had sent would show here.
  const after = await meetings(window);
  expect(after.map((each) => each.id)).toEqual([stopped?.id]);
  expect(after[0]?.status).toBe("stopped");
  expect(after[0]?.audio.kept).toBe(stopped?.audio.kept);
  expect(await mindsOf(window)).toHaveLength(1);
  await app.close();
});

test("Record from ⌘K records in the Folder of the Mind in view", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await readNotice(window);
  const folder = await (await core(window)).evaluate((bridge) =>
    bridge.createLibraryGroup({ name: "Clients", description: "Client calls." }),
  );
  await (await core(window)).evaluate(
    (bridge, folderId) => bridge.createMind({ title: "Brief", folderId }),
    folder.id,
  );
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Brief");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Brief" }).first(),
  );
  await expect(frontMindName(window)).toHaveText("Brief");

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Record a meeting");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
  const [recording] = await meetings(window);
  const made = (await mindsOf(window)).find((mind) => mind.id === recording?.mindId);
  expect(made?.folderId).toBe(folder.id);
  await app.close();
});

test("Record while a Meeting records opens that Meeting and makes nothing", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await readNotice(window);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-record-meeting"));
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
  const [recording] = await meetings(window);
  const recordingName = await frontMindName(window).textContent();

  await newMind(window);
  await expect(frontMindName(window)).not.toHaveText(recordingName ?? "");
  const before = (await mindsOf(window)).length;

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-record-meeting"));
  await expect(frontMindName(window)).toHaveText(recordingName ?? "");
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
  expect(await mindsOf(window)).toHaveLength(before);
  expect((await meetings(window)).map((each) => each.id)).toEqual([recording?.id]);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`on a copy that can't record audio, Record says so in one line, with the way on (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { noAudioEngine: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    const line = {
      en: "This copy of IncarnaMind can’t record audio.",
      "zh-CN": "这个版本的 IncarnaMind 无法录制音频。",
    }[language];

    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-record-meeting"));
    const problem = window.getByTestId("cant-record");
    await expect(problem).toContainText(line);
    expect(await mindsOf(window)).toHaveLength(0);

    await pointAndClick(window, problem.getByTestId("cant-record-notes"));
    await expect(problem).toHaveCount(0);
    await expect.poll(async () => (await mindsOf(window)).length).toBe(1);
    expect(await meetings(window)).toEqual([]);
    await app.close();
  });
}
