import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, ReferencePatch } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import { paragraph, run, tracked, wordFile } from "../tests/helpers/word";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  importWordFromMenu,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Checking the User's own sentences (#96): select sentences, then Check
 * against Documents in the selection menu. Each sentence
 * gets a mark in the margin, its card says what was found, and the check
 * badge's card counts them. The scripted model (see
 * src/main/fakeChat/checks.ts) finds a sentence supported when it shares three
 * words with a line of a Document, contradicted when it also has a number the
 * line doesn't, and otherwise unsupported. Set INCARNAMIND_SCREENSHOTS to a
 * folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SUPPORTED = "Spring tides happen at new and full moon.";
const UNSUPPORTED = "Penguins nest on the harbour cliffs.";
const CONTRADICTED = "Harbours publish the times of high water every 6 months.";
const BLANK = "This line asks the model for a blank reply.";
const LIGHTHOUSES = "Lighthouses guide ships past rocks at night.";

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

/** Launches with the scripted model and the Tides PDF to check against. */
async function launchWithTides() {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const running = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(running.window);
  return running;
}

/** A new Mind with one paragraph of these sentences, once the Tides PDF is added. */
async function mindWithSentences(window: Page, sentences: readonly string[]) {
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(sentences.join(" "));
  const line = editor.locator(":scope > p").first();
  await expect(line).toHaveText(sentences.join(" "));
  return { editor, line };
}

/** Selects from the line's first words to its last, with the mouse, and chooses an action in the menu. */
async function checkAll(window: Page, line: Locator, first: string, last: string, action: string) {
  await slideSelect(window, line, first, { line, words: last });
  const menu = window.getByTestId("selection-menu");
  await expect(menu.getByTestId(`selection-action-${action}`)).toBeVisible();
  await pointAndClick(window, menu.getByTestId(`selection-action-${action}`));
}

const marks = (window: Page) => window.getByTestId("claim-mark");

/** A journal article's record, as its Cite as panel would set it: a paper, so the Mind cites a work. */
const PAPER_RECORD: ReferencePatch = {
  type: "article-journal",
  title: "Tides and the Moon",
  authors: [{ family: "Bowler", given: "Diana E." }],
  issued: "2010",
  containerTitle: "Ocean Review",
};

/** Sets a Document's reference record, as its "Cite as" panel would. */
const setRecord = (window: Page, documentId: string, patch: ReferencePatch) =>
  window.evaluate(
    ([id, fields]) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateReference(
        id,
        fields,
      ),
    [documentId, patch] as const,
  );

