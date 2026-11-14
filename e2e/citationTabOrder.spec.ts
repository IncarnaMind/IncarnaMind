import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Tab through a Note's Citations reaches the same places whether the keys come at a person's pace
 * or all at once: a Citation's card opens a moment after its marker takes the focus, and the next
 * Tab must not go into it on one run and past it on another.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = {
  en: ["Harbours publish the times of high water.", "Tide tables are printed each year."],
  "zh-CN": ["港口公布高潮的时间。", "潮汐表每年印制一次。"],
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

/** Starts a log of every element the focus lands on, as its test id (or tag). */
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
        const owner = target?.closest("[data-testid]");
        holder.landed.push(owner?.getAttribute("data-testid") ?? target?.tagName ?? "nothing");
      },
      true,
    );
  });

const landed = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { landed: string[] }).landed);

/** The caret at the start of the first sentence, put there by a click as a person does. */
async function caretAtStart(window: Page, editor: Locator) {
  const first = await editor.locator(":scope > p").first().boundingBox();
  if (!first) throw new Error("The first sentence isn't drawn.");
  await window.mouse.click(first.x + 2, first.y + first.height / 2);
  await expect(editor).toBeFocused();
}

const TABS = 8;

for (const language of ["en", "zh-CN"] as const) {
  test(`Tab through Citations goes the same way at a person's pace and all at once (${language})`, async () => {
    test.setTimeout(180_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    const cite = {
      type: "citation",
      attrs: {
        passageId: "passage-1",
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
    };
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        ...SENTENCES[language].map((text) => ({
          type: "paragraph",
          content: [{ type: "text", text }, cite],
        })),
        { type: "paragraph", content: [{ type: "text", text: "·" }] },
      ],
    );
    await expect(window.getByTestId("citation-chip")).toHaveCount(2);

    const card = window.getByTestId("citation-card");
    const settle = async () => {
      // As a person waits: the chip's card is open and still before the next key.
      if (
        (await window.evaluate(() => document.activeElement?.getAttribute("data-testid"))) ===
        "citation-chip"
      )
        await expect(card).toBeVisible();
      await motionSettled(window);
    };

    // At a person's pace: each key after the card the last one opened has settled.
    await caretAtStart(window, editor);
    await logFocus(window);
    for (let key = 0; key < TABS; key++) {
      await window.keyboard.press("Tab");
      await settle();
    }
    const paced = await landed(window);

    // All at once: the keys come faster than a card can open.
    await window.keyboard.press("Escape");
    await caretAtStart(window, editor);
    await logFocus(window);
    await Promise.all(Array.from({ length: TABS }, () => window.keyboard.press("Tab")));
    await motionSettled(window);
    const fast = await landed(window);

    expect(fast).toEqual(paced);
    await app.close();
  });
}
