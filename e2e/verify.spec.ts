import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  openPageMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Verify (#97): "Verify a document…" in the + menu takes a PDF someone else
 * wrote. It opens beside the Mind made of its text, whose claims are found;
 * the check badge's card checks them, and each gets a mark in the margin.
 * The scripted model (src/main/fakeChat/) takes every sentence but
 * thanks for a claim, finds one supported when it shares three words with a
 * line of a Document, contradicted when it also has a number the line
 * doesn't, unsupported otherwise, and refuses a sentence with "refuse". Set
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
const CONTRADICTED = "Harbours publish the times of high water every 6 months.";
const UNSUPPORTED = "Penguins nest on the harbour cliffs.";
const REFUSED = "The model should refuse to check this line.";
const THANKS = "Thank you for reading this report.";

/** The report someone else wrote: a title, four claims over two pages, and thanks. */
const REPORT = buildPdf([
  { lines: ["Harbour report", SUPPORTED, CONTRADICTED] },
  { lines: [UNSUPPORTED, REFUSED, THANKS] },
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

/** Launches with the scripted model, and the report and the Tides PDF on disk. */
async function launch() {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(join(sources, "Harbour report.pdf"), REPORT);
  const running = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(running.window);
  return running;
}

/** Adds the Tides PDF, if asked, and has the open dialog pick the report. */
async function readyToVerify({ app, window }: Awaited<ReturnType<typeof launch>>, tides = true) {
  if (tides) await addDocuments(window, [join(sources, "Tides.pdf")]);
  await interceptOpenDialog(app, join(sources, "Harbour report.pdf"));
}

/** "Verify a document…" from the + menu. */
async function verifyFromPlusMenu(window: Page, label: string) {
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  const item = window.getByTestId("plus-verify-document");
  await expect(item).toHaveText(label);
  await pointAndClick(window, item);
}

const marks = (window: Page) => window.getByTestId("claim-mark");

test("Verify a PDF: its Mind opens beside it, its claims are checked, and the counts say how it went", async () => {
  const running = await launch();
  const { app, window } = running;
  await useLocalChatModel(window);
  await readyToVerify(running);
  await setWindowSize(app, window, 1440, 900);

  await verifyFromPlusMenu(window, "Verify a document…");

  await expect(frontMindName(window)).toHaveText("Checking: Harbour report");
  // The question opens the badge's card by itself.
  const ask = window.getByTestId("check-card").getByTestId("verify-ask");
  await expect(ask).toBeVisible();
  const card = await checkCard(window);
  // The PDF is open beside the Mind, on the right, as a tab of its own.
  const viewer = window.getByTestId("viewer");
  await expect(viewer).toBeVisible();
  const editor = window.getByTestId("mind-editor");
  expect((await viewer.boundingBox())?.x ?? 0).toBeGreaterThan(
    (await editor.boundingBox())?.x ?? 0,
  );
  const check = ask.getByTestId("verify-check");
  await expect(check).toHaveText("Check 4 claims");
  await expect(ask).toContainText("Check it against your Documents?");
  await expect(window.getByTestId("check-badge-open")).toHaveAccessibleName(
    "Sentences and Citations: 4 claims not checked yet",
  );
  // A model on this computer costs nothing: no estimate.
  await expect(ask.getByTestId("verify-estimate")).toHaveCount(0);
  await screenshot(window, "verify-start-en");
  await expect(
    window
      .getByTestId("document-list-item")
      .filter({ hasText: "Harbour report" })
      .getByTestId("document-not-cited"),
  ).toHaveText("Not cited");

  await pointAndClick(window, check);

  // Need a look is only what the checks found; the claim no model checked is a row of its own.
  const done = card.getByTestId("verify-done");
  await expect(done).toContainText("Checked 3 of 4 claims · 2 need a look");
  await expect(done.getByTestId("verify-contradicted")).toContainText("1 contradicted");
  await expect(done.getByTestId("verify-unsupported")).toContainText("1 unsupported");
  await expect(done.getByTestId("verify-notChecked")).toContainText("1 not checked");
  await expect(done.getByTestId("verify-supported")).toContainText("1 supported");
  await expect(marks(window)).toHaveCount(4);
  await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(1);
  await expect(marks(window).and(window.locator('[data-check="contradicted"]'))).toHaveCount(1);
  await expect(marks(window).and(window.locator('[data-check="unsupported"]'))).toHaveCount(1);
  const notChecked = marks(window).and(window.locator('[data-check="not-checked"]'));
  await expect(notChecked).toHaveAccessibleName("Sentence check: Not checked");
  await screenshot(window, "verify-results-en");

  // Where its text came from is in the page's ⋯ menu.
  const pageMenu = await openPageMenu(window);
  await expect(pageMenu.getByTestId("page-from")).toHaveText("From Harbour report");
  await window.keyboard.press("Escape");
  await expect(pageMenu).toBeHidden();

  // The claim the model failed on says why, with Check again.
  await pointAndClick(window, notChecked);
  const claimCard = window.getByTestId("claim-card");
  await expect(claimCard.getByTestId("claim-reason")).toHaveText("The model declined to check it.");
  await window.keyboard.press("Escape");

  // The PDF being verified holds every claim of it: no card calls it a copy that was left out.
  await pointAndClick(window, marks(window).and(window.locator('[data-check="unsupported"]')));
  await expect(claimCard).toBeVisible();
  await expect(claimCard.getByTestId("claim-left-out")).toHaveCount(0);
  // Someone else's words: the claim can be kept as the User's view, never cut.
  await expect(claimCard.getByTestId("claim-keep")).toBeVisible();
  await expect(claimCard.getByTestId("claim-cut-sentence")).toHaveCount(0);
  await window.keyboard.press("Escape");

  // A contradicted claim can be kept as the User's view too.
  await pointAndClick(window, marks(window).and(window.locator('[data-check="contradicted"]')));
  await expect(claimCard).toBeVisible();
  await expect(claimCard.getByTestId("claim-keep")).toBeVisible();
  await window.keyboard.press("Escape");

  // Each row goes to the next claim of its kind.
  const caretIn = () =>
    editor.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest("p")?.textContent);
  await pointAndClick(window, (await checkCard(window)).getByTestId("verify-notChecked"));
  await expect(editor).toBeFocused();
  await expect.poll(caretIn).toContain(REFUSED);
  await pointAndClick(window, done.getByTestId("verify-contradicted"));
  await expect.poll(caretIn).toContain(CONTRADICTED);
  await pointAndClick(window, done.getByTestId("verify-unsupported"));
  await expect.poll(caretIn).toContain(UNSUPPORTED);

  // Editing a claim makes its check need a re-check, as Find support's do: a row of its own.
  const first = editor.locator(":scope > p").nth(1);
  await slideSelect(window, first, "Spring");
  await window.keyboard.type("Some spring");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  await checkCard(window);
  await expect(done.getByTestId("verify-recheck")).toContainText("1 needs re-check");
  await expect(done).toContainText("2 need a look");
  await pointAndClick(window, done.getByTestId("verify-recheck"));
  await expect.poll(caretIn).toContain("Some spring tides");

  // A claim the model refused is still not checked once it is edited: it never counts as checked.
  const refused = editor.locator(":scope > p").filter({ hasText: REFUSED });
  await slideSelect(window, refused, "refuse");
  await window.keyboard.type("decline");
  await expect(
    editor.locator(":scope > p").filter({ hasText: "should decline to check" }),
  ).toHaveCount(1);
  await checkCard(window);
  await expect(done.getByTestId("verify-notChecked")).toContainText("1 not checked");
  await expect(done.getByTestId("verify-recheck")).toContainText("1 needs re-check");
  await expect(done).toContainText("Checked 3 of 4 claims");
  await pointAndClick(window, done.getByTestId("verify-notChecked"));
  await expect.poll(caretIn).toContain("should decline to check");
});

/** The report of #690: 18 claims the Stations PDF supports, 2 it contradicts, and 4 the model won't check. */
const STATIONS = [
  "Alder",
  "Birch",
  "Cedar",
  "Elm",
  "Fir",
  "Hazel",
  "Larch",
  "Maple",
  "Oak",
  "Pine",
  "Rowan",
  "Spruce",
  "Willow",
  "Yew",
  "Ash",
  "Beech",
  "Holly",
  "Juniper",
].map((name) => `The ${name} station records the tide every morning.`);
const FERRIES = "Ferries leave the harbour 4 times a day.";
const LONG_REPORT = [
  ...STATIONS,
  CONTRADICTED,
  FERRIES,
  ...["one", "two", "three", "four"].map((n) => `The model should refuse to check line ${n}.`),
];

test("Twenty-four claims, two contradicted and four the model fails on: the card counts each apart, in English and Chinese; a run that checks none never reads as checked", async () => {
  await writeFile(
    join(sources, "Stations.pdf"),
    buildPdf([
      { lines: [...STATIONS.slice(0, 9)] },
      { lines: [...STATIONS.slice(9), "Ferries leave the harbour 9 times a day."] },
    ]),
  );
  await writeFile(
    join(sources, "Station report.pdf"),
    buildPdf([0, 8, 16].map((from) => ({ lines: LONG_REPORT.slice(from, from + 8) }))),
  );
  await writeFile(
    join(sources, "Refusals.pdf"),
    buildPdf([
      { lines: ["Please refuse this one.", "Then refuse this one.", "And refuse the last one."] },
    ]),
  );
  const running = await launch();
  const { app, window } = running;
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Stations.pdf")]);
  await setWindowSize(app, window, 1440, 900);

  await interceptOpenDialog(app, join(sources, "Station report.pdf"));
  await verifyFromPlusMenu(window, "Verify a document…");
  const card = window.locator('[data-testid="check-card"]:visible');
  await expect(card.getByTestId("verify-ask")).toBeVisible();
  await pointAndClick(window, card.getByTestId("verify-check"));
  const done = card.getByTestId("verify-done");
  await expect(done).toContainText("Checked 20 of 24 claims · 2 need a look", {
    timeout: 60_000,
  });
  await expect(done.getByTestId("verify-notChecked")).toContainText("4 not checked");
  await screenshot(window, "verify-counts-en");
  await setLanguage(window, "zh-CN");
  await expect(done).toContainText("已核对 20/24 条说法 · 2 条需要留意");
  await expect(done.getByTestId("verify-notChecked")).toContainText("4 条未核对");
  await screenshot(window, "verify-counts-zh");
  await setLanguage(window, "en");

  await interceptOpenDialog(app, join(sources, "Refusals.pdf"));
  await verifyFromPlusMenu(window, "Verify a document…");
  await expect(frontMindName(window)).toHaveText("Checking: Refusals");
  // The question opens the card by itself once the claims are found.
  await expect(card.getByTestId("verify-ask")).toBeVisible();
  await pointAndClick(window, card.getByTestId("verify-check"));
  await expect(done).toContainText("Checked 0 of 3 claims");
  await expect(done.getByTestId("verify-notChecked")).toContainText("3 not checked");
  await expect(done.getByTestId("verify-contradicted")).toHaveCount(0);
  await expect(done.getByTestId("verify-unsupported")).toHaveCount(0);
});

test("In Chinese and a narrow window: the same, in Chinese", async () => {
  const running = await launch();
  const { app, window } = running;
  await useLocalChatModel(window);
  await readyToVerify(running);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);

  await verifyFromPlusMenu(window, "核对文档…");

  await expect(window.getByTestId("check-card").getByTestId("verify-ask")).toBeVisible();
  const card = await checkCard(window);
  await expect(card).toContainText("要对照你的文档核对吗？");
  await expect(card.getByTestId("verify-check")).toHaveText("核对 4 条说法");
  // The card keeps to the Mind's side: its right edge at the badge's, the PDF's tab beside it.
  const cardBox = await card.boundingBox();
  const badgeBox = await window.getByTestId("check-badge").boundingBox();
  expect((cardBox?.x ?? 0) + (cardBox?.width ?? 0)).toBeLessThanOrEqual(
    (badgeBox?.x ?? 0) + (badgeBox?.width ?? 0) + 1,
  );
  await screenshot(window, "verify-start-zh-narrow");

  await pointAndClick(window, card.getByTestId("verify-check"));
  const done = card.getByTestId("verify-done");
  await expect(done).toContainText("已核对 3/4 条说法 · 2 条需要留意");
  await expect(marks(window)).toHaveCount(4);
  await screenshot(window, "verify-results-zh-narrow");
  const pageMenu = await openPageMenu(window);
  await expect(pageMenu.getByTestId("page-from")).toHaveText("来自 Harbour report");
});

const STATEMENT = join(__dirname, "../tests/fixtures/organize/files/2025年度财务报表.pdf");

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a PDF's tables keep their rows and columns, and each row's mark is level with it (${language}, ${width}px)`, async () => {
    await writeFile(join(sources, "Fleet ledger.md"), "# 车队台账\n\n车队共有冷链车 42 台。\n");
    const running = await launch();
    const { app, window } = running;
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 820);
    await addDocuments(window, [join(sources, "Fleet ledger.md")]);
    await interceptOpenDialog(app, STATEMENT);
    await verifyFromPlusMenu(window, language === "en" ? "Verify a document…" : "核对文档…");

    const editor = window.getByTestId("mind-editor");
    const tables = editor.locator("table");
    await expect(tables).toHaveCount(3);
    const row = tables.first().locator("tr").filter({ hasText: "固定资产" });
    await expect(row.locator("td")).toHaveText(["固定资产", "9,470", "8,860"]);
    await expect(tables.first().locator("th")).toHaveText(["项目", "期末余额", "期初余额"]);
    await expect(editor.locator("p").filter({ hasText: "3,145应收账款" })).toHaveCount(0);
    const [above, below] = await Promise.all([
      tables.first().locator("tr").nth(1).locator("td").nth(1).boundingBox(),
      row.locator("td").nth(1).boundingBox(),
    ]);
    expect(Math.abs((above?.x ?? 0) - (below?.x ?? 1))).toBeLessThan(1);
    expect(below?.y ?? 0).toBeGreaterThan(above?.y ?? 0);
    await screenshot(window, `verify-tables-${language}`);

    const card = await checkCard(window);
    await pointAndClick(window, card.getByTestId("verify-check"));
    await expect(card.getByTestId("verify-done")).toBeVisible({ timeout: 30_000 });
    const claimed = row.locator("td").first().locator("[data-claim-check]");
    await expect(claimed).toHaveText("固定资产");
    await expect(row.locator("td").nth(1).locator("[data-claim-check]")).toHaveCount(0);
    const id = await claimed.getAttribute("data-claim-check");
    const mark = window.locator(`[data-testid="claim-mark"][data-claim="${id}"]`);
    await expect(mark).toHaveAttribute("data-check", "unsupported");
    const [markBox, rowBox] = await Promise.all([mark.boundingBox(), row.boundingBox()]);
    const middle = (markBox?.y ?? 0) + (markBox?.height ?? 0) / 2;
    expect(middle).toBeGreaterThan(rowBox?.y ?? 0);
    expect(middle).toBeLessThan((rowBox?.y ?? 0) + (rowBox?.height ?? 0));
    await screenshot(window, `verify-tables-checked-${language}`);
  });
}

test("Empty states: nothing to check against, then no claims found", async () => {
  const running = await launch();
  const { app, window } = running;
  await useLocalChatModel(window);
  await readyToVerify(running, false);
  await setWindowSize(app, window, 1440, 900);

  await verifyFromPlusMenu(window, "Verify a document…");
  const card = window.getByTestId("check-card");
  // The PDF is the only Document, and it is never its own evidence.
  await expect(card.getByTestId("verify-empty")).toHaveText(
    "Nothing to check against: add Documents first",
  );
  await expect(card.getByTestId("verify-add-files")).toHaveText("Add files…");

  const thanks = buildPdf([{ lines: ["Thank you all for coming.", "Thanks again for the help."] }]);
  await writeFile(join(sources, "Thanks.pdf"), thanks);
  // The report is listed already: the Tides PDF joins it.
  await window.getByTestId("add-documents-input").setInputFiles([join(sources, "Tides.pdf")]);
  const tides = window.getByTestId("document-list-item").filter({ hasText: "Tides" });
  await expect(tides).toHaveAttribute("data-status", "ready");
  await interceptOpenDialog(app, join(sources, "Thanks.pdf"));
  await verifyFromPlusMenu(window, "Verify a document…");
  // The first Mind's tab stays open behind it.
  await expect(frontMindName(window)).toHaveText("Checking: Thanks");
  // Nothing to check: the card opens by itself to say so.
  await expect(card.getByTestId("verify-empty")).toHaveText("No claims found");
});

test("a provider failure while finding the claims is worded like an Answer's, with its next step (#764)", async () => {
  const running = await launch();
  const { app, window } = running;
  // The scripted model fails as one its provider doesn’t know.
  await useLocalChatModel(window, "ghost-claims-not-found");
  await readyToVerify(running);
  await setWindowSize(app, window, 1440, 900);

  await verifyFromPlusMenu(window, "Verify a document…");

  const failure = window.getByTestId("answer-error");
  await expect(failure).toHaveAttribute("data-error-kind", "model");
  await expect(failure).toContainText("doesn’t know");
  await expect(failure.getByTestId("answer-error-action")).toBeVisible();
  await expect(window.getByTestId("verify-problem")).toHaveCount(0);
  await app.close();
});

test("a check that fails says why in the interface language, and again in the other after a switch (#627)", async () => {
  const running = await launch();
  const { app, window } = running;
  await useLocalChatModel(window);
  await readyToVerify(running);
  await setWindowSize(app, window, 1440, 900);
  await verifyFromPlusMenu(window, "Verify a document…");
  const card = window.getByTestId("check-card");
  await expect(card.getByTestId("verify-ask")).toBeVisible();

  // The core refuses the check as it does a Mind that verifies nothing: its sentence, and its wording after it.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("core:verifyClaims");
    ipcMain.handle("core:verifyClaims", () => {
      const refused = new Error(
        `This Mind doesn't verify a document.\n\u2063wording:${JSON.stringify({ key: "error.verify.notVerifying" })}`,
      );
      refused.name = "InvalidInputError";
      throw refused;
    });
  });
  await pointAndClick(window, card.getByTestId("verify-check"));
  const problem = window.getByTestId("verify-problem");
  await expect(problem).toContainText("Couldn’t check: This Mind doesn’t verify a document.");
  await setLanguage(window, "zh-CN");
  await expect(problem).toContainText("无法核对：这个 Mind 没有在核对文档。");
  await setLanguage(window, "en");
  await expect(problem).toContainText("Couldn’t check: This Mind doesn’t verify a document.");
  await app.close();
});
