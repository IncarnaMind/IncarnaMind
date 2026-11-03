import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import { FAKE_LINES } from "../src/core/transcription/fake";
import {
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  leaveText,
  paletteFound,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * A voice memo (#1568): + › Voice memo and ⌘K record at once (the first time, after the
 * recording notice), the bar reads "Voice memo · 00:42 · Pause · Stop" with no call's parts, and
 * Stop writes the note as one Undo: a title line that names the Mind, then the speech with its
 * times; with no model, the Transcript as it is.
 */

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

const ZH_LINES = ["我们先定一下发布日期。", "发布推迟到十一月十八日。", "合作伙伴预览保持不变。"];

const WORDS = {
  en: {
    menu: "Voice memo",
    command: "Record a voice memo",
    stop: "Stop recording",
    bar: "Voice memo",
    microphone: "IncarnaMind records your microphone.",
    tell: "Tell everyone",
    hint: "Speak, then Stop: your note is written here.",
    written: "Memo written",
    undone: "Memo undone",
    asIs: "Transcript written in as it is: choose an AI model first.",
    title: FAKE_LINES[0]?.split(" ").slice(0, 4).join(" ") ?? "",
    dated: /^Voice memo, /,
  },
  "zh-CN": {
    menu: "语音备忘",
    command: "录一段语音备忘",
    stop: "停止录制",
    bar: "语音备忘",
    microphone: "IncarnaMind 会录制你的麦克风。",
    tell: "告诉所有人",
    hint: "说完后停止录制，笔记就会写在这里。",
    written: "已写入语音备忘",
    undone: "已撤销语音备忘",
    asIs: "已按原样写入转写稿：请先选择一个 AI 模型。",
    title: (ZH_LINES[0] ?? "").replace("。", ""),
    dated: /^语音备忘，/,
  },
} as const;

const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

const memosOf = async (window: Page): Promise<Meeting[]> =>
  (await (await bridge(window)).evaluate((core) => core.listMeetings())).filter(
    (each) => each.kind === "memo",
  );

const mindCount = async (window: Page) =>
  (await (await bridge(window)).evaluate((core) => core.listMinds())).length;

const readNotice = async (window: Page) =>
  (await bridge(window)).evaluate((core) =>
    core.updateSettings({ device: { meetingNoticeAccepted: true } }),
  );

const heard = (window: Page, lines: number) =>
  expect
    .poll(async () => (await memosOf(window))[0]?.transcript?.lines ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(lines);

async function expectBarFits(bar: Locator): Promise<void> {
  const layout = await bar.evaluate((element) => {
    const controls = element.querySelector<HTMLElement>('[data-testid="meeting-controls"]');
    if (!controls) throw new Error("The bar has no controls.");
    const frame = controls.getBoundingClientRect();
    const middle = (box: DOMRect) => box.top + box.height / 2;
    const seen = [...controls.children].filter(
      (each): each is HTMLElement => each instanceof HTMLElement && each.offsetParent !== null,
    );
    const page = element.closest<HTMLElement>('[data-testid="mind-editor"]')?.parentElement;
    return {
      oneRow: seen.every(
        (each) => Math.abs(middle(each.getBoundingClientRect()) - middle(frame)) < 2,
      ),
      inside: seen.every((each) => each.getBoundingClientRect().right <= frame.right + 1),
      fits: element.scrollWidth <= element.clientWidth + 1,
      noPageScroll: page ? page.scrollWidth <= page.clientWidth + 1 : true,
    };
  });
  expect(layout).toEqual({ oneRow: true, inside: true, fits: true, noPageScroll: true });
}

async function expectNoCallParts(bar: Locator): Promise<void> {
  for (const testId of [
    "meeting-mic",
    "meeting-mark",
    "meeting-call-help",
    "meeting-transcript-toggle",
    "meeting-more",
  ]) {
    await expect(bar.getByTestId(testId), testId).toHaveCount(0);
  }
}

async function expectNote(window: Page, title: string): Promise<void> {
  const notes = window.getByTestId("mind-editor");
  const heading = notes.locator("h1").first();
  await expect(heading).toHaveText(title, { timeout: 30_000 });
  await expect(heading.locator(".generated-text")).toHaveCount(1);
  const chips = notes.locator("p").getByTestId("citation-chip-text");
  await expect(chips.first()).toHaveText(/^\d{1,2}:\d{2}$/);
  await expect(frontMindName(window)).toHaveText(title);
}

for (const [language, width] of [
  ["en", 1600],
  ["zh-CN", 900],
] as const) {
  test(`+ › Voice memo records at once after the first notice, with no call's parts, and Stop writes a titled note with its times, one Undo (${language}, ${width}px)`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ...(language === "zh-CN" && { transcriber: { lines: ZH_LINES } }),
    });
    await setWindowSize(app, window, width, 820);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await useLocalChatModel(window);
    await useOutputLocation(window, sources);
    try {
      await pointAndClick(window, window.getByTestId("plus-menu"));
      await pointAndClick(window, window.getByTestId("plus-more"));
      const item = window.getByTestId("plus-record-memo");
      await expect(item).toHaveText(words.menu);
      await pointAndClick(window, item);

      // The first time, the recording notice: the microphone only, and no one else to tell.
      const notice = window.getByTestId("meeting-notice");
      await expect(notice).toContainText(words.microphone);
      await expect(notice).not.toContainText(words.tell);
      expect(await memosOf(window)).toEqual([]);
      await pointAndClick(window, notice.getByTestId("meeting-notice-start"));
      await expect(notice).toBeHidden();

      const bar = window.getByTestId("meeting-bar");
      await expect(bar).toHaveAttribute("data-status", "recording");
      await expect(bar).toHaveAttribute("data-kind", "memo");
      await expect(bar.getByTestId("meeting-state")).toHaveText(words.bar);
      await expect(bar.getByTestId("meeting-time")).toHaveText(/^\d{1,2}:\d{2}$/);
      await expect(bar.getByTestId("meeting-pause")).toBeVisible();
      await expect(bar.getByTestId("meeting-stop")).toBeVisible();
      await expectNoCallParts(bar);
      await expect(window.getByTestId("help-strip")).toHaveCount(0);
      await expectBarFits(bar);
      await expect(window.getByTestId("end-hint")).toHaveText(words.hint);
      expect(await mindCount(window)).toBe(1);
      expect((await memosOf(window))[0]).toMatchObject({ status: "recording", systemAudio: false });

      await heard(window, 2);
      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      const line = window.getByTestId("meeting-fill-line");
      await expect(line).toContainText(words.written, { timeout: 30_000 });
      await expectNote(window, words.title);

      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(window.getByTestId("mind-editor").locator("h1")).toHaveCount(0);
      await expect(line).toContainText(words.undone);
      await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

for (const [language, width] of [
  ["zh-CN", 900],
  ["en", 1600],
] as const) {
  test(`⌘K records a voice memo into the empty Mind in front, by keyboard alone; its title line names that Mind, and ⌘Z takes the note back (${language}, ${width}px)`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ...(language === "zh-CN" && { transcriber: { lines: ZH_LINES } }),
    });
    await setWindowSize(app, window, width, 820);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await useLocalChatModel(window);
    await useOutputLocation(window, sources);
    try {
      await readNotice(window);

      await window.keyboard.press("ControlOrMeta+t");
      await expect.poll(() => mindCount(window)).toBe(1);

      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(words.command);
      await expect(paletteFound(window).first()).toContainText(words.command);
      await window.keyboard.press("Enter");

      const bar = window.getByTestId("meeting-bar");
      await expect(bar).toHaveAttribute("data-status", "recording");
      await expect(bar.getByTestId("meeting-state")).toHaveText(words.bar);
      await expectBarFits(bar);
      // In the Mind that was in front: none is made.
      expect(await mindCount(window)).toBe(1);

      await heard(window, 2);
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(words.stop);
      await expect(paletteFound(window).first()).toContainText(words.stop);
      await window.keyboard.press("Enter");

      await expect(window.getByTestId("meeting-fill-line")).toContainText(words.written, {
        timeout: 30_000,
      });
      await expectNote(window, words.title);
      expect(await mindCount(window)).toBe(1);

      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(window.getByTestId("mind-editor").locator("h1")).toHaveCount(0);
      await expect(window.getByTestId("meeting-fill-line")).toContainText(words.undone);
    } finally {
      await app.close();
    }
  });
}

test("with no model, Stop writes the Transcript in as it is, under a dated title line, and says why", async () => {
  const words = WORDS.en;
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1100, 820);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  try {
    await readNotice(window);

    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-more"));
    await pointAndClick(window, window.getByTestId("plus-record-memo"));
    const bar = window.getByTestId("meeting-bar");
    await expect(bar).toHaveAttribute("data-status", "recording");
    await heard(window, 2);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));

    const line = window.getByTestId("meeting-fill-line");
    await expect(line).toContainText(words.asIs, { timeout: 30_000 });
    const notes = window.getByTestId("mind-editor");
    await expect(notes.locator("h1")).toHaveText(words.dated);
    await expect(notes.locator("p").filter({ hasText: FAKE_LINES[0] as string })).toHaveCount(1);
    await expect(notes.locator("p").first().getByTestId("citation-chip-text")).toHaveText(
      /^\d{1,2}:\d{2}$/,
    );
    await expect(frontMindName(window)).toHaveText(words.dated);
  } finally {
    await app.close();
  }
});
