import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
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
 * A check card that opened with nothing in it takes its height from what lands in it, once, when
 * it has stopped landing, then holds it (#2313). From the Check button at the Note's top right
 * (#3677, #3794) it opens down and hangs from its top edge: the edge under the button never moves,
 * in any frame, and only its foot goes down, as far as the window's margin. From a Check button at
 * a page's foot, as the line above the Note's input has it, it opens up and hangs from its foot:
 * nothing in its foot ever moves, and only its top edge goes up, as far as the window's margin. It
 * never covers the button. Nothing animates the growth. Each test attaches the card's two stills,
 * before and after.
 */

const TIDES = buildPdf([{ lines: ["Harbour times", "Harbours publish times of high water."] }]);

const SENTENCES = {
  en: [
    "Penguins nest on the harbour cliffs.",
    "Lighthouses guard every headland on the coast.",
    "The model was not able to check this one.",
    "Ferries cross the bay twice every hour.",
  ],
  "zh-CN": [
    "企鹅在港口悬崖上筑巢。",
    "灯塔守护着海岸的每个岬角。",
    "模型这次没能核对这一句。",
    "渡轮每小时往返海湾两次。",
  ],
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
 * When the marks say they were checked: after the test's Document was added, however long the
 * file has run, or the card would say a Document was added since the check.
 */
let checkedAt = "";
const mark = (id: string, state: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "claimCheck",
  attrs: {
    id,
    request: "check-1",
    action: "check-against-documents",
    state,
    text,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt,
    ...extra,
  },
});
const paragraph = (text: string, check: object) => ({
  type: "paragraph",
  content: [{ type: "text", text, marks: [check] }],
});

/** Writes checked sentences into the Note: what lands in the open card. */
async function land(window: Page, sentences: readonly string[], from: number) {
  const content = sentences.map((text, at) =>
    paragraph(
      text,
      at === 2
        ? mark(`check-${from + at}`, "not-checked", text, { reason: "refused" })
        : mark(`check-${from + at}`, "unsupported", text),
    ),
  );
  await window.getByTestId("mind-editor").evaluate((dom, blocks) => {
    (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, blocks);
  }, content);
}

type Box = [number, number, number, number];

/**
 * What the browser says moved in a drawn frame: the owner's test id, where it was and is, and
 * whether it is something inside the card (the card's own box is drawn with its shadow).
 */
interface Shift {
  test: string;
  inside: boolean;
  inFoot: boolean;
  previous: Box;
  current: Box;
}

interface ShiftEntry {
  sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
}

/** Every layout shift the browser draws until `stop`: only what was drawn, never a state between frames. */
const watch = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as {
      shifts: Shift[];
      shifting?: PerformanceObserver;
      collect(entries: PerformanceEntryList): void;
    };
    holder.shifts = [];
    const box = (rect: DOMRectReadOnly): Box => [rect.x, rect.y, rect.width, rect.height];
    holder.collect = (entries) => {
      for (const entry of entries as unknown as ShiftEntry[]) {
        for (const source of entry.sources) {
          const element = source.node instanceof Element ? source.node : null;
          const owner = element?.closest("[data-testid]") ?? null;
          holder.shifts.push({
            test: owner?.getAttribute("data-testid") ?? "",
            inside: element?.closest(".check-card") != null && !element.matches(".check-card"),
            inFoot: element?.closest('[data-testid="check-card-foot"]') != null,
            previous: box(source.previousRect),
            current: box(source.currentRect),
          });
        }
      }
    };
    holder.shifting = new PerformanceObserver((list) => holder.collect(list.getEntries()));
    holder.shifting.observe({ type: "layout-shift" });
  });

const stop = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as {
      shifts: Shift[];
      shifting?: PerformanceObserver;
      collect(entries: PerformanceEntryList): void;
    };
    // What the browser drew but has not delivered yet.
    if (holder.shifting) holder.collect(holder.shifting.takeRecords());
    holder.shifting?.disconnect();
    return holder.shifts;
  });

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't drawn.");
  return [box.x, box.y, box.width, box.height];
}

const same = (a: Box, b: Box) => a.every((value, at) => Math.abs(value - (b[at] ?? 0)) < 0.01);

