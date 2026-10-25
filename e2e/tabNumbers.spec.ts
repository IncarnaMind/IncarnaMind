import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  nameMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * ⌃1–⌃8 show the focused group's tab at that place and ⌃9 its last, as in VS Code (#1602): Alt+1–9
 * on Windows and Linux, where Ctrl+1–3 go to a group as ⌘1–⌘3 do on macOS. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save ⌘K's list and the strip.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const MAC = process.platform === "darwin";

const LANGUAGES = ["en", "zh-CN"] as const;
type Language = (typeof LANGUAGES)[number];

const NAMES: Record<Language, string[]> = {
  en: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota"],
  "zh-CN": [
    "一月计划",
    "二月计划",
    "三月计划",
    "四月计划",
    "五月计划",
    "六月计划",
    "七月计划",
    "八月计划",
    "九月计划",
  ],
};

const LABELS: Record<Language, { tab: (n: number) => string; last: string; search: string }> = {
  en: { tab: (n) => `Go to Tab ${n}`, last: "Go to Last Tab", search: "Search" },
  "zh-CN": { tab: (n) => `转到第 ${n} 个标签页`, last: "转到最后一个标签页", search: "搜索" },
};

/** The keys for the tab at this place, as Playwright presses them and as the app writes them. */
const tabKeys = (number: number) => `${MAC ? "Control" : "Alt"}+${number}`;
const tabKeysLabel = (number: number) => (MAC ? `⌃${number}` : `Alt+${number}`);

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: `${SCREENSHOTS}/${name}.png` });
}

const tabsOf = (scope: Page | Locator) => scope.locator('[data-testid="mind-tab"]');
const shownIn = (scope: Page | Locator) =>
  scope.locator('[data-testid="mind-tab"][aria-selected="true"]');
const tabNamed = (window: Page, title: string) =>
  window.locator(`[data-testid="mind-tab"][title=${JSON.stringify(title)}]`);
const groupAt = (window: Page, index: number) => window.getByTestId("tab-group").nth(index);

/** ⌘T (Ctrl+T): a new Mind in a new tab of the focused group, named, the cursor in its text. */
async function newMind(window: Page, title: string): Promise<void> {
  const count = await tabsOf(window).count();
  await window.keyboard.press("ControlOrMeta+t");
  await expect(tabsOf(window)).toHaveCount(count + 1);
  await expect(frontMind(window).getByTestId("mind-editor")).toBeFocused();
  await nameMind(window, title);
}

/** Presses the keys for this place, and says whether the window took them for a command. */
async function pressTabKeys(window: Page, number: number): Promise<boolean> {
  await window.evaluate((code) => {
    const page = globalThis as unknown as { tabKeysTaken?: boolean };
    page.tabKeysTaken = undefined;
    // After the window's keymap, which takes the keys of a shortcut it runs.
    const listen = (event: KeyboardEvent) => {
      if (event.code !== code) return;
      globalThis.removeEventListener("keydown", listen);
      page.tabKeysTaken = event.defaultPrevented;
    };
    globalThis.addEventListener("keydown", listen);
  }, `Digit${number}`);
  await window.keyboard.press(tabKeys(number));
  let taken: boolean | undefined;
  await expect
    .poll(async () => {
      taken = await window.evaluate(
        () => (globalThis as unknown as { tabKeysTaken?: boolean }).tabKeysTaken,
      );
      return taken;
    })
    .not.toBeUndefined();
  return taken === true;
}

/** Whether a tab is wholly inside its strip's visible part, and the pointer finds it at its centre. */
const wholeInView = (tab: Locator) =>
  tab.evaluate((element) => {
    const list = element.closest('[data-testid="tab-list"]');
    if (!list) return false;
    const box = element.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return (
      box.left >= view.left - 1 &&
      box.right <= view.right + 1 &&
      hit?.closest('[role="tab"]') === element
    );
  });

const palette = (window: Page) => window.getByTestId("palette");
const paletteCommand = (window: Page, id: string) =>
  palette(window).locator(`[data-key="command:${id}"]`);

async function typeInPalette(window: Page, text: string): Promise<void> {
  if (!(await palette(window).isVisible())) {
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
  }
  await window.getByTestId("palette-search").fill(text);
}

