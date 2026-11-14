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

/** The Note as it is stored, so a key that typed into it shows. */
const noteOf = (editor: Locator) =>
  editor.evaluate((dom) => JSON.stringify((dom as unknown as { editor: Editor }).editor.getJSON()));

/** The ring on the focused stop: drawn for a key's focus, in the accent colour. */
async function expectRing(window: Page, accent: string) {
  const ring = await window.evaluate(() => {
    const target = document.activeElement;
    if (!target) return null;
    const style = getComputedStyle(target);
    return {
      keyboard: target.matches(":focus-visible"),
      line: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      color: style.outlineColor,
      shadow: style.boxShadow,
    };
  });
  expect(ring?.keyboard, "the focus is a key's").toBe(true);
  const outlined = ring?.line !== "none" && (ring?.width ?? 0) > 0 && ring?.color === accent;
  expect(outlined || (ring?.shadow ?? "none") !== "none", "the focus ring is drawn").toBe(true);
}


const stillOf = async (window: Page, name: string) => {
  await motionSettled(window);
  await test.info().attach(`still-${name}.png`, {
    body: await window.screenshot(),
    contentType: "image/png",
  });
};
const bothThemes = async (window: Page, name: string) => {
  for (const scheme of ["light", "dark"] as const) {
    await window.emulateMedia({ colorScheme: scheme });
    await stillOf(window, `${name}-${scheme}`);
  }
};
const CHIP = "citation-chip";

for (const language of ["en", "zh-CN"] as const) {
  test(`three Citations in a paragraph: Tab goes from chip to chip the same at a person's pace and all at once, Space goes into a card and Tab and Esc come back, and Shift+Tab goes back (${language})`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, systemColours: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
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
    const card = window.getByTestId("citation-card");
    const hint = window.getByTestId("card-key-hint");
    const chips = window.getByTestId(CHIP);

    // The card has opened by the next key: one card, and it has stopped growing.
    const settle = async () => {
      if ((await whereIsFocus(window)).startsWith(CHIP)) await expect(card).toHaveCount(1);
      await motionSettled(window);
    };

    for (const scheme of ["light", "dark"] as const) {
      await window.emulateMedia({ colorScheme: scheme });
      const accent = await tokenColor(window, "--color-accent");

      // At a person's pace: the card of each chip is open before the next key.
      await caretAtStart(window, editor);
      await logFocus(window);
      for (let key = 0; key < 3; key++) {
        await window.keyboard.press("Tab");
        await settle();
        await expectRing(window, accent);
      }
      const paced = await landed(window);
      expect(paced).toEqual([CHIP, CHIP, CHIP]);
      expect(await whereIsFocus(window)).toBe(CHIP);

      // All at once: the keys come faster than a card could open.
      await window.keyboard.press("Escape");
      await caretAtStart(window, editor);
      await logFocus(window);
      await Promise.all([1, 2, 3].map(() => window.keyboard.press("Tab")));
      await motionSettled(window);
      expect(await landed(window)).toEqual(paced);
    }

    // One more Tab is the page's next stop after the last chip: a stop of the page, not a card and not a chip.
    await window.keyboard.press("Tab");
    await settle();
    const after = await window.evaluate(() => ({
      card: document.activeElement?.closest("[popover]") !== null,
      page: document.activeElement !== document.body && document.activeElement !== null,
    }));
    expect(after).toEqual({ card: false, page: true });
    expect(await whereIsFocus(window)).not.toBe(CHIP);

    // Shift+Tab goes back through the chips, not into a card: the last chip, the one before, the first.
    await logFocus(window);
    for (let key = 0; key < 3; key++) {
      await window.keyboard.press("Shift+Tab");
      await settle();
    }
    expect(await landed(window)).toEqual([CHIP, CHIP, CHIP]);

    // The card shown by the focus says which key goes into it, and Space goes in without typing.
    await window.keyboard.press("Escape");
    await caretAtStart(window, editor);
    await window.keyboard.press("Tab");
    await settle();
    await expect(chips.first()).toHaveAttribute("aria-keyshortcuts", "Space");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("Space");
    await expect(hint).toContainText(t("card.useKey"));
    await bothThemes(window, `chip-hint-${language}`);
    const note = await noteOf(editor);
    await logFocus(window);
    await window.keyboard.press("Space");
    await expect.poll(() => whereIsFocus(window)).toBe("card");
    await bothThemes(window, `chip-in-card-${language}`);
    expect(await noteOf(editor), "Space typed nothing into the Note").toBe(note);
    await expect(window.getByTestId("viewer"), "Space opened no page").toHaveCount(0);
    await expect(hint).toHaveCount(0);
    const controls = await card.locator('button:visible:not([tabindex="-1"])').count();
    expect(controls, "the card has controls").toBeGreaterThan(0);

    // Inside, Tab goes through the controls, and past the last one back to the chip: no wrap, no
    // other chip, no top of the page.
    await logFocus(window);
    for (let key = 1; key < controls; key++) {
      await window.keyboard.press("Tab");
      expect(await whereIsFocus(window)).toBe("card");
    }
    await window.keyboard.press("Tab");
    expect(await whereIsFocus(window)).toBe(CHIP);
    await expect(chips.first()).toBeFocused();
    await expect(card).toHaveCount(1);
    await expect(hint).toBeVisible();

    // Shift+Tab from the first control goes back to the chip too.
    await window.keyboard.press("Space");
    await expect.poll(() => whereIsFocus(window)).toBe("card");
    await window.keyboard.press("Shift+Tab");
    await expect(chips.first()).toBeFocused();

    // Esc from inside goes back to the chip and keeps the card; Esc on the chip hides it, and the
    // next Tab goes on to the next chip.
    await window.keyboard.press("Space");
    await expect.poll(() => whereIsFocus(window)).toBe("card");
    await window.keyboard.press("Tab");
    await window.keyboard.press("Escape");
    await expect(chips.first()).toBeFocused();
    await expect(card).toHaveCount(1);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(chips.first()).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(chips.nth(1)).toBeFocused();
    await expect(card).toHaveCount(1);

    // Space while an input method composes does nothing.
    const untouched = await chips.nth(1).evaluate((chip) =>
      chip.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(untouched, "the key was left to the input method").toBe(true);
    await expect(chips.nth(1)).toBeFocused();

    // Enter on a chip still opens its page, beside the Note in a window this wide.
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
    await app.close();
  });
}

