import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  capture,
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
  useLocalChatModel,
} from "./app";

/**
 * A contradiction the check couldn't confirm (#2184): the card says a passage may say otherwise,
 * then what the check found, then the quote it rested on, never a bare Unsupported. The scripted
 * model finds the sentence contradicted (a number the line doesn't write), then judges its
 * confirmation neither, as it does a sentence that says "not confirmed".
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

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const SENTENCE = "Harbours publish the times of high water every 6 months, not confirmed.";

const WORDS = {
  en: { line: "A passage may say otherwise, but the check couldn’t confirm it." },
  "zh-CN": { line: "有段落的说法可能与此不同，但核对未能确认。" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`the card of a contradiction the check couldn't confirm says so, then what it found, then the quote (${language})`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(SENTENCE);
    const line = editor.locator(":scope > p").first();
    await slideSelect(window, line, "Harbours publish", { line, words: "confirmed." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(1);
    await expect(marks.first()).toHaveAttribute("data-check", "unsupported");
    await motionSettled(window);

    await pointAndClick(window, marks.first());
    const card = window.getByTestId("claim-card");
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "unsupported");
    await expect(card.getByTestId("claim-not-confirmed")).toHaveText(WORDS[language].line);
    await expect(card.getByTestId("claim-why")).toContainText(
      "Harbours publish the times of high water every 12 months",
    );
    await expect(card.getByTestId("claim-quote")).toContainText(
      "Harbours publish the times of high water every 12 months.",
    );
    await expect(card.getByTestId("claim-nothing")).toHaveCount(0);
    await expect(card.getByTestId("claim-differs")).toHaveCount(0);
    // The line, then the check's words, then the Citation.
    const order = await card
      .locator(
        '[data-testid="claim-not-confirmed"], [data-testid="claim-why"], [data-testid="claim-quote"]',
      )
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
    expect(order).toEqual(["claim-not-confirmed", "claim-why", "claim-quote"]);
    await capture(window, `not-confirmed-card-${language}`);
    await app.close();
  });
}
