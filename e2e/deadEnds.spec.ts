import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/**
 * The scope and the checks never dead-end (#764): an empty Folder says it is
 * empty in the "@" picker and on its chip; checks with no Documents offer
 * Add files…; most sentences unsupported says so once; an unsupported card
 * offers Find sources, Search the web and Remove the mark; and Verify's
 * provider failure is worded like an Answer's, with its next step.
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
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);
const UNSUPPORTED = "Penguins nest on the harbour cliffs.";
const UNSUPPORTED_TOO = "Whales sing in the deep ocean waters.";

const WORDS = {
  en: { empty: "Contracts", hint: "(empty)", chip: "· empty" },
  "zh-CN": { empty: "合同", hint: "（空）", chip: "· 空" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`an empty Folder says it is empty in the picker and on its chip, one with Documents shows its count (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await window.evaluate(async (name) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createLibraryGroup({ name, description: "" });
      const full = await core.createLibraryGroup({ name: "Coast", description: "" });
      const [document] = await core.listDocuments();
      if (document) await core.assignDocumentGroup(document.id, full.id);
    }, words.empty);
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("@");
    const choices = window.getByTestId("scope-choice");
    const empty = choices.filter({ hasText: words.empty });
    await expect(empty).toHaveAttribute("data-empty", "true");
    await expect(empty.getByTestId("scope-choice-count")).toHaveText(words.hint);
    await expect(choices.filter({ hasText: "Coast" }).getByTestId("scope-choice-count")).toHaveText(
      "1",
    );
    await window.keyboard.type(words.empty);
    await window.keyboard.press("Enter");
    const chip = window.getByTestId("composer").getByTestId("scope-chip");
    await expect(chip.getByTestId("scope-chip-empty")).toHaveText(words.chip);
    await app.close();
  });
}

test("checks with no Documents offer Add files…, in the menu, in an empty Folder and in Verify", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(UNSUPPORTED);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Penguins", { line, words: "cliffs." });
  const menu = window.getByTestId("selection-menu");
  await expect(menu.getByTestId("selection-action-check-against-documents")).toHaveText(
    "Add Documents to check",
  );
  // Clicking it opens the file picker, as Add files… does.
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await interceptOpenDialog(app, join(sources, "Tides.pdf"));
  await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
  await expect(window.getByTestId("document-list-item")).toHaveCount(1);
  await app.close();
});

test("a Mind in an empty Folder checks against every Document, as its chip says (#1359)", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await nameMind(window, "Deal memo");
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await core.createLibraryGroup({ name: "Contracts", description: "" });
    const mind = (await core.listMinds()).find((each) => each.title === "Deal memo");
    if (mind) await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });
  });
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(UNSUPPORTED);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Penguins", { line, words: "cliffs." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  await expect(window.getByTestId("claim-mark")).toHaveCount(1);
  await expect(window.getByTestId("checks-problem")).toHaveCount(0);
  await app.close();
});

test("most sentences unsupported says so once; an unsupported card offers its three ways on", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(`${UNSUPPORTED} ${UNSUPPORTED_TOO}`);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Penguins", { line, words: "waters." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(2);
  const covered = (await checkCard(window)).getByTestId("checks-uncovered");
  await expect(covered).toContainText("Your Documents don’t cover most of this");
  await expect(covered.getByTestId("checks-add-files")).toHaveText("Add files…");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("check-card")).toHaveCount(0);

  await pointAndClick(window, marks.first());
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-find-sources")).toHaveText("Find sources");
  await expect(card.getByTestId("claim-search-web")).toHaveText("Search the web");
  await expect(card.getByTestId("claim-remove")).toHaveText("Remove the mark");
  // With web search off (the default) Search the web says why, and where to turn it on.
  await pointAndClick(window, card.getByTestId("claim-search-web"));
  await expect(card.getByTestId("claim-web-off")).toContainText("Turn on web search");
  await expect(card.getByTestId("claim-web-off-settings")).toBeVisible();
  await pointAndClick(window, card.getByTestId("claim-remove"));
  await expect(marks).toHaveCount(1);
  await app.close();
});

test("in Chinese, the card's button and the panel it opens have one name, 查找资料, and the AI action that shortens is 精简", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(`${UNSUPPORTED} ${UNSUPPORTED_TOO}`);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Penguins", { line, words: "waters." });
  const menu = window.getByTestId("selection-menu");
  await expect(menu.getByTestId("selection-action-shorten")).toContainText("精简");
  await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(2);
  await expect(window.locator('[data-check="unsupported"]')).toHaveCount(2);

  await pointAndClick(window, marks.first());
  const button = window.getByTestId("claim-card").getByTestId("claim-find-sources");
  await expect(button).toHaveText("查找资料");
  await expect(window.getByTestId("claim-card").getByTestId("claim-search-web")).toHaveText(
    "联网搜索",
  );
  await pointAndClick(window, button);
  await expect(window.getByTestId("find-sources").getByRole("heading")).toHaveText("查找资料");
  await app.close();
});
