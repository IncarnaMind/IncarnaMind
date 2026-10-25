import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { listedGaps, readVtt } from "../src/core/documents/formats/vtt";
import type { FakeCapture } from "../src/core/meetings/fakeCapture";
import {
  createDataFolder,
  dismissChatSetup,
  expectBarOneRow,
  focusMainWindow,
  heldGlobalKeys,
  launchApp,
  panelOf,
  panelOpen,
  pointAndClick,
  pressHeldKeys,
  recordMeeting,
  recordMeetingNow,
  removeDataFolder,
  setLanguage,
  setMeetingKeys,
  setWindowSize,
  startRecording,
  tabTo,
} from "./app";

/**
 * Pause my mic (#1003), with the fake capture and transcriber every smoke test gets: the
 * microphone makes a tone that the transcriber reads as "Me", the computer's sound a quieter one
 * it reads as "Them". Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(page: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const mac = process.platform === "darwin";
const MIC_KEYS = "Ctrl+Alt+M";
const PANEL_KEYS = "Ctrl+Alt+H";
const MIC_LABEL = mac ? "⌃⌥M" : "Ctrl+Alt+M";
const CHECKLIST_KEYS = mac ? "Cmd+Shift+9" : "Ctrl+Shift+9";
const CHECKLIST_LABEL = mac ? "⇧⌘9" : "Ctrl+Shift+9";

/** Lines come every couple of seconds of sound, a few seconds behind it. */
const LINES_WITHIN = { timeout: 30_000 };

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const capture = (app: ElectronApplication) =>
  app.evaluate(() => {
    const fake = (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio;
    if (!fake) throw new Error("The app isn't recording with the fake capture.");
    return { running: fake.running, microphoneOn: fake.microphoneOn };
  });

const mainNow = (app: ElectronApplication) => app.evaluate(() => Date.now());

const sentBetween = (app: ElectronApplication, from: number, to: number) =>
  app.evaluate(
    (_electron, [after, before]) => {
      const sent = (globalThis as { incarnamindTranscribed?: { stream: string; at: number }[] })
        .incarnamindTranscribed;
      if (!sent) throw new Error("The app isn't transcribing with the fake transcriber.");
      const within = sent.filter((each) => each.at > after && each.at < before);
      return {
        microphone: within.filter((each) => /:microphone(:\d+)?$/.test(each.stream)).length,
        system: within.filter((each) => each.stream.endsWith(":system")).length,
      };
    },
    [from, to] as const,
  );

// Waits until some of the computer's sound has gone too, so audio was flowing while it counted.
async function sentSince(app: ElectronApplication, from: number) {
  let sent = { microphone: 0, system: 0 };
  await expect
    .poll(async () => {
      sent = await sentBetween(app, from, await mainNow(app));
      return sent.system;
    })
    .toBeGreaterThan(0);
  return sent;
}

async function recordingMeeting(window: Page): Promise<Locator> {
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
  return bar;
}

async function fromPalette(window: Page, name: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(name);
  await expect(window.getByTestId("palette-item").filter({ hasText: name }).first()).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("palette-search")).toBeHidden();
}

/**
 * How long after the next click or key the button read `pressed`, measured in the page so the
 * test's own round trips don't add to it.
 */
async function pressedAfter(
  window: Page,
  testId: string,
  pressed: boolean,
  act: () => Promise<void>,
): Promise<number> {
  // Listening before acting: the click can reach the page before a listener installed with it.
  await window.evaluate(
    ([id, expected]) => {
      (globalThis as { pressedAfter?: Promise<number> }).pressedAfter = new Promise<number>(
        (resolve) => {
          let from: number | null = null;
          const start = (event: Event) => {
            from ??= event.timeStamp;
          };
          document.addEventListener("click", start, true);
          document.addEventListener("keydown", start, true);
          const watch = new MutationObserver(() => {
            const button = document.querySelector(`[data-testid="${id}"]`);
            if (from === null || button?.getAttribute("aria-pressed") !== String(expected)) return;
            watch.disconnect();
            document.removeEventListener("click", start, true);
            document.removeEventListener("keydown", start, true);
            resolve(performance.now() - from);
          });
          watch.observe(document.body, { attributes: true, childList: true, subtree: true });
        },
      );
    },
    [testId, pressed] as const,
  );
  await act();
  return window.evaluate(
    async () => (globalThis as { pressedAfter?: Promise<number> }).pressedAfter ?? -1,
  );
}

