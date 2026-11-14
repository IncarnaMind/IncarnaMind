import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tokenColor,
  useLocalChatModel,
} from "./app";

/*
 * A card that shows from a control on keyboard focus (#3102, docs/agents/interaction.md): focus on
 * the control shows it at once; it is no Tab stop, so Tab and Shift+Tab go from control to control
 * the same at a person's pace and all at once; Space on the control goes into the card, whose Tab
 * and Shift+Tab go back to the control past either end; Esc goes back to the control, and Esc on
 * the control hides the card. A "Space to use" keycap shows only when the card has a control.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = {
  en: [
    "Harbours publish the times of high water.",
    " Tide tables are printed each year.",
    " The pilots read them before sailing.",
  ],
  "zh-CN": ["港口公布高潮的时间。", "潮汐表每年印制一次。", "领航员出航前会查阅它们。"],
} as const;

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
 * A log of every element the focus lands on, by name: inside a card as `card`, a margin mark or
 * a chart value by its test id and what it is for, anything else by its test id.
 */
const logFocus = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { landed: string[]; logging?: boolean };
    holder.landed = [];
    if (holder.logging) return;
    holder.logging = true;
    document.addEventListener(
      "focusin",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        holder.landed.push(
          target.closest("[popover]")
            ? "card"
            : [
                target.getAttribute("data-testid") ?? target.tagName,
                target.getAttribute("data-claim") ?? target.getAttribute("data-point"),
              ]
                .filter(Boolean)
                .join(" "),
        );
      },
      true,
    );
  });

const landed = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { landed: string[] }).landed);

/** Where the focus is now, named as `logFocus` names it. */
const whereIsFocus = (window: Page) =>
  window.evaluate(() => {
    const target = document.activeElement;
    if (!target) return "nothing";
    if (target.closest("[popover]")) return "card";
    return [
      target.getAttribute("data-testid") ?? target.tagName,
      target.getAttribute("data-claim") ?? target.getAttribute("data-point"),
    ]
      .filter(Boolean)
      .join(" ");
  });

/** The focus's places with a run inside one card taken as one. */
const places = (log: readonly string[]) =>
  log.filter((place, at) => place !== "card" || log[at - 1] !== "card");

/**
 * The caret at the start of the first sentence, put there by a click as a person does, with the
 * pointer then put out of the way: a card that grows under a pointer at rest is the pointer's,
 * and stays until it moves.
 */
async function caretAtStart(window: Page, editor: Locator) {
  const first = await editor.locator(":scope > p").first().boundingBox();
  if (!first) throw new Error("The first sentence isn't drawn.");
  await window.mouse.click(first.x + 2, first.y + first.height / 2);
  await expect(editor).toBeFocused();
  await window.mouse.move(0, 0);
}

/** The pointer has rested: a few frames have been drawn since it last moved. */
const rested = (window: Page) =>
  window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => (++frames < 5 ? requestAnimationFrame(tick) : resolve());
        requestAnimationFrame(tick);
      }),
  );

/** A dialog opens over the focused control and closes: the browser puts the focus back on it. */
async function dialogOver(window: Page, control: Locator, how: "palette" | "settings") {
  if (how === "palette") {
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("palette")).toHaveCount(0);
  } else {
    await window.keyboard.press("ControlOrMeta+,");
    await expect(window.locator("dialog[open]")).toHaveCount(1);
    await window.keyboard.press("Escape");
    await expect(window.locator("dialog[open]")).toHaveCount(0);
  }
  await expect(control).toBeFocused();
}

/**
 * Coming back shows no card (#3102): the focus a dialog gives back to `control` opens nothing, so
 * nothing covers the page; Space shows the card and goes in, so does the pointer on the control,
 * and so does moving the focus away (`away`) and back (`back`). A card Space went into is kept as
 * it is left by Esc.
 */
async function comesBackQuietly(
  window: Page,
  control: Locator,
  card: Locator,
  keys: { away: string; back: string },
) {
  const nothingShows = async () => {
    await expect(control).toBeFocused();
    await rested(window);
    await expect(card).toHaveCount(0);
    await rested(window);
    await expect(card).toHaveCount(0);
  };
  await dialogOver(window, control, "palette");
  await nothingShows();

  await window.keyboard.press("Space");
  await expect(card).toHaveCount(1);
  await expect.poll(() => whereIsFocus(window)).toBe("card");
  await window.keyboard.press("Escape");
  await expect(control).toBeFocused();
  await expect(card).toHaveCount(1);
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await dialogOver(window, control, "settings");
  await nothingShows();
  await control.hover();
  await expect(card).toHaveCount(1);
  await window.mouse.move(0, 0);
  await expect(card).toHaveCount(0);

  await dialogOver(window, control, "palette");
  await nothingShows();
  await window.keyboard.press(keys.away);
  await expect(control).not.toBeFocused();
  await window.keyboard.press(keys.back);
  await expect(control).toBeFocused();
  await expect(card).toHaveCount(1);
}

/** The Note as it is stored, so a key that typed into it shows. */
const noteOf = (editor: Locator) =>
  editor.evaluate((dom) => JSON.stringify((dom as unknown as { editor: Editor }).editor.getJSON()));

/**
 * The ring on the focused stop: drawn for a key's focus, in the accent colour. A plot's bar is
 * ringed by its fill going to the accent; everything else by an outline or a shadow in it.
 */
