import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
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
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A sentence's check card, reached with Next, stays clear of the page's check
 * badge (#1686): the badge shows the Mind's counts at the page's bottom right,
 * where a card for one of the last sentences would cover it. The checks are
 * written into the page, so no model is involved.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = {
  en: {
    unsupported: ["Seals sleep on the rocks at low tide.", "Gulls circle the pier before rain."],
    last: "Harbours publish the times of high water every 12 months.",
    says: "The harbour publishes them every 6 months.",
    filler: (at: number) => `Note ${at} says nothing to check.`,
  },
  "zh-CN": {
    unsupported: ["海豹退潮时在岩石上睡觉。", "下雨前海鸥在码头上空盘旋。"],
    last: "港口每 12 个月公布一次高潮时间，让船员能在离开码头之前很早就计划好每一次出海。",
    says: "港口每 6 个月公布一次高潮时间。",
    filler: (at: number) => `第${at}条笔记没有什么要核对的。`,
  },
} as const;

const WIDTHS = [
  { width: 900, height: 800 },
  { width: 1100, height: 800 },
  { width: 1440, height: 900 },
] as const;

const checked = (id: string, state: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  text,
  marks: [
    {
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
        checkedAt: "2026-10-22T09:00:00.000Z",
        ...extra,
      },
    },
  ],
});
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element isn't drawn.");
  return found;
}

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

for (const language of ["en", "zh-CN"] as const) {
  test(`Next on the last sentences leaves each check card clear of the page's badge (${language})`, async () => {
    test.setTimeout(240_000);
    const words = SENTENCES[language];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 800);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const passage = {
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
    };

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        ...Array.from({ length: 20 }, (_, at) =>
          paragraph({ type: "text", text: words.filler(at + 1) }),
        ),
        paragraph(checked("check-1", "unsupported", words.unsupported[0])),
        paragraph(checked("check-2", "unsupported", words.unsupported[1])),
        paragraph(
          checked("check-3", "contradicted", words.last, { evidence: passage, says: words.says }),
        ),
      ],
    );
    await expect(window.getByTestId("claim-mark")).toHaveCount(3);
    const badge = window.getByTestId("check-badge");
    const card = window.getByTestId("claim-card");
    await expect(badge).toBeVisible();

    /** Next on a part of the health card, which ends on that sentence's own card. */
    const next = async (
      part: "unsupported" | "contradicted",
      state: string,
      sentence: string,
      action: string,
    ) => {
      await window.mouse.move(2, 2);
      await pointAndClick(window, window.getByTestId("check-badge-open").first());
      const health = window.getByTestId("check-card");
      await expect(health).toBeVisible();
      await pointAndClick(window, health.getByTestId(`health-${part}`));
      await expect(health).toHaveCount(0);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-check", state);
      await expect(card.getByTestId("claim-sentence")).toHaveText(`“${sentence}”`);
      await expect(card.getByTestId(action)).toBeVisible();
      await motionSettled(window);
    };

    const clear = async ({ width, height }: { width: number; height: number }) => {
      const [onCard, onBadge] = await Promise.all([box(card), box(badge)]);
      const apart =
        onCard.x + onCard.width <= onBadge.x ||
        onBadge.x + onBadge.width <= onCard.x ||
        onCard.y + onCard.height <= onBadge.y ||
        onBadge.y + onBadge.height <= onCard.y;
      expect(
        apart,
        `the card ${JSON.stringify(onCard)} clears the badge ${JSON.stringify(onBadge)}`,
      ).toBe(true);
      expect(onCard.x).toBeGreaterThanOrEqual(0);
      expect(onCard.y).toBeGreaterThanOrEqual(0);
      expect(onCard.x + onCard.width).toBeLessThanOrEqual(width);
      expect(onCard.y + onCard.height).toBeLessThanOrEqual(height);
    };

    // Each width, in order: the two unsupported sentences, then the last, contradicted one.
    for (const size of WIDTHS) {
      await setWindowSize(app, window, size.width, size.height);
      for (const sentence of words.unsupported) {
        await next("unsupported", "unsupported", sentence, "claim-remove");
        await clear(size);
        await window.keyboard.press("Escape");
        await expect(card).toHaveCount(0);
      }
      await next("contradicted", "contradicted", words.last, "claim-open");
      await clear(size);
      // Next keeps the focus in the Mind, and the card takes none: unchanged by where it sits.
      expect(await window.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
        "mind-editor",
      );
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    }
    await app.close();
  });
}
