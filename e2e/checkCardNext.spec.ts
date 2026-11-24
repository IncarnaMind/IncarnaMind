import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Next in the check card, with the card open down from the badge at the Note's top right (#3677):
 * a sentence further down lands in the room under the card; one in the Note's first lines, which
 * no scroll can clear, has the card make way, and the walk goes on from it, never over again.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LINE = {
  en: "The ferry crossing from Kestrel Bay is the town's link to the mainland, and its timetable shapes the morning for most people who live on the quay.",
  "zh-CN":
    "凯斯特雷尔湾的渡轮是小镇通往大陆的通道，它的时刻表决定了住在码头附近大多数人的早晨怎么安排，晚点一次大家就都赶不上火车。",
};

/** The index of the paragraph the caret is in. */
const caretParagraph = (window: Page) =>
  window
    .getByTestId("mind-editor")
    .evaluate((dom) =>
      (dom as unknown as { editor: Editor }).editor.state.selection.$head.index(0),
    );

/** Whether a line of the caret's paragraph is under the check card. */
const underCard = (window: Page) =>
  window.evaluate(() => {
    const card = document.querySelector('[data-testid="check-card"]')?.getBoundingClientRect();
    const node = document.getSelection()?.anchorNode;
    const paragraph = (node instanceof Element ? node : node?.parentElement)?.closest("p");
    if (!card || !paragraph) return false;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    return [...range.getClientRects()].some(
      (line) =>
        line.width > 0 &&
        line.left < card.right &&
        card.left < line.right &&
        line.top < card.bottom &&
        card.top < line.bottom,
    );
  });

for (const [language, width] of [
  ["en", 900],
  ["zh-CN", 900],
  ["en", 1440],
  ["zh-CN", 1440],
] as const) {
  test(`Next makes way for a sentence in the Note's first lines and goes on from it; further down it lands clear of the card (${language}, ${width})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    await newMind(window);
    await window.getByTestId("mind-editor").evaluate((dom, text) => {
      (dom as unknown as { editor: Editor }).editor.commands.setContent(
        Array.from({ length: 30 }, () => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        })),
      );
    }, LINE[language]);
    const badge = window.getByTestId("check-badge-open");
    const card = window.getByTestId("check-card");
    const next = card.getByTestId("health-toCheck");

    // The first sentence is in the Note's first lines, under the card: the card makes way, and the
    // keyboard is at that sentence.
    await pointAndClick(window, badge);
    await pointAndClick(window, next);
    await expect(card).toHaveCount(0);
    expect(await caretParagraph(window)).toBe(0);
    await expect(window.getByTestId("mind-editor")).toBeFocused();

    // Opened again, Next goes on to the following sentence, never back to the first.
    let at = 0;
    for (let press = 0; press < 6; press++) {
      if ((await card.count()) === 0) await pointAndClick(window, badge);
      await pointAndClick(window, next);
      const now = await caretParagraph(window);
      expect(now, "the walk goes on").toBe(at + 1);
      at = now;
      // Wherever it lands, the sentence is never left under an open card.
      if ((await card.count()) > 0) expect(await underCard(window)).toBe(false);
    }
    // Further down, it lands in the room under the card, which stays open.
    await expect(card).toBeVisible();
    await app.close();
  });
}
