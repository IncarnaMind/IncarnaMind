import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addDocuments,
  useLocalChatModel as chooseScriptedModel,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  keptWords,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * A sentence a Document contradicts can be kept as the User's own view (#1768):
 * its card and ⌘K keep it with one Undo, a later Check this Mind leaves it, and
 * a Verify Mind offers it too. The scripted model contradicts a sentence that
 * shares three words with a line whose numbers it doesn't have
 * (src/main/fakeChat/checks.ts). Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const CLAIM = "Harbours publish the times of high water every 6 months.";
const SAYS = "Harbours publish the times of high water every 12 months.";
const OTHER = "The harbour office opens to visitors in the morning.";

const LANGUAGES = {
  en: {
    keep: "Keep as my view",
    kept: "Kept as your view",
    contradicted: "Contradicted",
    checkMind: "Check this Mind",
  },
  "zh-CN": {
    keep: "保留为我的观点",
    kept: "已保留为你的观点",
    contradicted: "与文档矛盾",
    checkMind: "核对此 Mind",
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

/** Two sentences checked against Office alone: the first contradicted, the second supported. */
async function launchedWithContradictedSentence(language: "en" | "zh-CN") {
  await writeFile(join(sources, "Tides.txt"), `${CLAIM}\n`);
  await writeFile(join(sources, "Office.txt"), `${SAYS}\n${OTHER}\n`);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.txt"), join(sources, "Office.txt")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(CLAIM);
  await window.keyboard.press("Enter");
  await window.keyboard.type(OTHER);
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("@Office");
  await expect(window.getByTestId("scope-picker")).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("composer").getByTestId("scope-chip")).toHaveText("Office");
  const lines = editor.locator(":scope > p");
  await slideSelect(window, lines.nth(0), "Harbours publish", {
    line: lines.nth(1),
    words: "morning.",
  });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");
  await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");
  return { app, window, editor, lines, marks, card: window.getByTestId("claim-card") };
}

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];

  test(`a contradicted sentence's card keeps it as the User's own view, one Undo brings the ≠ and the card back, and Check this Mind leaves it (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window, editor, lines, marks, card } =
      await launchedWithContradictedSentence(language);
    const undoLine = window.getByTestId("undo-line");
    const undo = async () => {
      await focusSettled(window, editor);
      await window.keyboard.press("ControlOrMeta+z");
    };
    const openCard = async () => {
      await motionSettled(window);
      await pointAndClick(window, marks.nth(0));
      await expect(card).toBeVisible();
    };
    const kept = () => keptWords(editor);
    const contradictedId = await marks.nth(0).getAttribute("data-claim");
    expect(contradictedId).toBeTruthy();

    // The card says what the Document says, with Keep as my view among its actions.
    await openCard();
    await expect(card.getByTestId("claim-badge")).toHaveText(words.contradicted);
    await screenshot(window, `contradicted-card-${language}`);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await setWindowSize(app, window, 900, 900);
    await openCard();
    await screenshot(window, `contradicted-card-${language}-narrow`);
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    await expect(card.getByTestId("claim-keep")).toHaveText(words.keep);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await setWindowSize(app, window, 1440, 900);
    await openCard();
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // Keep as my view: the mark and its wash go, the words stay, and one ⌘Z brings the card back.
    await openCard();
    await pointAndClick(window, card.getByTestId("claim-keep"));
    await expect(marks).toHaveCount(1);
    await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
    await expect(lines.nth(0)).toHaveText(CLAIM);
    await expect(lines.nth(0).locator(".claim-wash--contradicted")).toHaveCount(0);
    expect(await kept()).toEqual([CLAIM]);
    await expect(undoLine).toContainText(words.kept);
    await undo();
    await expect(marks).toHaveCount(2);
    await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");
    await expect(lines.nth(0).locator(".claim-wash--contradicted")).toBeVisible();
    await openCard();
    await expect(card.getByTestId("claim-keep")).toBeVisible();

    // ⌘K reaches it too, and one ⌘Z takes it back as the card's does.
    await window.keyboard.press("Escape");
    await clickEndOf(window, lines.nth(0));
    await runCommand(window, "check.keepAsView", words.keep);
    await expect(marks).toHaveCount(1);
    expect(await kept()).toEqual([CLAIM]);
    await expect(undoLine).toContainText(words.kept);
    await undo();
    await expect(marks).toHaveCount(2);
    await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");

    // Kept again with ⌘K: Check this Mind checks the other sentence and leaves this one.
    await clickEndOf(window, lines.nth(0));
    await runCommand(window, "check.keepAsView", words.keep);
    await expect(marks).toHaveCount(1);
    await slideSelect(window, lines.nth(1), "morning");
    await window.keyboard.type("daytime");
    await expect(marks.nth(0)).toHaveAttribute("data-check", "needs-recheck");
    await runCommand(window, "mind.check", words.checkMind);
    await expect(marks.nth(0)).toHaveAttribute("data-check", "supported", { timeout: 30_000 });
    await expect(marks).toHaveCount(1);
    expect(await kept()).toEqual([CLAIM]);
    const checkedIds = await marks.evaluateAll((all) =>
      all.map((each) => each.getAttribute("data-claim")),
    );
    expect(checkedIds).not.toContain(contradictedId);
    await expect(lines.nth(0)).toHaveText(CLAIM);
    await screenshot(window, `contradicted-kept-${language}`);
    await app.close();
  });
}