const msOf = (clock: string) => {
  const [minutes = 0, seconds = 0] = clock.split(":").map(Number);
  return (minutes * 60 + seconds) * 1000;
};

const linesOf = (transcript: Locator) =>
  transcript.getByTestId("transcript-line").evaluateAll((items) =>
    items.map((item) => ({
      start: Number(item.getAttribute("data-start")),
      speaker: item.querySelector('[data-testid="transcript-speaker"]')?.textContent ?? "",
    })),
  );

const wordsOf = (row: Locator) => row.locator(":scope > :last-child");

async function marksOf(transcript: Locator): Promise<{ from: number; to: number }[]> {
  const texts = await transcript
    .locator('[data-testid="transcript-gap"][data-reason="muted"]')
    .allTextContents();
  return texts.flatMap((text) => {
    const found = /(\d+:\d\d)\s*–\s*(\d+:\d\d)/.exec(text);
    return found ? [{ from: msOf(found[1] as string), to: msOf(found[2] as string) }] : [];
  });
}

test("Pause my mic: the bar's button, ⌘K and the shortcut pause and resume the microphone while the other side is recorded, no Me line comes for the stretch, and the Transcript marks it", async () => {
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  const bar = await recordingMeeting(window);
  const mic = bar.getByTestId("meeting-mic");

  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(mic).toHaveAccessibleName("Pause my mic");
  await expect(mic).toHaveAttribute(
    "title",
    `Pause my mic. The other side is still recorded (${MIC_LABEL})`,
  );
  const [state, button, pause] = await Promise.all(
    [bar.locator(".meeting-state"), mic, bar.getByTestId("meeting-pause")].map((each) =>
      each.boundingBox(),
    ),
  );
  if (!state || !button || !pause) throw new Error("The bar isn't drawn.");
  expect(state.x + state.width).toBeLessThanOrEqual(button.x + 1);
  expect(button.x + button.width).toBeLessThanOrEqual(pause.x + 1);
  expect(Math.abs(state.y + state.height / 2 - (button.y + button.height / 2))).toBeLessThan(6);
  expect(await capture(app)).toMatchObject({ running: true, microphoneOn: true });
  await expect.poll(() => heldGlobalKeys(app, MIC_KEYS)).toBe(true);

  const toggle = bar.getByTestId("meeting-transcript-toggle");
  await toggle.click();
  const transcript = window.getByTestId("viewer-transcript");
  const speakers = transcript.getByTestId("transcript-speaker");
  await expect(speakers.filter({ hasText: /^Me$/ }).first()).toBeVisible({ timeout: 20_000 });
  await expect(speakers.filter({ hasText: /^Them$/ }).first()).toBeVisible({ timeout: 20_000 });
  await shot(window, "mic-before-en");

  expect(
    await pressedAfter(window, "meeting-mic", true, () => pointAndClick(window, mic)),
  ).toBeLessThan(100);
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(mic).toHaveAccessibleName("Pause my mic");
  await expect(mic).toHaveAttribute("title", `Resume my mic (${MIC_LABEL})`);
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(false);
  const whilePaused: { microphone: number; system: number }[] = [];
  let pausedFrom = await mainNow(app);
  const line = bar.getByTestId("meeting-line-microphone-paused");
  await expect(line).toHaveText(/^My mic paused since \d+:\d\d · Resume$/);
  const open = transcript.getByTestId("transcript-mic-paused");
  await expect(wordsOf(open)).toHaveText(/^My mic paused since \d\d:\d\d · Resume$/);
  const since = msOf(/(\d+:\d\d)/.exec((await line.textContent()) ?? "")?.[1] ?? "0:00");
  await expect(bar).toHaveAttribute("data-status", "recording");
  await shot(window, "mic-paused-en");

  await expect
    .poll(async () => {
      const lines = await linesOf(transcript);
      return lines.filter((each) => each.speaker === "Them" && each.start >= since).length;
    }, LINES_WITHIN)
    .toBeGreaterThanOrEqual(2);

  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("my mic");
  await expect(
    window.getByTestId("palette-item").filter({ hasText: "Resume my mic" }),
  ).toContainText(MIC_LABEL);
  await shot(window, "mic-palette-en");
  whilePaused.push(await sentSince(app, pausedFrom));
  expect(
    await pressedAfter(window, "meeting-mic", false, () => window.keyboard.press("Enter")),
  ).toBeLessThan(100);
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(line).toBeHidden();
  await expect(open).toBeHidden();
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(true);
  const span = transcript.locator('[data-testid="transcript-gap"][data-reason="muted"]');
  await expect(wordsOf(span)).toHaveText(/^My mic paused \d\d:\d\d–\d\d:\d\d$/);
  await shot(window, "mic-after-en");

  await pressHeldKeys(app, "mic");
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(false);
  whilePaused.push(await sentSince(app, await mainNow(app)));
  await pressHeldKeys(app, "mic");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(true);

  await mic.focus();
  expect(
    await pressedAfter(window, "meeting-mic", true, () => window.keyboard.press("Enter")),
  ).toBeLessThan(100);
  await expect(mic).toBeFocused();
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(false);
  pausedFrom = await mainNow(app);

  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(bar).toHaveAttribute("data-status", "paused");
  await expect.poll(async () => (await capture(app)).running).toBe(false);
  await expect.poll(() => heldGlobalKeys(app, MIC_KEYS)).toBe(false);
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await bar.getByTestId("meeting-resume").click();
  await expect(bar).toHaveAttribute("data-status", "recording");
  await expect.poll(async () => capture(app)).toEqual({ running: true, microphoneOn: false });
  await expect.poll(() => heldGlobalKeys(app, MIC_KEYS)).toBe(true);
  whilePaused.push(await sentSince(app, pausedFrom));
  await pointAndClick(window, mic);
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(true);
  await expect
    .poll(async () => {
      const marks = await marksOf(transcript);
      const lines = await linesOf(transcript);
      // A mark's times are whole seconds, rounded down.
      const last = (marks.at(-1)?.to ?? Number.POSITIVE_INFINITY) + 1000;
      return lines.filter((each) => each.speaker === "Me" && each.start >= last).length;
    }, LINES_WITHIN)
    .toBeGreaterThanOrEqual(1);

  expect(whilePaused.map((each) => each.microphone)).toEqual([0, 0, 0]);

  await bar.getByTestId("meeting-stop").click();
  await expect(bar).toBeHidden();
  await expect.poll(() => heldGlobalKeys(app, MIC_KEYS)).toBe(false);
  await expect(window.getByTestId("meeting-transcript-line")).toContainText("Transcript saved", {
    timeout: 20_000,
  });
  const [stopped] = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );
  const { cues, gaps } = readVtt(readFileSync(stopped?.transcript?.savedPath ?? "", "utf8"));
  const stretches = gaps.filter((gap) => gap.reason === "muted");
  expect(stretches.length).toBeGreaterThanOrEqual(3);
  // A stretch under a second is in the file but not listed, as every gap is.
  expect(listedGaps(stretches).length).toBeGreaterThanOrEqual(1);
  expect((await marksOf(transcript)).length).toBe(listedGaps(stretches).length);
  for (const { fromMs, toMs } of stretches) {
    expect(
      cues.filter((cue) => cue.speaker === "Me" && cue.endMs > fromMs && cue.startMs < toMs),
    ).toEqual([]);
  }
  const [firstStretch] = stretches;
  expect(
    cues.filter((cue) => cue.speaker === "Them" && cue.startMs >= (firstStretch?.fromMs ?? 0))
      .length,
  ).toBeGreaterThanOrEqual(2);

  const second = await recordMeetingNow(window);
  const secondMic = second.getByTestId("meeting-mic");
  await expect(secondMic).toHaveAttribute("aria-pressed", "false");
  await expect(second.getByTestId("meeting-line-microphone-paused")).toHaveCount(0);
  expect(await capture(app)).toMatchObject({ running: true, microphoneOn: true });
  await app.close();
});

