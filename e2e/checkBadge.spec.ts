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
  checkChanged,
  checkNote,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  noteCheck,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The Note's check (#909, #1909, #3794): its Check button with the Note's own controls,
 * saying the Note's state on every note with a sentence a check reads ("Check 1" while one waits,
 * "1 needs a look", "Checked"), its tooltip the state in full ("1 sentence not checked yet",
 * "Checked 14:25"). One press checks while sentences wait; otherwise its press opens the Checks
 * card, which ⌘K opens too. The scripted model (src/main/fakeChat/checks.ts) finds a sentence
 * supported when it shares three words with a line of a Document, and otherwise unsupported. Set
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

test("a Note of plain notes says its state; its card, from ⌘K, has one count per state and no Check of its own; the button checks, and says what it checked until you type", async () => {
  const { app, window } = await launchWithTides();
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Thanks!");
  const button = noteCheck(window);
  await expect(editor).toContainText("Thanks!");
  // "Thanks!" makes no claim a check reads: nothing to say.
  await expect(button).toHaveCount(0);

  // A claim in the User's own notes is one to check: the button says so, with no Citation.
  await window.keyboard.type(` ${SUPPORTED}`);
  await expect(editor).toContainText(SUPPORTED);
  await expect(button).toHaveAttribute("data-state", "check");
  await expect(button.locator(".note-check-count")).toHaveText("1");
  await expect(button).toHaveAttribute("title", "1 sentence not checked yet");
  const card = await checkCard(window);
  // Before its first check the card's head says so, and its line counts the sentence once (#3840).
  await expect(card.getByTestId("check-card-head")).toHaveText("Not checked yet");
  await expect(card.getByTestId("check-card-line")).toContainText("1 sentence");
  await expect(card.getByTestId("mind-health").getByTestId("health-toCheck")).toHaveCount(0);
  await expect(card.getByTestId("health-noCitation")).toHaveCount(0);
  // No action of its own to check: the Note's button is the one way in, and Check for
  // contradictions is in ⌘K and the page menu.
  await expect(card.getByRole("button", { name: "Check", exact: true })).toHaveCount(0);
  await expect(card).not.toContainText("Check for contradictions");
  await expect(card).not.toContainText("Whether each claim");
  await screenshot(window, "note-check-card-en");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await checkNote(window);
  // Every claim checked and none to look at: the green, its time left to the card (#3840).
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
  await expect(button).toHaveAttribute("data-state", "checked");
  await expect(button).toHaveAttribute("data-tone", "success");
  await expect(button).toHaveAttribute("title", "Checked");
  await expect(card).toHaveCount(0);
  // It sits with the Note's own controls in its tab strip (#3765), never past the Mind's pane.
  const pane = await window.getByTestId("mind-pane").boundingBox();
  const box = await button.boundingBox();
  if (!pane || !box) throw new Error("The button isn't drawn.");
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  // At 1,100 px the card stays over the Mind's page.
  await setWindowSize(app, window, 1100, 720);
  await pointAndClick(window, button);
  await expect(card).toBeVisible();
  const narrowPane = await window.locator(".mind-scroller").first().boundingBox();
  const cardBox = await card.boundingBox();
  if (!narrowPane || !cardBox) throw new Error("The card isn't drawn.");
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(narrowPane.x + narrowPane.width + 1);
  await screenshot(window, "note-check-card-en-1100");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await setWindowSize(app, window, 1440, 900);
  await editor.click();
  await window.keyboard.press("End");
  await window.keyboard.type(" The harbour is quiet in winter.");
  // Another claim arrives with no check: the button keeps the check's verdict without its ✓, and
  // its tooltip says one waits (#3840).
  await expect(button).toHaveAttribute("data-state", "checked");
  await expect(button).toHaveAttribute("data-tone", "neutral");
  await expect(button).toHaveAttribute("title", "Checked · 1 not checked yet");

  // ⌘K reaches the card from anywhere, named Checks, and its old name still finds it; Esc from
  // inside it puts the focus back.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Claims and Citations");
  await expect(window.getByTestId("palette-item").first()).toContainText("Checks");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Checks" }).first(),
  );
  await expect(card).toBeVisible();
  await expect(card.getByTestId("health-found")).toHaveCount(0);
  await expect(card.getByTestId("check-card-again")).toHaveText("Check 1 new");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await app.close();
});

const checkedText = (
  id: string,
  state: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "text",
  text,
  marks: [
    {
      type: "claimCheck",
      attrs: {
        id,
        request: "check-1",
        action: "check-against-documents",
        state,
        text,
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt: "2026-10-22T09:00:00.000Z",
        ...extra,
      },
    },
  ],
});

