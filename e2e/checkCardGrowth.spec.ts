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
 * A check card that opened with nothing in it takes its height from what lands first, once, then
 * holds it (#2313). It hangs from its foot: the Check in the foot never moves, in any frame, and
 * only the card's top edge goes up, as far as the window's margin above its badge, or only to the
 * badge's bottom edge when there was no room above and the card sits below it. It never covers the
 * badge, and what doesn't fit stays in its body, which scrolls. Nothing animates the growth.
 * Each test attaches the card's two stills, before and after.
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

const checkedAt = new Date(Date.now() + 60_000).toISOString();
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
interface Frame {
  card: Box | null;
  check: Box | null;
}

/** The boxes of the card and of the Check in its foot, as each frame is drawn, until `stop`. */
const watch = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { frames: Frame[]; watching: boolean };
    holder.frames = [];
    holder.watching = true;
    const box = (selector: string): Box | null => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? [rect.x, rect.y, rect.width, rect.height] : null;
    };
    // Read once the frame is drawn: a read inside the frame's own callback lays the page out
    // before the observers of its size have run, and sees a state that is never drawn.
    const step = () => {
      if (!holder.watching) return;
      requestAnimationFrame(() =>
        setTimeout(() => {
          holder.frames.push({
            card: box('[data-testid="check-card"]'),
            check: box('[data-testid="check-card"] [data-testid="badge-check-mind"]'),
          });
          step();
        }, 0),
      );
    };
    step();
  });

const stop = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { frames: Frame[]; watching: boolean };
    holder.watching = false;
    return holder.frames;
  });

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't drawn.");
  return [box.x, box.y, box.width, box.height];
}

const same = (a: Box, b: Box) => a.every((value, at) => Math.abs(value - (b[at] ?? 0)) < 0.01);

/** Whether two boxes share any area, as a card over its badge would. */
const overlap = (a: Box, b: Box) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5;

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [1440, 900]) {
    for (const placement of ["above", "below"] as const) {
      test(`an empty check card takes its height from what lands first, hung from its foot: the Check stays and the badge stays clear (${placement} its badge, ${language}, ${width}px)`, async () => {
        test.setTimeout(120_000);
        await writeFile(join(sources, "Tides.pdf"), TIDES);
        const { app, window } = await launchApp(dataDir, { fakeChat: true });
        await dismissChatSetup(window);
        await useLocalChatModel(window);
        await setLanguage(window, language);
        await setWindowSize(app, window, width, 900);
        await addDocuments(window, [join(sources, "Tides.pdf")]);
        await newMind(window);
        // No room above the badge, as in a short pane: the card is placed below it.
        if (placement === "below") {
          await window.addStyleTag({
            content:
              ".check-badge-place { position: fixed !important; top: 72px !important; right: 40px !important; }",
          });
        }
        const card = await checkCard(window);
        const badge = window.locator(".check-badge-place");
        const still = async (name: string) =>
          test.info().attach(`${placement}-${language}-${width}-${name}`, {
            body: await window.screenshot(),
            contentType: "image/png",
          });

        // At rest: the title only, and the Check in the foot.
        await motionSettled(window);
        const rest = {
          card: await boxOf(card),
          check: await boxOf(card.getByTestId("badge-check-mind")),
        };
        const anchor = await boxOf(badge);
        if (placement === "above")
          expect(rest.card[1] + rest.card[3]).toBeLessThanOrEqual(anchor[1] + 0.5);
        else expect(rest.card[1]).toBeGreaterThanOrEqual(anchor[1] + anchor[3] - 0.5);
        await still("before");

        await watch(window);
        await land(window, SENTENCES[language], 0);
        const body = card.locator(".check-card-body");
        await expect(card.getByTestId("health-look")).toBeVisible();
        await motionSettled(window);
        const frames = await stop(window);
        const grown = await boxOf(card);
        await still("after");

        // The Check never moved, in any frame, and the card never covered its badge.
        for (const frame of frames) {
          if (frame.check)
            expect(same(frame.check, rest.check), `the Check in a frame: ${frame.check}`).toBe(
              true,
            );
          if (frame.card)
            expect(overlap(frame.card, anchor), `the card in a frame: ${frame.card}`).toBe(false);
        }
        expect(same(await boxOf(card.getByTestId("badge-check-mind")), rest.check)).toBe(true);
        // Only its top edge moved.
        expect(grown[1] + grown[3]).toBeCloseTo(rest.card[1] + rest.card[3], 0);
        if (placement === "above") {
          expect(grown[3], "the card grew").toBeGreaterThan(rest.card[3] + 20);
          expect(grown[1], "within the window's margin").toBeGreaterThanOrEqual(8 - 0.5);
        } else {
          expect(grown[1], "no higher than the badge's bottom edge").toBeGreaterThanOrEqual(
            anchor[1] + anchor[3] - 0.5,
          );
          expect(
            grown[3] - rest.card[3],
            "the free room below the badge is the gap",
          ).toBeLessThanOrEqual(9);
          // What didn't fit scrolls in the body.
          expect(
            await body.evaluate((element) => element.scrollHeight > element.clientHeight + 1),
          ).toBe(true);
        }

        // Held from then on: more landing leaves the card as it is.
        await land(window, SENTENCES[language], 10);
        await expect(card.getByTestId("health-look")).toContainText("6");
        await motionSettled(window);
        expect(same(await boxOf(card), grown)).toBe(true);
        expect(same(await boxOf(card.getByTestId("badge-check-mind")), rest.check)).toBe(true);
        await app.close();
      });
    }
  }
}