async function expectRing(window: Page, accent: string) {
  const ring = await window.evaluate(() => {
    const target = document.activeElement;
    if (!target) return null;
    const style = getComputedStyle(target);
    return {
      keyboard: target.matches(":focus-visible"),
      svg: target instanceof SVGElement,
      fill: style.fill,
      line: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      color: style.outlineColor,
      shadow: style.boxShadow,
    };
  });
  expect(ring?.keyboard, "the focus is a key's").toBe(true);
  const drawn = ring?.svg
    ? ring.fill === accent
    : (ring?.line !== "none" && (ring?.width ?? 0) > 0 && ring?.color === accent) ||
      (ring?.shadow ?? "").includes(accent);
  expect(drawn, `the focus ring is drawn in the accent (${JSON.stringify(ring)})`).toBe(true);
}

const CHIP = "citation-chip";

/** A Note with three Citations in one paragraph, in a window wide enough for two groups (below 1,000 px, or a Note area under 736 px, the groups share one strip). */
async function openThreeChips(language: "en" | "zh-CN", width = 1600) {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, systemColours: true });
  await dismissChatSetup(window);
  // biome-ignore lint/correctness/useHookAtTopLevel: an e2e helper whose name begins with "use", not a React hook.
  await useLocalChatModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  const [tides] = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  const cite = (at: number) => ({
    type: "citation",
    attrs: {
      passageId: `passage-${at}`,
      documentId: tides?.id,
      documentName: "Tides",
      contentHash: tides?.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Harbours publish the times of high water every 12 months.",
      check: "found",
      checkReason: null,
    },
  });
  const [first, second, third] = SENTENCES[language];
  await editor.evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
    },
    [
      {
        type: "paragraph",
        content: [
          { type: "text", text: first },
          cite(1),
          { type: "text", text: second },
          cite(2),
          { type: "text", text: third },
          cite(3),
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "·" }] },
    ],
  );
  await expect(window.getByTestId(CHIP)).toHaveCount(3);
  return { app, window, editor };
}

const MARK = "claim-mark";

/** Acme's quarterly revenue, as `charts.spec.ts` has it: a chart of its cited table has values with a card. */
const REPORT = buildPdf([
  { lines: ["Revenue by quarter, 2024", "Quarterly revenue was 289.4, 301.2, 309.8 and 330.6."] },
  { lines: ["Revenue by quarter, 2025", "Quarterly revenue was 341.5, 362.0 and 377.9."] },
]);

const NARROW = 900;
const shot = async (window: Page, name: string) => {
  await motionSettled(window);
  await test.info().attach(`still-${name}.png`, {
    body: await window.screenshot(),
    contentType: "image/png",
  });
};

for (const language of ["en", "zh-CN"] as const) {
  test(`narrow: a Citation's card with the hint (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor } = await openThreeChips(language, NARROW);
    const hint = window.getByTestId("card-key-hint");
    await caretAtStart(window, editor);
    await window.keyboard.press("Tab");
    await expect(hint).toBeVisible();
    await shot(window, `narrow-chip-hint-${language}`);
    await window.keyboard.press("Space");
    await expect.poll(() => whereIsFocus(window)).toBe("card");
    await shot(window, `narrow-chip-in-card-${language}`);
    await app.close();
  });

  test(`narrow: a margin mark's card with the hint (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, systemColours: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, NARROW, 900);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    const checkedAt = new Date(Date.now() + 60_000).toISOString();
    const mark = (id: string, text: string) => ({
      type: "claimCheck",
      attrs: {
        id,
        request: "check-1",
        action: "check-against-documents",
        state: "unsupported",
        text,
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt,
      },
    });
    const [first, second] = SENTENCES[language];
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [first, second.trim()].map((text, at) => ({
        type: "paragraph",
        content: [{ type: "text", text, marks: [mark(`check-${at + 1}`, text)] }],
      })),
    );
    await expect(window.getByTestId(MARK)).toHaveCount(2);
    const marks = window.getByTestId(MARK);
    const hint = window.getByTestId("card-key-hint");
    await window.mouse.move(0, 0);
    await caretAtStart(window, editor);
    for (
      let key = 0;
      key < 8 && !(await marks.first().evaluate((each) => each === document.activeElement));
      key++
    ) {
      await window.keyboard.press("Tab");
    }
    await expect(marks.first()).toBeFocused();
    await expect(hint).toBeVisible();
    await shot(window, `narrow-mark-hint-${language}`);
    await app.close();
  });

  test(`narrow: a chart value's card with the hint (${language})`, async () => {
    test.setTimeout(240_000);
    await writeFile(join(sources, "Acme.pdf"), REPORT);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, systemColours: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, NARROW, 900);
    await addDocuments(window, [join(sources, "Acme.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await addToNote(
      window,
      await askInAssistant(
        window,
        language === "en" ? "Revenue by quarter?" : "按季度列出营业收入 revenue quarter",
      ),
    );
    const table = editor.locator("table");
    await expect(table.getByTestId("citation")).toHaveCount(7);
    await pointAndClick(window, table.locator("td").filter({ hasText: /^Q2$/ }));
    await pointAndClick(window, window.getByTestId("table-menu"));
    await pointAndClick(window, window.getByTestId("chart.fromTable"));
    const chart = editor.getByTestId("chart");
    await expect(chart.getByTestId("chart-point")).toHaveCount(8);
    const card = window.getByTestId("chart-card");
    const hint = window.getByTestId("card-key-hint");
    const cited = chart.locator('[data-testid="chart-point"][aria-keyshortcuts="Space"]').first();
    await window.mouse.move(0, 0);
    await cited.focus();
    await expect(card).toHaveCount(1);
    await expect(hint).toBeVisible();
    await shot(window, `narrow-chart-hint-${language}`);
    await app.close();
  });
}
