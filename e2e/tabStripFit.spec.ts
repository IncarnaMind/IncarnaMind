import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { SHOW_ALL_PX } from "../src/renderer/src/components/tabs/useTabStripFit";
import { TYPE_AHEAD_MS } from "../src/renderer/src/components/usePopoverMenu";
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
  pointAndClick,
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
    /**
     * The box a name's letters fill, cut to the span that shows them: the same measure the strip's
     * fit takes, so a slice of empty span never counts as a readable name (#2244).
     */
    const textOf = (span: HTMLElement | null | undefined) => {
      if (!span) return undefined;
      const box = span.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(span);
      const letters = range.getBoundingClientRect();
      if (letters.width === 0 && letters.height === 0) return box;
      const left = Math.max(box.left, letters.left);
      const right = Math.min(box.right, letters.right);
      return right >= left
        ? { left, right, top: box.top, bottom: box.bottom, width: right - left, height: box.height }
        : box;
    };
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
        const text = textOf(title);
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
        // The room a readable piece of the hidden tab's name needs: the fade's width at least,
        // and the tab's own chrome before the name (#2244).
        if ((partLeft || outLeft) && text) {
          needBefore = Math.max(needBefore, fade, box.right - text.right + seen);
        } else if (partLeft || outLeft) {
          needBefore = Math.max(needBefore, fade);
        }
        if ((partRight || outRight) && text) {
          needAfter = Math.max(needAfter, fade, text.left - box.left + seen);
        } else if (partRight || outRight) {
          needAfter = Math.max(needAfter, fade);
        }
        // The whole tabs as they are drawn: what the fit had to fit beside them.
        if (inside) {
          whole++;
          wholeWidth += box.width;
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
      // The whole tabs and those readable pieces are wider than the room the strip has (its
      // buttons and fonts decide it, so it differs by system): the pieces give way, and only the
      // fade says more.
      const spare = strip.querySelector<HTMLElement>(".tab-strip-spacer");
      const room = list.offsetWidth + (spare?.offsetWidth ?? 0);
      const squeezed = list.hasAttribute("data-squeezed");
      // A squeezed strip has already narrowed its shown tab for the room: the pieces give way.
      const cramped = squeezed || wholeWidth + needBefore + needAfter + 10 > room + slack;
      const state = `whole ${whole}, wholeWidth ${Math.round(wholeWidth)}, need ${Math.round(needBefore)}/${Math.round(needAfter)}, room ${Math.round(room)}, cramped ${cramped}, squeezed ${squeezed}, fit ${strip.getAttribute("data-fit")}, scroll ${Math.round(list.scrollLeft)}`;
      if (!cramped) {
        if (before > 0 && !nameBefore)
          problems.push(`${where}: no name shows tabs on the left (${state})`);
        if (after > 0 && !nameAfter)
          problems.push(`${where}: no name shows tabs on the right (${state})`);
        if (fadeLeft && shownLeft) problems.push(`${where}: the fade covers the shown tab`);
        if (fadeRight && shownRight) problems.push(`${where}: the fade covers the shown tab`);
      }
      // A tab out of view is behind "Show all tabs", whose count says how many, and only while
      // one is: a strip that fits stays as it was (#2244).
      const hidden = tabs.length - whole;
      const all = strip.querySelector<HTMLElement>('[data-testid="show-all-tabs"]');
      const showing = all?.checkVisibility() === true;
      const fit = strip.getAttribute("data-fit");
      if (hidden > 0) {
        if (!all || !showing) {
          problems.push(`${where}: ${hidden} tab(s) are hidden with no Show all tabs`);
        } else {
          const said = Number(/\d+/.exec(all.getAttribute("aria-label") ?? "Show all tabs")?.[0]);
          if (said !== hidden) {
            problems.push(`${where}: Show all tabs says ${said} hidden, but ${hidden} are`);
          }
        }
        if (fit !== "cut") problems.push(`${where}: tabs hide but the strip didn't cut them`);
      } else {
        if (showing) problems.push(`${where}: Show all tabs shows with no tab hidden`);
        if (fit === "cut") problems.push(`${where}: the strip is cut with every tab in view`);
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

/**
 * A strip's fit: the room it made (null for no step), the tabs it hides, and the controls that
 * step leaves. A tab out of view is what the cut step answers, and the strip's own extent, not
 * its `scrollWidth`, decides whether they fit: the shown tab's feet reach past that.
 */
function fitOf(window: Page, index = 0) {
  return window
    .getByTestId("tab-strip")
    .nth(index)
    .evaluate((strip) => {
      const list = strip.querySelector<HTMLElement>('[data-testid="tab-list"]');
      if (!list) return null;
      const view = list.getBoundingClientRect();
      const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
      let whole = 0;
      for (const tab of tabs) {
        const box = tab.getBoundingClientRect();
        if (box.left >= view.left - 1 && box.right <= view.right + 1) whole++;
      }
      const label = strip.querySelector<HTMLElement>('[data-testid="export-mind"] > span');
      const split = strip.querySelector<HTMLElement>('[data-testid="split-group"]');
      const all = strip.querySelector<HTMLElement>('[data-testid="show-all-tabs"]');
      return {
        step: strip.getAttribute("data-fit"),
        group: Math.round(strip.getBoundingClientRect().width),
        tabs: tabs.length,
        hidden: tabs.length - whole,
        squeezed: list.hasAttribute("data-squeezed"),
        label: label?.checkVisibility() ?? null,
        split: split?.checkVisibility() ?? null,
        all: all?.checkVisibility() ? (all.getAttribute("aria-label") ?? null) : null,
      };
    });
}

type Fit = NonNullable<Awaited<ReturnType<typeof fitOf>>>;

/**
 * What is wrong with a strip's step. Each is taken only while the one before it isn't enough, so
 * a step that hides no tab leaves the next control in place, and only the tab-hiding step makes
 * one appear (#2244).
 */
function wrongStep(fit: Fit): string[] {
  const problems: string[] = [];
  const at = `${fit.tabs} tabs in ${fit.group} px, step ${fit.step ?? "none"}`;
  // Under 420px a group keeps Split in its ⋯ menu and Export to its icon whatever the step.
  const wide = fit.group >= 420;
  if (!wide && fit.label) problems.push(`${at}: a narrow group shows Export's label`);
  if (!wide && fit.split) problems.push(`${at}: a narrow group shows Split`);
  // A strip narrowed to its one shown tab hides none: the tab gives way and the narrow group's
  // own rule keeps the buttons to their icons. Nothing is hidden, so there is nothing to list.
  if (fit.squeezed && fit.hidden === 0) {
    if (fit.step === "cut") problems.push(`${at}: squeezed with the tab-hiding step`);
    if (fit.all !== null) problems.push(`${at}: Show all tabs shows with nothing hidden`);
    return problems;
  }
  if (fit.step === null) {
    if (fit.hidden > 0) problems.push(`${at}: ${fit.hidden} tab(s) hidden with no step`);
    if (wide && !fit.label) problems.push(`${at}: Export's label left while the tabs fit`);
    if (wide && !fit.split) problems.push(`${at}: Split left while the tabs fit`);
  }
  if (fit.step === "label") {
    if (fit.hidden > 0) problems.push(`${at}: ${fit.hidden} tab(s) hidden after the first step`);
    if (fit.label) problems.push(`${at}: the label step shows Export's label`);
    if (wide && !fit.split) problems.push(`${at}: Split left before the label was enough`);
  }
  if (fit.step === "split") {
    if (fit.hidden > 0) problems.push(`${at}: ${fit.hidden} tab(s) hidden after two steps`);
    if (fit.label || fit.split) problems.push(`${at}: a strip button shows after two steps`);
  }
  if (fit.step === "cut") {
    if (fit.hidden === 0) problems.push(`${at}: the strip is cut with every tab in view`);
    if (fit.label || fit.split)
      problems.push(`${at}: a strip button shows after the tabs were cut`);
    if (fit.all === null) problems.push(`${at}: tabs are hidden with no Show all tabs`);
  }
  if (fit.hidden === 0 && fit.all !== null)
    problems.push(`${at}: Show all tabs shows with nothing hidden`);
  if (fit.hidden > 0 && fit.all === null)
    problems.push(`${at}: ${fit.hidden} tab(s) hidden with no Show all tabs`);
  return problems;
}

/** The steps in order, as a walk through them takes them and gives them back. */
const STEPS = ["none", "label", "split", "cut"] as const;
const compress = (walk: readonly string[]) =>
  walk.filter((step, index) => index === 0 || walk[index - 1] !== step);

for (const language of LANGUAGES) {
  test(`the strip makes room in three steps, each only while the one before isn't enough, and gives them back as the room returns (${language}) (#2244)`, async () => {
    test.setTimeout(300_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    const report = await addReport(window, language);
    await addMind(window, groupAt(window, 0), nameOf(language, 0));
    await addMind(window, groupAt(window, 0), nameOf(language, 1));
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expect(window.getByTestId("tab-group")).toHaveCount(2);

    // The divider's keys make the Note's group as wide and as narrow as it goes, in 10px steps,
    // the room the tabs have changing with it.
    const divider = window.getByTestId("group-divider").first();
    const widthOf = () =>
      window
        .getByTestId("tab-group")
        .first()
        .evaluate((group) => group.getBoundingClientRect().width);
    /** The width the divider takes the Note's group to, and the least and most it can. */
    const rod = () =>
      divider.evaluate((element) => ({
        now: Number(element.getAttribute("aria-valuenow")),
        min: Number(element.getAttribute("aria-valuemin")),
        max: Number(element.getAttribute("aria-valuemax")),
      }));
    const press = async (
      key: "ArrowLeft" | "ArrowRight" | "Shift+ArrowLeft" | "Shift+ArrowRight",
    ) => {
      // A menu opened on the way takes the focus with it.
      await divider.focus();
      const before = await widthOf();
      await window.keyboard.press(key);
      await expect.poll(widthOf).not.toBe(before);
    };
    await divider.focus();
    // Widest first, where no step is needed and Export shows its label.
    while ((await rod()).now < (await rod()).max) await press("Shift+ArrowRight");
    const widest = (await rod()).now;

    const read = async () => {
      await expectResting(window, `the strip at ${Math.round(await widthOf())} px`);
      // The controls follow the strip's own state a render later: it settles, then holds.
      await expect
        .poll(
          async () => {
            const fit = await fitOf(window, 0);
            return fit === null ? ["no strip"] : wrongStep(fit);
          },
          { message: `the strip's step at ${Math.round(await widthOf())} px` },
        )
        .toEqual([]);
      const found = (await fitOf(window, 0)) as Fit;
      return found;
    };

    // As the room goes, the steps are taken in order; as it comes back, in reverse.
    const down: string[] = [];
    down.push((await read()).step ?? "none");
    while ((await rod()).now > (await rod()).min) {
      await press("ArrowLeft");
      down.push((await read()).step ?? "none");
    }
    // Each step in its turn, never backwards, and each state's own rule holds (wrongStep).
    expect(compress(down)).toEqual([...STEPS]);
    const up: string[] = [];
    while ((await rod()).now < widest) {
      await press("ArrowRight");
      const fit = await read();
      up.push(fit.step ?? "none");
      // With Split out of the strip, the group's ⋯ menu and the tab's own menu still offer it.
      if (fit.split === false && fit.group >= 420) {
        await window.getByTestId("group-menu").first().click();
        await expect(window.getByTestId("tab-menu-split").first()).toBeEnabled();
        await window.keyboard.press("Escape");
        await pointAndClick(window, shownTab(window).first(), { button: "right" });
        await expect(
          shownTab(window).first().getByTestId("tab-actions").getByTestId("tab.split"),
        ).toBeEnabled();
        await window.keyboard.press("Escape");
      }
    }
    // Given back in reverse, each in its turn: a 10px step may land past a narrow one's width.
    const back = compress(up);
    expect(back[0]).toBe("cut");
    expect(back.at(-1)).toBe("none");
    expect(back).toEqual([...STEPS].reverse().filter((step) => back.includes(step)));

    // With the split button gone, ⌥⌘\ and ⌘K still split the shown tab to the right.
    while ((await rod()).now > (await rod()).min) await press("Shift+ArrowLeft");
    const fit = await read();
    expect(fit.step).toBe("cut");
    await window.keyboard.press("ControlOrMeta+Alt+Backslash");
    await expect(window.getByTestId("tab-group")).toHaveCount(3);
    // Back to two groups, through the third's own menu.
    await window.getByTestId("group-menu").last().click();
    await window.getByTestId("tab-menu-close-group").click();
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(language === "en" ? "> Split to the Right" : "> 向右拆分");
    const entry = window.getByTestId("palette-item").first();
    await expect(entry).toContainText(language === "en" ? "Split to the Right" : "向右拆分");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("tab-group")).toHaveCount(3);
    await app.close();
  });

  test(`Show all tabs lists every tab of the strip, by keyboard too, and choosing one brings it whole into view (${language}) (#2244)`, async () => {
    test.setTimeout(300_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    const report = await addReport(window, language);
    await addMind(window, groupAt(window, 0), nameOf(language, 0));
    await addMind(window, groupAt(window, 0), nameOf(language, 1));
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expect(window.getByTestId("tab-group")).toHaveCount(2);

    // The Note's group at its least width: the tabs that don't fit are behind "Show all tabs".
    const divider = window.getByTestId("group-divider").first();
    const widthOf = () =>
      window
        .getByTestId("tab-group")
        .first()
        .evaluate((group) => group.getBoundingClientRect().width);
    await divider.focus();
    while ((await widthOf()) > 225) {
      const before = await widthOf();
      await window.keyboard.press("ArrowLeft");
      await expect.poll(widthOf).not.toBe(before);
    }
    const list = listAt(window, 0);
    const button = window.getByTestId("show-all-tabs").first();
    const said = (count: number) =>
      language === "en"
        ? `Show all tabs (${count} hidden)`
        : `显示所有标签页（已隐藏 ${count} 个）`;

    /** How many tabs are not whole in the strip, as the button says. */
    const hiddenCount = () =>
      list.evaluate((element) => {
        const view = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll<HTMLElement>('[role="tab"]')).filter((tab) => {
          const box = tab.getBoundingClientRect();
          return box.left < view.left - 1 || box.right > view.right + 1;
        }).length;
      });
    let hidden = await hiddenCount();
    expect(hidden).toBeGreaterThan(0);
    await expect(button).toHaveAttribute("aria-label", said(hidden));
    await expect(button).toHaveAttribute("title", said(hidden));
    // Its space in the strip is the room the fit takes when a tab hides (SHOW_ALL_PX).
    expect(
      await button.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.getBoundingClientRect().width +
          Number.parseFloat(style.marginLeft) +
          Number.parseFloat(style.marginRight)
        );
      }),
    ).toBe(SHOW_ALL_PX);

    // The keyboard reaches the button from the shown tab, and Enter opens the list.
    await shownTab(window).first().focus();
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("new-tab").first()).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await window.keyboard.press("Enter");
    const strip = window.getByTestId("tab-strip").first();
    const menu = strip.getByTestId("show-all-tabs-menu");
    await expect(menu).toBeVisible();

    // Every tab of the strip, in its order, the shown one checked, and no close buttons.
    const names = await list
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label") ?? ""));
    const rows = menu.getByTestId("show-all-tabs-row");
    await expect(rows).toHaveCount(names.length);
    expect(await rows.evaluateAll((each) => each.map((row) => row.textContent))).toEqual(names);
    const shownAt = await list.evaluate((element) =>
      Array.from(element.querySelectorAll('[role="tab"]')).findIndex(
        (tab) => tab.getAttribute("aria-selected") === "true",
      ),
    );
    await expect(rows.nth(shownAt)).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByTestId("tab-close")).toHaveCount(0);
    // Typing a name's first letters jumps to its row, as in every list on the computer; the
    // shared menu matches a Chinese name by its pinyin too.
    await window.keyboard.type(language === "en" ? "Lit" : "cheng");
    await expect(rows.nth(0)).toBeFocused();
    const menuBox = await menu.boundingBox();
    const buttonBox = await button.boundingBox();
    if (!menuBox || !buttonBox) throw new Error("The list or its button isn't visible.");
    expect(menuBox.width).toBeLessThanOrEqual(321);
    expect(Math.abs(menuBox.x + menuBox.width - (buttonBox.x + buttonBox.width))).toBeLessThan(8);

    // The keys walk the list; Enter on a hidden tab shows it, whole, and it takes the keyboard.
    await window.keyboard.press("Home");
    await window.keyboard.press("Enter");
    await expect(list.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await expect(list.getByRole("tab").first()).toBeFocused();
    await expect.poll(() => wholeInView(list, "first")).toBe(true);
    await expectResting(window, "the first tab chosen from the list");

    // More tabs, at 1,440 px in a narrow group and at 900 px where the groups share one strip.
    let minds = 2;
    for (const count of [3, 5, 12]) {
      while (minds < count) {
        await addMind(window, groupAt(window, 0), nameOf(language, minds));
        minds++;
      }
      for (const width of [1440, 900]) {
        await setWindowSize(app, window, width, 900);
        await expectResting(window, `${count} tabs at ${width} px`);
        hidden = await hiddenCount();
        if (hidden === 0) {
          await expect(button).not.toBeVisible();
          continue;
        }
        await expect(button).toHaveAttribute("aria-label", said(hidden));
        await button.click();
        await expect(menu).toBeVisible();
        const every = await window
          .getByTestId("tab-list")
          .first()
          .getByRole("tab")
          .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label") ?? ""));
        await expect(rows).toHaveCount(every.length);
        expect(await rows.evaluateAll((each) => each.map((row) => row.textContent))).toEqual(every);
        await window.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      }
    }
    await app.close();
  });

  test(`typing in the list searches from the row in focus, repeats cycle, and a Space joins a name only when the name goes on with it (${language}) (#2244)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    const first = language === "en" ? "Untitled alpha" : "城市热岛 报告";
    const second = language === "en" ? "Untitled beta" : "城市热岛 草稿";
    const other = language === "en" ? "Zebra notes" : "斑马笔记";
    const key = language === "en" ? "u" : "c";
    const none = language === "en" ? "q" : "l";
    const jump = language === "en" ? "z" : "b";
    const query = language === "en" ? "untitled b" : "chengshiredao c";
    const report = await addReport(window, language);
    for (const name of [first, second, other]) await addMind(window, groupAt(window, 0), name);
    await openDocumentAt(window, { documentId: report, ...OPENS_PDF });
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    const divider = window.getByTestId("group-divider").first();
    const widthOf = () =>
      window
        .getByTestId("tab-group")
        .first()
        .evaluate((group) => group.getBoundingClientRect().width);
    await divider.focus();
    while ((await widthOf()) > 225) {
      const before = await widthOf();
      await window.keyboard.press("ArrowLeft");
      await expect.poll(widthOf).not.toBe(before);
    }
    await expectResting(window, "the list's tabs");
    const list = listAt(window, 0);
    const button = window.getByTestId("show-all-tabs").first();
    const menu = window.getByTestId("tab-strip").first().getByTestId("show-all-tabs-menu");
    const rows = menu.getByTestId("show-all-tabs-row");
    const rowOf = (name: string) => rows.filter({ hasText: name });
    const openList = async () => {
      await shownTab(window).first().focus();
      await window.keyboard.press("Tab");
      await window.keyboard.press("Tab");
      await window.keyboard.press("Enter");
      await expect(menu).toBeVisible();
    };
    const reopen = async () => {
      await button.focus();
      await window.keyboard.press("Enter");
      await expect(menu).toBeVisible();
    };
    await openList();

    // A new name is looked for from the row after the one in focus, and round from the last.
    await window.keyboard.press("Home");
    await expect(rowOf(first)).toBeFocused();
    await window.keyboard.press(key);
    await expect(rowOf(second)).toBeFocused();

    // The same letter again, on its own, cycles to the next name starting with it.
    await window.keyboard.press(key);
    await expect(rowOf(first)).toBeFocused();

    // A Space within a name is part of it: the whole name reaches the second row, and the Space
    // never presses the row in focus.
    await window.keyboard.press("Escape");
    await expect(button).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await window.keyboard.type(query);
    await expect(rowOf(second)).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(list.getByRole("tab", { name: second, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // A key that moves the focus ends the name: a Space straight after presses the row in focus,
    // rather than joining letters typed before the move.
    await reopen();
    await window.keyboard.press(key);
    await expect(rowOf(first)).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("ArrowDown");
    const moved = await menu.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    await window.keyboard.press("Space");
    await expect(menu).not.toBeVisible();
    await expect(list.getByRole("tab", { name: moved, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // A letter no name takes ends the search too: the Space after it presses the focused row.
    await reopen();
    await window.keyboard.press("Home");
    await expect(rowOf(first)).toBeFocused();
    await window.keyboard.press(none);
    await expect(rowOf(first)).toBeFocused();
    await window.keyboard.press("Space");
    await expect(menu).not.toBeVisible();
    await expect(list.getByRole("tab", { name: first, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The pause ends the search as well: a Space then presses the row in focus.
    await reopen();
    await window.keyboard.press(key);
    await expect(rowOf(second)).toBeFocused();
    await window.waitForTimeout(TYPE_AHEAD_MS + 100);
    await window.keyboard.press("Space");
    await expect(menu).not.toBeVisible();
    await expect(list.getByRole("tab", { name: second, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // A letter that jumped to a row, then a Space straight after: the space goes on with no name,
    // so it presses the row the letter reached.
    await reopen();
    await window.keyboard.press(jump);
    await expect(rowOf(other)).toBeFocused();
    await window.keyboard.press("Space");
    await expect(menu).not.toBeVisible();
    await expect(list.getByRole("tab", { name: other, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The same for a letter that reaches the row after the one shown.
    await reopen();
    await window.keyboard.press(key);
    const reached = await menu.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    await window.keyboard.press("Space");
    await expect(menu).not.toBeVisible();
    await expect(list.getByRole("tab", { name: reached, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await app.close();
  });

  test(`the fit is the tabs' own extent, so a shown tab's feet past the strip's edge hide nothing (${language}) (#2244)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await addMind(window, groupAt(window, 0), nameOf(language, 0));
    await addMind(window, groupAt(window, 0), nameOf(language, 1));
    const list = listAt(window, 0);
    await expectResting(window, "two tabs");

    // The shown tab's corner curves reach past the strip's end padding, as they always do: its
    // scroll box then reads as overflowing while every tab is inside. The fit must not fall for it.
    await window.evaluate(() => {
      const style = document.createElement("style");
      style.id = "tab-feet-past-the-strip";
      style.textContent =
        '.tab[aria-selected="true"] .tab-foot[data-side="right"] { right: -24px; }';
      document.head.append(style);
    });
    await setWindowSize(app, window, 1439, 900);
    await setWindowSize(app, window, 1440, 900);
    await expect
      .poll(() => list.evaluate((element) => element.scrollWidth - element.clientWidth), {
        message: "the feet read as overflow",
      })
      .toBeGreaterThan(0);
    await expectResting(window, "the feet past the strip");
    await expect(window.getByTestId("tab-strip").first()).not.toHaveAttribute("data-fit");
    await expect(window.getByTestId("show-all-tabs").first()).not.toBeVisible();
    await expect
      .poll(() =>
        list.getByRole("tab").evaluateAll((tabs) => {
          const strip = tabs[0]?.parentElement ?? null;
          if (strip === null) return false;
          const view = strip.getBoundingClientRect();
          return tabs.every((tab) => {
            const box = tab.getBoundingClientRect();
            return box.left >= view.left - 1 && box.right <= view.right + 1;
          });
        }),
      )
      .toBe(true);

    await window.evaluate(() => document.getElementById("tab-feet-past-the-strip")?.remove());
    await setWindowSize(app, window, 1439, 900);
    await setWindowSize(app, window, 1440, 900);
    await expectResting(window, "the feet back inside");
    await app.close();
  });

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
        // The strip comes to rest, then holds: its scroll and width stop changing for six frames,
        // and the tab it brought into view is whole.
        try {
          await expect
            .poll(
              () =>
                tab.evaluate(async (element) => {
                  const strip = element.parentElement as HTMLElement;
                  let last = "";
                  for (let still = 0; still < 6; ) {
                    await new Promise((next) => requestAnimationFrame(next));
                    const now = `${Math.round(strip.scrollLeft)}|${Math.round(strip.getBoundingClientRect().width)}`;
                    still = now === last ? still + 1 : 0;
                    last = now;
                  }
                  const view = strip.getBoundingClientRect();
                  const at = element.getBoundingClientRect();
                  const whole = at.left >= view.left - 1 && at.right <= view.right + 1;
                  // A tab wider than the strip can't be whole: it is shown from its start, and
                  // "Show all tabs" reaches everything.
                  const tooWide = at.width > view.width + 1;
                  const atStart = Math.abs(at.left - view.left) <= 1;
                  return whole || (tooWide && atStart);
                }),
              { message: `"${name}" at ${width} px` },
            )
            .toBe(true);
        } catch (error) {
          const seen = await tab.evaluate((element) => {
            const strip = element.parentElement as HTMLElement;
            const view = strip.getBoundingClientRect();
            const at = element.getBoundingClientRect();
            const all = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]')).map(
              (tab) => {
                const box = tab.getBoundingClientRect();
                return `${tab.getAttribute("aria-label")?.slice(0, 8)} ${Math.round(box.left)}..${Math.round(box.right)}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`;
              },
            );
            return {
              view: `${Math.round(view.left)}..${Math.round(view.right)}`,
              tab: `${Math.round(at.left)}..${Math.round(at.right)}`,
              scrollLeft: Math.round(strip.scrollLeft),
              clientWidth: strip.clientWidth,
              scrollWidth: strip.scrollWidth,
              run: strip.style.getPropertyValue("--tab-run"),
              fit: strip
                .closest<HTMLElement>('[data-testid="tab-strip"]')
                ?.getAttribute("data-fit"),
              all,
            };
          });
          throw new Error(`"${name}" at ${width} px: ${JSON.stringify(seen)}`, { cause: error });
        }
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