/** Whether two boxes share any area, as a card over its Check button would. */
const overlap = (a: Box, b: Box) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5;

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [1440, 900]) {
    for (const placement of ["above", "below"] as const) {
      test(`an empty check card takes its height from what lands, hung from where it opens: nothing in its foot moves and the Check button stays clear (${placement} its Check button, ${language}, ${width}px)`, async () => {
        test.setTimeout(120_000);
        await writeFile(join(sources, "Tides.pdf"), TIDES);
        const { app, window } = await launchApp(dataDir, { fakeChat: true });
        await dismissChatSetup(window);
        await useLocalChatModel(window);
        await setLanguage(window, language);
        await setWindowSize(app, window, width, 900);
        await addDocuments(window, [join(sources, "Tides.pdf")]);
        checkedAt = new Date(Date.now() + 60_000).toISOString();
        await newMind(window);
        // A Check button at a page's foot, as the line above the Note's input has it: the card is
        // placed above it.
        if (placement === "above") {
          await window.addStyleTag({
            content:
              ".note-check-frame { position: fixed !important; top: auto !important; bottom: 72px !important; right: 40px !important; }",
          });
        }
        const card = await checkCard(window);
        const place = window.locator(".note-check-frame");
        const still = async (name: string) =>
          test.info().attach(`${placement}-${language}-${width}-${name}`, {
            body: await window.screenshot(),
            contentType: "image/png",
          });

        // At rest: the title only, and no foot: the Check is the Note's button.
        await motionSettled(window);
        const rest = { card: await boxOf(card) };
        await expect(card.getByTestId("check-card-foot")).toHaveCount(0);
        const anchor = await boxOf(place);
        if (placement === "above")
          expect(rest.card[1] + rest.card[3]).toBeLessThanOrEqual(anchor[1] + 0.5);
        else expect(rest.card[1]).toBeGreaterThanOrEqual(anchor[1] + anchor[3] - 0.5);
        // Off the card, beside it: the pointer left on what opened it would be under the card as it
        // grows, and the User's touch ends the wait, so this would ask of a card the pointer held.
        await window.mouse.move(rest.card[0] - 60, 900 - 40);
        await still("before");

        await watch(window);
        await land(window, SENTENCES[language], 0);
        const body = card.locator(".check-card-body");
        await expect(card.getByTestId("health-look")).toBeVisible();
        // Held once what lands has settled: the body then has the height it keeps.
        await expect(body).toHaveAttribute("style", /height/);
        await motionSettled(window);
        const shifts = await stop(window);
        const grown = await boxOf(card);
        await still("after");

        // What was drawn: nothing in the foot shifted, and nothing in the card was drawn over the Check button.
        const placeNow = await boxOf(place);
        const trail = shifts
          .map(
            (shift) =>
              `${shift.test}${shift.inside ? " (in the card)" : ""} ${shift.previous.map(Math.round)} to ${shift.current.map(Math.round)}`,
          )
          .join("  >  ");
        for (const shift of shifts) {
          if (placement === "above") expect(shift.inFoot, `the foot shifted: ${trail}`).toBe(false);
          if (shift.inside)
            expect(
              overlap(shift.current, placeNow),
              `the card covered its Check button: ${trail}`,
            ).toBe(false);
        }
        if (placement === "above") {
          // Only its top edge moved: the foot hangs where it was.
          expect(grown[1] + grown[3]).toBeCloseTo(rest.card[1] + rest.card[3], 0);
        } else {
          // Only its foot moved.
          expect(grown[1]).toBeCloseTo(rest.card[1], 0);
        }
        if (placement === "above") {
          expect(grown[3], "the card grew").toBeGreaterThan(rest.card[3] + 20);
          expect(grown[1], "within the window's margin").toBeGreaterThanOrEqual(8 - 0.5);
          // All of it landed in the body: nothing scrolls out of sight.
          expect(
            await body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
            `the body hides rows: ${trail}`,
          ).toBe(true);
          await expect(card.getByTestId("health-toCheck")).toBeVisible();
        } else {
          // Opening down, its foot went down to show all that landed.
          expect(grown[3], "the card grew").toBeGreaterThan(rest.card[3] + 20);
          expect(grown[1] + grown[3], "within the window's margin").toBeLessThanOrEqual(
            900 - 8 + 0.5,
          );
          expect(
            await body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
            `the body hides rows: ${trail}`,
          ).toBe(true);
          await expect(card.getByTestId("health-toCheck")).toBeVisible();
        }

        // Held from then on: more landing leaves the card as it is.
        await land(window, SENTENCES[language], 10);
        await expect(card.getByTestId("health-look")).toContainText("6");
        await motionSettled(window);
        expect(same(await boxOf(card), grown)).toBe(true);
        await app.close();
      });
    }
  }
}
