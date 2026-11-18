import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { encryptedOfficeFile } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import { plainDeck } from "../tests/helpers/pptx";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  verifyRows,
} from "./app";

/*
 * Verify a deck (#3275): "Check someone else’s file…" takes a PowerPoint deck as it takes a PDF.
 * Its slides become the Mind beside it, a table a table and the speaker notes after; each claim
 * is checked, and going to one turns the deck to its slide. The scripted model
 * (src/main/fakeChat/) finds a claim supported when it shares three words with a line of a
 * Document, contradicted when it also has a number the line doesn't, unsupported otherwise. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SUPPORTED = "Spring tides happen at new and full moon.";
const UNSUPPORTED = "Penguins nest on the harbour cliffs.";
const CONTRADICTED = "Harbours publish the times of high water every 6 months.";

/** The deck someone sent: a title slide, two claims as bullets with one in the notes, a slide of nothing, a table. */
const DECK = plainDeck([
  { title: "Harbour review" },
  { title: "Tides", lines: [SUPPORTED, UNSUPPORTED] },
  {},
  {
    title: "Moorings",
    table: [
      ["Berth", "Boats", "Fee (£)"],
      ["North quay", "42", "1,260"],
    ],
    notes: [CONTRADICTED],
  },
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

async function verifyFromPlusMenu(window: Page, label: string) {
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  const item = window.getByTestId("plus-verify-document");
  await expect(item).toHaveText(label);
  await pointAndClick(window, item);
}

for (const language of ["en", "zh-CN"] as const) {
  const words =
    language === "en"
      ? {
          command: "Check someone else’s file…",
          name: "Checking: Harbour review",
          check: "Check 4 claims",
          done: "Checked 4 claims · 3 need a look",
          locked: "That file needs a password, so it couldn’t be read.",
        }
      : {
          command: "核对别人的文件…",
          name: "核对：Harbour review",
          check: "核对 4 条说法",
          done: "已核对 4 条说法 · 3 条需要留意",
          locked: "这个文件需要密码，无法读取。",
        };

  test(`Verify a deck (${language}): its slides are checked like a PDF's pages, a claim goes to its slide, and a deck with a password says so`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    await writeFile(join(sources, "Harbour review.pptx"), DECK);
    await writeFile(join(sources, "Locked.pptx"), encryptedOfficeFile());
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, "Tides.pdf")]);

      // A deck saved with a password makes no Mind, and says why where it was picked.
      await interceptOpenDialog(app, join(sources, "Locked.pptx"));
      await verifyFromPlusMenu(window, words.command);
      await expect(window.getByTestId("error-notice")).toContainText(words.locked);
      await pointAndClick(window, window.getByTestId("error-notice-dismiss"));

      await interceptOpenDialog(app, join(sources, "Harbour review.pptx"));
      await verifyFromPlusMenu(window, words.command);
      await expect(frontMindName(window)).toHaveText(words.name);

      // The deck is beside the Mind; a title is a heading, the table a table, the notes after it.
      const viewer = window.getByTestId("viewer");
      await expect(viewer.getByTestId("viewer-slide")).toHaveCount(4);
      const editor = window.getByTestId("mind-editor");
      await expect(editor.locator(":scope > h2")).toHaveText([
        "Harbour review",
        "Tides",
        "Moorings",
      ]);
      await expect(editor.locator("table tr")).toHaveCount(2);
      await expect(editor.locator(":scope > p").last()).toHaveText(CONTRADICTED);

      const ask = window.getByTestId("check-card").getByTestId("verify-ask");
      const check = ask.getByTestId("verify-check");
      await expect(check).toHaveText(words.check);
      await pointAndClick(window, check);
      const card = await checkCard(window);
      await expect(card.getByTestId("verify-done")).toContainText(words.done);
      await screenshot(window, `verify-deck-${language}`);

      // The contradicted claim is in slide 4's speaker notes: its row turns the deck to slide 4.
      await pointAndClick(window, (await verifyRows(window)).getByTestId("verify-contradicted"));
      await expect(viewer.locator('[data-testid="viewer-slide"][data-slide="4"]')).toBeInViewport();
      await screenshot(window, `verify-deck-slide-${language}`);
    } finally {
      await app.close();
    }
  });
}