const MARK = "claim-mark";

for (const language of ["en", "zh-CN"] as const) {
  test(`two margin marks: Tab goes from mark to mark the same at a person's pace and all at once, Space or Enter goes into a card and Tab and Esc come back (${language})`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, systemColours: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 900);
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
    const card = window.getByTestId("claim-card");
    const hint = window.getByTestId("card-key-hint");
    const settle = async () => {
      if ((await whereIsFocus(window)).startsWith(MARK)) await expect(card).toHaveCount(1);
      await motionSettled(window);
    };
    const accent = await tokenColor(window, "--color-accent");

    // At a person's pace, from the first sentence to the first mark, the second, and past it.
    await caretAtStart(window, editor);
    await logFocus(window);
    for (let key = 0; key < 6 && (await whereIsFocus(window)) !== `${MARK} check-1`; key++) {
      await window.keyboard.press("Tab");
      await settle();
    }
    await expect(marks.first()).toBeFocused();
    await expectRing(window, accent);
    await window.keyboard.press("Tab");
    await settle();
    await expect(marks.nth(1)).toBeFocused();
    await expectRing(window, accent);
    await window.keyboard.press("Tab");
    await settle();
    const paced = await landed(window);
    expect(paced.slice(-3, -1), "the two marks, with no card between").toEqual([
      `${MARK} check-1`,
      `${MARK} check-2`,
    ]);
    expect(places(paced)).not.toContain("card");
    expect(await whereIsFocus(window)).not.toBe("card");

    // All at once.
    await window.keyboard.press("Escape");
    await caretAtStart(window, editor);
    await logFocus(window);
    await Promise.all(paced.map(() => window.keyboard.press("Tab")));
    await motionSettled(window);
    expect(await landed(window)).toEqual(paced);

    // Shift+Tab goes from the second mark to the first, not into the first mark's card.
    await expect(marks.first()).not.toBeFocused();
    await marks.nth(1).focus();
    await settle();
    await logFocus(window);
    await window.keyboard.press("Shift+Tab");
    await settle();
    expect(await landed(window)).toEqual([`${MARK} check-1`]);

    // The focus shows the card at once, with the key that goes into it.
    await expect(marks.first()).toHaveAttribute("aria-keyshortcuts", "Space Enter");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("Space");
    await expect(hint).toContainText(t("card.useKey"));
    await bothThemes(window, `mark-hint-${language}`);
    const note = await noteOf(editor);
    for (const key of ["Space", "Enter"]) {
      await marks.first().evaluate((button) => button.blur());
      await marks.first().focus();
      await settle();
      await window.keyboard.press(key);
      await expect.poll(() => whereIsFocus(window)).toBe("card");
      if (key === "Space") await bothThemes(window, `mark-in-card-${language}`);
      expect(await noteOf(editor), `${key} typed nothing into the Note`).toBe(note);
      await expect(hint).toHaveCount(0);
      const controls = await card.locator('button:visible:not([tabindex="-1"])').count();
      expect(controls, "the card has controls").toBeGreaterThan(0);

      // Tab goes through the controls and, past the last one, back to the mark: it doesn't wrap.
      for (let step = 1; step < controls; step++) {
        await window.keyboard.press("Tab");
        expect(await whereIsFocus(window)).toBe("card");
      }
      await window.keyboard.press("Tab");
      await expect(marks.first()).toBeFocused();
      await expect(card).toHaveCount(1);

      // Shift+Tab from the first control goes back to the mark.
      await window.keyboard.press(key);
      await expect.poll(() => whereIsFocus(window)).toBe("card");
      await window.keyboard.press("Shift+Tab");
      await expect(marks.first()).toBeFocused();

      // Esc from inside goes back to the mark and keeps the card; Esc on the mark hides it.
      await window.keyboard.press(key);
      await expect.poll(() => whereIsFocus(window)).toBe("card");
      await window.keyboard.press("Escape");
      await expect(marks.first()).toBeFocused();
      await expect(card).toHaveCount(1);
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(marks.first()).toBeFocused();
    }

    // The next Tab goes on to the second mark, whose card shows.
    await window.keyboard.press("Tab");
    await expect(marks.nth(1)).toBeFocused();
    await expect(card).toHaveCount(1);

    // Space while an input method composes does nothing.
    const untouched = await marks.nth(1).evaluate((button) =>
      button.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(untouched, "the key was left to the input method").toBe(true);
    await expect(marks.nth(1)).toBeFocused();
    await app.close();
  });
}

