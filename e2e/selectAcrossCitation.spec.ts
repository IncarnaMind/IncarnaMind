import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  launchApp,
  leaveFirstOpen,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A Shift-press extends a Note's selection to where it landed, through a
 * Citation and past it (#2279). The browser's own extension goes by the last
 * selection's granularity: after a double-click that is a word, so a press
 * just past a Citation could keep the word alone, and a Citation's marker
 * takes its own press before the editor hears it.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const editor = (window: Page) => window.getByTestId("mind-pane").getByTestId("mind-editor");

/** What the User sees selected, and whether it covers the first Citation. */
const selection = (window: Page) =>
  window.evaluate(() => {
    const chosen = getSelection();
    const citation = document.querySelector('[data-testid="citation"]');
    return {
      text: String(chosen?.toString()),
      covers: citation !== null && (chosen?.containsNode(citation, true) ?? false),
      cards: document.querySelectorAll('[data-testid="citation-card"]').length,
    };
  });

/** Presses Shift and clicks at a point, as a person does. */
async function shiftClick(window: Page, x: number, y: number): Promise<void> {
  await window.keyboard.down("Shift");
  try {
    await window.mouse.move(x, y, { steps: 4 });
    await window.mouse.down();
    await window.mouse.up();
  } finally {
    await window.keyboard.up("Shift");
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Shift-press just after a Citation, or on it, extends the selection through it (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      // A wide window in English, a narrow one in Chinese.
      await setWindowSize(app, window, language === "en" ? 1600 : 900, 900);
      await setLanguage(window, language);
      await leaveFirstOpen(window);
      const chip = editor(window).getByTestId("citation-chip").first();
      await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
      await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = await chip.boundingBox();
      if (!box) throw new Error("The Citation isn't on screen.");
      const y = box.y + box.height / 2;
      // The last character of the word before the Citation, as the User sees it.
      const word = await window.evaluate(() => {
        const citation = document.querySelector('[data-testid="citation"]');
        const before = citation?.closest(".node-citation")?.previousSibling;
        if (!(before instanceof Text)) return null;
        let index = before.data.length - 1;
        while (index >= 0 && /\s/.test(before.data[index] ?? "")) index--;
        if (index < 0) return null;
        const range = document.createRange();
        range.setStart(before, index);
        range.setEnd(before, index + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      if (!word) throw new Error("No word before the Citation.");

      // Double-click the word; the selection menu is the state a person's pause sees.
      await window.mouse.dblclick(word.x, word.y);
      await expect(window.getByTestId("selection-menu")).toBeVisible();
      const worded = await selection(window);
      expect(worded.covers).toBe(false);
      const typed = worded.text.trim();
      expect(typed).not.toBe("");

      // A Shift-press just after the Citation takes the word, the Citation and the text
      // after it, every time.
      await shiftClick(window, box.x + box.width + 4, y);
      const past = await selection(window);
      expect(past.covers).toBe(true);
      expect(past.text.trim().startsWith(typed)).toBe(true);
      expect(past.text.length).toBeGreaterThan(worded.text.length);

      // One landing on the Citation itself extends to it too, and opens nothing: the card
      // the pointer showed closes away from it, and no page is opened.
      await window.keyboard.press("Escape");
      await window.mouse.dblclick(word.x, word.y);
      await expect(window.getByTestId("selection-menu")).toBeVisible();
      await shiftClick(window, box.x + box.width - 2, y);
      expect((await selection(window)).covers).toBe(true);
      await window.mouse.move(box.x - 15, box.y - 120);
      await expect(window.getByTestId("citation-card")).toHaveCount(0);
      await expect(window.getByTestId("viewer")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