test("Check against Documents on two sentences with no Citation: one is supported and its Citation is added, the other is marked unsupported", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { editor, line } = await mindWithSentences(window, [SUPPORTED, UNSUPPORTED]);
  await setWindowSize(app, window, 1440, 900);
  await expect((await checkCard(window)).getByTestId("health-toCheck")).toContainText(
    "2 claims not checked yet",
  );

  await checkAll(window, line, "Spring tides", "harbour cliffs.", "check-against-documents");

  await expect(marks(window)).toHaveCount(2);
  const supported = marks(window).and(window.locator('[data-check="supported"]'));
  const unsupported = marks(window).and(window.locator('[data-check="unsupported"]'));
  await expect(supported).toHaveAttribute("data-addable", "true");
  await expect(supported).toHaveAccessibleName("Sentence check: Supported");
  await expect(unsupported).toHaveAccessibleName("Sentence check: Needs a look · Not found");
  // Each mark sits in the margin, right of the text, the first above the second.
  const lineBox = await line.boundingBox();
  const supportedBox = await supported.boundingBox();
  const unsupportedBox = await unsupported.boundingBox();
  expect(supportedBox?.x ?? 0).toBeGreaterThan((lineBox?.x ?? 0) + (lineBox?.width ?? 0));
  expect(unsupportedBox?.y ?? 0).toBeGreaterThan(supportedBox?.y ?? 0);
  // The unsupported sentence is washed; the badge's card counts both.
  await expect(line.locator(".claim-wash--unsupported")).toHaveText(UNSUPPORTED);
  await expect((await checkCard(window)).getByTestId("health-unsupported")).toContainText(
    "1 claim needs a look",
  );
  await expect((await checkCard(window)).getByTestId("health-noCitation")).toContainText(
    "1 claim with no Citation",
  );
  await screenshot(window, "check-results-en");

  // The unsupported sentence's card says where it looked.
  await pointAndClick(window, unsupported);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-badge")).toHaveText("Needs a look · Not found");
  await expect(card.getByTestId("claim-nothing")).toHaveText(
    "I didn’t find this in “All Documents”.",
  );
  await window.keyboard.press("Escape");
  await expect(card).toBeHidden();

  // The supported one shows the Passage found, and adds it as the sentence's Citation in one click.
  await pointAt(window, supported);
  await expect(card.getByTestId("claim-badge")).toHaveText("Supported");
  await expect(card.getByTestId("claim-quote")).toHaveText(
    "Spring tides happen at new moon and at full moon.",
  );
  await screenshot(window, "check-supported-card-en");
  await pointAndClick(window, card.getByTestId("claim-add-citation"));

  const citation = line.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(marks(window)).toHaveCount(1);
  // ⌘Z takes it back in one step: the check's mark returns; ⌘⇧Z adds the Citation again.
  await window.keyboard.press("ControlOrMeta+z");
  await expect(citation).toHaveCount(0);
  await expect(supported).toBeVisible();
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(line).toHaveText(`${SUPPORTED.slice(0, -1)} 1. ${UNSUPPORTED}`);
  await expect(marks(window)).toHaveCount(1);
  await expect((await checkCard(window)).getByTestId("health-found")).toContainText(
    "1 Citation found",
  );
  await expect((await checkCard(window)).getByTestId("health-noCitation")).toHaveCount(0);

  // Editing the unsupported sentence makes its check need a re-check; Check again checks it.
  await slideSelect(window, line, "Penguins");
  await window.keyboard.type("Gulls");
  await expect(marks(window)).toHaveAttribute("data-check", "needs-recheck");
  // Its Citation's check stands for the supported sentence, which has no mark now; the edited one is to check too.
  await expect((await checkCard(window)).getByTestId("health-toCheck")).toContainText(
    "2 claims not checked yet",
  );
  await screenshot(window, "check-recheck-en");
  await pointAndClick(window, marks(window));
  await expect(card.getByTestId("claim-reason")).toHaveText(
    "The sentence has changed since it was checked.",
  );
  await pointAndClick(window, card.getByTestId("claim-check-again"));
  await expect(marks(window)).toHaveAttribute("data-check", "unsupported");
  await expect((await checkCard(window)).getByTestId("health-unsupported")).toContainText(
    "1 claim needs a look",
  );
  await expect(editor).toContainText("Gulls nest on the harbour cliffs.");
});

test("Find sources… waits in the card's ⋯, and is a button only in a Mind that cites a paper or book", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { line } = await mindWithSentences(window, [SUPPORTED, UNSUPPORTED]);
  await setRecord(window, await documentIdOf(window, "Tides"), PAPER_RECORD);
  await setWindowSize(app, window, 1440, 900);
  await checkAll(window, line, "Spring tides", "harbour cliffs.", "check-against-documents");
  await expect(marks(window)).toHaveCount(2);
  const supported = marks(window).and(window.locator('[data-check="supported"]'));
  const unsupported = marks(window).and(window.locator('[data-check="unsupported"]'));
  const card = window.getByTestId("claim-card");

  // Before the Mind cites the paper, Find sources is only in the ⋯.
  await pointAndClick(window, unsupported);
  await expect(card.getByTestId("claim-find-sources")).toHaveCount(0);
  await pointAndClick(window, card.getByTestId("check-menu"));
  await expect(card.getByTestId("check.findSources")).toBeVisible();
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await expect(card).toBeHidden();

  // A Citation of the paper makes the Mind one that cites a work.
  await pointAndClick(window, supported);
  await pointAndClick(window, card.getByTestId("claim-add-citation"));
  await expect(line.getByTestId("citation")).toHaveAttribute("data-check", "found");
  await pointAndClick(window, unsupported);
  await expect(card.getByTestId("claim-find-sources")).toBeVisible();
  await expect(card.getByTestId("claim-find-sources")).toHaveText("Find sources");
  await pointAndClick(window, card.getByTestId("check-menu"));
  await expect(card.getByTestId("check.findSources")).toBeVisible();
  await app.close();
});

test("The selection menu has one check, Check against Documents, and no Find support", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { line } = await mindWithSentences(window, [SUPPORTED, UNSUPPORTED]);
  await setWindowSize(app, window, 1440, 900);

  await slideSelect(window, line, "Spring tides", { line, words: "harbour cliffs." });

  const menu = window.getByTestId("selection-menu");
  await expect(menu.getByTestId("selection-action-check-against-documents")).toHaveText(
    "Check against Documents",
  );
  await expect(menu.getByTestId("selection-action-find-support")).toHaveCount(0);
  await app.close();
});

