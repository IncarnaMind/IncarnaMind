import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { PARAGRAPHS } from "../src/main/fakeChat/paragraphs";
import { countFor, countText } from "../src/shared/wordCount";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setWindowSize,
  showCountWhileWriting,
  useLocalChatModel,
  WORD_KEY,
} from "./app";

/*
 * The count while writing, at the page's bottom left once the page's ⋯ menu
 * shows it (#908): words for English, characters for Chinese, the selection's
 * own count, a target per Mind, and a count that waits for a pause in typing.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of it at a
 * wide and a narrow window, in English and Chinese.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

test("the count follows the writing, in words and in characters, and the selection has its own", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  await showCountWhileWriting(window);
  const button = window.getByTestId("mind-count-button");
  await expect(button).toHaveText("0 words");

  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("The tide turns at noon");
  await expect(button).toHaveText("5 words");
  await expect(button).toHaveAttribute("title", /Citation markers and Questions don’t count/);

  // Select the last two words with the keyboard.
  await window.keyboard.press(`Shift+${WORD_KEY}+ArrowLeft`);
  await window.keyboard.press(`Shift+${WORD_KEY}+ArrowLeft`);
  await expect(button).toHaveText("2 of 5 words");
  await window.keyboard.press("ArrowRight");
  await expect(button).toHaveText("5 words");

  // Chinese is counted by character.
  await window.keyboard.press("Enter");
  await window.keyboard.type("潮水每天涨落两次");
  await expect(button).toHaveText("13 characters");
  await window.keyboard.press("Enter");
  await window.keyboard.type("潮水每天涨落两次潮水每天涨落两次潮水每天涨落两次");
  await expect(button).toHaveText("37 characters");
  await app.close();
});

test("typing is not slowed: the count is worked out after a pause, not for each key", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  await showCountWhileWriting(window);
  const button = window.getByTestId("mind-count-button");
  await window.getByTestId("mind-editor").click();

  // Count how many times the count changes while a burst of keys goes in.
  await window.evaluate(() => {
    const target = document.querySelector('[data-testid="mind-count-button"]');
    const seen = { changes: 0 };
    (globalThis as unknown as { countChanges: typeof seen }).countChanges = seen;
    if (target)
      new MutationObserver(() => {
        seen.changes += 1;
      }).observe(target, { attributes: true, attributeFilter: ["data-total"] });
  });
  const burst = "word ".repeat(80);
  await window.keyboard.type(burst, { delay: 0 });
  await expect(button).toHaveAttribute("data-total", "80");
  const changes = await window.evaluate(
    () => (globalThis as unknown as { countChanges: { changes: number } }).countChanges.changes,
  );
  expect(changes).toBeLessThan(burst.length / 4);
  await app.close();
});

test("a target shows progress, is kept for the Mind, and can be removed", async () => {
  const first = await launchApp(dataDir);
  const { window } = first;
  await dismissChatSetup(window);
  await newMind(window);
  await showCountWhileWriting(window);
  const button = window.getByTestId("mind-count-button");
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("one two three four five");
  await expect(window.getByTestId("mind-editor")).toHaveText("one two three four five");
  await expect(button).toHaveText("5 words");
  await expect(window.getByTestId("mind-count-progress")).toHaveCount(0);

  await button.click();
  const menu = window.getByTestId("mind-count-menu");
  await expect(menu).toBeVisible();
  // The menu puts the focus on its checked item as it opens; wait for that before typing in the field.
  await expect(
    window.locator('[data-testid="mind-count-basis"][aria-checked="true"]'),
  ).toBeFocused();
  const field = window.getByTestId("mind-count-target");
  // Tab walks the menu's options into its target field, and the menu stays open while the focus is inside.
  await window.keyboard.press("Tab");
  await window.keyboard.press("Tab");
  await window.keyboard.press("Tab");
  await expect(field).toBeFocused();
  await expect(menu).toBeVisible();
  await field.fill("words");
  await window.getByTestId("mind-count-set").click();
  await expect(menu.getByRole("alert")).toBeVisible();
  await field.fill("20");
  await field.press("Enter");
  await expect(menu).toBeHidden();
  await expect(button).toHaveText("5 / 20 words");
  await expect(window.getByTestId("mind-count-progress")).toHaveAttribute("aria-valuenow", "25");

  // Shift+Tab from the first item leaves the menu, and it closes.
  await button.click();
  await expect(menu).toBeVisible();
  await window.keyboard.press("Shift+Tab");
  await expect(menu).toBeHidden();

  // What the count shows is chosen in the menu: characters without spaces here.
  await button.click();
  await window.locator('[data-testid="mind-count-basis"][data-basis="charactersNoSpaces"]').click();
  await expect(button).toHaveText("19 / 20 characters");
  await first.app.close();

  // After a restart the Mind still has both, and still shows its count.
  const second = await launchApp(dataDir);
  await second.window.getByTestId("mind-list-item").click();
  await expect(second.window.getByTestId("mind-count-button")).toHaveText("19 / 20 characters");

  await second.window.getByTestId("mind-count-button").click();
  await second.window.getByTestId("mind-count-remove").click();
  await expect(second.window.getByTestId("mind-count-button")).toHaveText("19 characters");
  await expect(second.window.getByTestId("mind-count-progress")).toHaveCount(0);
  await second.app.close();
});

test("the target's field keeps the focus when the menu's toggle event comes late, as on a busy computer", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  await showCountWhileWriting(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("The tide turns at noon.");
  await window.getByTestId("mind-count-button").click();
  const field = window.getByTestId("mind-count-target");
  await field.fill("8,000");
  await expect(field).toBeFocused();
  // The popover's toggle event comes a frame after it shows: here, after the field took the focus.
  await window
    .getByTestId("mind-count-menu")
    .evaluate((menu) =>
      menu.dispatchEvent(new ToggleEvent("toggle", { oldState: "closed", newState: "open" })),
    );
  await expect(field).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("mind-count-progress")).toBeVisible();
  await app.close();
});

/** How long after the next click or key the count read `shown`, measured in the page so the test's own round trips don't add to it. */
async function countShownAfter(window: Page, shown: string, act: () => Promise<void>) {
  // Listening before acting: on a busy computer the click can reach the page before a listener
  // installed alongside it, and the wait would never start.
  await window.evaluate((expected) => {
    (globalThis as { countShown?: Promise<number> }).countShown = new Promise<number>((resolve) => {
      let from: number | null = null;
      const start = (event: Event) => {
        from ??= event.timeStamp;
      };
      document.addEventListener("click", start, true);
      document.addEventListener("keydown", start, true);
      const shown = () =>
        document
          .querySelector('[data-testid="mind-count-button"]')
          ?.textContent?.replace(/\s+/g, " ")
          .trim() === expected;
      const watch = new MutationObserver(() => {
        if (from === null || !shown()) return;
        watch.disconnect();
        document.removeEventListener("click", start, true);
        document.removeEventListener("keydown", start, true);
        resolve(performance.now() - from);
      });
      watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }, shown);
  await act();
  return window.evaluate(() => (globalThis as { countShown?: Promise<number> }).countShown);
}

const COUNTS = {
  en: { empty: "0 words", written: PARAGRAPHS.en, ask: "Write three paragraphs", unit: "words" },
  "zh-CN": { empty: "0 字", written: PARAGRAPHS.zh, ask: "写三段", unit: "字" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`text the assistant wrote is counted once it applies, and Undo and Redo count within 100 ms (${language})`, async () => {
    const { empty, written, ask, unit } = COUNTS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    await showCountWhileWriting(window);
    const button = window.getByTestId("mind-count-button");
    await expect(button).toHaveText(empty);
    const words = (paragraphs: readonly string[]) =>
      countFor(countText(paragraphs.join("\n")), "words");
    const total = words(written);

    await askInAssistant(window, ask);
    await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
    await expect(button).toHaveText(`${total} ${unit}`);

    // Undo is waited on, so its count comes within 100 ms, not after the pause typing gets.
    await window.getByTestId("mind-editor").click();
    const undone = await countShownAfter(window, empty, () =>
      window.keyboard.press("ControlOrMeta+z"),
    );
    expect(undone).toBeLessThan(100);
    const redone = await countShownAfter(window, `${total} ${unit}`, () =>
      window.keyboard.press("ControlOrMeta+Shift+z"),
    );
    expect(redone).toBeLessThan(100);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [1440, 900]) {
    test(`the count fits at the page's bottom left at ${width}px in ${language}`, async () => {
      const { app, window } = await launchApp(dataDir);
      await dismissChatSetup(window);
      await setWindowSize(app, window, width, 700);
      await setLanguage(window, language);
      await newMind(window);
      await nameMind(window, "Tides of the Aldermoor coast");
      await showCountWhileWriting(window);
      await window.getByTestId("mind-editor").click();
      await window.keyboard.type(
        language === "en"
          ? "The tide turns at noon, and again near midnight."
          : "潮水在正午转向，午夜前后再次转向。",
      );
      const button = window.getByTestId("mind-count-button");
      await button.click();
      await expect(
        window.locator('[data-testid="mind-count-basis"][aria-checked="true"]'),
      ).toBeFocused();
      const target = window.getByTestId("mind-count-target");
      await target.click();
      await target.fill(language === "en" ? "8,000" : "3万");
      await target.press("Enter");
      await expect(window.getByTestId("mind-count-progress")).toBeVisible();
      // The count waits for a pause in typing.
      await expect(button).not.toHaveAttribute("data-total", "0");

      // At the page's bottom left, inside it, and nothing scrolls sideways.
      const count = await window.getByTestId("mind-count").boundingBox();
      const page = await window.getByTestId("mind-pane").boundingBox();
      const scroller = await window.locator(".mind-scroller").boundingBox();
      if (!count || !page || !scroller) throw new Error("Not laid out.");
      expect(count.x).toBeGreaterThanOrEqual(page.x);
      expect(count.x + count.width).toBeLessThanOrEqual(page.x + page.width / 2);
      expect(count.y + count.height).toBeLessThanOrEqual(scroller.y + scroller.height);
      expect(count.y).toBeGreaterThan(scroller.y + scroller.height / 2);
      expect(await window.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      if (SCREENSHOTS)
        await window.screenshot({ path: join(SCREENSHOTS, `count-${language}-${width}.png`) });
      await app.close();
    });
  }
}
