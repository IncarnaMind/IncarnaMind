import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A calculated figure in a note (#439): an Answer's two worked-out figures keep their
 * formula and inputs when added to the note, each an =n marker numbered with the Citations.
 * The one Check recalculates them from their kept inputs; the card opens on hover and from
 * the keyboard, shows the formula in words and with its values and each input with its own
 * check, and Open shows the input's quote in its Document. Convert to text keeps the shown
 * words without the working, and Undo brings the figure back. English wide, Chinese narrow.
 */

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const shot = async (window: Page, name: string) => {
  if (!SHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
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

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`an Answer's two calculated figures keep their working in the note (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    await writeFile(
      join(sources, "Acme annual report 2025.pdf"),
      buildPdf([{ lines: ["Revenue was 1,482.6 in 2025, compared with 1,231.0 in 2024."] }]),
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
      await addDocuments(window, [join(sources, "Acme annual report 2025.pdf")]);
      await setLanguage(window, language);
      await newMind(window);
      const answer = await askInAssistant(
        window,
        language === "en"
          ? "How much did revenue grow, and what share of 2025 was 2024?"
          : "收入增长了多少，2024年占比多少？",
      );
      await addToNote(window, answer);

      const editor = window.getByTestId("mind-editor");
      const figures = editor.getByTestId("calculated-figure");
      await expect(figures).toHaveCount(2);
      await expect(figures.nth(0)).toContainText("20.4%");
      await expect(figures.nth(1)).toContainText("83.0%");
      const markers = editor.getByTestId("calculated-figure-marker");
      await expect(markers.nth(0)).toHaveText(/^=\d+$/);
      await expect(markers.nth(1)).toHaveText(/^=\d+$/);
      const numbers = await markers.allTextContents();
      expect(Number(numbers[1]?.slice(1))).toBeGreaterThan(Number(numbers[0]?.slice(1)));
      await expect(figures.nth(0)).toHaveAttribute("data-state", "not-checked");

      // The one Check recalculates each figure from its kept inputs.
      await runCommand(window, "mind.check", t("mindCheck.command"));
      const ask = window.getByTestId("mind-check-ask");
      await expect(
        ask.or(window.locator('[data-testid="calculated-figure"][data-state="supported"]')),
      ).toBeVisible({ timeout: 30_000 });
      if (await ask.isVisible()) await pointAndClick(window, ask.getByTestId("mind-check-check"));
      await expect(figures.nth(0)).toHaveAttribute("data-state", "supported", { timeout: 60_000 });
      await expect(figures.nth(1)).toHaveAttribute("data-state", "supported");

      // Hover opens the card: the state line, the formula in words and with its values, the inputs.
      await pointAt(window, markers.nth(0));
      const card = window.locator(".calculated-figure-card");
      await expect(card).toBeVisible();
      await expect(card.locator(".calculated-figure-state")).toContainText(
        t("figures.inline.recalculated"),
      );
      const formula = card.locator(".calculated-figure-formula");
      await expect(formula).toContainText("1,482.6");
      await expect(formula).toContainText("1,231.0");
      await expect(card.locator(".calculated-figure-input")).toHaveCount(2);
      await shot(window, `calculated-figure-card-${language}`);
      await window.mouse.move(0, 0);
      await expect(card).toBeHidden();

      // The keyboard opens it too, and Esc closes it back to the marker.
      await markers.nth(1).focus();
      await window.keyboard.press("Enter");
      await expect(card).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await expect(markers.nth(1)).toBeFocused();

      // Open shows the input's quote in its Document, beside the note.
      await markers.nth(0).focus();
      await window.keyboard.press("Enter");
      await pointAndClick(
        window,
        card.locator(".calculated-figure-input").first().getByRole("button").first(),
      );
      await expect(
        window.getByTestId("viewer").locator("[data-quote-highlight]").first(),
      ).toBeVisible({
        timeout: 30_000,
      });

      // Convert to text keeps the shown words without the working; Undo brings the figure back.
      // In a narrow window the Document took the note's place: its tab brings the note back.
      if (!(await editor.isVisible()))
        await pointAndClick(window, window.getByRole("tab", { name: /^(It grew|增长了)/ }));
      await markers.nth(0).focus();
      await window.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await pointAndClick(window, figures.nth(1), { button: "right" });
      await pointAndClick(
        window,
        window.getByRole("menuitem", { name: t("figures.inline.convert") }),
      );
      await expect(figures).toHaveCount(1);
      await expect(editor).toContainText("83.0%");
      await window.keyboard.press("ControlOrMeta+z");
      await expect(figures).toHaveCount(2);
    } finally {
      await app.close();
    }
  });
}