for (const language of LANGUAGES) {
  test(`${language === "en" ? "English" : "Chinese"}: with five tabs ⌃3 shows the third, ⌃9 the last and ⌃7 nothing; ⌘K and its list of actions show them with their keys; in a narrow window a tab out of sight comes whole into view`, async () => {
    const names = NAMES[language];
    const labels = LABELS[language];
    const name = (index: number) => names[index] ?? "";
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await expect(window.getByTestId("sidebar-search")).toContainText(labels.search);
    for (const title of names.slice(0, 5)) await newMind(window, title);
    await expect(shownIn(window)).toHaveAttribute("title", name(4));

    // From the Mind's text, where the cursor is.
    expect(await pressTabKeys(window, 3)).toBe(true);
    await expect(shownIn(window)).toHaveAttribute("title", name(2));
    expect(await pressTabKeys(window, 9)).toBe(true);
    await expect(shownIn(window)).toHaveAttribute("title", name(4));
    expect(await pressTabKeys(window, 1)).toBe(true);
    await expect(shownIn(window)).toHaveAttribute("title", name(0));
    // No seventh tab: the keys are left alone and the first stays shown.
    expect(await pressTabKeys(window, 7)).toBe(false);
    await expect(shownIn(window)).toHaveAttribute("title", name(0));
    await expect(tabsOf(window)).toHaveCount(5);

    // ⌘K finds each by its name, with its keys; there is none for a tab that isn't there.
    await typeInPalette(window, labels.tab(3));
    await expect(paletteCommand(window, "tab.show3")).toContainText(labels.tab(3));
    await expect(paletteCommand(window, "tab.show3")).toContainText(tabKeysLabel(3));
    await typeInPalette(window, labels.last);
    await expect(paletteCommand(window, "tab.showLast")).toContainText(labels.last);
    await expect(paletteCommand(window, "tab.showLast")).toContainText(tabKeysLabel(9));
    await typeInPalette(window, labels.tab(7));
    await expect(paletteCommand(window, "tab.show7")).toHaveCount(0);
    // ">" lists every action with its keys: tabs 1 to 5 and the last, not 6 to 8.
    await typeInPalette(window, ">");
    for (const number of [1, 2, 3, 4, 5]) {
      await expect(paletteCommand(window, `tab.show${number}`)).toContainText(
        `${labels.tab(number)}${tabKeysLabel(number)}`,
      );
    }
    await expect(paletteCommand(window, "tab.showLast")).toContainText(
      `${labels.last}${tabKeysLabel(9)}`,
    );
    for (const number of [6, 7, 8]) {
      await expect(paletteCommand(window, `tab.show${number}`)).toHaveCount(0);
    }
    await screenshot(window, `tab-numbers-palette-${language}`);
    // Run from ⌘K, as from the keys.
    await typeInPalette(window, labels.tab(2));
    await paletteCommand(window, "tab.show2").click();
    await expect(palette(window)).toBeHidden();
    await expect(shownIn(window)).toHaveAttribute("title", name(1));

    // Nine tabs in a narrow window: the strip can't show them all. Each comes whole into view.
    // A new tab opens after the shown one, so the last is shown first.
    await setWindowSize(app, window, 900, 700);
    expect(await pressTabKeys(window, 9)).toBe(true);
    await expect(shownIn(window)).toHaveAttribute("title", name(4));
    for (const title of names.slice(5)) await newMind(window, title);
    await expect(tabsOf(window).getByTestId("tab-title")).toHaveText(names);
    await expect(shownIn(window)).toHaveAttribute("title", name(8));
    await expect.poll(() => wholeInView(tabNamed(window, name(8)))).toBe(true);
    expect(await wholeInView(tabNamed(window, name(0)))).toBe(false);
    for (const [number, index] of [
      [1, 0],
      [5, 4],
      [9, 8],
      [2, 1],
    ] as const) {
      expect(await pressTabKeys(window, number)).toBe(true);
      await expect(shownIn(window)).toHaveAttribute("title", name(index));
      await expect.poll(() => wholeInView(tabNamed(window, name(index)))).toBe(true);
    }
    await screenshot(window.getByTestId("tab-strip").first(), `tab-numbers-strip-${language}`);
    await app.close();
  });
}

test("in a second and third group they act on that group's tabs; ⌘1–⌘3 still go to the groups", async () => {
  const names = NAMES.en;
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  for (const title of names.slice(0, 5)) await newMind(window, title);

  // ⌥⌘\ copies the shown tab into a group on the right, which takes the focus; two more Minds join it.
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  const [first, second] = [groupAt(window, 0), groupAt(window, 1)];
  await expect(second).toHaveAttribute("data-focused", "true");
  for (const title of names.slice(5, 7)) await newMind(window, title);
  await expect(tabsOf(second)).toHaveCount(3);
  await expect(shownIn(second)).toHaveAttribute("title", names[6] ?? "");

  expect(await pressTabKeys(window, 1)).toBe(true);
  await expect(shownIn(second)).toHaveAttribute("title", names[4] ?? "");
  expect(await pressTabKeys(window, 9)).toBe(true);
  await expect(shownIn(second)).toHaveAttribute("title", names[6] ?? "");
  // The second group has three tabs: ⌃4 is left alone, and the first group is as it was.
  expect(await pressTabKeys(window, 4)).toBe(false);
  await expect(shownIn(second)).toHaveAttribute("title", names[6] ?? "");
  await expect(shownIn(first)).toHaveAttribute("title", names[4] ?? "");

  // ⌘1 still goes to the first group, where the keys then act.
  await window.keyboard.press("ControlOrMeta+1");
  await expect(first).toHaveAttribute("data-focused", "true");
  await expect(shownIn(first)).toBeFocused();
  expect(await pressTabKeys(window, 2)).toBe(true);
  await expect(shownIn(first)).toHaveAttribute("title", names[1] ?? "");
  await expect(first).toHaveAttribute("data-focused", "true");
  await expect(shownIn(second)).toHaveAttribute("title", names[6] ?? "");

  // ⌘2 and ⌘3 too: a third group from the second's shown tab.
  await window.keyboard.press("ControlOrMeta+2");
  await expect(second).toHaveAttribute("data-focused", "true");
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await expect(window.getByTestId("tab-group")).toHaveCount(3);
  const third = groupAt(window, 2);
  await newMind(window, names[7] ?? "");
  await window.keyboard.press("ControlOrMeta+1");
  await expect(first).toHaveAttribute("data-focused", "true");
  await window.keyboard.press("ControlOrMeta+3");
  await expect(third).toHaveAttribute("data-focused", "true");
  await expect(shownIn(third)).toBeFocused();
  expect(await pressTabKeys(window, 1)).toBe(true);
  await expect(shownIn(third)).toHaveAttribute("title", names[6] ?? "");
  await expect(shownIn(first)).toHaveAttribute("title", names[1] ?? "");
  await expect(shownIn(second)).toHaveAttribute("title", names[6] ?? "");
  await screenshot(window, "tab-numbers-groups");
  await app.close();
});