test("Pause my mic in Chinese: the tooltips, the line, ⌘K and the mark in Chinese, and the bar holds at 1,100 px in English and Chinese", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1100, 800);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  const bar = await recordingMeeting(window);
  const mic = bar.getByTestId("meeting-mic");
  await window.mouse.move(1, 1);
  await expectBarOneRow(bar);
  await shot(bar, "mic-bar-1100-en");

  await setLanguage(window, "zh-CN");
  await expect(mic).toHaveAccessibleName("暂停我的麦克风");
  await expect(mic).toHaveAttribute("title", `暂停我的麦克风，对方仍会录制（${MIC_LABEL}）`);
  await expectBarOneRow(bar);
  await shot(bar, "mic-bar-1100-zh");

  await pointAndClick(window, mic);
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(mic).toHaveAccessibleName("暂停我的麦克风");
  await expect(mic).toHaveAttribute("title", `恢复我的麦克风（${MIC_LABEL}）`);
  const line = bar.getByTestId("meeting-line-microphone-paused");
  await expect(line).toHaveText(/^我的麦克风自 \d+:\d\d 起已暂停 · 恢复$/);
  await window.mouse.move(1, 1);
  await expectBarOneRow(bar);
  await shot(bar, "mic-bar-paused-1100-zh");
  await setLanguage(window, "en");
  await expect(line).toHaveText(/^My mic paused since \d+:\d\d · Resume$/);
  await expectBarOneRow(bar);
  await shot(bar, "mic-bar-paused-1100-en");
  await setLanguage(window, "zh-CN");

  // The live mark in the Transcript, in Chinese, beside the meeting where the window has room.
  await setWindowSize(app, window, 1440, 900);
  await bar.getByTestId("meeting-transcript-toggle").click();
  const transcript = window.getByTestId("viewer-transcript");
  const open = transcript.getByTestId("transcript-mic-paused");
  await expect(wordsOf(open)).toHaveText(/^我的麦克风自 \d\d:\d\d 起已暂停 · 恢复$/);
  const since = msOf(/(\d+:\d\d)/.exec((await open.textContent()) ?? "")?.[1] ?? "0:00");
  await expect
    .poll(async () => {
      const lines = await linesOf(transcript);
      return lines.filter((each) => each.speaker === "对方" && each.start >= since).length;
    }, LINES_WITHIN)
    .toBeGreaterThanOrEqual(1);
  await fromPalette(window, "恢复我的麦克风");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(wordsOf(transcript.getByTestId("transcript-gap"))).toHaveText(
    /^我的麦克风在 \d\d:\d\d–\d\d:\d\d 暂停$/,
  );
  await expect(transcript.getByTestId("transcript-gap")).toHaveAttribute("data-reason", "muted");
  await shot(window, "mic-after-zh");

  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("麦克风");
  await expect(
    window.getByTestId("palette-item").filter({ hasText: "暂停我的麦克风" }),
  ).toContainText(MIC_LABEL);
  await window.keyboard.press("Escape");
  await app.close();
});