test("a card opened while its sentence is still checking stays open when the result arrives, until Esc, and a click after it opens it again", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  // "slowly" makes the scripted check report slowly, so the card is opened while it checks.
  const { line } = await mindWithSentences(window, [`${UNSUPPORTED.slice(0, -1)} slowly.`]);
  await setWindowSize(app, window, 1440, 900);
  await checkAll(window, line, "Penguins", "slowly.", "check-against-documents");

  // Clicked while it checks, its card opens.
  const checking = marks(window).and(window.locator('[data-check="checking"]'));
  await expect(checking).toHaveCount(1);
  await pointAndClick(window, checking);
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-check", "checking");

  // The result arriving keeps the card open, showing it.
  const unsupported = marks(window).and(window.locator('[data-check="unsupported"]'));
  await expect(unsupported).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-check", "unsupported");
  await expect(card.getByTestId("claim-badge")).toHaveText("Needs a look · Not found");
  await expect(card.getByTestId("claim-nothing")).toHaveText(
    "I didn’t find this in “All Documents”.",
  );

  // Esc closes it; a click after the check opens it again, and Esc closes that too.
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await pointAndClick(window, unsupported);
  await expect(card).toHaveAttribute("data-check", "unsupported");
  await expect(card.getByTestId("claim-badge")).toHaveText("Needs a look · Not found");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await app.close();
});

test("In Chinese and a narrow window: Check against Documents marks a contradiction and a sentence it couldn't check", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { line } = await mindWithSentences(window, [CONTRADICTED, BLANK]);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await expect((await checkCard(window)).getByTestId("health-toCheck")).toContainText(
    "2 条说法待核对",
  );

  await slideSelect(window, line, "Harbours publish", { line, words: "blank reply." });
  const menu = window.getByTestId("selection-menu");
  await expect(menu.getByTestId("selection-action-check-against-documents")).toHaveText(
    "对照文档核对",
  );
  await expect(menu.getByTestId("selection-action-find-support")).toHaveCount(0);
  await screenshot(window, "check-menu-zh-narrow");
  await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));

  const contradicted = marks(window).and(window.locator('[data-check="contradicted"]'));
  const notChecked = marks(window).and(window.locator('[data-check="not-checked"]'));
  await expect(contradicted).toBeVisible();
  // A sentence not checked yet has no mark on the page; its card opens from the row.
  await expect(notChecked).toBeHidden();
  // In a narrow Mind the marks keep to the gutter right of the text.
  const lineBox = await line.boundingBox();
  const markBox = await contradicted.boundingBox();
  expect(markBox?.x ?? 0).toBeGreaterThanOrEqual((lineBox?.x ?? 0) + (lineBox?.width ?? 0));
  await expect(line.locator(".claim-wash--contradicted")).toHaveText(CONTRADICTED);
  await expect((await checkCard(window)).getByTestId("health-contradicted")).toContainText(
    "1 条说法与文档矛盾",
  );
  await expect((await checkCard(window)).getByTestId("health-toCheck")).toContainText(
    "1 条说法待核对",
  );
  await screenshot(window, "check-results-zh-narrow");
  // In a narrow window the card covers the margin: Esc puts it away.
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("check-card")).toHaveCount(0);

  await pointAndClick(window, contradicted);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-badge")).toHaveText("需要留意：与文档矛盾");
  await expect(card.getByTestId("claim-says")).toContainText(
    "Harbours publish the times of high water every 12 months.",
  );
  await expect(card.getByTestId("claim-quote")).toHaveText(
    "Harbours publish the times of high water every 12 months.",
  );
  await screenshot(window, "check-contradicted-card-zh-narrow");
  await window.keyboard.press("Escape");

  await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
  await expect(card.getByTestId("claim-reason")).toHaveText("模型的回复是空的。");
  await expect(card.getByTestId("claim-check-again")).toHaveText("重新核对");

  // Each row of the badge's card moves to its sentence.
  await window.keyboard.press("Escape");
  await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
  await expect(window.getByTestId("mind-editor")).toBeFocused();
});