test("a checked Note with a sentence a check cannot settle says Checked with that sentence's own mark, never the ✓, and says it in full in its tooltip, in a narrow pane too (#2313, #3677, #3794)", async () => {
  const { app, window } = await launchWithTides();
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.setContent(content);
    },
    [
      {
        type: "paragraph",
        content: [
          checkedText("check-settled", "supported", "Spring tides happen at new and full moon."),
        ],
      },
      {
        type: "paragraph",
        content: [
          checkedText(
            "check-kept",
            "not-checked",
            "Harbours publish the times of high water every week.",
            {
              reason: "kept-inside",
              detail: "Other Folder",
            },
          ),
        ],
      },
    ],
  );
  const button = noteCheck(window);
  await expect(button).toHaveAttribute("data-state", "checked");
  await expect(button.locator(".note-check-words")).toHaveText("Checked");
  // Its mark is the unsettled sentence's own, in the margin's tone for it, never the checked
  // green, in both themes.
  for (const appearance of ["light", "dark"] as const) {
    await window.evaluate(
      (theme) =>
        (
          globalThis as unknown as {
            incarnamind: { updateSettings(patch: unknown): Promise<unknown> };
          }
        ).incarnamind.updateSettings({ device: { appearance: theme } }),
      appearance,
    );
    await expect
      .poll(() =>
        window.evaluate(() => {
          const tone = (name: string) => {
            const probe = document.createElement("span");
            probe.style.color = `var(${name})`;
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          };
          const icon = document.querySelector(
            '[data-testid="note-check-place"] [data-testid="note-check"] .note-check-mark',
          );
          const color = icon ? getComputedStyle(icon).color : "";
          return {
            meta: color === tone("--color-ink-meta"),
            green: color === tone("--color-success"),
          };
        }),
      )
      .toEqual({ meta: true, green: false });
  }
  await expect(button).toHaveAttribute("title", /^Checked .*1 sentence can’t be checked/);
  await pointAndClick(window, window.getByTestId("split-group"));
  const pages = window.locator(".mind-scroller:visible");
  await expect(pages).toHaveCount(2);
  await setWindowSize(app, window, 1340, 900);
  for (const width of await pages.evaluateAll((all) => all.map((page) => page.clientWidth))) {
    expect(width).toBeLessThan(400);
  }
  // At a narrow pane it is the same: the word, the mark, the caveat in its tooltip.
  const narrow = noteCheck(window.getByTestId("tab-group").first());
  await expect(narrow).toHaveAttribute("data-state", "checked");
  await expect(narrow).toHaveAttribute("title", /1 sentence can’t be checked/);
  await screenshot(window, "note-check-caveat-narrow");
  await app.close();
});

test("in Chinese and a narrow pane the button keeps its word and number; the keyboard checks with it, Tab reaches its card and Esc brings the focus back", async () => {
  const { app, window } = await launchWithTides();
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  // A cited claim no check has looked at is one to check: an Answer added to the note has one.
  await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
  await expect(editor.getByTestId("citation")).toHaveCount(1);
  const button = noteCheck(window);
  await expect(button).toHaveAccessibleName("Check 1");
  await expect(button).toHaveAttribute("title", "1 sentence not checked yet");
  await setLanguage(window, "zh-CN");
  await expect(button).toHaveAccessibleName("核对 1");
  await expect(button).toHaveAttribute("title", "1 句未核对");
  await setWindowSize(app, window, 1100, 720);
  await expect(button.locator(".note-check-count")).toBeVisible();
  await setWindowSize(app, window, 1440, 900);
  // The Mind beside itself in a narrower window: each page under 400 px keeps the word and number.
  await pointAndClick(window, window.getByTestId("split-group"));
  const pages = window.locator(".mind-scroller:visible");
  await expect(pages).toHaveCount(2);
  await setWindowSize(app, window, 1340, 900);
  for (const width of await pages.evaluateAll((all) => all.map((page) => page.clientWidth))) {
    expect(width).toBeLessThan(400);
  }
  const buttons = window.getByTestId("note-check-place").getByTestId("note-check");
  await expect(buttons).toHaveCount(2);
  for (const each of await buttons.all()) {
    await expect(each.locator(".note-check-words")).toBeVisible();
    await expect(each.locator(".note-check-count")).toHaveText("1");
  }
  await screenshot(window, "note-check-zh-narrow");

  // The keyboard reaches the Check and checks with it; then its press opens the card.
  const first = buttons.first();
  await first.focus();
  await window.keyboard.press("Enter");
  await expect(first).not.toHaveAttribute("data-state", "check", { timeout: 30_000 });
  await expect(first).not.toHaveAttribute("data-state", "checking", { timeout: 30_000 });
  await expect(first).toBeFocused();
  await window.keyboard.press("Enter");
  // Only the button's own pane opens its card.
  const card = window.getByTestId("check-card");
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await motionSettled(window);
  await window.keyboard.press("Tab");
  await expect(card.locator(":focus")).toHaveCount(1);
  // ↓ and ↑ go through its rows and buttons, round to the first.
  const focusedId = () =>
    card.evaluate((element) => element.querySelector(":focus")?.getAttribute("data-testid") ?? "");
  const firstFocused = await focusedId();
  await window.keyboard.press("ArrowDown");
  await expect.poll(focusedId).not.toBe(firstFocused);
  await window.keyboard.press("ArrowUp");
  await expect.poll(focusedId).toBe(firstFocused);
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(first).toBeFocused();
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
  await checkNote(window);
  const marks = window.getByTestId("claim-mark");
  await expect(marks.and(window.locator('[data-check="unsupported"]'))).toHaveCount(2);
  // Opened as a person opens it once the button says what the check found: from the button.
  const unsupported = async () => {
    const card = window.getByTestId("check-card");
    if (!(await card.isVisible())) await pointAndClick(window, noteCheck(window));
    await expect(card).toBeVisible();
    return card.getByTestId("health-look");
  };
  await expect(await unsupported()).toContainText("2 need a look");
  // Each Next ends as a click on the sentence's mark does: its card open, the Checks card closed.
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

  // Sentences the scripted model checks slowly: the button counts, and Stop ends the run.
  await editor.click();
  await window.keyboard.press("End");
  await window.keyboard.type(" Seals sleep on the rocks slowly. Gulls circle the pier slowly.");
  await checkChanged(window);
  const stop = window.getByTestId("note-check-stop");
  await expect(stop).toBeVisible();
  await expect(noteCheck(window).locator(".note-check-words")).toContainText("Checking");
  await screenshot(window, "note-check-running-en");
  await pointAndClick(window, stop);
  await expect(stop).toHaveCount(0);
  await expect(marks.and(window.locator('[data-check="checking"]'))).toHaveCount(0);
  await app.close();
});
