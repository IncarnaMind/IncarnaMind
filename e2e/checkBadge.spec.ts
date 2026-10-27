import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The check badge (#909, #1909, D266): at a Mind's bottom right, its state on every note
 * with a sentence a check reads ("Not checked", "1 needs a look", "Checked 14:25"), never
 * bare while one waits. Its card opens from it, and from ⌘K. The scripted model
 * (src/main/fakeChat/checks.ts) finds a sentence supported when it shares
 * three words with a line of a Document, and otherwise unsupported. Set
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
]);
const SUPPORTED = "Spring tides happen at new and full moon.";

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

async function launchWithTides() {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const running = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(running.window);
  await connectLocalChatModel(running.window);
  await addDocuments(running.window, [join(sources, "Tides.pdf")]);
  return running;
}

test("a Note of plain notes says its state; its card, from ⌘K, has one count per state and one action, checks, and says what it checked until you type", async () => {
  const { app, window } = await launchWithTides();
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Thanks!");
  const badge = window.getByTestId("check-badge");
  const open = window.getByTestId("check-badge-open");
  await expect(editor).toContainText("Thanks!");
  // "Thanks!" makes no claim a check reads: nothing to say.
  await expect(badge).toHaveCount(0);

  // A claim in the User's own notes is one to check: the badge says so, with no Citation (D266).
  await window.keyboard.type(` ${SUPPORTED}`);
  await expect(editor).toContainText(SUPPORTED);
  await expect(badge).toHaveAttribute("data-state", "not-checked");
  await expect(badge.locator(".check-badge-words")).toHaveText("Not checked");
  const card = await checkCard(window);
  await expect(card.getByTestId("health-toCheck")).toContainText("1 claim not checked yet");
  await expect(card.getByTestId("health-noCitation")).toHaveCount(0);
  // One action, and nothing under it: Check for contradictions is in ⌘K and the page menu.
  await expect(card.getByTestId("badge-check-mind")).toHaveText("Check");
  await expect(card.locator('[data-testid^="badge-check"]')).toHaveCount(1);
  await expect(card).not.toContainText("Check for contradictions");
  await expect(card).not.toContainText("Whether each claim");
  await screenshot(window, "check-badge-card-en");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await pointAndClick(window, (await checkCard(window)).getByTestId("badge-check-mind"));
  // The model names the claims, and the card asks before it checks them.
  await pointAndClick(window, card.getByTestId("mind-check-ask").getByTestId("mind-check-check"));
  // Every claim checked and none to look at: the green, with its time (D266).
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
  await expect(badge).toHaveAttribute("data-state", "checked");
  await expect(badge.locator(".check-badge-words")).toHaveText(/^Checked /);
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  // It sits at the page's bottom right, over the text, never past the Mind's pane.
  const pane = await window.getByTestId("mind-pane").boundingBox();
  const box = await badge.boundingBox();
  if (!pane || !box) throw new Error("The badge isn't drawn.");
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  // At 1,100 px the card stays over the Mind's page.
  await setWindowSize(app, window, 1100, 720);
  await pointAndClick(window, open);
  await expect(card).toBeVisible();
  const narrowPane = await window.locator(".mind-scroller").first().boundingBox();
  const cardBox = await card.boundingBox();
  if (!narrowPane || !cardBox) throw new Error("The card isn't drawn.");
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(narrowPane.x + narrowPane.width + 1);
  await screenshot(window, "check-badge-card-en-1100");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await setWindowSize(app, window, 1440, 900);
  await editor.click();
  await window.keyboard.press("End");
  await window.keyboard.type(" The harbour is quiet in winter.");
  // Another claim arrives with no check: the note is not checked any more (D266).
  await expect(badge).toHaveAttribute("data-state", "not-checked");
  await expect(badge.locator(".check-badge-words")).toHaveText("Not checked");

  // ⌘K reaches the card from anywhere; Esc from inside it puts the focus back.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Sentences and Citations");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Sentences and Citations" }).first(),
  );
  await expect(card).toBeVisible();
  await expect(card.getByTestId("health-found")).toHaveCount(0);
  await expect(card.getByTestId("badge-check-mind")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await app.close();
});

