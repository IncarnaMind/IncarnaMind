import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Check this Note (#1624): a sentence whose check starts while the model still names the rest
 * shows the checking mark in the margin at once, before the Note itself is marked; the run's line
 * counts once its total is known. The scripted model holds its sort after the first sentence it names until the
 * test releases it. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

const TIDES = buildPdf([
  {
    lines: [
      "Harbour times",
      "Spring tides come at new moon and at full moon.",
      "The harbour office opens at nine in the morning.",
    ],
  },
]);

const NOTE =
  "Spring tides come at new moon and at full moon. The harbour office opens at nine in the morning. Penguins nest on the cliffs above the harbour.";

type SlowCheck = { incarnamindSlowCheck: { holdSort: boolean; release(): void } };

const holdSort = (app: ElectronApplication, hold: boolean) =>
  app.evaluate((_, on) => {
    const { incarnamindSlowCheck } = globalThis as unknown as SlowCheck;
    incarnamindSlowCheck.holdSort = on;
    if (!on) incarnamindSlowCheck.release();
  }, hold);

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

/** A model on a service, which checks several sentences at once, the Tides PDF, and the Note open. */
async function harbourNotes(app: ElectronApplication, window: Page, language: "en" | "zh-CN") {
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  // A model on this computer checks one sentence at a time, so the sort holds the only place.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) await core.allowDataFlow("checks", provider.service.id);
  });
  await setLanguage(window, language);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await mindWrittenBefore(window, "Harbour notes", [{ note: NOTE }]);
  await window.getByTestId("mind-list-item").filter({ hasText: "Harbour notes" }).click();
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a sentence whose check starts while the claims are named shows as checking (${language})`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await harbourNotes(app, window, language);

      await holdSort(app, true);
      await runCommand(window, "mind.check", translate(language, "mindCheck.command"));
      const early = window.getByTestId("claim-mark-early");
      await expect(early).toHaveCount(1, { timeout: 30_000 });
      await expect(window.getByTestId("claim-mark")).toHaveCount(0);
      // The line keeps saying the claims are being found until the run's total is known.
      await expect(window.getByTestId("badge-progress").first()).toHaveText(
        translate(language, "verify.finding"),
      );
      // Beside its paragraph's first line, in the margin.
      const line = await window.getByTestId("mind-editor").locator("p").first().boundingBox();
      const mark = await early.boundingBox();
      if (!line || !mark) throw new Error("The sentence or its mark isn't drawn.");
      expect(mark.y).toBeLessThan(line.y + line.height);
      expect(mark.x).toBeGreaterThan(line.x + line.width);
      if (SCREENSHOTS) {
        await motionSettled(window);
        await window.screenshot({ path: join(SCREENSHOTS, `early-check-${language}.png`) });
      }

      await holdSort(app, false);
      await expect(window.getByTestId("claim-mark")).toHaveCount(3, { timeout: 30_000 });
      await expect(early).toHaveCount(0);
      await expect(
        window.getByTestId("claim-mark").and(window.locator('[data-check="checking"]')),
      ).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await app.close();
    }
  });
}

test("Stop while the claims are named takes the early checking mark away, and leaves the Note unmarked", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await harbourNotes(app, window, "en");
    await holdSort(app, true);
    await runCommand(window, "mind.check", translate("en", "mindCheck.command"));
    const early = window.getByTestId("claim-mark-early");
    await expect(early).toHaveCount(1, { timeout: 30_000 });

    await pointAndClick(window, window.getByTestId("badge-stop").first());
    await holdSort(app, false);
    await expect(window.getByTestId("badge-progress")).toHaveCount(0, { timeout: 30_000 });
    await expect(early).toHaveCount(0);
    await expect(window.getByTestId("claim-mark")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
