import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * A sentence's parts card (#2313): it opens with a row per part, each saying Checking…, and the
 * card keeps that height as the verdicts land in the rows. A result that needs more room scrolls
 * inside the card; opened again, the card fits the result.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

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

const evidence = {
  passageId: "passage-1",
  documentId: "tides",
  documentName: "Tides",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: "Every 12 months.",
  check: "found",
  checkReason: null,
};

/** A part as the core writes one into a check's mark (#2002). */
const part = (
  start: number,
  end: number,
  verdict: "supported" | "unsupported" | "checking",
  over: Record<string, unknown> = {},
) => ({
  span: { start, end },
  kind: "fact",
  verdict,
  evidence: [],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
  ...over,
});

const checked = (state: string, parts: Record<string, unknown>[]) => ({
  type: "text",
  text: "Revenue rose and costs fell",
  marks: [
    {
      type: "claimCheck",
      attrs: {
        id: "check-parts",
        request: "check-1",
        action: "check-against-documents",
        state,
        text: "Revenue rose and costs fell",
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt: "2026-11-03T09:00:00.000Z",
        parts,
      },
    },
  ],
});

test("the parts card keeps one height as verdicts land, scrolls a longer result, and fits it when opened again", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    const write = (state: string, parts: Record<string, unknown>[]) =>
      editor.evaluate(
        (dom, content) => {
          (dom as unknown as { editor: Editor }).editor.commands.setContent(content);
        },
        [{ type: "paragraph", content: [checked(state, parts)] }],
      );

    // The check is under way: one row per part, each saying Checking….
    await write("checking", [part(0, 12, "checking"), part(17, 27, "checking")]);
    await pointAndClick(window, window.getByTestId("claim-mark").first());
    const card = window.getByTestId("claim-card");
    await expect(card).toBeVisible();
    const pane = card.locator(".claim-card");
    const rows = card.getByTestId("claim-part");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Checking");
    await expect(rows.nth(1)).toContainText("Checking");
    // The card grows from its mark as it opens, so its box holds still only once that ends; the
    // Checking rows' own motion runs on while the check does.
    await expect
      .poll(() =>
        card.evaluate((element) =>
          element.getAnimations().every((animation) => animation.playState !== "running"),
        ),
      )
      .toBe(true);
    // It opens to the rows it has, every one in view.
    expect(await pane.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(
      true,
    );
    const before = await pane.boundingBox();
    if (!before) throw new Error("The parts card isn't drawn.");

    // The verdicts land in the same rows; one brings a reason that needs more room than the card
    // opened with, and the card scrolls instead of growing.
    await write("unsupported", [
      part(0, 12, "supported", { evidence: [evidence] }),
      part(17, 27, "unsupported", {
        unsupported: {
          reason: "The lease says costs rose.",
          covered: null,
          uncovered: null,
          found: true,
        },
      }),
    ]);
    await expect(rows.nth(0)).toContainText("Supported");
    await expect(rows.nth(1)).toContainText("Needs a look");
    const after = await pane.boundingBox();
    if (!after) throw new Error("The parts card is gone.");
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(await pane.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );

    // Closed and opened again, the card fits the result rather than scrolling.
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await pointAndClick(window, window.getByTestId("claim-mark").first());
    await expect(card).toBeVisible();
    const again = card.locator(".claim-card");
    expect(
      await again.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    ).toBe(true);

    // A part that found nothing says so in its own row, drawn from that part.
    await write("unsupported", [
      part(0, 12, "supported", { evidence: [evidence] }),
      part(17, 27, "unsupported"),
    ]);
    await expect(rows.nth(0)).toContainText("Supported");
    await expect(rows.nth(1)).toContainText("Not found");
  } finally {
    await app.close();
  }
});
