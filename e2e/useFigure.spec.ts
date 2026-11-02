import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * A sentence whose stated number doesn't match the figure the check worked
 * out offers Use {figure} (#1247): it changes only that number, keeps the
 * sentence's Citation and checks the sentence again. The undo line and ⌘Z
 * bring back the number and the check it had. The button isn't offered when
 * the figure agrees or when two numbers are written alike. English and
 * Chinese.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
/** Waits for the check and the card's motion to finish, then saves the window when asked. */
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

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

const FIGURE = "1.31x";

const WORDS = {
  en: {
    use: `Use ${FIGURE}`,
    done: `Changed to ${FIGURE}`,
    stated: "The sentence says 1.1x.",
  },
  "zh-CN": {
    use: `改为 ${FIGURE}`,
    done: `已改为 ${FIGURE}`,
    stated: "这句话写的是 1.1x。",
  },
} as const;

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a figure that doesn't recompute is used, with Undo, and is not offered when it agrees or is written twice (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    await writeFile(
      join(sources, "Board update.pdf"),
      buildPdf([
        {
          lines: ["Board update", "Net debt was $1,234m and EBITDA was $942m at the end of 2025."],
        },
      ]),
    );
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, width, 900);
      await dismissChatSetup(window);
      // A model measured to use calculate (ADR-0021): the scripted model answers in its place.
      await acceptPlainTextKeys(window);
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-haiku-5-5",
        });
      });
      await addDocuments(window, [join(sources, "Board update.pdf")]);
      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      await editor.click();
      const cited = "Net debt to EBITDA was fine at the end of 2025.";
      const agreeing = "Net debt to EBITDA was 1.3x at the end of 2025.";
      const twice = "Net debt to EBITDA was 1.1x in 2025 and 1.1x in 2024.";
      await window.keyboard.type(`${cited} ${agreeing} ${twice}`);
      const line = editor.locator(":scope > p").first();
      await expect(line).toHaveText(`${cited} ${agreeing} ${twice}`);

      // Check all three: a Passage backs the first, the two figures that agree settle their
      // sentences, the one written twice doesn't.
      await slideSelect(window, line, "Net debt", { line, words: "in 2024." });
      const menu = window.getByTestId("selection-menu");
      await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
      const marks = window.getByTestId("claim-mark");
      await expect(marks).toHaveCount(3, { timeout: 30_000 });
      await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
      await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");
      await expect(marks.nth(2)).toHaveAttribute("data-check", "contradicted");

      await setLanguage(window, language);
      const card = window.getByTestId("claim-card");

      // A figure that agrees is worked out, and the card offers no Use.
      await pointAndClick(window, marks.nth(1));
      await expect(card.getByTestId("claim-sentence")).toContainText(agreeing);
      await expect(card.getByTestId("claim-working")).toBeVisible();
      await expect(card.getByTestId("claim-use-figure")).toHaveCount(0);
      await window.keyboard.press("Escape");

      // Two numbers written alike can't be told apart: the card shows the working and offers no Use.
      await pointAndClick(window, marks.nth(2));
      await expect(card.getByTestId("claim-sentence")).toContainText(twice);
      await expect(card.getByTestId("claim-stated")).toBeVisible();
      await expect(card.getByTestId("claim-use-figure")).toHaveCount(0);
      await expect(card.getByTestId("claim-keep")).toBeVisible();
      await screenshot(window, `use-figure-two-numbers-${language}`);
      await window.keyboard.press("Escape");

      // A Citation goes on the first sentence, as a person cites it.
      await pointAndClick(window, marks.nth(0));
      await expect(card.getByTestId("claim-add-citation")).toBeVisible();
      await pointAndClick(window, card.getByTestId("claim-add-citation"));
      const citation = line.getByTestId("citation");
      await expect(citation).toHaveAttribute("data-check", "found");

      // Its number is changed to one the Documents don't give, and it is checked again.
      await slideSelect(window, line, "fine");
      await window.keyboard.type("1.1x");
      await slideSelect(window, line, "Net debt", { line, words: "2025" });
      await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
      await expect(marks).toHaveCount(3, { timeout: 30_000 });
      await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");
      const earlier = await marks.nth(0).getAttribute("data-claim");
      expect(earlier).toBeTruthy();

      // The card offers Use {figure}; the other fixes stay as they were.
      await pointAndClick(window, marks.nth(0));
      await expect(card.getByTestId("claim-sentence")).toContainText("1.1x at the end of 2025");
      await expect(card.getByTestId("claim-stated")).toHaveText(WORDS[language].stated);
      const use = card.getByTestId("claim-use-figure");
      await expect(use).toHaveText(WORDS[language].use);
      await expect(card.getByTestId("claim-keep")).toBeVisible();
      await screenshot(window, `use-figure-offered-${language}`);

      // Use changes only the number, keeps the Citation and checks the sentence again.
      await pointAndClick(window, use);
      await expect(card).toBeHidden();
      await expect(line).toContainText("was 1.31x at the end of 2025");
      await expect(line).not.toContainText("was 1.1x at");
      await expect(citation).toHaveAttribute("data-check", "found");
      await expect(window.getByTestId("undo-line")).toContainText(WORDS[language].done);
      await expect(marks.nth(0)).toHaveAttribute("data-check", "supported", { timeout: 30_000 });
      await expect(marks.nth(0)).not.toHaveAttribute("data-claim", earlier ?? "");
      await screenshot(window, `use-figure-used-${language}`);

      // The undo line brings back the number and the check it had.
      await pointAndClick(window, window.getByTestId("undo-line").getByTestId("undo-action"));
      await expect(line).toContainText("was 1.1x at the end of 2025");
      await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");
      await expect(marks.nth(0)).toHaveAttribute("data-claim", earlier ?? "");

      // ⌘Z too (the window's Undo where the card's action left the focus, the note's where it stayed in).
      await pointAndClick(window, marks.nth(0));
      await pointAndClick(window, card.getByTestId("claim-use-figure"));
      await expect(marks.nth(0)).toHaveAttribute("data-check", "supported", { timeout: 30_000 });
      await window.keyboard.press("ControlOrMeta+z");
      await expect(line).toContainText("was 1.1x at the end of 2025");
      await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");
      await expect(marks.nth(0)).toHaveAttribute("data-claim", earlier ?? "");
      // ⇧⌘Z does it again, and checks the sentence again as Use did (#2402); ⌘Z takes it back.
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect(line).toContainText("was 1.31x at the end of 2025");
      await expect(marks.nth(0)).toHaveAttribute("data-check", "supported", { timeout: 30_000 });
      await window.keyboard.press("ControlOrMeta+z");
      await expect(line).toContainText("was 1.1x at the end of 2025");
      await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");

      // Keep as my view still works beside it.
      await expect(marks).toHaveCount(3);
      await pointAndClick(window, marks.nth(2));
      await expect(card).toBeVisible();
      await pointAndClick(window, card.getByTestId("claim-keep"));
      await expect(marks).toHaveCount(2);
    } finally {
      await app.close();
    }
  });
}
