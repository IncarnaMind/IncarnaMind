import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { GROUP_MIN_WIDTH } from "../src/renderer/src/assistantPlace";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkNote,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  noteCheck,
  placeAssistant,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setSidebarShown,
  setWindowSize,
  watchShifts,
} from "./app";
import { holdModel, modelHeld } from "./heldModel";

/*
 * The Note's Check in its tab strip (#3794, #3765, #2519): from the press on, a check run to its
 * end with no input moves nothing in the strip, nor its card: the Check and its Stop keep the
 * widest room they had until the User types. At a group's least width the Check is whole and the
 * shown tab keeps its title. In a group narrower than that, the strip gives way in one order
 * whatever its width: Export and the conversation's button leave, the Note's other controls give
 * up their room, then the Check gives up its word, before the tab goes under its least width; only
 * past the tab's icon and ✕ does the Check give up its start, never its end; the ⋯ and its Stop
 * stay.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = [
  "Spring tides happen at new and full moon.",
  "The Moon raises two bulges of water on the Earth.",
  "Harbours publish the times of high water every 12 months.",
  "Penguins nest on the harbour cliffs.",
];

const WORDS = {
  en: {
    stop: "Stop",
    running: /^Checking… \d+ of 4$/,
    runningTitle: /^Checking \d+ of 4$/,
    name: "Tides",
  },
  "zh-CN": {
    stop: "停止",
    running: /^正在核对 \d+\/4…$/,
    runningTitle: /^正在核对 \d+\/4$/,
    name: "潮汐",
  },
} as const;

/** The least width DESIGN.md gives the shown tab, so its title stays readable. */
const SHOWN_LEAST_PX = 132;

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

/** The Note with its four sentences and the Document they are checked against. */
async function noteToCheck(window: Page, language: "en" | "zh-CN") {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setLanguage(window, language);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await nameMind(window, WORDS[language].name);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await window.keyboard.type(SENTENCES.join(" "));
  await expect(editor).toContainText(SENTENCES.at(-1) ?? "");
  await expect(noteCheck(window)).toHaveAttribute("data-state", "check");
}

/** The test ids in the strip now: what is drawn there, for what may not move. */
const idsIn = (strip: Locator) =>
  strip.evaluate((band) => [
    "tab-strip",
    ...[...band.querySelectorAll("[data-testid]")].map(
      (element) => element.getAttribute("data-testid") ?? "",
    ),
  ]);

/** Where the strip's parts and the card are drawn. */
const placesOf = (strip: Locator) =>
  strip.evaluate((band) => {
    const box = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect ? [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(",") : "none";
    };
    return {
      tab: box(band.querySelector('[role="tab"][aria-selected="true"]')),
      plus: box(band.querySelector('[data-testid="new-tab"]')),
      room: box(band.querySelector('[data-testid="note-check-place"]')),
      controls: box(band.querySelector('[data-testid="note-controls"]')),
      export: box(band.querySelector('[data-testid="export-mind"]')),
      more: box(band.querySelector('[data-testid="page-menu"]')),
      card: box(document.querySelector('[data-testid="check-card"]')),
    };
  });

