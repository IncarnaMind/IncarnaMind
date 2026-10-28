import { basename, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  runFromPalette,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * History (#113): accepting the assistant's changes saves a Checkpoint
 * first; the Mind's ⋯ menu opens History over the whole window, with that
 * version beside the Mind now in grey marks; Restore brings it back as a new
 * change, and ⌘Z takes the restore back. The scripted model (see
 * src/main/fakeChat/edit.ts) shortens by dropping "very" and "really" (非常).
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

/** Writes a line in a new Mind and shortens it from the selection menu, which applies at once. */
async function shorten(window: Page, line: string, shortened: string): Promise<Locator> {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(line);
  const note = editor.locator(":scope > p").first();
  await expect(note).toHaveText(line);
  await slideSelect(window, note, line);
  await pointAndClick(window, window.getByTestId("selection-action-shorten"));
  await expect(note).toHaveText(shortened);
  return note;
}

/** Opens the tab's menu by the keyboard and arrows down from Outline, past the exports, to History. */
async function openHistoryFromTabMenu(window: Page, tab: Locator): Promise<void> {
  const menu = tab.getByTestId("tab-actions");
  await tab.focus();
  await window.keyboard.press("Shift+F10");
  await expect(menu.getByTestId("mind.outline")).toBeFocused();
  const ids = await menu
    .getByRole("menuitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
  const steps = ids.indexOf("mind.history") - ids.indexOf("mind.outline");
  for (let step = 0; step < steps; step++) await window.keyboard.press("ArrowDown");
  await expect(menu.getByTestId("mind.history")).toBeFocused();
}

test("an AI edit saves a version first; History compares it with now, Restore brings it back, ⌘Z takes it back", async () => {
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const note = await shorten(
    window,
    "The tides here are very strong and really regular.",
    "The tides here are strong and regular.",
  );

  // The Mind's ⋯ menu in the sidebar: History.
  const row = window.getByTestId("mind-row").first();
  await pointAt(window, row);
  await pointAndClick(window, row.getByTestId("mind-menu"));
  const item = row.getByTestId("mind-actions").getByTestId("mind.history");
  await expect(item).toHaveText("History");
  await pointAndClick(window, item);

  const history = window.getByTestId("history");
  await expect(history).toBeVisible();
  const picker = history.getByTestId("history-picker-left");
  await expect(picker).toContainText("before AI edits");
  await expect(picker).toBeFocused();
  await expect(history.getByTestId("history-picker-right")).toHaveText("Now");
  const changed = history.locator('[data-testid="history-row"][data-changed]');
  await expect(changed).toHaveCount(1);
  const left = changed.locator('[data-side="left"]');
  const right = changed.locator('[data-side="right"]');
  await expect(left.locator("del")).toHaveText(["Removed: very ", "Removed: really "]);
  await expect(left.locator("del").first()).toHaveCSS("text-decoration-line", "line-through");
  await expect(right).toHaveText("The tides here are strong and regular.");
  // Side by side in a wide window: the earlier version on the left.
  const [leftBox, rightBox] = [await left.boundingBox(), await right.boundingBox()];
  expect((leftBox?.x ?? 0) + (leftBox?.width ?? 0)).toBeLessThanOrEqual((rightBox?.x ?? 0) + 1);
  expect(Math.abs((leftBox?.y ?? 0) - (rightBox?.y ?? 0))).toBeLessThan(2);
  await screenshot(window, "history-compare-en-wide");

  // The picker lists the versions by day; Esc closes it, and History stays.
  await window.keyboard.press("Enter");
  const versions = history.getByTestId("history-versions-left");
  await expect(versions).toBeVisible();
  const options = versions.getByTestId("history-version");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAttribute("aria-checked", "true");
  await expect(options.first()).toContainText("before AI edits");
  await screenshot(window, "history-picker-en-wide");
  await window.keyboard.press("Escape");
  await expect(versions).toBeHidden();
  await expect(history).toBeVisible();

  // Restore: History closes, the Mind reads as it did, and the undo line says so.
  await pointAndClick(window, history.getByTestId("history-restore"));
  await expect(history).toBeHidden();
  await expect(note).toHaveText("The tides here are very strong and really regular.");
  await expect(window.getByTestId("undo-message")).toContainText("Restored the version from");
  // ⌘Z, outside the note, takes the restore back; ⇧⌘Z does it again.
  await window.keyboard.press("ControlOrMeta+z");
  await expect(note).toHaveText("The tides here are strong and regular.");
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(note).toHaveText("The tides here are very strong and really regular.");

  // Each restore kept the Mind as it was in History first.
  await pointAt(window, row);
  await pointAndClick(window, row.getByTestId("mind-menu"));
  await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.history"));
  await expect(history).toBeVisible();
  await pointAndClick(window, picker);
  await expect(options.filter({ hasText: "before restoring a version" })).toHaveCount(3);
  await expect(options.filter({ hasText: "before AI edits" })).toHaveCount(1);
  await window.keyboard.press("Escape");
  await pointAndClick(window, history.getByTestId("history-close"));
  await expect(history).toBeHidden();
});

test("in Chinese, at a narrow window: an empty History, then by the keyboard from the tab's menu, stacked", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 660);
  const history = window.getByTestId("history");

  // A new Mind has no versions yet.
  await newMind(window);
  const tab = window.getByRole("tab", { selected: true }).first();
  const tabMenu = tab.getByTestId("tab-actions");
  await openHistoryFromTabMenu(window, tab);
  await expect(tabMenu.getByTestId("mind.history")).toHaveText("历史版本");
  await window.keyboard.press("Enter");
  await expect(history).toBeVisible();
  await expect(history.getByTestId("history-empty")).toContainText("还没有历史版本");
  await expect(history.getByTestId("history-restore")).toBeDisabled();
  await window.keyboard.press("Escape");
  await expect(history).toBeHidden();

  await shorten(window, "潮水每天非常规律地涨落两次。", "潮水每天规律地涨落两次。");
  await openHistoryFromTabMenu(window, window.getByRole("tab", { selected: true }).first());
  await window.keyboard.press("Enter");
  await expect(history).toBeVisible();
  await expect(history.getByTestId("history-picker-left")).toContainText("接受修订前");
  await expect(history.getByTestId("history-picker-right")).toHaveText("当前版本");
  await expect(history.getByTestId("history-restore")).toHaveText("恢复此版本");
  const changed = history.locator('[data-testid="history-row"][data-changed]');
  await expect(changed.locator("del")).toHaveText("已删除：非常");
  // Stacked: the earlier version above the later, both inside the window.
  const left = changed.locator('[data-side="left"]');
  const right = changed.locator('[data-side="right"]');
  const [leftBox, rightBox] = [await left.boundingBox(), await right.boundingBox()];
  expect((leftBox?.y ?? 0) + (leftBox?.height ?? 0)).toBeLessThanOrEqual((rightBox?.y ?? 0) + 1);
  expect((rightBox?.x ?? 0) + (rightBox?.width ?? 0)).toBeLessThanOrEqual(900);
  // The bar fits: Restore and ✕ inside the window.
  const close = await history.getByTestId("history-close").boundingBox();
  expect((close?.x ?? 0) + (close?.width ?? 0)).toBeLessThanOrEqual(900);
  await screenshot(window, "history-compare-zh-narrow");
  await history.getByTestId("history-picker-left").focus();
  await window.keyboard.press("Enter");
  await expect(history.getByTestId("history-versions-left")).toBeVisible();
  await screenshot(window, "history-picker-zh-narrow");
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await expect(history).toBeHidden();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a version is named where it shows, Undo takes the name back, and sending the Note as Word keeps a version with the file's name (${language})`, async () => {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, language === "en" ? 1600 : 900, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await useOutputLocation(window, await createDataFolder());
    await shorten(
      window,
      "The tides here are very strong and really regular.",
      "The tides here are strong and regular.",
    );
    await setLanguage(window, language);
    await exportFromMenu(window, "docx");
    const done = window.getByTestId("export-result").getByTestId("export-done");
    await expect(done).toContainText(".docx", { timeout: 30_000 });
    const file = basename((await done.getAttribute("title")) ?? "");

    await runFromPalette(window, t("history.command"));
    const history = window.getByTestId("history");
    const picker = history.getByTestId("history-picker-left");
    await pointAndClick(window, picker);
    const options = history.getByTestId("history-versions-left").getByTestId("history-version");
    const sent = options.filter({ hasText: t("history.reason.export.docx", { file }) });
    await expect(sent).toHaveCount(1);
    await pointAndClick(window, sent);
    await expect(picker).toContainText(t("history.reason.export.docx", { file }));

    // Named where it shows: a click on "Name this version" makes it a field; Enter keeps it.
    const name = history.getByTestId("history-name");
    await expect(name).toHaveText(t("history.name.add"));
    await pointAndClick(window, name);
    const field = history.getByTestId("history-name-field");
    await expect(field).toBeFocused();
    await window.keyboard.type(language === "en" ? "Filed draft" : "已提交的草稿");
    await window.keyboard.press("Enter");
    const named = language === "en" ? "Filed draft" : "已提交的草稿";
    await expect(name).toHaveText(named);
    await expect(picker).toContainText(named);
    await screenshot(window, `history-named-${language}`);
    await expect(history.getByTestId("undo-line-here").getByTestId("undo-message")).toHaveText(
      t("history.named", { name: named }),
    );

    // ⌘Z takes the name back; F2 on the picker names it again.
    await picker.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(name).toHaveText(t("history.name.add"));
    await picker.focus();
    await window.keyboard.press("F2");
    await expect(field).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(name).toHaveText(t("history.name.add"));
    await expect(history).toBeVisible();
  });
}
