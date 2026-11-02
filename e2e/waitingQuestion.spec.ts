import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  createDataFolder,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A Question asked with no model set waits where it was typed, and the app still does what it
 * can first (#763): the line says it waits for an AI model and offers Choose, the setup card it
 * opens takes the cursor, and a local search shows what the Documents say meanwhile. English and
 * Chinese, at 900 and 1,600 px.
 */

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

const TIDE = "The tide tables are read every spring.";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function shot(window: Page, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}

/** The first own Question with no model set: the setup card comes up and the Question waits. */
async function askWithNoModel(window: Page, question: string) {
  await newMind(window);
  await window.getByTestId("mind-editor").focus();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  const card = window.getByTestId("model-setup");
  await expect(card).toBeVisible();
  return card;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`with no model, the Question waits with Choose and the passages local search found (${language})`, async () => {
    test.setTimeout(120_000);
    const path = join(sources, "Tide.txt");
    await writeFile(path, TIDE);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    try {
      await setWindowSize(app, window, 900, 700);
      await setLanguage(window, language);
      await addDocuments(window, [path]);
      const card = await askWithNoModel(window, "What do the tide tables say?");

      const waiting = window.getByTestId("assistant-waiting-model");
      await expect(waiting).toHaveText(
        `${translate(language, "setup.waiting")} · ${translate(language, "status.choose")}`,
      );
      await expect(window.getByTestId("found-passages")).toContainText(
        translate(language, "answer.found"),
      );
      const passage = window.getByTestId("found-passage").first();
      await expect(passage.getByTestId("found-passage-document")).toContainText("Tide");
      await expect(passage.getByTestId("found-passage-text")).toContainText("tide tables");
      await shot(window, `waiting-${language}-900`);

      // Choose brings the setup card's field the cursor, where the User already is.
      await window.getByTestId("mind-editor").click();
      await pointAndClick(window, window.getByTestId("assistant-waiting-choose"));
      await expect(card.getByTestId("setup-key")).toBeFocused();

      // The same words and passages hold in a wide window, and the line stays inside it.
      await setWindowSize(app, window, 1600, 900);
      await expect(waiting).toBeVisible();
      await expect(window.getByTestId("found-passage").first()).toBeVisible();
      const [lineBox, size] = await Promise.all([
        waiting.boundingBox(),
        window.evaluate(() => ({ width: innerWidth })),
      ]);
      expect((lineBox?.x ?? 0) + (lineBox?.width ?? 0)).toBeLessThanOrEqual(size.width);
      await shot(window, `waiting-${language}-1600`);
    } finally {
      await app.close();
    }
  });
}

test("a Question whose words nothing matches still waits, with the way to choose a model", async () => {
  test.setTimeout(120_000);
  const path = join(sources, "Tide.txt");
  await writeFile(path, TIDE);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  try {
    await setWindowSize(app, window, 900, 700);
    await setLanguage(window, "en");
    await addDocuments(window, [path]);
    await askWithNoModel(window, "What is the capital of Finland?");
    await expect(window.getByTestId("assistant-waiting-model")).toBeVisible();
    await expect(window.getByTestId("assistant-waiting-choose")).toBeVisible();
    // Nothing matched: no empty list is drawn under the Question.
    await expect(window.getByTestId("found-passages")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
