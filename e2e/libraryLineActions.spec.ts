/**
 * Two lines of the Library keep their actions together (#3114): a Document that couldn't be read,
 * and Organize's estimate. A width sweep, 900 to 1600 px, in both languages, finds the two actions
 * on different rows nowhere the pair fits on one row, and no row starting or ending with a dot.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { TestHooks } from "../src/shared/testHooks";
import { buildPdf, pdfAppearance } from "../tests/helpers/pdf";
import { inspectionPage } from "../tests/helpers/pdfForms";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/** Where stills are taken when INCARNAMIND_SCREENSHOTS is set: the narrowest, one where Organize's line split, the widest. */
const STILLS = [900, 1000, 1600];
const WIDTHS = Array.from({ length: 15 }, (_, index) => 900 + index * 50);
/** A part's dot sits in the gap before it: the gap, in px, a pair of actions shares. */
const GAP = 12;

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("A control of the line isn't shown.");
  return box;
};

/**
 * Whether the line's two actions are on one row, and whether they could be: the room the line
 * gives them against the width of both with the gap and dot between.
 */
async function pairOf(line: Locator, first: Locator, second: Locator) {
  const [lineBox, a, b] = [await boxOf(line), await boxOf(first), await boxOf(second)];
  const sameRow = Math.abs(a.y - b.y) < 4;
  return { sameRow, fits: a.width + b.width + GAP * 2 <= lineBox.width - 24, a, b, lineBox };
}

/** The first and last control of every row of a line: a row never starts or ends with its dot. */
async function dotsOnEdges(line: Locator): Promise<number> {
  return line.evaluate((element) => {
    const dots = [...element.querySelectorAll<HTMLElement>(".meta-dot")];
    const rows = new Map<number, number[]>();
    for (const part of element.querySelectorAll<HTMLElement>(".meta-part")) {
      const box = part.getBoundingClientRect();
      rows.set(Math.round(box.top), [...(rows.get(Math.round(box.top)) ?? []), box.left]);
    }
    let visibleAtEdge = 0;
    for (const dot of dots) {
      const dotBox = dot.getBoundingClientRect();
      const part = dot.parentElement?.getBoundingClientRect();
      if (!part) continue;
      const first = Math.min(...(rows.get(Math.round(part.top)) ?? [part.left]));
      // A dot left of the first part of its row is clipped by the line: it must not be drawn there.
      if (part.left <= first + 0.5 && dotBox.right > element.getBoundingClientRect().left + 4) {
        const clip = element.getBoundingClientRect().left;
        if (dotBox.left >= clip) visibleAtEdge++;
      }
    }
    return visibleAtEdge;
  });
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
  test(`${language}: a Document that couldn't be read keeps its two actions together at every width`, async () => {
    test.setTimeout(120_000);
    const form = inspectionPage(language === "zh-CN");
    const path = join(sources, "Inspection.pdf");
    await writeFile(
      path,
      buildPdf([
        {
          ...form,
          fields: [
            ...(form.fields ?? []),
            {
              dictionary:
                "/FT /Foo /T (brokenChoice) /TU (Broken choice) /V (Fallback) /Rect [210 80 570 104] /F 4",
              appearance: pdfAppearance("Fallback"),
            },
          ],
        },
      ]),
    );
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 900, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await window.getByTestId("add-documents-input").setInputFiles(path);
      await expect(window.getByTestId("document-list-item")).toHaveAttribute(
        "data-status",
        "failed",
      );
      await pointAndClick(window, window.getByTestId("open-library"));
      const fix = window.getByTestId("library-fix");
      const open = fix.getByTestId("library-fix-open");
      const print = fix.getByTestId("library-fix-print");
      const split: number[] = [];
      for (const width of WIDTHS) {
        await setWindowSize(app, window, width, 900);
        await expect(print).toBeVisible();
        const pair = await pairOf(fix, open, print);
        if (pair.fits && !pair.sameRow) split.push(width);
        if (process.env.INCARNAMIND_SCREENSHOTS && STILLS.includes(width))
          await window.screenshot({
            path: join(process.env.INCARNAMIND_SCREENSHOTS, `library-fix-${language}-${width}.png`),
          });
      }
      expect(split).toEqual([]);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: Organize's estimate keeps Organize and Not now together at every width`, async () => {
    test.setTimeout(120_000);
    const path = join(sources, "Harbour survey.md");
    await writeFile(path, "# Harbour survey\n\nThe berth depth at the north quay.\n");
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 900, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await addDocuments(window, [path]);
      await pointAndClick(window, window.getByTestId("open-library"));
      await window.evaluate(() =>
        (
          globalThis as { incarnamindTestHooks?: TestHooks }
        ).incarnamindTestHooks?.showOrganizeEstimate(40, 1.4),
      );
      const line = window.getByTestId("organize-estimate");
      await expect(line).toBeVisible();
      const go = line.getByTestId("organize-estimate-go");
      const notNow = line.getByTestId("organize-estimate-not-now");
      const split: number[] = [];
      const dots: number[] = [];
      for (const width of WIDTHS) {
        await setWindowSize(app, window, width, 900);
        await expect(notNow).toBeVisible();
        const pair = await pairOf(line, go, notNow);
        if (pair.fits && !pair.sameRow) split.push(width);
        if ((await dotsOnEdges(line)) > 0) dots.push(width);
        if (process.env.INCARNAMIND_SCREENSHOTS && STILLS.includes(width))
          await window.screenshot({
            path: join(
              process.env.INCARNAMIND_SCREENSHOTS,
              `organize-estimate-${language}-${width}.png`,
            ),
          });
      }
      expect(split).toEqual([]);
      expect(dots).toEqual([]);
    } finally {
      await app.close();
    }
  });
}
