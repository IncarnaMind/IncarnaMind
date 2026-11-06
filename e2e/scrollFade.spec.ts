import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  cutALineAtFoot,
  dismissChatSetup,
  footFadeOf,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * The assistant's thread under the composer (#2616): while text runs on below the foot, the last
 * line and a half above the composer fade to the sheet, so the line the foot cuts fades out whole;
 * at the thread's end, or in a thread that fits, nothing is cut and nothing fades. The checks are
 * relations between the fade, the line it covers and the thread's foot. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const QUESTIONS = {
  en: [
    "When do spring tides happen?",
    "And neap tides?",
    "Why twice a day?",
    "Does the wind matter?",
    "What about rivers?",
  ],
  "zh-CN": ["春潮什么时候出现？", "那小潮呢？", "为什么一天两次？", "风有影响吗？", "河口呢？"],
} as const;

/** The Answers' own paragraphs, which are the lines a reader is in the middle of. */
const READING = '[data-testid="assistant-answer-text"] p';

for (const language of ["en", "zh-CN"] as const) {
  test(`the thread fades the line its foot cuts, whole, and nothing at its end (${language}, 900 and 1,440 px)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 640);
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await setLanguage(window, language);
    const thread = window.getByTestId("assistant-thread");
    const marked = async () => (await footFadeOf(thread, READING)).marked;

    // A thread that fits has nothing cut, so nothing fades.
    const [first, ...more] = QUESTIONS[language];
    await askInAssistant(window, first);
    expect(await thread.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await marked()).toBe(false);
    expect((await footFadeOf(thread, READING)).fade).toBe(0);

    for (const question of more) await askInAssistant(window, question);
    expect(await thread.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 640);
      const at = `${language}, ${width}px`;

      // At the end the last line is fully legible: no fade is drawn over it.
      await thread.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect.poll(marked, { message: `at the end, ${at}` }).toBe(false);
      const end = await footFadeOf(thread, READING);
      expect(end.fade, at).toBe(0);
      expect(end.cut, at).toBeNull();
      expect(end.last, at).toBeLessThanOrEqual(end.foot + 0.5);
      if (SCREENSHOTS) {
        await thread.screenshot({ path: join(SCREENSHOTS, `thread-${language}-${width}-end.png`) });
      }

      // Scrolled up so the foot cuts a line in two, the line fades out over its whole height.
      await cutALineAtFoot(thread, READING);
      await expect.poll(marked, { message: `cut, ${at}` }).toBe(true);
      const cutting = await footFadeOf(thread, READING);
      if (!cutting.cut) throw new Error(`The foot cut no line, ${at}.`);
      expect(cutting.fade, at).toBeGreaterThanOrEqual(1.5 * cutting.cut.lineHeight);
      expect(cutting.cut.top, at).toBeGreaterThanOrEqual(cutting.foot - cutting.fade - 0.5);
      if (SCREENSHOTS) {
        await thread.screenshot({ path: join(SCREENSHOTS, `thread-${language}-${width}-cut.png`) });
      }
    }
    await app.close();
  });
}