test("A figure the Documents don't state is worked out from theirs: a wrong multiple is contradicted and a right one supported, each card showing the working and its inputs, in English and Chinese (#707)", async () => {
  await writeFile(
    join(sources, "Board update.pdf"),
    buildPdf([
      {
        lines: ["Board update", "Net debt was $1,234m and EBITDA was $942m at the end of 2025."],
      },
    ]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // A model measured to use calculate (ADR-0021): the scripted model answers in its place.
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
  });
  await addDocuments(window, [join(sources, "Board update.pdf")]);
  await newMind(window);
  const wrong = "Net debt to EBITDA was 1.1x at the end of 2025.";
  const right = "Net debt to EBITDA was 1.3x at the end of 2025.";
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(`${wrong} ${right}`);
  const line = editor.locator(":scope > p").first();
  await checkAll(window, line, "Net debt", "1.3x at the end of 2025.", "check-against-documents");

  const contradicted = marks(window).and(window.locator('[data-check="contradicted"]'));
  const supported = marks(window).and(window.locator('[data-check="supported"]'));
  await expect(contradicted).toBeVisible({ timeout: 15_000 });
  await expect(supported).toBeVisible();
  // Its inputs are what it rests on, not one Passage to add as the sentence's Citation.
  await expect(supported).not.toHaveAttribute("data-addable");

  await pointAndClick(window, contradicted);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-badge")).toHaveText("Needs a look · Contradicted");
  const working = card.getByTestId("claim-working");
  await expect(working).toContainText("Calculated from your Documents");
  await expect(working.getByTestId("claim-figure")).toHaveText("$1,234m ÷ $942m = 1.31x");
  await expect(working.getByTestId("claim-stated")).toHaveText("The sentence says 1.1x.");
  const inputs = working.getByTestId("claim-input");
  await expect(inputs).toHaveCount(2);
  await expect(inputs.first()).toContainText("$1,234m");
  await expect(inputs.first()).toContainText("Board update");
  await screenshot(window, "check-calculated-contradicted-en");
  // An input opens its Document at the quote it was read from.
  await pointAndClick(window, inputs.first());
  await expect(card).toBeHidden();
  await expect(window.getByTestId("viewer")).toBeVisible();

  await pointAndClick(window, supported);
  await expect(card.getByTestId("claim-badge")).toHaveText("Supported");
  await expect(working.getByTestId("claim-figure")).toHaveText("$1,234m ÷ $942m = 1.31x");
  await expect(working.getByTestId("claim-stated")).toHaveCount(0);
  await expect(card.getByTestId("claim-add-citation")).toHaveCount(0);
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await pointAndClick(window, contradicted);
  await expect(working).toContainText("根据你的文档计算得出");
  await expect(working.getByTestId("claim-stated")).toHaveText("这句话写的是 1.1x。");
  await screenshot(window, "check-calculated-contradicted-zh");
});

test("A figure worked out from an amount in brackets says the amount was counted as negative, in English and Chinese (#978)", async () => {
  await writeFile(
    join(sources, "Cash update.pdf"),
    buildPdf([
      { lines: ["Cash update", "Net cash was $(500.0)m and EBITDA was $400m at the end of 2025."] },
    ]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
  });
  await addDocuments(window, [join(sources, "Cash update.pdf")]);
  await newMind(window);
  const sentence = "Net cash to EBITDA was 1.3x at the end of 2025.";
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(sentence);
  const line = editor.locator(":scope > p").first();
  await checkAll(window, line, "Net cash", "end of 2025.", "check-against-documents");

  const contradicted = marks(window).and(window.locator('[data-check="contradicted"]'));
  await expect(contradicted).toBeVisible({ timeout: 15_000 });
  await pointAndClick(window, contradicted);
  const inputs = window.getByTestId("claim-card").getByTestId("claim-input");
  await expect(inputs).toHaveCount(2);
  await expect(inputs.first()).toContainText("$(500.0)m");
  await expect(inputs.first()).toContainText("counted as negative");
  await expect(inputs.last()).toContainText("$400m");
  await expect(inputs.last()).not.toContainText("counted as negative");
  await motionSettled(window);
  await screenshot(window, "check-calculated-negative-en");
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await pointAndClick(window, contradicted);
  await expect(inputs.first()).toContainText("按负数计算");
  await expect(inputs.last()).not.toContainText("按负数计算");
  await motionSettled(window);
  await screenshot(window, "check-calculated-negative-zh");
});