/** Acme's quarterly revenue, as `charts.spec.ts` has it: a chart of its cited table has values with a card. */
const REPORT = buildPdf([
  { lines: ["Revenue by quarter, 2024", "Quarterly revenue was 289.4, 301.2, 309.8 and 330.6."] },
  { lines: ["Revenue by quarter, 2025", "Quarterly revenue was 341.5, 362.0 and 377.9."] },
]);

for (const language of ["en", "zh-CN"] as const) {
  test(`a chart value's card: Tab goes on from value to value the same at a person's pace and all at once, Space goes into it to Open and Tab and Esc come back, Enter opens the page (${language})`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    await writeFile(join(sources, "Acme.pdf"), REPORT);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 900);
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
    const viewers = window.getByTestId("viewer");
    const before = await viewers.count();

    const exercise = async (cited: Locator, uncited: Locator) => {
      // The card is open as the focus lands, with no wait; Tab goes on past it, to the page's next stop.
      await window.mouse.move(0, 0);
      await logFocus(window);
      await cited.focus();
      await expect(card).toHaveCount(1);
      await motionSettled(window);
      await expect(cited).toHaveAttribute("aria-keyshortcuts", "Space");
      await expect(hint).toBeVisible();
      await expect(hint).toContainText("Space");
      await expect(hint).toContainText(t("card.useKey"));
      await stillOf(window, `chart-hint-${language}`);
      await window.keyboard.press("Tab");
      expect(await whereIsFocus(window)).not.toBe("card");
      expect(places(await landed(window))).not.toContain("card");

      // Space goes into the card, to Open, and opens nothing itself.
      await cited.focus();
      await expect(card).toHaveCount(1);
      await window.keyboard.press("Space");
      await expect.poll(() => whereIsFocus(window)).toBe("card");
      await expect(card.getByTestId("chart-card-open")).toBeFocused();
      await stillOf(window, `chart-in-card-${language}`);
      await expect(viewers, "Space opened no page").toHaveCount(before);
      await expect(hint).toHaveCount(0);

      // Tab from its last control, and Shift+Tab from its first, go back to the value.
      await window.keyboard.press("Tab");
      await expect(cited).toBeFocused();
      await window.keyboard.press("Space");
      await expect(card.getByTestId("chart-card-open")).toBeFocused();
      await window.keyboard.press("Shift+Tab");
      await expect(cited).toBeFocused();

      // Esc from inside goes back to the value and keeps the card; Esc on the value hides it.
      await window.keyboard.press("Space");
      await expect(card.getByTestId("chart-card-open")).toBeFocused();
      await window.keyboard.press("Escape");
      await expect(cited).toBeFocused();
      await expect(card).toHaveCount(1);
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(cited).toBeFocused();

      // A value with no Citation has no control: no key hint, and Space keeps its card as it was.
      await uncited.focus();
      await expect(card).toHaveCount(1);
      await expect(hint).toHaveCount(0);
      await expect(uncited).not.toHaveAttribute("aria-keyshortcuts", /.+/);
      await window.keyboard.press("Space");
      await expect(uncited).toBeFocused();
      await expect(card).toHaveCount(1);
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    };

    // A value that quotes Acme has its Open; the one that quotes nothing has no control.
    const plotCited = chart.locator('[data-testid="chart-point"][aria-keyshortcuts="Space"]');
    const plotUncited = chart.locator(
      '[data-testid="chart-point"]:not([aria-keyshortcuts="Space"])',
    );
    await expect(plotUncited.first()).toBeAttached();
    await exercise(plotCited.first(), plotUncited.first());

    // The same on the chart's table of values.
    await pointAndClick(window, chart.getByTestId("chart-show-table"));
    const listCited = chart.locator('[data-testid="chart-value"][aria-keyshortcuts="Space"]');
    const listUncited = chart.locator(
      '[data-testid="chart-value"]:not([aria-keyshortcuts="Space"])',
    );
    await expect(listUncited.first()).toBeAttached();
    await exercise(listCited.first(), listUncited.first());

    // Enter keeps opening the page.
    await listCited.first().focus();
    await window.keyboard.press("Enter");
    await expect(viewers.first()).toBeVisible();
    await app.close();
  });
}