test("in Chinese and a narrow pane the badge keeps its state to its mark; Tab reaches its card and Esc brings the focus back", async () => {
  const { app, window } = await launchWithTides();
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  // A cited claim no check has looked at is one to check: an Answer added to the note has one.
  await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
  await expect(editor.getByTestId("citation")).toHaveCount(1);
  await setLanguage(window, "zh-CN");
  const open = window.getByTestId("check-badge-open");
  await expect(open).toHaveAccessibleName("句子和引用：未核对");
  const words = window.getByTestId("check-badge").locator(".check-badge-words");
  await expect(words).toHaveText("未核对");
  await expect(words).toBeVisible();
  await setWindowSize(app, window, 1100, 720);
  await expect(words).toBeVisible();
  await setWindowSize(app, window, 1440, 900);
  // The Mind beside itself in a narrower window: each page under 400 px keeps the mark, not the words.
  await pointAndClick(window, window.getByTestId("split-group"));
  const pages = window.locator(".mind-scroller:visible");
  await expect(pages).toHaveCount(2);
  await setWindowSize(app, window, 1340, 900);
  for (const width of await pages.evaluateAll((all) => all.map((page) => page.clientWidth))) {
    expect(width).toBeLessThan(400);
  }
  await expect(words).toHaveCount(2);
  for (const each of await words.all()) await expect(each).toBeHidden();
  await expect(
    window.getByTestId("check-badge").first().locator(".mind-health-icon"),
  ).toBeVisible();
  await screenshot(window, "check-badge-zh-narrow");

  await open.first().focus();
  await window.keyboard.press("Enter");
  // Only the badge's own pane opens its card.
  const card = window.getByTestId("check-card");
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await motionSettled(window);
  await window.keyboard.press("Tab");
  await expect(card.locator(":focus")).toHaveCount(1);
  // ↓ and ↑ go through its rows and buttons, round to the first.
  const focusedId = () =>
    card.evaluate((element) => element.querySelector(":focus")?.getAttribute("data-testid") ?? "");
  const first = await focusedId();
  await window.keyboard.press("ArrowDown");
  await expect.poll(focusedId).not.toBe(first);
  await window.keyboard.press("ArrowUp");
  await expect.poll(focusedId).toBe(first);
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(open.first()).toBeFocused();
  await app.close();
});

/** Where the editor's cursor is, as an offset in the text of its first paragraph. */
const cursorAt = (window: Page) =>
  window.getByTestId("mind-editor").evaluate((element) => {
    const view = (element as Element & { editor?: Editor }).editor?.view;
    if (!view) return -1;
    return view.state.selection.from - 1;
  });

test("each row's Next goes through its sentences in order and round to the first; a running check says how far it has got, and Stop stops it", async () => {
  const { app, window } = await launchWithTides();
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  const first = "Penguins nest on the harbour cliffs.";
  await window.keyboard.type(`${first} Whales sing in the deep bay.`);
  const card = await checkCard(window);
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  await pointAndClick(window, card.getByTestId("mind-check-ask").getByTestId("mind-check-check"));
  const marks = window.getByTestId("claim-mark");
  await expect(marks.and(window.locator('[data-check="unsupported"]'))).toHaveCount(2);
  const unsupported = async () => (await checkCard(window)).getByTestId("health-unsupported");
  await expect(await unsupported()).toContainText("2 need a look");
  // Each Next ends as a click on the sentence's mark does: its card open, the badge's card closed.
  const sentenceCard = window.getByTestId("claim-card");
  await pointAndClick(window, await unsupported());
  await expect.poll(() => cursorAt(window)).toBe(0);
  await expect(sentenceCard).toHaveAttribute("data-check", "unsupported");
  await expect(window.getByTestId("check-card")).toHaveCount(0);
  await pointAndClick(window, await unsupported());
  await expect.poll(() => cursorAt(window)).toBe(first.length + 1);
  await pointAndClick(window, await unsupported());
  await expect.poll(() => cursorAt(window)).toBe(0);
  await window.keyboard.press("Escape");
  await expect(sentenceCard).toHaveCount(0);

  // A sentence the scripted model checks slowly: the badge counts, and Stop ends the run.
  await editor.click();
  await window.keyboard.press("End");
  await window.keyboard.type(" Seals sleep on the rocks slowly. Gulls circle the pier slowly.");
  const again = await checkCard(window);
  await pointAndClick(window, again.getByTestId("badge-check-mind"));
  await pointAndClick(window, again.getByTestId("mind-check-ask").getByTestId("mind-check-check"));
  const stop = window.getByTestId("badge-stop");
  await expect(stop).toBeVisible();
  await expect(window.getByTestId("badge-progress")).toContainText("Checking");
  await screenshot(window, "check-badge-running-en");
  await pointAndClick(window, stop);
  await expect(stop).toHaveCount(0);
  await expect(marks.and(window.locator('[data-check="checking"]'))).toHaveCount(0);
  await app.close();
});
