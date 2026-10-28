import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * Uncited figures are checked in the background (#1445), with the scripted
 * model and no keys: a supported mark, a contradiction, an absence report and
 * Stop after one of two results, in a local model and at both page widths.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const REPORT = "Annual revenue was $1,482.6 million.\n";
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

async function start(width: number) {
  await writeFile(join(sources, "Report.md"), REPORT);
  const running = await launchApp(dataDir, { fakeChat: true });
  const { app, window } = running;
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setWindowSize(app, window, width, 900);
  await addDocuments(window, [join(sources, "Report.md")]);
  return running;
}

for (const width of [1440, 900]) {
  test(`uncited supported and contradicted figures are marked with no click (${width}px)`, async () => {
    const { app, window } = await start(width);
    const supportedAnswer = await askInAssistant(
      window,
      "uncited supported figure, without citing",
    );
    const supported = supportedAnswer.getByTestId("claim-mark");
    await expect(supported).toHaveAttribute("data-check", "supported");
    await screenshot(window, `uncited-supported-${width}`);
    await pointAndClick(window, supported);
    await expect(window.getByTestId("claim-card").getByTestId("claim-quote")).toHaveText(
      REPORT.trim(),
    );
    await expect(supported).not.toHaveAttribute("data-addable", "true");
    await expect(window.getByTestId("claim-card").getByTestId("claim-add-citation")).toHaveCount(0);
    await expect(window.getByTestId("claim-card").getByTestId("claim-open")).toBeVisible();
    await window.keyboard.press("Escape");

    const contradictedAnswer = await askInAssistant(
      window,
      "uncited contradicted figure, without citing",
    );
    const contradicted = contradictedAnswer.getByTestId("claim-mark");
    await expect(contradicted).toHaveAttribute("data-check", "contradicted");
    await screenshot(window, `uncited-contradicted-${width}`);
    await pointAndClick(window, contradicted);
    await expect(window.getByTestId("claim-card").getByTestId("claim-quote")).toHaveText(
      REPORT.trim(),
    );
    await app.close();
  });

  test(`an absence report is never checked (${width}px)`, async () => {
    const { app, window } = await start(width);
    await askInAssistant(window, "I didn't find the 2024 revenue figure, without citing");
    await expect(window.getByTestId("claim-mark")).toHaveCount(0);
    await expect(window.getByTestId("assistant-answer").last()).not.toContainText(
      "Checking claims",
    );
    await app.close();
  });

  test(`Stop after one background result keeps it and the text (${width}px)`, async () => {
    const { app, window } = await start(width);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type("two uncited figures, without citing");
    await window.keyboard.press("Enter");
    const answer = window.getByTestId("assistant-answer").last();
    await expect(answer).toBeVisible();
    await expect(answer).toContainText("Checking uncited figures and quoted facts against Documents…");
    await expect(answer.locator('[data-testid="claim-mark"][data-check="supported"]')).toHaveAttribute(
      "data-check",
      "supported",
    );
    const stop = window.getByTestId("composer").getByTestId("composer-stop");
    await expect(stop).toBeVisible();
    await pointAndClick(window, stop);
    await expect(stop).toHaveCount(0);
    await expect(answer.getByTestId("claim-mark")).toHaveCount(1);
    await expect(answer).toContainText("Annual revenue totaled $1,200 million, forever.");
    await screenshot(window, `uncited-stopped-${width}`);
    await app.close();
  });
}