test("Pause my mic in the floating panel: the header's button and the line under it, in step with the bar, in English and Chinese", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  const bar = await recordingMeeting(window);
  const panel = await panelOf(app);
  const mic = panel.getByTestId("panel-mic");
  const barMic = bar.getByTestId("meeting-mic");

  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(mic).toHaveAttribute(
    "title",
    `Pause my mic. The other side is still recorded (${MIC_LABEL})`,
  );
  await expect(panel.getByTestId("panel-mic-line")).toHaveCount(0);
  const [recordingState, button, template] = await Promise.all(
    [panel.locator(".panel-state"), mic, panel.getByTestId("panel-template")].map((each) =>
      each.boundingBox(),
    ),
  );
  if (!recordingState || !button || !template) throw new Error("The panel isn't drawn.");
  expect(recordingState.x + recordingState.width).toBeLessThanOrEqual(button.x + 1);
  expect(button.x + button.width).toBeLessThanOrEqual(template.x + 1);

  await pointAndClick(panel, mic);
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(mic).toHaveAccessibleName("Pause my mic");
  await expect(mic).toHaveAttribute("title", `Resume my mic (${MIC_LABEL})`);
  const line = panel.getByTestId("panel-mic-line");
  await expect(line).toHaveText(/^My mic paused since \d+:\d\d·Resume$/);
  await expect(barMic).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(false);
  await shot(panel.locator("body"), "mic-panel-paused-en");

  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText(/^我的麦克风自 \d+:\d\d 起已暂停·恢复$/);
  await expect(mic).toHaveAttribute("title", `恢复我的麦克风（${MIC_LABEL}）`);
  await expect(mic).toHaveAccessibleName("暂停我的麦克风");
  const header = await panel.locator(".panel-header").boundingBox();
  const lineBox = await line.boundingBox();
  const closeBox = await panel.getByTestId("panel-close").boundingBox();
  if (!header || !lineBox || !closeBox) throw new Error("The panel isn't drawn.");
  expect(lineBox.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(header.x + header.width + 1);
  await shot(panel.locator("body"), "mic-panel-paused-zh");

  await pointAndClick(panel, panel.getByTestId("panel-mic-resume"));
  await expect(line).toHaveCount(0);
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(mic).toHaveAttribute("title", `暂停我的麦克风，对方仍会录制（${MIC_LABEL}）`);
  await expect(barMic).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(true);
  await app.close();
});

