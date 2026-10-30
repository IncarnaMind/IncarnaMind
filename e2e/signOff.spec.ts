import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  checkCard,
  createDataFolder,
  launchApp,
  leaveFirstOpen,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The User's own "Checked by me" (#1933): a Citation's card and menu mark it as checked by
 * the User, with their name and the time, apart from the app's check; Undo takes it back; an
 * edit to its sentence keeps the mark as changed, with the toggle unticked until ticked again;
 * the badge's card counts the User's checks on a line of their own.
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
      // and Backspace. A loaded runner can miss the second click (#2279, a known flake under
      // #1741); the counts cover the text.
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
