import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  addToNote,
  askInAssistant,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  leaveFirstOpen,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The User's own "Checked by me" (#1933): a Citation's card and menu, a calculated figure's
 * card and the figure schedule mark an item as checked by the User, with the time, apart from
 * the app's check; Undo takes it back; an edit to its sentence keeps the mark as changed, with
 * the toggle unticked until ticked again; the badge's card counts the User's checks on a line
 * of their own.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const editor = (window: Page) => window.getByTestId("mind-pane").getByTestId("mind-editor");

async function openCard(window: Page, chip: Locator): Promise<Locator> {
  // Clear of the check badge at the page's foot, as a person scrolls it to the middle.
  await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await pointAndClick(window, chip);
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  return card;
}

const WORDS = {
  en: {
    action: "Checked by me",
    // The time as the system writes it: "14:02", "2:02 pm", "上午6:27".
    mine: /^Checked by you · .*\d{1,2}:\d{2}/,
    changed: "Checked by you before it changed",
    count: "1 checked by you",
    countChanged: "1 changed since you checked",
  },
  "zh-CN": {
    action: "我已核对",
    mine: /^由你核对 · .*\d{1,2}:\d{2}/,
    changed: "核对后已改动",
    count: "由你核对 1 项",
    countChanged: "核对后已改动 1 项",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`a Citation's card marks it checked by the User, Undo takes it back, and an edit keeps it as changed (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      // A wide window in English, a narrow one in Chinese.
      await setWindowSize(app, window, language === "en" ? 1600 : 900, 900);
      await setLanguage(window, language);
      await leaveFirstOpen(window);
      const chip = editor(window).getByTestId("citation-chip").first();
      await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });

      const card = await openCard(window, chip);
      const toggle = card.getByTestId("sign-off-toggle");
      await expect(toggle).toHaveText(words.action);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(card.getByTestId("sign-off-line")).toHaveCount(0);
      await screenshot(window, `sign-off-card-before-${language}`);

      await pointAndClick(window, toggle);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(card.getByTestId("sign-off-line")).toHaveText(words.mine);
      await screenshot(window, `sign-off-card-checked-${language}`);

      // Undo takes the mark back, as any edit of the note.
      await pointAndClick(window, window.getByTestId("undo-action"));
      await expect(card).toHaveCount(0);
      const undone = await openCard(window, chip);
      await expect(undone.getByTestId("sign-off-toggle")).toHaveAttribute("aria-pressed", "false");
      await expect(undone.getByTestId("sign-off-line")).toHaveCount(0);

      // From the Citation's right-click menu, in the shared order: a toggle that shows ticked.
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await pointAndClick(window, chip, { button: "right" });
      const unticked = window.getByRole("menuitemcheckbox", { name: words.action });
      await expect(unticked).toHaveAttribute("aria-checked", "false");
      await pointAndClick(window, unticked);
      await pointAndClick(window, chip, { button: "right" });
      await expect(window.getByRole("menuitemcheckbox", { name: words.action })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await window.keyboard.press("Escape");

      const health = await checkCard(window);
      await expect(health.getByTestId("health-sign-offs")).toHaveText(words.count);
      await window.keyboard.press("Escape");

      // An edit to its sentence keeps the mark, as changed: it no longer counts as checked.
      await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = await chip.boundingBox();
      if (!box) throw new Error("The Citation isn't on screen.");
      // The word just before the Citation, written over as a person does.
      await window.mouse.dblclick(box.x - 15, box.y + box.height / 2);
      await window.keyboard.type(language === "en" ? "period" : "期末");
      const changed = await openCard(window, chip);
      await expect(changed.getByTestId("sign-off-line")).toHaveText(words.changed);
      await expect(changed.getByTestId("sign-off-toggle")).toHaveAttribute("aria-pressed", "false");
      await screenshot(window, `sign-off-card-changed-${language}`);
      await window.keyboard.press("Escape");
      await expect((await checkCard(window)).getByTestId("health-sign-offs")).toHaveText(
        words.countChanged,
      );
      await screenshot(window, `sign-off-badge-card-${language}`);
      await window.keyboard.press("Escape");

      // Ticking it again marks it as checked by the User now.
      const again = await openCard(window, chip);
      await pointAndClick(window, again.getByTestId("sign-off-toggle"));
      await expect(again.getByTestId("sign-off-line")).toHaveText(words.mine);
      await expect(again.getByTestId("sign-off-toggle")).toHaveAttribute("aria-pressed", "true");

      // ⌘K reaches it while the card shows, ticked; choosing it takes the mark off.
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(words.action);
      const item = window
        .getByTestId("palette")
        .locator('[data-key="command:citation.signOffRemove"]');
      await expect(item.getByTestId("palette-checked")).toBeVisible();
      await pointAndClick(window, item);
      await openCard(window, chip);
      await expect(again.getByTestId("sign-off-toggle")).toHaveAttribute("aria-pressed", "false");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a checked Citation deleted by editing leaves the counts and Undo brings it back; a restore without it says so, and the next restore brings its mark back (${language})`, async () => {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      // A wide window in English, a narrow one in Chinese.
      await setWindowSize(app, window, language === "en" ? 1600 : 900, 900);
      await setLanguage(window, language);
      await leaveFirstOpen(window);
      const chips = editor(window).getByTestId("citation-chip");
      const chip = chips.first();
      await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
      const card = await openCard(window, chip);
      await pointAndClick(window, card.getByTestId("sign-off-toggle"));
      await expect(card.getByTestId("sign-off-toggle")).toHaveAttribute("aria-pressed", "true");
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      const cited = await chips.count();

      // Deleted as a person does: the word before it double-clicked, a Shift-click just after it,
      // and Backspace. The Shift-click sometimes doesn't extend the selection across the Citation
      // (#2279, a known flake under #1741); the counts cover the text.
      await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = await chip.boundingBox();
      if (!box) throw new Error("The Citation isn't on screen.");
      await window.mouse.dblclick(box.x - 15, box.y + box.height / 2);
      await window.keyboard.down("Shift");
      await window.mouse.click(box.x + box.width + 4, box.y + box.height / 2);
      await window.keyboard.up("Shift");
      await window.mouse.move(box.x - 15, box.y - 120);
      await expect(window.getByTestId("citation-card")).toHaveCount(0);
      await window.keyboard.press("Backspace");
      await expect.poll(() => chips.count()).toBeLessThan(cited);
      const left = await chips.count();
      await expect((await checkCard(window)).getByTestId("health-sign-offs")).toHaveCount(0);
      await window.keyboard.press("Escape");

      // A version of the Note without it, then ⌘Z brings it back with its mark.
      const mindId =
        (await window.locator("article[data-mind-id]").first().getAttribute("data-mind-id")) ?? "";
      await window.evaluate(async (id) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.saveCheckpoint(id, "accept");
      }, mindId);
      await editor(window).focus();
      await window.keyboard.press("ControlOrMeta+z");
      await expect(chips).toHaveCount(cited);
      const back = await openCard(window, chip);
      await expect(back.getByTestId("sign-off-toggle")).toHaveAttribute("aria-pressed", "true");
      await window.keyboard.press("Escape");

      // Restoring that version says, in the restore's own line, that the Citation isn't in it.
      await runCommand(window, "mind.history", t("history.command"));
      const history = window.getByTestId("history");
      await expect(history).toBeVisible();
      await pointAndClick(window, history.getByTestId("history-restore"));
      await expect(history).toBeHidden();
      await expect(chips).toHaveCount(left);
      const [restored, leftOut] = t("history.restored.leftOut.one", {
        version: "\u0000",
        count: 1,
      }).split("\u0000");
      await expect(window.getByTestId("undo-message")).toContainText(restored ?? "");
      await expect(window.getByTestId("undo-message")).toContainText(leftOut ?? "");
      await screenshot(window, `sign-off-restored-left-out-${language}`);

      // Undo takes the restore back: the Citation returns, and its mark with it.
      await pointAndClick(window, window.getByTestId("undo-action"));
      await expect(chips).toHaveCount(cited);
      const returned = await openCard(window, chip);
      await expect(returned.getByTestId("sign-off-toggle")).toHaveAttribute("aria-pressed", "true");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the figure schedule marks figures checked by the User, shows who and when, and filters the rest (${language})`, async () => {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      // A wide window in English, a narrow one in Chinese.
      await setWindowSize(app, window, language === "en" ? 1600 : 900, 900);
      await setLanguage(window, language);
      await leaveFirstOpen(window);
      await expect(editor(window).getByTestId("citation-chip").first()).toHaveAttribute(
        "data-check",
        "found",
        { timeout: 30_000 },
      );
      const health = await checkCard(window);
      await pointAndClick(window, health.getByTestId("health-open-schedule"));
      const schedule = window.getByTestId("figure-schedule");
      const rows = schedule.locator("tbody tr[data-figure-id]");
      await expect(rows).toHaveCount(3);
      const rowOf = (index: number) => rows.nth(index);
      const checkedBy = (index: number) => rowOf(index).locator(".figure-checked-by");
      await expect(checkedBy(0)).toHaveText("");

      // One figure, from its row's menu.
      await pointAndClick(window, rowOf(0).locator("[data-tree-row]"));
      await pointAndClick(window, rowOf(0).locator("[data-figure-more]"));
      const menu = rowOf(0).getByRole("menu");
      const toggle = menu.getByRole("menuitemcheckbox", { name: t("signOff.action") });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await pointAndClick(window, toggle);
      const mine = new RegExp(`^${t("figures.checkedBy.mine", { time: "" }).trim()}`);
      await expect(checkedBy(0)).toHaveText(mine);
      await expect(checkedBy(1)).toHaveText("");
      await screenshot(window, `sign-off-schedule-${language}`);

      // Not checked by me: the figure the User checked leaves the list.
      await pointAndClick(window, schedule.locator('[data-filter="not-mine"]'));
      await expect(rows).toHaveCount(2);
      await pointAndClick(window, schedule.locator('[data-filter="all"]'));
      await expect(rows).toHaveCount(3);

      // Two figures at once from ⌘K.
      await pointAndClick(window, rowOf(1).locator("[data-tree-row]"));
      await pointAndClick(window, rowOf(2).locator("[data-tree-row]"), { modifiers: ["Shift"] });
      await runCommand(window, "figures.signOffChosen", t("signOff.markCount", { count: 2 }));
      await expect(checkedBy(1)).toHaveText(mine);
      await expect(checkedBy(2)).toHaveText(mine);
      // A narrow window shows one tab at a time: the badge is on the note's.
      if (language !== "en") await pointAndClick(window, window.getByRole("tab").first());
      await expect((await checkCard(window)).getByTestId("health-sign-offs")).toHaveText(
        t("signOff.count.mine", { count: 3 }),
      );
    } finally {
      await app.close();
    }
  });
}

for (const [language, width] of [
  ["en", 1600],
  ["zh-CN", 900],
] as const) {
  test(`a calculated figure's card marks it checked by the User, Undo takes it back, and an edit keeps one changed beside one still checked (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const sources = await createDataFolder();
    await writeFile(
      join(sources, "Acme annual report 2025.pdf"),
      buildPdf([{ lines: ["Revenue was 1,482.6 in 2025, compared with 1,231.0 in 2024."] }]),
    );
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, width, 900);
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
      await addDocuments(window, [join(sources, "Acme annual report 2025.pdf")]);
      await setLanguage(window, language);
      await newMind(window);
      const question =
        language === "en"
          ? "How much did revenue grow, and what share of 2025 was 2024?"
          : "收入增长了多少，2024年占比多少？";
      // Two Answers, so each sentence holds figures of its own: an edit to one leaves a
      // still-checked figure beside the changed one.
      for (let copy = 0; copy < 2; copy++)
        await addToNote(window, await askInAssistant(window, question));
      const markers = editor(window).getByTestId("calculated-figure-marker");
      await expect(markers).toHaveCount(4, { timeout: 30_000 });
      const card = window.locator(".calculated-figure-card");
      const line = card.getByTestId("sign-off-line");
      const toggle = card.getByTestId("sign-off-toggle");
      const openAt = async (index: number) => {
        await markers.nth(index).focus();
        await window.keyboard.press("Enter");
        await expect(card).toBeVisible();
      };
      const close = async () => {
        await window.keyboard.press("Escape");
        await expect(card).toBeHidden();
      };
      const mark = async (index: number) => {
        await openAt(index);
        await pointAndClick(window, toggle);
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await expect(line).toHaveText(words.mine);
        await close();
      };

      await openAt(0);
      await expect(toggle).toHaveText(words.action);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(line).toHaveCount(0);
      await pointAndClick(window, toggle);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(line).toHaveText(words.mine);
      await screenshot(window, `sign-off-figure-card-checked-${language}`);
      await close();

      // Undo takes the mark back, as any edit of the Note.
      await pointAndClick(window, window.getByTestId("undo-action"));
      await openAt(0);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(line).toHaveCount(0);
      await close();

      // The first figure of each sentence is checked; the edit below is the first sentence's.
      await mark(0);
      await mark(2);

      // A caret in the sentence's words, away from its figures and Citations, which a click on
      // their marker or chip would take into the node and typing would replace.
      const point = await editor(window)
        .locator(":scope > p")
        .first()
        .evaluate(
          (paragraph, target) => {
            const walker = paragraph.ownerDocument.createTreeWalker(
              paragraph,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const text = node as Text;
              const at = text.data.indexOf(target);
              if (at < 0) continue;
              const range = paragraph.ownerDocument.createRange();
              range.setStart(text, at + 1);
              range.collapse(true);
              const rect = range.getBoundingClientRect();
              return { x: rect.left, y: rect.top + rect.height / 2 };
            }
            return null;
          },
          language === "en" ? "earlier" : "上年",
        );
      if (!point) throw new Error("The figure's sentence isn't on screen.");
      await window.mouse.click(point.x, point.y);
      await window.keyboard.type(language === "en" ? "own " : "上下");

      await openAt(0);
      await expect(line).toHaveText(words.changed);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await screenshot(window, `sign-off-figure-card-changed-${language}`);
      await close();
      // The other sentence was not edited: its mark still reads checked.
      await openAt(2);
      await expect(line).toHaveText(words.mine);
      await close();
    } finally {
      await removeDataFolder(sources);
      await app.close();
    }
  });
}