test("the recording bar never wraps: from 1,600 px down to 900 px, in English and Chinese, with the transcript beside it or not, it is one row of one height and keeps the state, Pause my mic, Pause and Stop", async () => {
  test.setTimeout(300_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  const bar = await recordingMeeting(window);
  const toggle = bar.getByTestId("meeting-transcript-toggle");
  const more = bar.getByTestId("meeting-more");
  const notes = window.getByTestId("mind-editor");
  await notes.click();

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const beside of [false, true]) {
      await setWindowSize(app, window, 1600, 900);
      if ((await toggle.getAttribute("aria-pressed")) !== String(beside)) {
        await pointAndClick(window, toggle);
      }
      await expect(toggle).toHaveAttribute("aria-pressed", String(beside));
      const folded: number[] = [];
      for (let width = 1600; width >= 900; width -= 50) {
        await setWindowSize(app, window, width, 800);
        await window.mouse.move(1, 1);
        await expectBarOneRow(bar);
        if (!(await bar.getByTestId("meeting-mark").isVisible())) folded.push(width);
      }
      if (!beside) continue;

      // Where Mark has folded the ⋯ shows, and the keyboard reaches it and what it lists.
      const width = folded.at(-1);
      expect(width).toBeDefined();
      await setWindowSize(app, window, width ?? 900, 800);
      await window.mouse.move(1, 1);
      await expect(more).toBeVisible();
      await bar.getByTestId("meeting-pause").focus();
      await tabTo(window, more);
      await expect(more).toBeFocused();
      await window.keyboard.press("Enter");
      const menu = window.getByTestId("meeting-more-menu");
      const items = menu.getByRole("menuitem");
      await expect(items.first()).toBeFocused();
      await expect(menu.getByTestId("meeting-more-mark")).toBeEnabled();
      const hidden = [];
      for (const id of ["meeting-mark", "meeting-call-help", "meeting-transcript-toggle"]) {
        if (!(await bar.getByTestId(id).isVisible())) hidden.push(id);
      }
      await expect(items).toHaveCount(hidden.length);
      expect(hidden.length).toBeGreaterThanOrEqual(2);
      await window.keyboard.press("ArrowDown");
      await expect(items.nth(1)).toBeFocused();
      await window.keyboard.press("ArrowUp");
      await expect(items.first()).toBeFocused();
      await window.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(more).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(items.first()).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(menu).toBeHidden();
      await expect(notes.locator("li p[data-meeting-time]").last()).toHaveText("");
      await shot(bar, `mic-bar-folded-${language}`);
    }
  }
  await app.close();
});

