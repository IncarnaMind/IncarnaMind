import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  launchApp,
  nameMind,
  newMind,
  openDocumentAt,
  placeAssistant,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A group's tab strip rests on whole tabs (DESIGN.md, Components: Mind tabs, Width): no tab is
 * clipped at its edge, the shown tab is whole, and nothing covers the "+", at the narrow sizes
 * where the tabs don't fit. A strip being scrolled may show a part; these checks wait for it to rest.
 */

const LANGUAGES = ["en", "zh-CN"] as const;
type Language = (typeof LANGUAGES)[number];

const NAMES: Record<Language, string[]> = {
  en: [
    "Lit review: urban heat islands",
    "Interview notes, July",
    "Budget 2027",
    "Field work plan",
    "Reading list for the spring",
    "Meeting with the council",
    "Draft of the final report",
    "Survey results by district",
  ],
  "zh-CN": [
    "城市热岛文献综述",
    "七月访谈记录",
    "二〇二七年预算",
    "田野调查计划",
    "春季阅读清单",
    "与市议会的会议",
    "最终报告初稿",
    "各区调查结果",
  ],
};
const REPORT: Record<Language, string> = { en: "Urban heat", "zh-CN": "城市热岛报告" };

/** The nth Mind's name, different from every other. */
const nameOf = (language: Language, index: number) =>
  `${NAMES[language][index % NAMES[language].length]} ${index + 1}`;

const SIZES = [
  { width: 1100, height: 760 },
  { width: 900, height: 700 },
  { width: 1280, height: 760 },
  { width: 1440, height: 900 },
];

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

/**
 * What is wrong with the strips as they are drawn now: empty when each rests on whole tabs, with
 * part of a hidden tab's name faded at each side that hides tabs, never over the shown tab. A
 * strip the User scrolled away may rest with its shown tab out of sight.
 */
