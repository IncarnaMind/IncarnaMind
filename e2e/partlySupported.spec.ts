import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
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
  useLocalChatModel,
} from "./app";

/**
 * A sentence with no Citation that a Document states only part of (#1608):
 * its card says what the Documents support and what they don't, quotes the
 * Passage the check read, and offers to open it, never that the sentence
 * wasn't found; a sentence nothing states says where the check looked. The
 * scripted model records the line it read for a sentence `PARTLY_UNCITED`
 * lists, then names what it covers and what it doesn't.
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

const CLAUSE =
  "The Employee may work from home two days a week, agreed in advance with the manager.";
const AGREEMENT = buildPdf([{ lines: ["Hours and place of work", CLAUSE] }]);
const STAFF = "Staff may work from home two days a week.";
const UNRELATED = "Penguins nest on the harbour cliffs.";

const WORDS = {
  en: {
    covers:
      "Your Documents support home working two days a week, not the parts about staff in general.",
    nothing: "I didn’t find this in “All Documents”.",
    open: "Open the page",
  },
  "zh-CN": {
    covers: "你的文档支持home working two days a week，但不支持staff in general的部分。",
    nothing: "未在“全部文档”中找到。",
    open: "打开该页",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`the card of a sentence the Documents state part of says what they support, with the quote (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Agreement.pdf"), AGREEMENT);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Agreement.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(`${STAFF} ${UNRELATED}`);
    const line = editor.locator(":scope > p").first();
    await slideSelect(window, line, "Staff may", { line, words: "cliffs." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveAttribute("data-check", "unsupported");
    await expect(marks.nth(1)).toHaveAttribute("data-check", "unsupported");
    await motionSettled(window);
    const card = window.getByTestId("claim-card");

    await pointAndClick(window, marks.first());
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "unsupported");
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${STAFF}”`);
    await expect(card.getByTestId("claim-covers")).toHaveText(words.covers);
    await expect(card.getByTestId("claim-quote")).toHaveText(CLAUSE);
    await expect(card.getByTestId("claim-nothing")).toHaveCount(0);
    await expect(card.getByTestId("claim-differs")).toHaveCount(0);
    await expect(card.getByTestId("claim-open")).toHaveText(words.open);
    await pointAndClick(window, card.getByTestId("claim-open"));
    await expect(window.getByTestId("viewer")).toBeVisible();

    await pointAndClick(window, marks.nth(1));
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${UNRELATED}”`);
    await expect(card.getByTestId("claim-nothing")).toHaveText(words.nothing);
    await expect(card.getByTestId("claim-covers")).toHaveCount(0);
    await expect(card.getByTestId("claim-quote")).toHaveCount(0);
    await app.close();
  });
}