/** What each strip shows and where, as a person would see it. */
const stripsNow = (window: Page) =>
  window.evaluate(() => {
    const box = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
    };
    const drawn = (element: Element | null) =>
      element !== null && element.getClientRects().length > 0;
    const hit = (element: Element | null | undefined) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return at !== null && element.contains(at);
    };
    return [...document.querySelectorAll('[data-testid="tab-strip"]')].map((strip) => {
      const tab = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const title = tab?.querySelector<HTMLElement>('[data-testid="tab-title"]');
      const controls = strip.querySelector<HTMLElement>('[data-testid="note-controls"]');
      const check = controls?.querySelector('[data-testid="note-check"]');
      const stop = controls?.querySelector('[data-testid="note-check-stop"]');
      const more = strip.querySelector('[data-testid="page-menu"]');
      const others = controls
        ? [...controls.children].filter((each) => !each.matches(".note-head-badge"))
        : [];
      const checkBox = box(check);
      const controlsBox = box(controls);
      return {
        strip: box(strip),
        tab: box(tab),
        chrome: tab && title ? tab.offsetWidth - title.offsetWidth : 0,
        titleWhole: title ? title.clientWidth > 0 && title.scrollWidth <= title.clientWidth : false,
        close: box(tab?.querySelector('[data-testid="tab-close"]')),
        plus: box(strip.querySelector('[data-testid="new-tab"]')),
        exportShown: drawn(strip.querySelector('[data-testid="export-mind"]')),
        conversationShown: drawn(
          strip.querySelector('[data-testid="note-ask-conversation-toggle"]'),
        ),
        compact: strip.hasAttribute("data-check-compact"),
        controls: controlsBox,
        check: checkBox,
        checkHit: check ? hit(check) : null,
        stop: box(stop),
        stopHit: stop ? hit(stop) : null,
        more: box(more),
        moreHit: hit(more),
        checkCut:
          checkBox !== null && controlsBox !== null && checkBox.left < controlsBox.left - 0.5,
        othersCut: others.some((each) => each.scrollWidth > each.clientWidth + 0.5),
      };
    });
  });

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`from the press on, a check runs to its end with no input and nothing in a full strip moves; Stop by its name stops one, and the Check then opens the card (${language})`, async () => {
    test.setTimeout(150_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      // Other Notes in the group first, so its strip has no room to spare.
      await setWindowSize(app, window, 1120, 800);
      for (let other = 0; other < 4; other++) await newMind(window);
      await noteToCheck(window, language);
      const strip = window.getByTestId("tab-strip");
      const button = noteCheck(window);
      const stop = strip.getByTestId("note-check-stop");

      // Stop, by its name, stops a run.
      await holdModel(app, "hold", true);
      await checkNote(window);
      await expect.poll(() => modelHeld(app)).toBe(true);
      await expect(stop).toBeVisible();
      await expect(stop).toHaveAccessibleName(words.stop);
      await expect(stop).toHaveAttribute("title", words.stop);
      await pointAndClick(window, stop);
      await expect(stop).toHaveCount(0);
      await holdModel(app, "hold", false);
      await expect(
        window.getByTestId("claim-mark").and(window.locator('[data-check="checking"]')),
      ).toHaveCount(0);
      await expect(button).toHaveAttribute("data-state", "check");
      await motionSettled(window);

      // A whole run: the press is the only input.
      await holdModel(app, "hold", true);
      await checkNote(window);
      await expect.poll(() => modelHeld(app)).toBe(true);
      // Running: how far it has got, drawn, with the run's words in full as its tooltip, and Stop.
      await expect(button.locator(".note-check-words")).toHaveText(words.running);
      await expect(button).toHaveAttribute("title", words.runningTitle);
      await expect(stop).toBeVisible();
      await motionSettled(window);
      const before = await placesOf(strip);
      const kept = new Set([...(await idsIn(strip)), "check-card"]);

      const shifts = await watchShifts(window);
      await holdModel(app, "hold", false);
      await expect(stop).toHaveCount(0, { timeout: 30_000 });
      await expect(button).not.toHaveAttribute("data-state", "checking");
      await motionSettled(window);
      for (const id of await idsIn(strip)) kept.add(id);
      // The strip's parts and the card's own box; the card's rows take what the check found.
      const moved = (await shifts()).filter((each) => !each.inCard && kept.has(each.testId));
      const trail = moved
        .map(
          (each) =>
            `${each.testId}${each.inCard ? " (in the card)" : ""} ${each.from} to ${each.to}`,
        )
        .join("; ");
      expect(moved, `what moved with no input: ${trail}`).toEqual([]);
      expect(await placesOf(strip)).toEqual(before);

      // A press on what the check found opens its card, and never lands on "+".
      await expect(button).toHaveAttribute("data-state", "look");
      await expect(window.getByTestId("check-card")).toHaveCount(0);
      const tabs = await window.getByTestId("mind-tab").count();
      const target = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const at = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return at?.closest("[data-testid]")?.getAttribute("data-testid") ?? "";
      });
      expect(target).toBe("note-check");
      await pointAndClick(window, button);
      await expect(window.getByTestId("check-card")).toBeVisible();
      await expect(window.getByTestId("mind-tab")).toHaveCount(tabs);
    } finally {
      await app.close();
    }
  });

  test(`at a group's least width the Check is whole and the tab keeps its title; narrower, the strip gives way in its one order, the Check before the tab, and Stop stays in view (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1600, 900);
      await noteToCheck(window, language);
      await setSidebarShown(window, false);
      await placeAssistant(window, { dock: "bottom", folded: true });
      const groups = window.getByTestId("tab-group");
      await window.keyboard.press("ControlOrMeta+Alt+Backslash");
      await expect(groups).toHaveCount(2);
      await window.keyboard.press("ControlOrMeta+Alt+Backslash");
      await expect(groups).toHaveCount(3);
      await expect(groups.nth(2).getByTestId("mind-tab")).toBeFocused();
      for (const index of [0, 1]) {
        const divider = window.getByTestId("group-divider").nth(index);
        await divider.focus();
        for (let press = 0; press < 40; press++) await window.keyboard.press("Shift+ArrowLeft");
        const least = await divider.getAttribute("aria-valuemin");
        expect(Number(least)).toBeGreaterThanOrEqual(GROUP_MIN_WIDTH);
        await expect.poll(() => divider.getAttribute("aria-valuenow")).toBe(least);
      }
      await motionSettled(window);

      // At the least width, once the strips have fitted it: the tab at its least width or wider,
      // with its title whole, and the Check whole.
      await expect(async () => {
        const atLeast = await stripsNow(window);
        for (const [at, strip] of atLeast.slice(0, 2).entries()) {
          const about = `group ${at + 1}: ${JSON.stringify(strip)}`;
          expect(strip.tab?.width ?? 0, about).toBeGreaterThanOrEqual(SHOWN_LEAST_PX - 0.5);
          expect(strip.titleWhole, about).toBe(true);
          expect(strip.checkCut, about).toBe(false);
          expect(strip.othersCut, about).toBe(false);
          expect(strip.check, about).not.toBeNull();
          expect(strip.checkHit, about).toBe(true);
          expect(strip.moreHit, about).toBe(true);
          if (strip.compact) expect(strip.exportShown, about).toBe(false);
        }
      }).toPass();

      // Narrower, as the window narrows and each group keeps its share.
      const holds = (strips: Awaited<ReturnType<typeof stripsNow>>, width: number) => {
        for (const [at, strip] of strips.entries()) {
          const about = `${width}px, strip ${at + 1}: ${JSON.stringify(strip)}`;
          const tab = strip.tab?.width ?? 0;
          if (tab < SHOWN_LEAST_PX - 0.5) {
            expect(strip.exportShown, about).toBe(false);
            expect(strip.conversationShown, about).toBe(false);
            // The Check gave up its word before the tab went under its least width.
            expect(strip.compact, about).toBe(true);
          }
          // Its word goes only once Export has left the row.
          if (strip.compact) expect(strip.exportShown, about).toBe(false);
          // The Note's other controls give up their room, and then the Check its start, only past
          // the tab's icon and ✕, and only once the Check has given up its word.
          if (strip.othersCut || strip.checkCut) {
            expect(tab, about).toBeLessThanOrEqual(strip.chrome + 1);
            expect(strip.compact, about).toBe(true);
            expect(strip.exportShown, about).toBe(false);
          }
          expect(strip.moreHit, about).toBe(true);
          expect(strip.more?.right ?? 0, about).toBeLessThanOrEqual(
            (strip.strip?.right ?? 0) + 0.5,
          );
          if (strip.check && strip.controls) {
            expect(strip.check.right, about).toBeLessThanOrEqual(strip.controls.right + 0.5);
            // Its end stays in view: its number, or while it runs its Stop (checked below).
            if (!strip.stop)
              expect(strip.check.right - 22, about).toBeGreaterThanOrEqual(
                strip.controls.left - 0.5,
              );
          }
          expect(strip.close?.right ?? 0, about).toBeLessThanOrEqual((strip.plus?.left ?? 0) + 0.5);
        }
      };
      for (const width of [1400, 1250, 1100]) {
        await setWindowSize(app, window, width, 900);
        await motionSettled(window);
        // Once the strips have fitted the new width.
        await expect(async () => holds(await stripsNow(window), width)).toPass();
      }

      // Running in the narrowest groups: Stop whole and in view in every strip.
      await holdModel(app, "hold", true);
      await checkNote(window, groups.last());
      await expect.poll(() => modelHeld(app)).toBe(true);
      await expect(window.getByTestId("note-check-stop")).toHaveCount(3);
      await motionSettled(window);
      await expect(async () => {
        const running = await stripsNow(window);
        holds(running, 1100);
        for (const [at, strip] of running.entries()) {
          const about = `running, strip ${at + 1}: ${JSON.stringify(strip)}`;
          expect(strip.stopHit, about).toBe(true);
          expect(strip.stop?.left ?? 0, about).toBeGreaterThanOrEqual(
            (strip.controls?.left ?? 0) - 0.5,
          );
          expect(strip.stop?.right ?? 0, about).toBeLessThanOrEqual(
            (strip.controls?.right ?? 0) + 0.5,
          );
        }
      }).toPass();
      await holdModel(app, "hold", false);
      await expect(window.getByTestId("note-check-stop")).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await app.close();
    }
  });
}
