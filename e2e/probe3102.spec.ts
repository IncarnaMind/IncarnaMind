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

const CHIP = "citation-chip";

/** A Note with three Citations in one paragraph, in a window wide enough for Enter to open the page. */
async function openThreeChips(language: "en" | "zh-CN") {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, systemColours: true });
  await dismissChatSetup(window);
  // biome-ignore lint/correctness/useHookAtTopLevel: an e2e helper whose name begins with "use", not a React hook.
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
  return { app, window, editor };
}

test("probe: where a Citation's focus comes from", async () => {
  test.setTimeout(240_000);
  const { app, window, editor } = await openThreeChips("en");
  await window.evaluate(() => {
    const holder = globalThis as unknown as { log: string[] };
    holder.log = [];
    const name = (element: EventTarget | null) => {
      if (!(element instanceof Element)) return String(element);
      return `${element.getAttribute("data-testid") ?? element.tagName}{connected:${element.isConnected},visible:${element.checkVisibility()},inClosedDialog:${element.closest("dialog:not([open])") !== null},inOpenDialog:${element.closest("dialog[open]") !== null}}`;
    };
    document.addEventListener(
      "focusin",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.getAttribute("data-testid") === "citation-chip") {
          holder.log.push(`chip focusin from ${name(event.relatedTarget)}`);
        }
      },
      true,
    );
  });
  const log = async (label: string) => {
    const lines = await window.evaluate(() =>
      (globalThis as unknown as { log: string[] }).log.splice(0),
    );
    await test
      .info()
      .attach(`${label}.json`, {
        body: JSON.stringify(lines, null, 1),
        contentType: "application/json",
      });
  };
  const chips = window.getByTestId("citation-chip");
  await caretAtStart(window, editor);
  await window.keyboard.press("Tab");
  await expect(chips.first()).toBeFocused();
  await log("a-tab-from-the-text");
  await window.keyboard.press("Tab");
  await window.keyboard.press("Shift+Tab");
  await log("b-tab-then-shift-tab");
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("palette")).toHaveCount(0);
  await expect(chips.first()).toBeFocused();
  await log("c-palette-closed-by-escape");
  await window.keyboard.press("ControlOrMeta+,");
  await expect(window.locator("dialog[open]")).toHaveCount(1);
  await window.keyboard.press("Escape");
  await expect(window.locator("dialog[open]")).toHaveCount(0);
  await log("d-settings-closed");
  await chips.first().focus();
  await log("e-programmatic-focus");
  await app.close();
});
