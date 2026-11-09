import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { agreement, firstClauses, type Language } from "../tests/helpers/sameTextAgreements";
import { printedPdf, wordOf } from "../tests/helpers/sameTextFiles";
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
} from "./app";

/*
 * Verify (#2216): a PDF of the Word file being checked, already in the Library, holds the
 * same text in other bytes. It is never the check's evidence, and a claim's card names it with
 * its reason. The scripted model (src/main/fakeChat/) supports a claim only when a line of a
 * Document it is handed shares three words with it, and the other Document shares none.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = "# Tides\n\nSpring tides happen at new moon and at full moon.\n";

const CASES: readonly {
  language: Language;
  ui: "en" | "zh-CN";
  name: string;
  copy: string;
  line: string;
}[] = [
  {
    language: "en",
    ui: "en",
    name: "Services Agreement",
    copy: "Services Agreement (signed)",
    line: "Also in “Services Agreement (signed)”, same text as this file: not counted",
  },
  {
    language: "zh",
    ui: "zh-CN",
    name: "技术服务合同",
    copy: "技术服务合同（签署版）",
    line: "也出现在“技术服务合同（签署版）”（与此文件的文字相同）中，未计为依据",
  },
];

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

for (const each of CASES) {
  test(`Verify a Word file whose PDF is in the Library: the PDF is left out and named on the claim's card (${each.language})`, async () => {
    const file = firstClauses(agreement(each.language), 1);
    const word = join(sources, `${each.name}.docx`);
    const pdf = join(sources, `${each.copy}.pdf`);
    const tides = join(sources, "Tides.md");
    await writeFile(word, wordOf(file, each.language));
    await writeFile(pdf, printedPdf([file], each.language).bytes);
    await writeFile(tides, TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, each.ui);
    await useLocalChatModel(window);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [pdf, tides]);
    await interceptOpenDialog(app, word);

    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-more"));
    await pointAndClick(window, window.getByTestId("plus-verify-document"));
    await expect(frontMindName(window)).toContainText(each.name);
    const ask = window.getByTestId("check-card").getByTestId("verify-ask");
    await expect(ask).toBeVisible();
    const card = await checkCard(window);
    await pointAndClick(window, ask.getByTestId("verify-check"));
    await expect(card.getByTestId("verify-done")).toBeVisible({ timeout: 60_000 });

    // Its own PDF never supports the file's claims: none is supported, and each is unsupported.
    const marks = window.getByTestId("claim-mark");
    await expect(marks.and(window.locator('[data-check="supported"]'))).toHaveCount(0);
    const unsupported = marks.and(window.locator('[data-check="unsupported"]'));
    await expect(unsupported.first()).toBeVisible();
    await window.keyboard.press("Escape");
    await pointAndClick(window, unsupported.first());
    const claimCard = window.getByTestId("claim-card");
    await expect(claimCard).toBeVisible();
    await expect(claimCard.getByTestId("claim-left-out")).toHaveText(each.line);
    await screenshot(window, `same-text-${each.language}`);
  });
}
