/**
 * The steps the recording's scenes share: opening a Mind as a person does, running a command
 * from ⌘K, and putting the screen back between scenes.
 */
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { CoreBridge } from "../../src/core/api";
import { leaveText } from "../app";
import type { Hand } from "./film";
import type { DemoScript } from "./script";

export const bridgeOf = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

/** Opens a Mind by its name from ⌘K, as a person does. */
export async function openMind(window: Page, title: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(title);
  const item = window.getByTestId("palette-item").filter({ hasText: title }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(window.getByTestId("palette-search")).toBeHidden();
}

export async function dismissNotice(window: Page): Promise<void> {
  const notice = window.getByTestId("tab-notice");
  if ((await notice.count()) > 0) await notice.locator(".tab-notice-close").click();
  await expect(notice).toHaveCount(0);
}

/** Closes the Documents opened beside the Mind, and the card and the notice that follow them. */
export async function clearAside(window: Page): Promise<void> {
  const tabs = window.getByTestId("document-tab");
  while ((await tabs.count()) > 0) await tabs.first().getByTestId("tab-close").click();
  await window.keyboard.press("Escape");
  // A click on nothing puts away the Citation's card, which Esc leaves open. Only then: with the
  // sidebar folded the click lands on whatever its rows are under it.
  if ((await window.getByTestId("citation-card").count()) > 0) await leaveText(window);
  await expect(window.getByTestId("citation-card")).toHaveCount(0);
  await dismissNotice(window);
}

/** Runs a command from ⌘K with no one watching: types the start of its name and picks it. */
export async function quietCommand(window: Page, typed: string, name: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(typed);
  await expect(window.getByTestId("palette-item").filter({ hasText: name }).first()).toBeVisible();
  await window.keyboard.press("Enter");
}

/** Runs a command from ⌘K: types the start of its name as a hand does, and picks it. */
export async function command(
  window: Page,
  hand: Hand,
  typed: string,
  name: string,
): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await hand.type(typed, 55);
  await expect(window.getByTestId("palette-item").filter({ hasText: name }).first()).toBeVisible();
  await hand.hold(150);
  await window.keyboard.press("Enter");
}

/**
 * Runs Check this note with no one watching and waits until every sentence has its mark. The
 * question that comes with its estimate is answered, as a person does.
 */
export async function checkTheMind(window: Page, script: DemoScript): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(script.words.typed.check);
  await expect(
    window.getByTestId("palette-item").filter({ hasText: script.words.checkCommand }).first(),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  const ask = window.getByTestId("mind-check-check");
  await expect(ask).toBeVisible({ timeout: 90_000 });
  await ask.click();
  await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 240_000 });
  await expect(window.getByTestId("claim-mark").first()).toBeVisible();
  await window.keyboard.press("Escape");
}

/** The margin mark of the paragraph that holds this text: the one whose line the paragraph spans. */
export async function markBeside(window: Page, text: string) {
  const paragraph = window.getByTestId("mind-editor").locator("p", { hasText: text }).first();
  const box = await paragraph.boundingBox();
  if (!box) throw new Error(`No paragraph has “${text}”.`);
  const marks = window.getByTestId("claim-mark");
  const count = await marks.count();
  for (let index = 0; index < count; index++) {
    const mark = marks.nth(index);
    const at = await mark.boundingBox();
    if (at && at.y + at.height / 2 >= box.y && at.y + at.height / 2 <= box.y + box.height) {
      return mark;
    }
  }
  throw new Error(`No mark stands beside “${text}”.`);
}

/** A picture of the window for working on the script: only when `DEMO_DEBUG` names a folder. */
export async function snap(window: Page, name: string): Promise<void> {
  const folder = process.env.DEMO_DEBUG;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}