test("the meeting's keys work with IncarnaMind in front: with the notes focused Pause my mic's key is held, shown where the User looks, and pauses and resumes the microphone", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  const bar = await recordingMeeting(window);
  const mic = bar.getByTestId("meeting-mic");
  const notes = window.getByTestId("mind-editor");

  await focusMainWindow(app, true);
  await notes.click();
  await window.keyboard.type("Agenda");
  await expect(mic).toHaveAttribute(
    "title",
    `Pause my mic. The other side is still recorded (${MIC_LABEL})`,
  );
  await expect.poll(() => heldGlobalKeys(app, MIC_KEYS)).toBe(true);
  await expect.poll(() => heldGlobalKeys(app, PANEL_KEYS)).toBe(true);
  await pressHeldKeys(app, "mic");
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(false);
  await pressHeldKeys(app, "mic");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(true);
  await expect(notes).toContainText("Agenda");
  await app.close();
});

test("a meeting key the User set to one of the editor's own is held only while another app is in front: with a Mind in front the key is the editor's and the microphone stays on, and with the panel or another app in front it pauses the microphone", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window, { mic: CHECKLIST_KEYS });
  const bar = await recordingMeeting(window);
  const panel = await panelOf(app);
  const mic = bar.getByTestId("meeting-mic");
  const notes = window.getByTestId("mind-editor");

  await focusMainWindow(app, true);
  await expect.poll(() => heldGlobalKeys(app, CHECKLIST_KEYS)).toBe(false);
  await expect(mic).toHaveAttribute("title", "Pause my mic. The other side is still recorded");
  await notes.click();
  await window.keyboard.type("Agenda");
  await window.keyboard.press("ControlOrMeta+Shift+9");
  await expect(notes.locator('ul[data-type="taskList"]')).toBeVisible();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  expect(await capture(app)).toMatchObject({ microphoneOn: true });
  await expect(pressHeldKeys(app, "mic")).rejects.toThrow(/isn't held/);

  // The panel pointed at, which is another app in front for the keys: the key pauses the microphone.
  await focusMainWindow(app, false);
  await expect.poll(() => heldGlobalKeys(app, CHECKLIST_KEYS)).toBe(true);
  await expect(panel.getByTestId("panel-mic")).toHaveAttribute(
    "title",
    `Pause my mic. The other side is still recorded (${CHECKLIST_LABEL})`,
  );
  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await pressHeldKeys(app, "mic");
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(false);

  await pointAndClick(window, bar.getByTestId("meeting-call-help"));
  await expect.poll(() => panelOpen(app)).toBe(false);
  await pressHeldKeys(app, "mic");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await capture(app)).microphoneOn).toBe(true);

  await focusMainWindow(app, true);
  await expect.poll(() => heldGlobalKeys(app, CHECKLIST_KEYS)).toBe(false);
  await focusMainWindow(app, false);
  await expect.poll(() => heldGlobalKeys(app, CHECKLIST_KEYS)).toBe(true);
  await app.close();
});
