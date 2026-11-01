import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { dcfWorkbook } from "../tests/helpers/financeWorkbooks";
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
 * A workbook's own formulas (#2347): asked what drives 2027 EBITDA in a DCF and what it would be
 * at 3% growth, the Answer gives the figure traced through the workbook's formulas and the figure
 * worked out again with the growth input changed. Added to the note, each card shows the
 * figure's formula chain and its inputs cited to their cells; the what-if's names the input it
 * changed and the value the workbook has. Tied out, each is checked against the workbook and the
 * what-if's row names its change. The workbook's file is unchanged. English wide, Chinese narrow.
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
  test(`a workbook figure's card shows its formula chain and a what-if's changed input (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    const file = join(sources, "DCF model.xlsx");
    await writeFile(file, dcfWorkbook().xlsx());
    const before = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
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
      await addDocuments(window, [file]);
      await setLanguage(window, language);
      await newMind(window);
      const answer = await askInAssistant(
        window,
        language === "en"
          ? "What drives 2027 EBITDA, and what if growth is 3%?"
          : "2027 年的 EBITDA 由什么驱动？如果增长率是 3% 呢？",
      );
      await addToNote(window, answer);

      const editor = window.getByTestId("mind-editor");
      const figures = editor.getByTestId("calculated-figure");
      await expect(figures).toHaveCount(2);
      await expect(figures.nth(0)).toContainText("254.7");
      await expect(figures.nth(1)).toContainText("240.4");

      const markers = editor.getByTestId("calculated-figure-marker");
      const card = window.locator(".calculated-figure-card");
      await pointAt(window, markers.nth(0));
      await expect(card).toBeVisible();
      await expect(card.locator(".calculated-figure-state")).toContainText(
        t("figures.workbook.workedOut"),
      );
      const chain = card.locator(".calculated-figure-formula");
      await expect(chain).toContainText("DCF!E5 = E4*Margin");
      await expect(chain).toContainText("DCF!E4 = D4*(1+Growth)");
      await expect(card.locator(".calculated-figure-input")).toHaveCount(3);
      await expect(card).toContainText("Assumptions!B4");
      await shot(window, `workbook-figure-chain-${language}`);
      await window.mouse.move(0, 0);
      await expect(card).toBeHidden();

      await pointAt(window, markers.nth(1));
      await expect(card).toBeVisible();
      await expect(card).toContainText(
        t("figures.workbook.change", {
          input: "Revenue growth (Growth)",
          cell: "Assumptions!B4",
          from: "5.0%",
          to: "3.0%",
        }),
      );
      await expect(card).toContainText(t("figures.workbook.inWorkbook", { value: "254.7" }));
      await expect(card).toContainText(t("figures.workbook.note"));
      await shot(window, `workbook-figure-what-if-${language}`);
      await window.mouse.move(0, 0);
      await expect(card).toBeHidden();

      // Tied out, each figure is checked against the workbook, and the what-if is named as one.
      const schedule = window.getByTestId("figure-schedule");
      await runCommand(window, "mind.tieOut", t("figures.command"));
      const ask = window.getByTestId("mind-check-ask");
      await expect(ask.or(schedule).first()).toBeVisible({ timeout: 30_000 });
      if (await ask.isVisible()) await pointAndClick(window, ask.getByTestId("mind-check-check"));
      // The "3%" the Answer writes is a figure of the Note too, a row of its own.
      const rows = schedule.locator("tbody tr[data-figure-id]");
      await expect(rows).toHaveCount(3);
      const row = (figure: string) =>
        rows.filter({ has: window.locator(".figure-main-button", { hasText: figure }) });
      for (const figure of ["254.7", "240.4"])
        await expect(row(figure).locator(".figure-status")).toContainText(
          t("claim.state.supported"),
          { timeout: 60_000 },
        );
      await expect(row("254.7").locator(".figure-source")).toHaveText(
        `${t("figures.calculated")} · DCF!E5 = E4*Margin`,
      );
      await expect(row("240.4").locator(".figure-source")).toContainText(
        t("figures.workbook.whatIfFormula", {
          cell: "DCF!E5",
          formula: "E4*Margin",
          input: "Revenue growth (Growth)",
          from: "5.0%",
          to: "3.0%",
        }),
      );
      await shot(window, `workbook-figure-schedule-${language}`);

      expect(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ).toBe(before);
    } finally {
      await app.close();
    }
  });
}
