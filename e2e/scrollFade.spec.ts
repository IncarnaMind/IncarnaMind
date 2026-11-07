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

      // A few px short of the end, only the thread's padding lies below: all its text shows.
      await thread.evaluate((el) => {
        el.scrollTop = el.scrollHeight - el.clientHeight - 6;
      });
      await expect.poll(marked, { message: `short of the end, ${at}` }).toBe(false);
      expect((await footFadeOf(thread, READING)).fade, at).toBe(0);

      // Scrolled so the foot barely cuts a line, the whole line is in the fade.
      await cutALineAtFoot(thread, READING);
      await expect.poll(marked, { message: `cut, ${at}` }).toBe(true);
      const cutting = await footFadeOf(thread, READING);
      if (!cutting.cut) throw new Error(`The foot cut no line, ${at}.`);
      expect(cutting.position, at).toBe("sticky");
      expect(cutting.fadeBottom, at).toBeCloseTo(cutting.foot, 0);
      expect(cutting.fade, at).toBeGreaterThanOrEqual(1.5 * cutting.cut.lineHeight);
      expect(cutting.cut.top, at).toBeGreaterThanOrEqual(cutting.foot - cutting.fade - 0.5);
      // The fade takes no room: the thread is as long with it as without.
      expect(cutting.scrollHeight, at).toBe(end.scrollHeight);
      if (SCREENSHOTS) {
        await thread.screenshot({ path: join(SCREENSHOTS, `thread-${language}-${width}-cut.png`) });
      }
    }

    // The scroll a link back from a Note makes to its Answer stops above the fade, which the
    // frame keeps clear, not under it (#2622). At 1,440px, where the Answer fits above the fade;
    // at 900 the thread is shorter than an Answer, so the browser aligns its top instead and
    // there is no room below it to clear the fade. The Answer just before the last: a newer one
    // lies below it, so the fade is drawn over it and the thread can scroll clear of it.
    await setWindowSize(app, window, 1440, 640);
    const sought = await thread.evaluate((element) => {
      const answers = [
        ...element.querySelectorAll<HTMLElement>('[data-testid="assistant-answer"]'),
      ];
      const answer = answers.at(-2) ?? answers.at(-1);
      if (!answer) throw new Error("The thread holds no Answer.");
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      element.scrollTop = 0;
      answer.scrollIntoView({ block: "nearest" });
      return {
        bottom: answer.getBoundingClientRect().bottom,
        foot: element.getBoundingClientRect().bottom,
        fade: 1.5 * lineHeight,
      };
    });
    if (SCREENSHOTS) {
      await thread.screenshot({ path: join(SCREENSHOTS, `thread-${language}-1440-sought.png`) });
    }
    expect(sought.fade, `sought, ${language}`).toBeGreaterThan(0);
    expect(sought.bottom, `sought, ${language}`).toBeLessThanOrEqual(
      sought.foot - sought.fade + 0.5,
    );

    // The room the thread keeps under its newest Question is blank, not content: the log's
    // padding below its text is not a line, so with the text ending just above the foot the
    // thread draws no fade over the room (#2622). Its own padding changes the thread's height,
    // so it runs after the checks above, at each width.
    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 640);
      const room = await thread.evaluate((element, pad) => {
        const log = element.lastElementChild;
        if (!(log instanceof HTMLElement)) throw new Error("The thread holds no log.");
        log.style.setProperty("padding-bottom", `${pad}px`, "important");
        const frame = Number.parseFloat(getComputedStyle(element).paddingBottom) || 0;
        // The text ends 6px above the foot, the padding filling the room below it. The mark is
        // read in this same turn, as the hook reads it on a scroll.
        element.scrollTop = element.scrollHeight - element.clientHeight - pad - frame + 6;
        element.dispatchEvent(new Event("scroll"));
        const edge = getComputedStyle(element, "::after");
        const foot = element.getBoundingClientRect().bottom;
        const bottom = log.getBoundingClientRect().bottom;
        return {
          textAboveFoot: foot - (bottom - pad),
          roomUnderText: bottom - foot,
          marked: element.hasAttribute("data-more-after"),
          fade: edge.display === "none" ? 0 : Number.parseFloat(edge.height),
        };
      }, 200);
      const at = `${language}, ${width}px`;
      expect(room.textAboveFoot, at).toBeGreaterThanOrEqual(0);
      expect(room.textAboveFoot, at).toBeLessThanOrEqual(8);
      expect(room.roomUnderText, at).toBeGreaterThan(0);
      expect(room.marked, `blank room, ${at}`).toBe(false);
      expect(room.fade, at).toBe(0);
    }

    // Its height is the frame's line height, not a number: lines of 40px give a fade of 60px.
    const sized = await thread.evaluate((el) => {
      el.style.lineHeight = "40px";
      const height = getComputedStyle(el, "::after").height;
      el.style.lineHeight = "";
      return height;
    });
    expect(sized).toBe("60px");
    await app.close();
  });
}