function problemsOf(window: Page, shownInView: boolean): Promise<string[]> {
  return window.evaluate((requireShown) => {
    const problems: string[] = [];
    const slack = 1;
    const strips = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tab-strip"]'));
    strips.forEach((strip, at) => {
      const list = strip.querySelector<HTMLElement>('[data-testid="tab-list"]');
      const plus = strip.querySelector<HTMLElement>('[data-testid="new-tab"]');
      if (!list || !plus) return;
      const where = `Strip ${at + 1}`;
      const view = list.getBoundingClientRect();
      const add = plus.getBoundingClientRect();
      const fade = 32;
      let before = 0;
      let after = 0;
      let shown = 0;
      let shownBox: DOMRect | undefined;
      let nameBefore = false;
      // What the strip needs beside its whole tabs for a readable piece of each hidden name.
      let needBefore = 0;
      let needAfter = 0;
      let wholeWidth = 0;
      let whole = 0;
      let nameAfter = false;
      const fadeLeft = list.hasAttribute("data-hidden-before");
      const fadeRight = list.hasAttribute("data-hidden-after");
      const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
      for (const tab of tabs) {
        const box = tab.getBoundingClientRect();
        const name = tab.getAttribute("aria-label") ?? "a tab";
        const title = tab.querySelector<HTMLElement>('[data-testid="tab-title"]');
        const text = title?.getBoundingClientRect();
        const inside = box.left >= view.left - slack && box.right <= view.right + slack;
        const outLeft = box.right <= view.left + slack;
        const outRight = box.left >= view.right - slack;
        const partLeft = !inside && !outLeft && !outRight && box.left < view.left;
        const partRight = !inside && !outLeft && !outRight && box.right > view.right;
        if (outLeft || partLeft) before++;
        if (outRight || partRight) after++;
        // Part of a hidden tab may show, under the fade at its side: the sign that there are more.
        if ((partLeft && !fadeLeft) || (partRight && !fadeRight) || (partLeft && partRight)) {
          problems.push(`${where}: "${name}" is clipped`);
        }
        // Half the fade of the name at least, which can be read.
        const seen = fade / 2 - slack;
        if (partLeft && text !== undefined && text.right - view.left >= seen) nameBefore = true;
        if (partRight && text !== undefined && view.right - text.left >= seen) nameAfter = true;
        if (partLeft && text !== undefined)
          needBefore = Math.max(fade, box.right - text.right + seen);
        if (partRight && text !== undefined)
          needAfter = Math.max(fade, text.left - box.left + seen);
        if (inside) {
          whole++;
          // A shown tab counts at its least width: it narrows to make the room (#2244).
          const shownNow = tab.getAttribute("aria-selected") === "true";
          wholeWidth += shownNow ? Math.min(box.width, 132) : box.width;
        }
        if (tab.getAttribute("aria-selected") === "true") {
          shown++;
          // Scrolled away by the User, the shown tab may be the one partly in view.
          if (inside) shownBox = box;
          if (requireShown && !inside)
            problems.push(`${where}: the shown tab "${name}" isn't whole`);
        }
        if (!inside) continue;
        if (box.right > add.left + slack) problems.push(`${where}: the + overlaps "${name}"`);
        const centre = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        if (centre?.closest('[role="tab"]') !== tab)
          problems.push(`${where}: "${name}" is covered`);
        if (title && text) {
          const whole = title.scrollWidth <= title.clientWidth;
          const ellipsis = getComputedStyle(title).textOverflow === "ellipsis";
          if (!whole && !ellipsis) problems.push(`${where}: "${name}" is cut mid-word`);
          if (text.left < box.left - slack || text.right > box.right + slack) {
            problems.push(`${where}: "${name}"'s name leaves its tab`);
          }
        }
      }
      if (tabs.length > 0 && tabs.length === before + after)
        problems.push(`${where}: shows no tab`);
      if (shown > 1) problems.push(`${where}: ${shown} tabs are shown`);
      const shownLeft =
        shownBox !== undefined &&
        shownBox.right > view.left &&
        shownBox.left < view.left + fade - slack;
      const shownRight =
        shownBox !== undefined &&
        shownBox.right > view.right - fade + slack &&
        shownBox.left < view.right;
      if (before > 0 && !fadeLeft) problems.push(`${where}: tabs hide on the left with no fade`);
      if (after > 0 && !fadeRight) problems.push(`${where}: tabs hide on the right with no fade`);
      // One whole tab and those pieces wider than the room the strip has (its buttons and fonts
      // decide it, so it differs by system): the pieces give way, and only the fade says more.
      const spare = strip.querySelector<HTMLElement>(".tab-strip-spacer");
      const room = list.offsetWidth + (spare?.offsetWidth ?? 0);
      const cramped = whole === 1 && wholeWidth + needBefore + needAfter + 10 > room + slack;
      if (!cramped) {
        if (before > 0 && !nameBefore) problems.push(`${where}: no name shows tabs on the left`);
        if (after > 0 && !nameAfter) problems.push(`${where}: no name shows tabs on the right`);
        if (fadeLeft && shownLeft) problems.push(`${where}: the fade covers the shown tab`);
        if (fadeRight && shownRight) problems.push(`${where}: the fade covers the shown tab`);
      }
      const onPlus = document.elementFromPoint(add.left + add.width / 2, add.top + add.height / 2);
      if (!onPlus?.closest('[data-testid="new-tab"]')) problems.push(`${where}: the + is covered`);
    });
    if (document.documentElement.scrollWidth > globalThis.innerWidth) {
      problems.push("The page scrolls sideways");
    }
    return problems;
  }, shownInView);
}

const expectResting = (window: Page, message: string, { shownInView = true } = {}) =>
  expect.poll(() => problemsOf(window, shownInView), { message }).toEqual([]);

const groupAt = (window: Page, index: number) => window.getByTestId("tab-group").nth(index);
const listAt = (window: Page, index: number) => window.getByTestId("tab-list").nth(index);
const scrollOf = (list: Locator) => list.evaluate((element) => element.scrollLeft);
const titlesOf = (list: Locator) => list.getByRole("tab").getByTestId("tab-title");
const shownTab = (window: Page) => window.locator('[role="tab"][aria-selected="true"]');

/** A new Mind from a group's "+", named. */
async function addMind(window: Page, group: Locator, name: string): Promise<void> {
  const count = await window.getByTestId("mind-tab").count();
  await group.getByTestId("new-tab").click();
  await expect(window.getByTestId("mind-tab")).toHaveCount(count + 1);
  await nameMind(window, name);
}

