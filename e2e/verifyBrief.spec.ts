import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The brief of a document someone else wrote (#3277): once its claims are found, the verifying
 * card opens with what it concludes (plain lines that go to their place in the file), the figures
 * that rests on with their claims' own marks as the checks land, and the claims whose check found
 * no source, with a note while the run fills it in. The scripted model (src/main/fakeChat/) makes
 * each of the first three claims a conclusion and the first three with a figure the figures.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  {
    lines: [
      "Spring and neap tides",
      "Spring tides happen at new moon and at full moon.",
      "Neap tides happen at the quarter moons.",
    ],
  },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const LINES = [
  "Spring tides happen at new and full moon.",
  "Neap tides happen at the quarter moons each month.",
  "Harbours publish the times of high water every 6 months.",
  "Penguins nest on the harbour cliffs for 4 months.",
  "The harbour office needs 3 staff at each high water.",
  "Moorings will cost 120 euros a year.",
  "The council wants 2 new slipways by 2030.",
];

/** The report someone else wrote: seven claims over two pages. */
const REPORT = buildPdf([
  { lines: ["Harbour report", ...LINES.slice(0, 4)] },
  { lines: ["Plans", ...LINES.slice(4)] },
]);

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

const WORDS = {
  en: {
    plus: "Check someone else’s file…",
    concludes: "What it concludes",
    figures: "The figures it rests on",
    noSource: "No source in your Documents",
    filling: "Filling in as the checks finish…",
    none: "None found",
  },
  "zh-CN": {
    plus: "核对别人的文件…",
    concludes: "结论",
    figures: "结论依据的数字",
    noSource: "你的文档中没有出处",
    filling: "核对完成后会补全…",
    none: "没有发现",
  },
} as const;

const WINDOWS = { narrow: [900, 700], wide: [1440, 900] } as const;

for (const [size, [width, height]] of Object.entries(WINDOWS)) {
  for (const language of ["en", "zh-CN"] as const) {
    const words = WORDS[language];
    test(`the card holds the brief: three conclusions, the figures with their marks, and the claims with no source, at ${width} px, in ${language}`, async () => {
      test.setTimeout(120_000);
      await writeFile(join(sources, "Tides.pdf"), TIDES);
      await writeFile(join(sources, "Harbour report.pdf"), REPORT);
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await interceptOpenDialog(app, join(sources, "Harbour report.pdf"));
      await setWindowSize(app, window, width, height);

      await pointAndClick(window, window.getByTestId("plus-menu"));
      await pointAndClick(window, window.getByTestId("plus-more"));
      const item = window.getByTestId("plus-verify-document");
      await expect(item).toHaveText(words.plus);
      await pointAndClick(window, item);

      // Before the checks: the brief is there at once, its figures not checked yet.
      const card = await checkCard(window);
      const brief = card.getByTestId("verify-brief");
      await expect(brief).toBeVisible();
      await expect(card.getByTestId("verify-brief-conclusion")).toHaveCount(3);
      await expect(brief).toContainText(words.concludes);
      await expect(brief).toContainText(words.figures);
      await expect(brief).toContainText(words.noSource);
      await expect(card.getByTestId("verify-brief-figure")).toHaveCount(3);
      await expect(card.getByTestId("verify-brief-no-source")).toHaveCount(0);
      await screenshot(window, `brief-before-${size}-${language}`);

      // As the checks land: the figures take their claims' marks, and the claims with no source are listed.
      await pointAndClick(window, card.getByTestId("verify-check"));
      await expect(card.getByTestId("verify-done")).toBeVisible({ timeout: 60_000 });
      await expect(brief.getByTestId("verify-brief-filling")).toHaveCount(0);
      const marksOfFigures = card.getByTestId("verify-brief-figure");
      await expect(marksOfFigures.first()).toHaveAttribute(
        "data-mark",
        /supported|contradicted|unsupported/,
      );
      expect(await card.getByTestId("verify-brief-no-source").count()).toBeGreaterThan(0);
      await screenshot(window, `brief-after-${size}-${language}`);

      // A claim shown among the figures is not listed again as one with no source.
      const figureTexts = await marksOfFigures.allInnerTexts();
      const noSourceTexts = await card.getByTestId("verify-brief-no-source").allInnerTexts();
      expect(noSourceTexts.filter((text) => figureTexts.includes(text))).toEqual([]);

      // Under the brief the card's one line of counts is the press that shows the rows.
      const summary = card.getByTestId("verify-summary");
      await expect(summary).toHaveAttribute("aria-expanded", "false");
      await expect(card.getByTestId("verify-unsupported")).toHaveCount(0);
      await pointAndClick(window, summary);
      await expect(summary).toHaveAttribute("aria-expanded", "true");
      await expect(card.getByTestId("verify-unsupported")).toBeVisible();
      await pointAndClick(window, summary);
      await expect(card.getByTestId("verify-unsupported")).toHaveCount(0);

      // A conclusion goes to its place in the file.
      await pointAndClick(window, card.getByTestId("verify-brief-conclusion").nth(1));
      await expect(window.getByTestId("mind-editor")).toBeFocused();
      await app.close();
    });
  }
}