test("A supported sentence's card names the Document as it is named now, after a rename in IncarnaMind", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { line } = await mindWithSentences(window, [SUPPORTED]);
  await setWindowSize(app, window, 1440, 900);
  await checkAll(window, line, "Spring tides", "full moon.", "check-against-documents");
  const supported = marks(window).and(window.locator('[data-check="supported"]'));
  const card = window.getByTestId("claim-card");
  await pointAt(window, supported);
  await expect(card.getByTestId("claim-source")).toHaveText(/^Tides · /);

  // Open goes to the Document, whose header renames it.
  await pointAndClick(window, card.getByTestId("claim-open"));
  const viewerTitle = window.getByTestId("viewer-title");
  await expect(viewerTitle).toHaveText("Tides");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  await viewerTitle.dblclick();
  const field = window.getByTestId("viewer-title-rename");
  await expect(field).toBeFocused();
  await field.fill("Tides of the coast");
  await window.keyboard.press("Enter");
  await expect(viewerTitle).toHaveText("Tides of the coast");

  await pointAt(window, supported);
  await expect(card.getByTestId("claim-source")).toHaveText(/^Tides of the coast · /);
});

const PENGUINS_A = "Penguins nest on a harbour cliffs.";
const HARBOURS_A = "Harbours publish a times of high water every 6 months.";

// The assistant's own changes apply at once (#1559): what waits is someone's tracked changes in a
// Word file, here "the" to "a" in each sentence that has it.
async function mindWithTheirChanges(
  app: ElectronApplication,
  window: Page,
  sentences: readonly string[],
) {
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  let id = 0;
  const runs = sentences.map((sentence, index) => {
    const space = index < sentences.length - 1 ? " " : "";
    const [before, after] = sentence.split(" the ");
    if (after === undefined) return run(`${sentence}${space}`);
    id += 2;
    return `${run(`${before} `)}${tracked("del", id - 1, "Dana Kim", "the")}${tracked("ins", id, "Dana Kim", "a")}${run(` ${after}${space}`)}`;
  });
  const path = join(sources, "Tide notes.docx");
  await writeFile(path, wordFile({ body: paragraph(runs.join("")) }));
  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-add-original").uncheck();
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();
  const line = window.getByTestId("mind-editor").locator(":scope > p").first();
  await expect(line.locator("ins.proposal-insert")).toHaveText(["a", "a"]);
  return { line };
}

test("A check reads the text as it stands and says which sentences with changes waiting it left out; Accept all and check checks them, and Undo takes the accept back, in English and Chinese", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { line } = await mindWithTheirChanges(app, window, [SUPPORTED, UNSUPPORTED, CONTRADICTED]);
  await setWindowSize(app, window, 1440, 900);

  await checkAll(window, line, "Spring tides", "6 months.", "check-against-documents");

  const waiting = window.getByTestId("checks-waiting");
  await expect(waiting).toContainText("2 sentences with changes waiting weren’t checked");
  await expect(marks(window)).toHaveCount(1);
  await expect(marks(window)).toHaveAttribute("data-check", "supported");
  await screenshot(window, "check-waiting-en");
  await setLanguage(window, "zh-CN");
  await expect(waiting).toContainText("有 2 句含待处理的修订，未核对");
  const acceptAndCheck = waiting.getByTestId("checks-accept-and-check");
  await expect(acceptAndCheck).toHaveText("全部接受并核对");
  await screenshot(window, "check-waiting-zh");

  await motionSettled(window);
  await pointAndClick(window, acceptAndCheck);
  const bar = window.getByTestId("proposals-bar");
  await expect(bar).toHaveCount(0);
  await expect(line).toHaveText(`${SUPPORTED} ${PENGUINS_A} ${HARBOURS_A}`);
  await expect(marks(window)).toHaveCount(3);
  await expect(waiting).toHaveCount(0);
  await expect(window.getByTestId("undo-message")).toHaveText("已接受 2 处修订");

  await window.keyboard.press("ControlOrMeta+z");
  await expect(line.locator("ins.proposal-insert")).toHaveText(["a", "a"]);
  await expect(line.locator("del.proposal-delete")).toHaveText(["the", "the"]);
  await expect(bar.getByTestId("their-changes-count")).toHaveText("来自 Dana Kim 的 2 处修订");
});

/**
 * Starts noting, every frame, where the element with this test id is, once the
 * card it is in has grown from the badge; the reader gives back each place seen.
 */