/** A Report, added as a Document; its ID. */
async function addReport(window: Page, language: Language): Promise<string> {
  const path = join(sources, `${REPORT[language]}.pdf`);
  await writeFile(
    path,
    buildPdf([{ lines: ["Urban heat", "Eastgate peaked at 47.2 degrees on 19 July."] }]),
  );
  await addDocuments(window, [path]);
  return documentIdOf(window, REPORT[language]);
}

const OPENS_PDF = { quote: "Eastgate peaked at 47.2 degrees on 19 July." };

const NOTE: Record<Language, string> = {
  en: "Your Documents answer this",
  "zh-CN": "你的文档回答了这个问题",
};
const MORE: Record<Language, string[]> = {
  en: ["Questions for the site office", "Shift rota for July", "Training notes"],
  "zh-CN": ["给现场办公室的问题清单", "七月份的值班安排表", "志愿者培训笔记整理"],
};

/**
 * What keeps a strip's tabs out of reach: a tab laid out outside the strip's scroll box, or tabs
 * hidden though they fit beside the strip's buttons. Empty when every tab can be reached.
 */
function unreachable(window: Page): Promise<string[]> {
  return window.evaluate(() => {
    const problems: string[] = [];
    const strips = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tab-strip"]'));
    strips.forEach((strip, at) => {
      const list = strip.querySelector<HTMLElement>('[data-testid="tab-list"]');
      const spare = strip.querySelector<HTMLElement>(".tab-strip-spacer");
      if (!list || !spare) return;
      const where = `Strip ${at + 1}`;
      const view = list.getBoundingClientRect();
      let hidden = 0;
      for (const tab of list.querySelectorAll<HTMLElement>('[role="tab"]')) {
        const box = tab.getBoundingClientRect();
        const name = tab.getAttribute("aria-label") ?? "a tab";
        const left = box.left - view.left + list.scrollLeft;
        const right = box.right - view.left + list.scrollLeft;
        if (left < -1 || right > list.scrollWidth + 1) {
          problems.push(`${where}: "${name}" is outside the strip's scroll box`);
        }
        if (box.left < view.left - 1 || box.right > view.right + 1) hidden++;
      }
      const room = list.offsetWidth + spare.offsetWidth;
      if (hidden > 0 && list.scrollWidth <= room + 1) {
        problems.push(`${where}: ${hidden} tab(s) hide though the tabs fit in ${room} px`);
      }
    });
    return problems;
  });
}

/** Whether a strip's first or last tab is whole in its view. */
const wholeInView = (list: Locator, which: "first" | "last") =>
  list.evaluate((element, end) => {
    const tabs = Array.from(element.querySelectorAll<HTMLElement>('[role="tab"]'));
    const tab = end === "first" ? tabs[0] : tabs.at(-1);
    if (!tab) return false;
    const view = element.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    return box.left >= view.left - 1 && box.right <= view.right + 1;
  }, which);

