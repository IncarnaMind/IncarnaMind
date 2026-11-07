import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * Words an Answer puts in quotation marks that the cited page doesn't have
 * (#483): the Citation shows "Quote not found" though its own quote is on the
 * page, and its card sets the Answer's words beside the page's nearest. The
 * scripted model quotes the clause after the page line's colon or comma with
 * the word before it joined on, as Claude Haiku 5.5 did: “培训覆盖率达到98%”
 * against “安全培训，覆盖率达到98%”.
 *
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** Three pages; the line about training is on page 3. */
const SAFETY_REPORT = buildPdf([
  { lines: ["Site safety report", "This report covers the harbour sites."] },
  { lines: ["Incidents", "No lost-time incidents were recorded."] },
  { lines: ["Training", "Safety training: coverage reached 98% of site staff."] },
]);

/** The line is the first the scripted model reads, which is the one it quotes when a Question shares no word with it. */
const CHINESE_REPORT = buildPdf([{ chineseLines: ["安全培训，覆盖率达到98%。"] }]);

const CASES = {
  en: {
    file: "Safety report.pdf",
    contents: SAFETY_REPORT,
    question: "What does the report say about training coverage? Use quotation marks.",
    badge: "Quote not found on p. 3",
    answerLabel: "In the Answer",
    closestLabel: "Closest words on p. 3",
    answer: "“training coverage reached 98% of site staff”",
    missing: "training ",
    closest: "“Safety training: coverage reached 98% of site staff.”",
    matched: "coverage reached 98% of site staff",
  },
  "zh-CN": {
    file: "安全生产报告.pdf",
    contents: CHINESE_REPORT,
    question: "报告怎么说？请用引号引用。",
    badge: "未在第 1 页找到引文",
    answerLabel: "回答中",
    closestLabel: "第 1 页最接近的文字",
    answer: "“培训覆盖率达到98%”",
    missing: "培训",
    closest: "“安全培训，覆盖率达到98%。”",
    matched: "覆盖率达到98%",
  },
} as const;

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

/** Opens the card of the last Answer's one Citation. */
async function openCard(window: Page) {
  const answer = assistantAnswers(window).last();
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveCount(1);
  await citation.getByTestId("citation-chip").click();
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  return { answer, citation, card };
}

for (const language of ["en", "zh-CN"] as const) {
  const wanted = CASES[language];
  for (const width of [900, 1600]) {
    test(`words in quotation marks that the page lacks show Quote not found, and the card sets both texts side by side, at ${width}px in ${language}`, async () => {
      await writeFile(join(sources, wanted.file), wanted.contents);
      const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
      await setWindowSize(app, window, width, 900);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, wanted.file)]);
      await newMind(window);
      await window.getByTestId("mind-editor").click();

      await askInAssistant(window, wanted.question);
      const { answer, citation, card } = await openCard(window);

      // The Answer shows the words in quotation marks; the page has the Citation's own quote, but not these.
      await expect(answer.getByTestId("assistant-answer-text")).toContainText(wanted.answer);
      await expect(citation).toHaveAttribute("data-check", "not-found");
      await expect(citation).toHaveAttribute("data-reason", "quoted-words-not-on-pages");
      await expect(card.getByTestId("citation-badge")).toHaveText(wanted.badge);

      // The card shows the Answer's words with the missing ones washed, above the page's with the match washed.
      const inAnswer = card.getByTestId("citation-answer-words");
      const onPage = card.getByTestId("citation-closest-words");
      await expect(inAnswer).toContainText(wanted.answerLabel);
      await expect(inAnswer.locator("blockquote")).toHaveText(wanted.answer);
      await expect(inAnswer.locator(".citation-card-wash")).toHaveText(wanted.missing);
      await expect(onPage).toContainText(wanted.closestLabel);
      await expect(onPage.locator("blockquote")).toHaveText(wanted.closest);
      await expect(onPage.locator(".citation-card-match")).toHaveText(wanted.matched);
      await expect(card.getByTestId("citation-reason")).toBeVisible();

      // Relations, not pixels: the Answer's words sit above the page's, neither overlaps the other,
      // and the whole card is inside the window and clips nothing.
      const boxes = await Promise.all([card, inAnswer, onPage].map((each) => each.boundingBox()));
      const [cardBox, answerBox, pageBox] = boxes;
      expect(cardBox && answerBox && pageBox).toBeTruthy();
      expect((answerBox?.y ?? 0) + (answerBox?.height ?? 0)).toBeLessThanOrEqual(pageBox?.y ?? 0);
      expect(cardBox?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((cardBox?.x ?? 0) + (cardBox?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );

      if (SCREENSHOTS) {
        await expect(card).toHaveCSS("opacity", "1");
        await window.screenshot({
          path: join(SCREENSHOTS, `quoted-words-${language}-${width}.png`),
        });
      }
      await app.close();
    });
  }
}

test("a quote the page has, with the same Question asked without quotation marks, stays found", async () => {
  await writeFile(join(sources, CASES.en.file), CASES.en.contents);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, CASES.en.file)]);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  await askInAssistant(window, "What does the report say about training coverage?");

  const { citation, card } = await openCard(window);
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(card.getByTestId("citation-badge")).toHaveText("Quote found on p. 3");
  await expect(card.getByTestId("citation-answer-words")).toHaveCount(0);
  await app.close();
});