async function notePlaces(window: Page, testId: string) {
  await window.evaluate((id) => {
    const seen: { x: number; y: number }[] = [];
    (globalThis as { placesSeen?: typeof seen }).placesSeen = seen;
    const hooks = (globalThis as { incarnamindTestHooks?: { motionRunning(): number } })
      .incarnamindTestHooks;
    const look = () => {
      const box = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      if (box && !hooks?.motionRunning()) seen.push({ x: box.x, y: box.y });
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, testId);
  return () =>
    window.evaluate(
      () => (globalThis as { placesSeen?: { x: number; y: number }[] }).placesSeen ?? [],
    );
}

for (const [language, width] of [
  ["en", 1100],
  ["en", 1440],
  ["zh-CN", 1100],
  ["zh-CN", 1440],
] as const) {
  test(`Accept all and check stays where it first showed while the counts fill in after the check (${language}, ${width}px)`, async () => {
    const { app, window } = await launchWithTides();
    await useLocalChatModel(window);
    if (language === "zh-CN") await setLanguage(window, language);
    const { line } = await mindWithTheirChanges(app, window, [
      SUPPORTED,
      UNSUPPORTED,
      CONTRADICTED,
      LIGHTHOUSES,
    ]);
    await setWindowSize(app, window, width, 900);
    const places = await notePlaces(window, "checks-accept-and-check");

    await checkAll(window, line, "Spring tides", "at night.", "check-against-documents");
    await expect(window.getByTestId("checks-accept-and-check")).toBeVisible();
    await expect(window.getByTestId("check-card").getByTestId("health-unsupported")).toBeVisible();
    await motionSettled(window);

    await expect.poll(async () => (await places()).length).toBeGreaterThan(0);
    const seen = await places();
    expect(seen.every(({ x, y }) => x === seen[0]?.x && y === seen[0]?.y)).toBe(true);
  });
}

test("Check against Documents on sentences that all have changes waiting sends nothing and says so; Accept all and check checks them against the Documents", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { line } = await mindWithTheirChanges(app, window, [UNSUPPORTED, CONTRADICTED]);
  await setWindowSize(app, window, 1440, 900);

  await checkAll(window, line, "Penguins", "6 months.", "check-against-documents");

  const waiting = window.getByTestId("checks-waiting");
  await expect(waiting).toContainText("2 sentences with changes waiting weren’t checked");
  await expect(marks(window)).toHaveCount(0);
  await expect(window.getByTestId("checks-problem")).toHaveCount(0);

  await motionSettled(window);
  await pointAndClick(window, waiting.getByTestId("checks-accept-and-check"));
  await expect(line).toHaveText(`${PENGUINS_A} ${HARBOURS_A}`);
  await expect(marks(window)).toHaveCount(2);
  await expect(marks(window).and(window.locator('[data-check="contradicted"]'))).toBeVisible();
  await expect(marks(window).and(window.locator('[data-check="unsupported"]'))).toBeVisible();
});

test("After the User accepts one change by hand and goes to another tab and back, Accept all and check accepts the rest and checks every sentence the check left out", async () => {
  const { app, window } = await launchWithTides();
  await useLocalChatModel(window);
  const { line } = await mindWithTheirChanges(app, window, [SUPPORTED, UNSUPPORTED, CONTRADICTED]);
  await setWindowSize(app, window, 1440, 900);
  await checkAll(window, line, "Spring tides", "6 months.", "check-against-documents");
  const waiting = window.getByTestId("checks-waiting");
  await expect(waiting).toContainText("2 sentences with changes waiting weren’t checked");

  await pointAndClick(window, line.locator("del.proposal-delete").first());
  await pointAndClick(window, window.getByTestId("change-bar").getByTestId("change-accept"));
  await expect(line.locator("ins.proposal-insert")).toHaveText(["a"]);
  await checkCard(window);
  await expect(waiting).toBeVisible();

  const tabs = window.getByTestId("tab-strip").getByRole("tab");
  await newMind(window);
  await expect(tabs).toHaveCount(2);
  await expect(waiting).toHaveCount(0);
  await pointAndClick(window, tabs.first());
  await expect(line).toContainText(PENGUINS_A);
  await expect(waiting).toContainText("2 sentences with changes waiting weren’t checked");

  await motionSettled(window);
  await pointAndClick(window, waiting.getByTestId("checks-accept-and-check"));
  await expect(window.getByTestId("undo-message")).toHaveText("Accepted 1 change");
  await expect(line).toHaveText(`${SUPPORTED} ${PENGUINS_A} ${HARBOURS_A}`);
  await expect(marks(window)).toHaveCount(3);
  await expect(waiting).toHaveCount(0);
});