for (const language of LANGUAGES) {
  test(`the strip rests on whole tabs with 3 to 8 tabs and a PDF beside the Minds, at every window size (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 900);
    await setLanguage(window, language);
    const report = await addReport(window, language);
    await addMind(window, groupAt(window, 0), nameOf(language, 0));
    await addMind(window, groupAt(window, 0), nameOf(language, 1));
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expect(window.getByTestId("tab-group")).toHaveCount(2);

    let total = 3;
    for (const target of [3, 4, 5, 8]) {
      while (total < target) {
        await addMind(window, groupAt(window, 0), nameOf(language, total - 1));
        total++;
      }
      for (const size of SIZES) {
        await setWindowSize(app, window, size.width, size.height);
        await expectResting(window, `${target} tabs at ${size.width} × ${size.height}`);
      }
    }
    await app.close();
  });

  test(`a Citation's page opened beside the Note leaves every tab reachable, a hidden one showing it is there, at 1,600, 1,440 and 900 px (${language}) (#2244)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await expect(window.getByTestId("mind-pane")).toBeVisible();
    const report = await addReport(window, language);
    await newMind(window);
    await nameMind(window, NOTE[language]);
    await expect(window.getByTestId("mind-tab")).toHaveCount(2);
    await window.getByTestId("ask-pill").click();
    await expect(window.getByTestId("assistant")).toBeVisible();

    for (const width of [1600, 1440, 900]) {
      const at = `${width} px`;
      await setWindowSize(app, window, width, 900);
      await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
      await expect(window.getByTestId("document-tab")).toHaveCount(1);
      await expect(shownTab(window).first()).toBeVisible();
      await expectResting(window, `the page opened beside the Note at ${at}`);
      await expect.poll(() => unreachable(window), { message: at }).toEqual([]);

      // The wheel reaches the last tab and comes back to the first.
      const list = listAt(window, 0);
      const box = await list.boundingBox();
      if (!box) throw new Error("The strip isn't visible.");
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await window.mouse.wheel(0, 2000);
      await expect.poll(() => wholeInView(list, "last"), { message: at }).toBe(true);
      await expectResting(window, `wheeled to the end at ${at}`, { shownInView: false });
      await window.mouse.wheel(0, -2000);
      await expect.poll(() => wholeInView(list, "first"), { message: at }).toBe(true);
      await expectResting(window, `wheeled to the start at ${at}`, { shownInView: false });

      // So do the keys of the tab list.
      await list.locator('[role="tab"][aria-selected="true"]').focus();
      await window.keyboard.press("End");
      await expect.poll(() => wholeInView(list, "last"), { message: at }).toBe(true);
      await expect(list.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
      await expectResting(window, `End at ${at}`);
      await window.keyboard.press("Home");
      await expect.poll(() => wholeInView(list, "first"), { message: at }).toBe(true);
      await expect(list.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
      await expectResting(window, `Home at ${at}`);
      await expect.poll(() => unreachable(window), { message: at }).toEqual([]);

      // Back to the Note alone, for the next width.
      const page = window.getByTestId("document-tab");
      await page.hover();
      await page.getByTestId("tab-close").click();
      await expect(window.getByTestId("document-tab")).toHaveCount(0);
      await window.getByRole("tab", { name: NOTE[language], exact: true }).click();
      await expect(shownTab(window)).toHaveAttribute("aria-label", NOTE[language]);
    }
    await app.close();
  });

  test(`with 3 and 5 tabs and the Note between them, a Citation's page beside it leaves a readable name on each side that hides tabs, at 1,440 and 900 px (${language}) (#2244)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await expect(window.getByTestId("mind-pane")).toBeVisible();
    const report = await addReport(window, language);
    await newMind(window);
    await nameMind(window, NOTE[language]);
    await window.getByTestId("ask-pill").click();
    await expect(window.getByTestId("assistant")).toBeVisible();

    let added = 0;
    for (const count of [3, 5]) {
      while (2 + added < count) {
        await newMind(window);
        await nameMind(window, MORE[language][added] ?? `${added}`);
        added++;
      }
      await expect(window.getByTestId("mind-tab")).toHaveCount(count);
      for (const width of [1440, 900]) {
        const at = `${count} tabs at ${width} px`;
        await setWindowSize(app, window, width, 900);
        const note = window.getByRole("tab", { name: NOTE[language], exact: true });
        await note.click();
        await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
        await expect(window.getByTestId("document-tab")).toHaveCount(1);
        // Below 1,000 px the page comes to the front of the one strip; the Note is shown again.
        await note.click();
        const list = listAt(window, 0);
        await expect(list.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute(
          "aria-label",
          NOTE[language],
        );
        if (width === 1440) {
          await expect(list).toHaveAttribute("data-hidden-before", "true");
          await expect(list).toHaveAttribute("data-hidden-after", "true");
        }
        await expectResting(window, `the Note between hidden tabs, ${at}`);
        await expect.poll(() => unreachable(window), { message: at }).toEqual([]);

        const page = window.getByTestId("document-tab");
        await page.hover();
        await page.getByTestId("tab-close").click();
        await expect(window.getByTestId("document-tab")).toHaveCount(0);
      }
    }
    await app.close();
  });

  test(`in a group narrowed to its least width, the strip comes to rest with the Note between hidden tabs in view, and holds still when the User scrolls away (${language}) (#2244)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await expect(window.getByTestId("mind-pane")).toBeVisible();
    const report = await addReport(window, language);
    await newMind(window);
    await nameMind(window, NOTE[language]);
    for (const name of MORE[language].slice(0, 2)) {
      await newMind(window);
      await nameMind(window, name);
    }
    await window.getByTestId("ask-pill").click();
    await expect(window.getByTestId("assistant")).toBeVisible();
    const note = window.getByRole("tab", { name: NOTE[language], exact: true });
    await note.click();
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expect(window.getByTestId("tab-group")).toHaveCount(2);

    // The divider's keys narrow the Note's group to its least width.
    const divider = window.getByTestId("group-divider");
    await divider.focus();
    await expect
      .poll(async () => {
        await window.keyboard.press("Shift+ArrowLeft");
        return (
          (await divider.getAttribute("aria-valuenow")) ===
          (await divider.getAttribute("aria-valuemin"))
        );
      })
      .toBe(true);

    const list = listAt(window, 0);
    /**
     * The strip over 20 frames: the same each frame once it rests, whether the Note is in view, and
     * where each tab is in the strip's scroll box and how wide.
     */
    const frames = () =>
      list.evaluate(async (element) => {
        const reads: string[] = [];
        let inView = true;
        for (let frame = 0; frame < 20; frame++) {
          await new Promise((next) => requestAnimationFrame(next));
          const view = element.getBoundingClientRect();
          const shown = element.querySelector('[role="tab"][aria-selected="true"]');
          const box = shown?.getBoundingClientRect();
          if (!box || box.left < view.left - 1 || box.right > view.right + 1) inView = false;
          const tabs = Array.from(element.querySelectorAll('[role="tab"]')).map((tab) => {
            const at = tab.getBoundingClientRect();
            return `${Math.round(at.left - view.left + element.scrollLeft)}+${Math.round(at.width)}`;
          });
          reads.push(
            `${Math.round(element.scrollLeft)} ${Math.round(view.width)} ${tabs.join(" ")}`,
          );
        }
        const view = element.getBoundingClientRect();
        // The tab at the strip's start: the one under the User's eye after a scroll.
        const first = Array.from(element.querySelectorAll('[role="tab"]')).find(
          (tab) => tab.getBoundingClientRect().right > view.left + 1,
        );
        const lead = `${first?.getAttribute("aria-label")}@${Math.round((first?.getBoundingClientRect().left ?? 0) - view.left)}`;
        return { still: new Set(reads).size === 1, inView, layout: reads.at(-1) ?? "", lead };
      });
    const tabsAt = (layout: string) => layout.split(" ").slice(2).join(" ");
    /** How far apart two readings are, in their largest number: a part of a pixel is no move. */
    const apart = (one: string, other: string) => {
      const a = one.split(/[ +]/).map(Number);
      const b = other.split(/[ +]/).map(Number);
      if (a.length !== b.length) return Infinity;
      return Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? Infinity))));
    };
    await expect.poll(frames, { message: "the strip comes to rest" }).toMatchObject({
      still: true,
      inView: true,
    });
    // And stays at rest: its own scrolls end without moving it again.
    for (let look = 0; look < 3; look++) {
      expect(await frames()).toMatchObject({ still: true, inView: true });
    }
    const shownTabHere = list.locator('[role="tab"][aria-selected="true"]');
    await expect(shownTabHere).toHaveAttribute("aria-label", NOTE[language]);
    await expect.poll(() => unreachable(window)).toEqual([]);
    const placed = tabsAt((await frames()).layout);

    // The User wheels away and back: the tabs keep their widths, so nothing shifts under the pointer.
    const box = await list.boundingBox();
    if (!box) throw new Error("The strip isn't visible.");
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    for (const delta of [2000, -2000]) {
      await window.mouse.wheel(0, delta);
      await expect
        .poll(async () => (await frames()).still, { message: `wheeled ${delta}` })
        .toBe(true);
      expect(
        apart(tabsAt((await frames()).layout), placed),
        `wheeled ${delta}`,
      ).toBeLessThanOrEqual(1);
    }

    // A 1px change of the window, with no tab revealed, leaves the tab at the strip's start where
    // it is. (The group's room may change with it, and the narrowed shown tab with that room.)
    const away = (await frames()).lead;
    await setWindowSize(app, window, 1441, 900);
    await expect.poll(async () => (await frames()).still, { message: "1px wider" }).toBe(true);
    expect((await frames()).lead, "1px wider").toBe(away);

    // Revealed again, the Note comes back whole, still narrowed: no wider than its least width.
    await shownTabHere.focus();
    await expect
      .poll(async () => {
        const read = await frames();
        const width = await shownTabHere.evaluate((tab) => tab.getBoundingClientRect().width);
        return { still: read.still, inView: read.inView, narrowed: width <= 132.5 };
      })
      .toEqual({ still: true, inView: true, narrowed: true });
    await app.close();
  });

  test(`a tab scrolled into view by a script, beside an open Document, comes to rest whole at every width from 1,180 to 1,440 px (${language}) (#2244)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 760);
    await setLanguage(window, language);
    const report = await addReport(window, language);
    // Names of different widths, so a narrow tab sits beside a wider one.
    for (const name of [
      NOTE[language],
      ...MORE[language],
      `${nameOf(language, 0)}, ${nameOf(language, 1)}`,
    ]) {
      await addMind(window, groupAt(window, 0), name);
    }
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    const list = listAt(window, 0);
    const names = await list
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label") ?? ""));
    for (let width = 1440; width >= 1180; width -= 20) {
      await setWindowSize(app, window, width, 760);
      for (const name of names) {
        const tab = list.getByRole("tab", { name, exact: true });
        await tab.scrollIntoViewIfNeeded();
        // Once it has held its place for six frames, the strip has come to rest.
        const whole = await tab.evaluate(async (element) => {
          const view = () => (element.parentElement as HTMLElement).getBoundingClientRect();
          let last = Math.round(element.getBoundingClientRect().left);
          for (let still = 0; still < 6; ) {
            await new Promise((next) => requestAnimationFrame(next));
            const now = Math.round(element.getBoundingClientRect().left);
            still = now === last ? still + 1 : 0;
            last = now;
          }
          const at = element.getBoundingClientRect();
          return at.left >= view().left - 1 && at.right <= view().right + 1;
        });
        expect(whole, `"${name}" at ${width} px`).toBe(true);
      }
    }
    await app.close();
  });

  test(`two groups side by side each rest on whole tabs with 3 to 8 tabs (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await setLanguage(window, language);
    await placeAssistant(window, { folded: true });
    const report = await addReport(window, language);
    await addMind(window, groupAt(window, 0), nameOf(language, 0));
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expect(window.getByTestId("tab-group")).toHaveCount(2);

    let minds = 1;
    let beside = 0;
    for (const target of [3, 5, 8]) {
      while (minds < target) {
        await addMind(window, groupAt(window, 0), nameOf(language, minds));
        minds++;
      }
      while (beside < target - 1) {
        await addMind(window, groupAt(window, 1), nameOf(language, 20 + beside));
        beside++;
      }
      await expectResting(window, `${target} tabs in each group`);
    }
    await app.close();
  });

  test(`a tab that becomes active comes whole into view, and stays whole as it changes size or the strip is scrolled (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await setLanguage(window, language);
    const report = await addReport(window, language);
    for (let index = 0; index < 4; index++) {
      await addMind(window, groupAt(window, 0), nameOf(language, index));
    }
    await expectResting(window, "four Minds");
    const list = listAt(window, 0);
    const titles = titlesOf(list);
    const mindTitles = await titles.allTextContents();
    expect(mindTitles).toHaveLength(4);

    // The newest tab is shown. ⌃Tab and ⌃⇧Tab walk to tabs that are hidden, each coming whole into view.
    for (let step = 1; step <= 4; step++) {
      await window.keyboard.press("Control+Tab");
      await expect(shownTab(window).getByTestId("tab-title")).toHaveText(
        mindTitles[(3 + step) % 4] ?? "",
      );
      await expectResting(window, `⌃Tab, step ${step}`);
    }
    for (let step = 1; step <= 4; step++) {
      await window.keyboard.press("Control+Shift+Tab");
      await expect(shownTab(window).getByTestId("tab-title")).toHaveText(
        mindTitles[(7 - step) % 4] ?? "",
      );
      await expectResting(window, `⌃⇧Tab, step ${step}`);
    }

    // A click on a tab that is whole already leaves the strip where it is.
    await window.keyboard.press("Control+Tab");
    await expectResting(window, "the second tab");
    const placed = await scrollOf(list);
    const visible = await list.getByRole("tab").evaluateAll((tabs) => {
      const view = tabs[0]?.parentElement?.getBoundingClientRect();
      return tabs.findIndex((tab) => {
        const box = tab.getBoundingClientRect();
        return view !== undefined && box.left >= view.left && box.right <= view.right;
      });
    });
    expect(visible).toBeGreaterThanOrEqual(0);
    await list.getByRole("tab").nth(visible).click();
    await expectResting(window, "a click on a whole tab");
    expect(await scrollOf(list)).toBe(placed);

    // A Mind opened from the sidebar, its tab hidden, comes into view.
    const hidden = await list.getByRole("tab").evaluateAll((tabs) => {
      const view = tabs[0]?.parentElement?.getBoundingClientRect();
      return tabs.findIndex((tab) => {
        const box = tab.getBoundingClientRect();
        return view !== undefined && (box.right <= view.left + 1 || box.left >= view.right - 1);
      });
    });
    expect(hidden).toBeGreaterThanOrEqual(0);
    const hiddenName = mindTitles[hidden] ?? "";
    await window.getByTestId("mind-list-item").filter({ hasText: hiddenName }).first().click();
    await expect(shownTab(window).getByTestId("tab-title")).toHaveText(hiddenName);
    await expectResting(window, "a Mind opened from the sidebar");

    // A new tab, then its name grown, which widens the tab after it was brought into view.
    await addMind(window, groupAt(window, 0), "Q3");
    await expectResting(window, "a short name");
    await nameMind(window, `${nameOf(language, 5)}, with a longer name than before`);
    await expectResting(window, "its name grown");

    // A mouse wheel scrolls the strip, and it rests on whole tabs when it stops.
    const box = await list.boundingBox();
    if (!box) throw new Error("The strip isn't visible.");
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, -2000);
    await expect(list).not.toHaveAttribute("data-hidden-before");
    await expectResting(window, "scrolled to the start", { shownInView: false });
    await window.mouse.wheel(0, 70);
    await expect.poll(() => scrollOf(list)).toBeGreaterThan(0);
    await expectResting(window, "scrolled a little", { shownInView: false });

    // A Document opened from the sidebar beside the Minds, its tab hidden or not, is in view too.
    await window.getByTestId("document-list-item").filter({ hasText: REPORT[language] }).click();
    await expect(window.getByTestId("document-tab")).toHaveCount(1);
    await expectResting(window, "a Document opened");
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expectResting(window, "a Citation opened the Document");
    await app.close();
  });

  test(`the strip rests on whole tabs at every window width from 960 to 1,300 px, whichever tab is shown (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await setLanguage(window, language);
    for (let index = 0; index < 5; index++) {
      await addMind(window, groupAt(window, 0), nameOf(language, index));
    }
    // The room the tabs have differs by system (the buttons beside the strip, the fonts), so a
    // width that fits two tabs on one fits one on another.
    for (let width = 1300; width >= 960; width -= 10) {
      await setWindowSize(app, window, width, 760);
      for (let step = 0; step < 3; step++) {
        if (step > 0) await window.keyboard.press("Control+Tab");
        await expectResting(window, `${width} px, shown tab ${step + 1} of the three tried`);
      }
    }
    await app.close();
  });

  test(`a tab partly shown under the fade at the strip's edge is shown by a click, and closed by its ✕, a middle click, its menu and ⌘W (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    for (let index = 0; index < 8; index++) {
      await addMind(window, groupAt(window, 0), nameOf(language, index));
    }
    const list = listAt(window, 0);
    const tabsLeft = (count: number) => expect(window.getByTestId("mind-tab")).toHaveCount(count);
    await expectResting(window, "eight Minds");

    /** The tab partly in view at one end of the strip, under the fade: its name and visible part. */
    const atEdge = async (side: "left" | "right") => {
      const found = await list.evaluate((element, end) => {
        const view = element.getBoundingClientRect();
        const tab = Array.from(element.querySelectorAll<HTMLElement>('[role="tab"]')).find(
          (each) => {
            const box = each.getBoundingClientRect();
            return end === "left"
              ? box.left < view.left - 1 && box.right > view.left + 1
              : box.right > view.right + 1 && box.left < view.right - 1;
          },
        );
        if (!tab) return null;
        const box = tab.getBoundingClientRect();
        const left = Math.max(box.left, view.left);
        const right = Math.min(box.right, view.right);
        return {
          name: tab.getAttribute("aria-label") ?? "",
          left,
          right,
          y: box.y + box.height / 2,
        };
      }, side);
      if (!found) throw new Error(`No tab is partly in view at the strip's ${side} end.`);
      const tab = window.getByRole("tab", { name: found.name, exact: true });
      const centre = { x: (found.left + found.right) / 2, y: found.y };
      // A person points at a tab before its ✕ shows.
      await window.mouse.move(centre.x + (side === "left" ? 30 : -30), centre.y, { steps: 6 });
      await window.mouse.move(centre.x, centre.y, { steps: 4 });
      return { ...found, tab, centre };
    };

    // ⌘W closes the shown tab, which is at the strip's end, with no fade over it.
    await expect(list).toHaveAttribute("data-hidden-before", "true");
    await expect(list).not.toHaveAttribute("data-hidden-after");
    await window.keyboard.press("ControlOrMeta+w");
    await tabsLeft(7);
    await expectResting(window, "⌘W at the end");

    // The end of the tab before the run shows its ✕ under the pointer, and the ✕ takes the click.
    const before = await atEdge("left");
    const close = await before.tab.getByTestId("tab-close").boundingBox();
    if (!close) throw new Error("The tab's ✕ isn't visible.");
    const closeAt = { x: close.x + close.width / 2, y: close.y + close.height / 2 };
    expect(closeAt.x).toBeGreaterThan(before.left);
    await expect
      .poll(() =>
        window.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.dataset.testid,
          closeAt,
        ),
      )
      .toBe("tab-close");
    await window.mouse.click(closeAt.x, closeAt.y);
    await tabsLeft(6);
    await expect(before.tab).toHaveCount(0);
    await expectResting(window, "closed by its ✕ at the edge");

    // Ctrl+Tab goes round to the first tab: it is shown, and the fade is on the other end.
    await window.keyboard.press("Control+Tab");
    await expect(shownTab(window)).toHaveAttribute("aria-label", nameOf(language, 0));
    await expect(list).toHaveAttribute("data-hidden-after", "true");
    await expect(list).not.toHaveAttribute("data-hidden-before");
    await expectResting(window, "the first tab shown");

    // A click on it shows it, brought whole into view; Home goes back to the first tab.
    const clicked = await atEdge("right");
    await window.mouse.click(clicked.centre.x, clicked.centre.y);
    await expect(shownTab(window)).toHaveAttribute("aria-label", clicked.name);
    await expectResting(window, "shown by a click at the edge");
    await shownTab(window).focus();
    await window.keyboard.press("Home");
    await expect(shownTab(window)).toHaveAttribute("aria-label", nameOf(language, 0));
    await expectResting(window, "the first tab shown again");

    // A middle click closes the tab at the edge, as in a browser.
    const second = await atEdge("right");
    await window.mouse.click(second.centre.x, second.centre.y, { button: "middle" });
    await tabsLeft(5);
    await expect(second.tab).toHaveCount(0);
    await expectResting(window, "closed by a middle click");

    // Its menu's Close does too.
    const third = await atEdge("right");
    await window.mouse.click(third.centre.x, third.centre.y, { button: "right" });
    const menu = third.tab.getByTestId("tab-actions");
    await expect(menu).toBeVisible();
    await menu.getByTestId("tab.close").click();
    await tabsLeft(4);
    await expect(third.tab).toHaveCount(0);
    await expectResting(window, "closed from its menu");

    // ⌘W closes the shown tab at the strip's start.
    await list.getByRole("tab").first().click();
    await expect(shownTab(window)).toHaveAttribute("aria-label", nameOf(language, 0));
    await window.keyboard.press("ControlOrMeta+w");
    await tabsLeft(3);
    await expect(window.getByRole("tab", { name: nameOf(language, 0), exact: true })).toHaveCount(
      0,
    );
    await expectResting(window, "⌘W at the start");
    await app.close();
  });
}
