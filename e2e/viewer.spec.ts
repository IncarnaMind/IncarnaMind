import { copyFile, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  darkPixels,
  dismissChatSetup,
  documentIdOf,
  interceptOpenPath,
  launchApp,
  linkFolderFromSidebar,
  newMind,
  openDocumentAt,
  openDocumentMenu,
  pathsOpened,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  widthOf,
} from "./app";

/** Office files to view (see tests/core/formats.test.ts). */
const FORMATS = join(__dirname, "..", "tests", "fixtures", "formats");

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of the viewer's states there. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/**
 * Makes the Document's group, right of the Mind's, this wide, as dragging the
 * divider between them would, through the core's bridge.
 */
async function setViewerWidth(window: Page, width: number): Promise<void> {
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  await window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const groups = document.querySelector('[data-testid="tab-groups"]');
    if (!groups) throw new Error("No groups.");
    const room = groups.getBoundingClientRect().width - 1;
    await bridge.changeLayout("main", { type: "resize", widths: [room - wanted, wanted] });
  }, width);
  await expect.poll(() => widthOf(window.getByTestId("viewer"))).toBeCloseTo(width, 0);
}

/** An element's box; it must be shown. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

/**
 * Expects the Citation's mark to sit beside the highlight: right of it, inside
 * the page, and centred on its first line.
 */
async function expectMarkBeside(mark: Locator, highlight: Locator, page: Locator) {
  const markBox = await boxOf(mark);
  const line = await highlight.evaluate((element) => {
    const rect = element.getClientRects()[0] ?? element.getBoundingClientRect();
    return { right: rect.right, middle: rect.top + rect.height / 2 };
  });
  const pageBox = await boxOf(page);
  expect(markBox.height).toBe(18);
  expect(markBox.x).toBeGreaterThan(line.right);
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
  expect(Math.abs(markBox.y + markBox.height / 2 - line.middle)).toBeLessThanOrEqual(1.5);
}

/** success-wash and warning-wash, as computed. */
const FOUND_WASH = "rgb(220, 243, 228)";
const NOT_FOUND_WASH = "rgb(254, 243, 226)";

/** Three pages; on page 2 a sentence runs across a line break. */
const REPORT = buildPdf([
  { lines: ["Quarterly report", "Prepared for the board."] },
  {
    lines: [
      "Results",
      "Revenue grew by ten percent",
      "in the third quarter, led by exports.",
      "Costs stayed flat.",
    ],
  },
  { lines: ["Outlook", "We expect steady growth next year."] },
]);

/** Six pages with an outline: two entries at the top, two under the second. */
const GUIDE = buildPdf(
  Array.from({ length: 6 }, (_, index) => ({ lines: [`Guide page ${index + 1}`] })),
  {
    outline: [
      { title: "Getting started", page: 1 },
      {
        title: "Reference",
        page: 3,
        via: "named",
        items: [
          { title: "Settings", page: 4 },
          { title: "Troubleshooting", page: 6, via: "action" },
        ],
      },
    ],
  },
);

/** Long enough to scroll, with the quoted sentence near the end. */
const NOTES = [
  "# Field notes",
  "",
  ...Array.from(
    { length: 120 },
    (_, index) => `Observation ${index + 1}: nothing unusual today.\n`,
  ),
  "The *key* finding was that attention",
  "spans shrink after lunch.",
  "",
].join("\n");

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder(); // the User's own files live outside the data folder
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function writeSources() {
  const report = join(sources, "Report.pdf");
  const notes = join(sources, "Field notes.md");
  await writeFile(report, REPORT);
  await writeFile(notes, NOTES);
  return { report, notes };
}

test("clicking a PDF in the sidebar opens it in a tab beside the Mind, and another Document replaces its preview", async () => {
  const { report, notes } = await writeSources();
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [report, notes]);
  await window.getByTestId("new-tab").click();
  const viewer = window.getByTestId("viewer");
  const groups = window.getByTestId("tab-group");
  const items = window.getByTestId("document-list-item");
  await expect(viewer).toHaveCount(0);
  await expect(groups).toHaveCount(1);
  const fullWidth = await widthOf(groups.first());

  await items.filter({ hasText: "Report" }).getByTestId("open-document").click();
  await expect(viewer).toBeVisible();
  await expect(groups).toHaveCount(2);
  expect(await widthOf(groups.first())).toBeLessThan(fullWidth);
  await expect(window.getByTestId("viewer-title")).toHaveText("Report");

  // Page 1 is drawn on its canvas, with its text selectable in the text layer.
  const page1 = viewer.locator('[data-page-number="1"]');
  await expect(page1).toHaveAttribute("data-drawn", "true");
  expect(await darkPixels(page1.locator("canvas"))).toBeGreaterThan(0);
  await expect(page1.locator(".textLayer")).toContainText("Quarterly report");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("1");
  await expect(window.getByTestId("viewer-header")).toContainText("of 3");

  // Page navigation: next, and typing a page number.
  await window.getByTestId("pdf-next-page").click();
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  await expect(viewer.locator('[data-page-number="2"]')).toBeInViewport();
  await window.getByTestId("pdf-page-number").fill("3");
  await window.getByTestId("pdf-page-number").press("Enter");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("3");
  await expect(viewer.locator('[data-page-number="3"] .textLayer')).toContainText("Outlook");

  // Zoom: in from fit-width, then back to fit-width.
  const fitted = await widthOf(page1);
  await window.getByTestId("pdf-zoom-in").click();
  await expect(window.getByTestId("pdf-fit-width")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => widthOf(page1)).toBeGreaterThan(fitted);
  await window.getByTestId("pdf-fit-width").click();
  await expect.poll(() => widthOf(page1)).toBe(fitted);

  // Another Document replaces the PDF's preview: one tab, not a pile.
  await items.filter({ hasText: "Field notes" }).getByTestId("open-document").click();
  await expect(window.getByTestId("viewer-title")).toHaveText("Field notes");
  await expect(window.getByTestId("document-tab")).toHaveCount(1);
  await expect(viewer.locator("[data-page-number]")).toHaveCount(0);
  await expect(window.getByTestId("viewer-text").locator("h1")).toHaveText("Field notes");

  // Closing its tab gives the Mind its full width back.
  await window.getByTestId("document-tab").getByTestId("tab-close").click();
  await expect(viewer).toHaveCount(0);
  await expect(groups).toHaveCount(1);
  expect(await widthOf(groups.first())).toBe(fullWidth);
  await app.close();
});

test("a PDF's outline shows beside its pages, and an entry goes to its page", async () => {
  const guide = join(sources, "Guide.pdf");
  await writeFile(guide, GUIDE);
  const { report } = await writeSources();
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [guide, report]);
  const viewer = window.getByTestId("viewer");
  const items = window.getByTestId("document-list-item");
  const pageNumber = window.getByTestId("pdf-page-number");

  // A PDF without an outline has no outline button.
  await items.filter({ hasText: "Report" }).getByTestId("open-document").click();
  await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "true");
  await expect(window.getByTestId("pdf-outline-button")).toHaveCount(0);

  await items.filter({ hasText: "Guide" }).getByTestId("open-document").click();
  const button = window.getByTestId("pdf-outline-button");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(window.getByTestId("pdf-outline")).toHaveCount(0);

  // Shown: the top-level entries, the nested ones once their entry is expanded.
  await button.click();
  const outline = window.getByTestId("pdf-outline");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const entries = outline.getByTestId("pdf-outline-item");
  await expect(entries).toHaveText(["Getting started", "Reference"]);
  await outline.getByRole("button", { name: "Expand Reference" }).click();
  await expect(entries).toHaveText(["Getting started", "Reference", "Settings", "Troubleshooting"]);

  // Rows are 28px; a nested entry is indented 16px more than its parent.
  const reference = entries.filter({ hasText: "Reference" });
  const settings = entries.filter({ hasText: "Settings" });
  expect((await boxOf(reference)).height).toBe(28);
  const indent = (entry: Locator) =>
    entry.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft));
  expect((await indent(settings)) - (await indent(reference))).toBe(16);

  // The entry for the page in view is marked.
  const current = outline.locator('[aria-current="location"]');
  await expect(current).toHaveText("Getting started");

  // Clicking an entry goes to its page.
  await entries.filter({ hasText: "Troubleshooting" }).click();
  await expect(pageNumber).toHaveValue("6");
  await expect(viewer.locator('[data-page-number="6"] .textLayer')).toContainText("Guide page 6");
  await expect(current).toHaveText("Troubleshooting");
  // Collapsed, an entry stands for the entries under it.
  await outline.getByRole("button", { name: "Collapse Reference" }).click();
  await expect(current).toHaveText("Reference");
  await outline.getByRole("button", { name: "Expand Reference" }).click();
  await reference.click();
  await expect(pageNumber).toHaveValue("3");
  await expect(viewer.locator('[data-page-number="3"]')).toBeInViewport();
  await expect(current).toHaveText("Reference");

  // Hidden again: the pages take the whole width back.
  const narrower = await widthOf(window.getByTestId("pdf-scroller"));
  await button.click();
  await expect(outline).toHaveCount(0);
  expect(await widthOf(window.getByTestId("pdf-scroller"))).toBeGreaterThan(narrower);
  await app.close();
});

/**
 * Whether a page fits across its scroller: nothing to scroll sideways, and
 * the page's edges inside the scroller's, with the backdrop showing on both sides.
 */
const fitsAcross = async (scroller: Locator, page: Locator) =>
  scroller.evaluate(
    (element, pageElement) => {
      if (!pageElement) return false;
      const box = element.getBoundingClientRect();
      const sheet = pageElement.getBoundingClientRect();
      return (
        element.scrollWidth <= element.clientWidth &&
        sheet.left > box.left &&
        sheet.right < box.left + element.clientWidth
      );
    },
    await page.elementHandle(),
  );

test("in a narrow viewer with the outline open, Fit width fits the page in the width beside the outline", async () => {
  const guide = join(sources, "Guide.pdf");
  const word = join(sources, "Coastal Flood Risk Review.docx");
  await writeFile(guide, GUIDE);
  await copyFile(join(FORMATS, "Coastal Flood Risk Review.docx"), word);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.getByTestId("new-tab").click();
  await addDocuments(window, [guide, word]);
  const viewer = window.getByTestId("viewer");
  const items = window.getByTestId("document-list-item");

  // A PDF: zoomed, then fitted again with the outline beside it.
  await items.filter({ hasText: "Guide" }).getByTestId("open-document").click();
  await setViewerWidth(window, 420);
  const page1 = viewer.locator('[data-page-number="1"]');
  await expect(page1).toHaveAttribute("data-drawn", "true");
  await window.getByTestId("pdf-outline-button").click();
  await expect(window.getByTestId("pdf-outline")).toBeVisible();
  await window.getByTestId("pdf-zoom-in").click();
  await window.getByTestId("pdf-fit-width").click();
  await expect(window.getByTestId("pdf-fit-width")).toHaveAttribute("aria-pressed", "true");
  const scroller = window.getByTestId("pdf-scroller");
  await expect.poll(() => fitsAcross(scroller, page1)).toBe(true);
  // The page fills the width beside the outline, less the backdrop's margins, and less the
  // scrollbar where the system always shows one (with a mouse and no trackpad, as on CI).
  const room = await scroller.evaluate((element) => element.clientWidth);
  expect(await widthOf(page1)).toBeGreaterThan(room - 2 * 24 - 2);
  await screenshot(viewer, "viewer-fit-width-outline");

  // A Word file's pages fit beside its outline too.
  await items.filter({ hasText: "Coastal Flood Risk Review" }).getByTestId("open-document").click();
  const docx = viewer.getByTestId("viewer-docx");
  await expect(docx).toHaveAttribute("data-rendered", "yes");
  await viewer.getByTestId("viewer-outline-button").click();
  await expect(viewer.getByTestId("viewer-outline")).toBeVisible();
  // Its icon is a list, not Show sidebar's window, and they have their own tooltips.
  const outlineButton = viewer.getByTestId("viewer-outline-button");
  const sidebarButton = window.getByTestId("sidebar-toggle");
  expect(await outlineButton.locator("svg").innerHTML()).not.toBe(
    await sidebarButton.locator("svg").innerHTML(),
  );
  expect(await outlineButton.getAttribute("title")).not.toBe(
    await sidebarButton.getAttribute("title"),
  );
  await expect.poll(() => fitsAcross(docx, docx.locator("section.docx").first())).toBe(true);
  await screenshot(viewer, "viewer-docx-outline");
  await app.close();
});

/** Where on a page a point of the window is, as fractions of the page's width and height. */
const pointOnPage = (page: Locator, x: number, y: number) =>
  page.evaluate(
    (element, point) => {
      const box = element.getBoundingClientRect();
      return { x: (point.x - box.left) / box.width, y: (point.y - box.top) / box.height };
    },
    { x, y },
  );

/** Wheel events as a trackpad's pinch sends them: Ctrl set, though no key is down. */
const pinch = (scroller: Locator, x: number, y: number, deltas: number[]) =>
  scroller.evaluate(
    (element, gesture) =>
      gesture.deltas.map(
        (deltaY) =>
          !element.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY,
              ctrlKey: true,
              clientX: gesture.x,
              clientY: gesture.y,
              bubbles: true,
              cancelable: true,
            }),
          ),
      ),
    { x, y, deltas },
  );

/**
 * A pinch over a page as a trackpad sends it: about a wheel event a frame.
 * After each, once the page has changed size (if it does within a few
 * frames): its width; whether it still shows the drawing and the text layer
 * it had before the pinch, as they were made (its runs of text not laid out
 * again); how far, in px, that text layer's box is off the page's; and
 * whether the event was the viewer's alone.
 */
const pinchFrames = (page: Locator, x: number, y: number, deltas: number[]) =>
  page.evaluate(
    async (element, gesture) => {
      const scroller = element.closest('[data-testid="pdf-scroller"]');
      if (!scroller) throw new Error("The page isn't in the viewer.");
      const drawing = element.querySelector("canvas");
      const text = element.querySelector(".textLayer");
      const madeAt = () => (text ? getComputedStyle(text).getPropertyValue("--scale-factor") : "");
      const made = madeAt();
      const widthNow = () => element.getBoundingClientRect().width;
      const textOff = () => {
        const pageBox = element.getBoundingClientRect();
        const textBox = text?.getBoundingClientRect();
        if (!textBox) return Number.POSITIVE_INFINITY;
        return Math.max(
          ...(["left", "top", "right", "bottom"] as const).map((side) =>
            Math.abs(textBox[side] - pageBox[side]),
          ),
        );
      };
      // The next frame (or a moment, if the window isn't drawing frames).
      const frame = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
          setTimeout(resolve, 20);
        });
      const frames: { width: number; sameDrawing: boolean; textOff: number; taken: boolean }[] = [];
      for (const deltaY of gesture.deltas) {
        const before = widthNow();
        const taken = !scroller.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY,
            ctrlKey: true,
            clientX: gesture.x,
            clientY: gesture.y,
            bubbles: true,
            cancelable: true,
          }),
        );
        for (let wait = 0; wait < 4 && widthNow() === before; wait++) await frame();
        frames.push({
          width: widthNow(),
          sameDrawing:
            element.querySelector("canvas") === drawing &&
            element.querySelector(".textLayer") === text &&
            madeAt() === made,
          textOff: textOff(),
          taken,
        });
      }
      return frames;
    },
    { x, y, deltas },
  );

/** How sharp a page's drawing is: its canvas's pixels per CSS pixel of the page's width. */
const sharpnessOf = (page: Locator) =>
  page.evaluate((element) => {
    const canvas = element.querySelector("canvas");
    return canvas ? canvas.width / element.getBoundingClientRect().width / devicePixelRatio : 0;
  });

/**
 * How a test PDF's page's text layer was made: the width, in CSS px, its
 * scale (`--scale-factor`) gives a Letter page, against the page's as shown.
 */
const textLayerMadeFor = (page: Locator) =>
  page.evaluate((element) => {
    const text = element.querySelector(".textLayer");
    const scale = text ? Number(getComputedStyle(text).getPropertyValue("--scale-factor")) : 0;
    return Math.abs(Math.floor(612 * scale) - element.getBoundingClientRect().width);
  });

test("a pinch zooms a PDF smoothly around the pointer; the wheel with Ctrl held goes a step per notch", async () => {
  const long = join(sources, "Long.pdf");
  await writeFile(
    long,
    buildPdf(Array.from({ length: 6 }, (_, index) => ({ lines: [`Page ${index + 1} of 6`] }))),
  );
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.getByTestId("new-tab").click();
  await addDocuments(window, [long]);
  await window.getByTestId("open-document").click();
  await setViewerWidth(window, 420);
  const viewer = window.getByTestId("viewer");
  const scroller = window.getByTestId("pdf-scroller");
  const level = window.getByTestId("pdf-zoom-level");
  const page2 = viewer.locator('[data-page-number="2"]');
  await expect(page2).toHaveAttribute("data-drawn", "true");
  await window.getByTestId("pdf-page-number").fill("2");
  await window.getByTestId("pdf-page-number").press("Enter");
  const percent = async () => Number.parseInt((await level.textContent()) ?? "", 10);
  const fitted = await percent();
  expect(fitted).toBeLessThan(50);
  const fittedWidth = await widthOf(page2);
  const box = await boxOf(scroller);
  const x = box.x + box.width * 0.7;
  const y = box.y + 160;
  const before = await pointOnPage(page2, x, y);

  // Pinching open: the page grows with every event, as much as the fingers moved (Chromium
  // sends a pinch by a scale s as deltaY = -100 ln s), not a step at a time. Meanwhile its
  // drawing and its text layer are stretched to fit, and nothing else takes the gesture.
  const opening = await pinchFrames(page2, x, y, Array(8).fill(-3));
  expect(opening.map((frame) => frame.taken)).toEqual(Array(8).fill(true));
  opening.forEach((frame, index) => {
    expect(frame.width).toBeGreaterThan(opening[index - 1]?.width ?? fittedWidth);
    expect(frame.textOff).toBeLessThanOrEqual(1);
  });
  expect(opening.map((frame) => frame.sameDrawing)).toEqual(Array(8).fill(true));
  const pinched = await widthOf(page2);
  expect(Math.abs(pinched / fittedWidth - Math.exp(0.24))).toBeLessThan(0.01);
  await expect(window.getByTestId("pdf-fit-width")).toHaveAttribute("aria-pressed", "false");
  // The level shown follows, between the steps (rounded, as the fitted level was).
  expect(Math.abs((await percent()) - fitted * Math.exp(0.24))).toBeLessThanOrEqual(1.5);
  // The point under the pointer stays put.
  const after = await pointOnPage(page2, x, y);
  expect(Math.abs(after.x - before.x)).toBeLessThan(0.01);
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.01);
  // Once the pinch stops, the page is drawn again, sharp at its new size, and its text layer
  // made again for that size.
  await expect.poll(() => sharpnessOf(page2)).toBeCloseTo(1, 1);
  await expect.poll(() => textLayerMadeFor(page2)).toBeLessThanOrEqual(1);
  await expect(page2).toHaveAttribute("data-drawn", "true");
  await screenshot(viewer, "viewer-pinch-zoomed");
  // Closing as far again brings it back to where it was.
  await pinchFrames(page2, x, y, Array(8).fill(3));
  expect(Math.abs((await widthOf(page2)) - fittedWidth)).toBeLessThanOrEqual(1);
  await expect(level).toHaveText(`${fitted}%`);

  // The wheel with Ctrl held: a step per notch (here from the fitted zoom to the next step),
  // around the pointer too.
  await window.mouse.move(x, y);
  const held = await pointOnPage(page2, x, y);
  await window.keyboard.down("Control");
  await window.mouse.wheel(0, -100);
  await window.keyboard.up("Control");
  await expect(level).toHaveText("50%");
  await expect(async () => {
    const stepped = await pointOnPage(page2, x, y);
    expect(Math.abs(stepped.x - held.x)).toBeLessThan(0.01);
    expect(Math.abs(stepped.y - held.y)).toBeLessThan(0.01);
  }).toPass();
  // The window itself isn't zoomed.
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
    ),
  ).toBe(1);

  // Without Ctrl the wheel scrolls, and leaves the zoom alone.
  const top = await scroller.evaluate((element) => element.scrollTop);
  await window.mouse.wheel(0, 200);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(top);
  await expect(level).toHaveText("50%");

  // However far the pinch goes, the zoom stays within its limits.
  await pinch(scroller, x, y, Array(200).fill(-5));
  await expect(level).toHaveText("400%");
  await expect(window.getByTestId("pdf-zoom-in")).toBeDisabled();
  await pinch(scroller, x, y, Array(300).fill(5));
  await expect(level).toHaveText("25%");
  await expect(window.getByTestId("pdf-zoom-out")).toBeDisabled();
  await app.close();
});

test("a long PDF draws only the pages near the view", async () => {
  const long = join(sources, "Long.pdf");
  await writeFile(
    long,
    buildPdf(Array.from({ length: 40 }, (_, index) => ({ lines: [`Page ${index + 1} of 40`] }))),
  );
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [long]);
  await window.getByTestId("open-document").click();
  const viewer = window.getByTestId("viewer");
  const drawn = viewer.locator('[data-drawn="true"]');

  await expect(viewer.locator("[data-page-number]")).toHaveCount(40);
  await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "true");
  expect(await drawn.count()).toBeLessThan(10);

  // Far down the Document, its pages are drawn and the first page is released.
  await window.getByTestId("pdf-page-number").fill("30");
  await window.getByTestId("pdf-page-number").press("Enter");
  await expect(viewer.locator('[data-page-number="30"]')).toHaveAttribute("data-drawn", "true");
  await expect(viewer.locator('[data-page-number="30"] .textLayer')).toContainText("Page 30 of 40");
  await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "false");
  expect(await drawn.count()).toBeLessThan(10);
  await app.close();
});

test("opened at a page range with a quote, the viewer shows that page with the quote highlighted", async () => {
  const { report, notes } = await writeSources();
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [report, notes]);
  const viewer = window.getByTestId("viewer");

  // The quote runs across a line break on page 2.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Report"),
    pageFrom: 2,
    pageTo: 2,
    quote: "Revenue grew by ten percent in the third quarter",
  });
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  const highlights = viewer.locator('[data-page-number="2"] [data-quote-highlight]');
  await expect(highlights).toHaveCount(2);
  await expect(highlights).toHaveText(["Revenue grew by ten percent", "in the third quarter"]);
  await expect(highlights.first()).toBeInViewport();
  await expect(viewer.locator('[data-page-number="1"] [data-quote-highlight]')).toHaveCount(0);

  // A quote with an ellipsis: each part is highlighted, and the words left out aren't.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Report"),
    pageFrom: 2,
    pageTo: 2,
    quote: "Revenue grew by ten percent … led by exports. Costs stayed flat.",
  });
  await expect(highlights).toHaveText([
    "Revenue grew by ten percent",
    "led by exports.",
    "Costs stayed flat.",
  ]);

  // A quote that isn't on those pages: the page opens, with nothing highlighted.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Report"),
    pageFrom: 3,
    quote: "Revenue grew by ten percent",
  });
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("3");
  await expect(viewer.locator("[data-quote-highlight]")).toHaveCount(0);

  // Markdown: the viewer scrolls down to the quote and highlights it.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Field notes"),
    quote: "attention spans shrink after lunch.",
  });
  const marks = window.getByTestId("viewer-text").locator("[data-quote-highlight]");
  await expect(marks.first()).toBeInViewport();
  expect((await marks.allTextContents()).join("")).toBe("attention\nspans shrink after lunch.");

  // With an ellipsis, each part is highlighted.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Field notes"),
    quote: "Observation 119: nothing unusual today. ... Observation 120: nothing unusual today.",
  });
  await expect(marks).toHaveText([
    "Observation 119: nothing unusual today.",
    "Observation 120: nothing unusual today.",
  ]);
  await expect(marks.first()).toBeInViewport();
  await app.close();
});

test("a Document deleted while it is open, or already deleted, shows Document removed", async () => {
  const { report } = await writeSources();
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [report]);
  const viewer = window.getByTestId("viewer");
  const item = window.getByTestId("document-list-item");
  const documentId = await documentIdOf(window, "Report");

  await item.getByTestId("open-document").click();
  await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "true");

  await openDocumentMenu(item);
  await item.getByTestId("document.delete").click();
  await expect(item).toHaveCount(0);
  await expect(window.getByTestId("viewer-removed")).toContainText(
    "has been deleted from IncarnaMind",
  );
  await expect(viewer.locator("[data-page-number]")).toHaveCount(0);

  // A Citation of a deleted Document opens the panel on the message and its stored quote.
  await window.getByTestId("document-tab").getByTestId("tab-close").click();
  await openDocumentAt(window, { documentId, pageFrom: 2, quote: "Revenue grew by ten percent" });
  await expect(window.getByTestId("viewer-removed")).toContainText(
    "has been deleted from IncarnaMind",
  );
  await expect(window.getByTestId("viewer-removed")).toContainText("Revenue grew by ten percent");
  // Deleted by the User, not unlinked with its folder: it says so.
  await expect(window.getByTestId("viewer-removed")).toContainText(
    "This Document has been deleted from IncarnaMind",
  );
  await app.close();
});

test("the open viewer follows its file on disk: the new version once indexed, and the file back after it went missing", async () => {
  const library = join(await realpath(sources), "Library");
  await mkdir(library);
  const notes = join(library, "Notes.md");
  const report = join(library, "Report.pdf");
  const SECOND_DRAFT = "# Notes\n\nThe second draft, rewritten.\n\nThe tide turns at noon.\n";
  await writeFile(notes, "# Notes\n\nThe first draft.\n\nThe tide turns at noon.\n");
  await writeFile(report, REPORT);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await linkFolderFromSidebar(app, window, library);
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(2);
  for (const item of await items.all()) await expect(item).toHaveAttribute("data-status", "ready");
  const viewer = window.getByTestId("viewer");
  const text = window.getByTestId("viewer-text");
  const mark = viewer.getByTestId("viewer-quote-mark");
  const notesItem = items.filter({ hasText: "Notes" });

  // Opened at a Citation's quote.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Notes"),
    quote: "The tide turns at noon.",
    citation: { check: "found", number: 1 },
  });
  await expect(text).toContainText("The first draft.");
  const washed = text.locator("[data-quote-highlight]");
  await expect(washed).toHaveText(["The tide turns at noon."]);

  // Edited on disk: once the new version is indexed the viewer shows it, at the same quote.
  await writeFile(notes, SECOND_DRAFT);
  await expect(text).toContainText("The second draft, rewritten.", { timeout: 15_000 });
  await expect(text).not.toContainText("The first draft.");
  await expect(washed).toHaveText(["The tide turns at noon."]);
  await expect(mark).toHaveText("1");
  await screenshot(viewer, "viewer-new-version");

  // Deleted on disk while open: what was read stays, but there is no file to open.
  await rm(notes);
  await expect(notesItem).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });
  await expect(text).toContainText("The second draft, rewritten.");
  await expect(viewer.getByTestId("viewer-open-externally")).toHaveCount(0);
  // Opened again, it can't be shown: its file is missing, the Document isn't deleted...
  await window.getByTestId("document-tab").getByTestId("tab-close").click();
  await notesItem.getByTestId("open-document").click();
  const gone = window.getByTestId("viewer-removed");
  await expect(gone).toContainText("The file for Notes is missing from its folder");
  await expect(gone).not.toContainText("deleted");
  await screenshot(viewer, "viewer-missing");
  // ...until the file comes back: then the viewer shows it, by itself.
  await writeFile(notes, SECOND_DRAFT);
  await expect(notesItem).toHaveAttribute("data-file-status", "available", { timeout: 15_000 });
  await expect(text).toContainText("The second draft, rewritten.");
  await expect(window.getByTestId("viewer-removed")).toHaveCount(0);
  await expect(viewer.getByTestId("viewer-open-externally")).toHaveCount(1);
  await screenshot(viewer, "viewer-file-back");

  // A PDF opened at a Citation's page keeps that page and its quote through a new version.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Report"),
    pageFrom: 2,
    quote: "Revenue grew by ten percent in the third quarter",
    citation: { check: "found", number: 2 },
  });
  const highlights = viewer.locator('[data-page-number="2"] [data-quote-highlight]');
  await expect(highlights).toHaveCount(2);
  await writeFile(
    report,
    buildPdf([
      { lines: ["Annual report", "Prepared for the shareholders."] },
      {
        lines: [
          "Results",
          "Revenue grew by ten percent",
          "in the third quarter, led by exports.",
          "Costs stayed flat.",
        ],
      },
      { lines: ["Outlook", "We expect steady growth next year."] },
    ]),
  );
  await expect(viewer.locator('[data-page-number="1"] .textLayer')).toContainText("Annual report", {
    timeout: 15_000,
  });
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  await expect(highlights).toHaveCount(2);
  await expect(highlights.first()).toBeInViewport();
  await expect(mark).toHaveText("2");

  // Opened from the sidebar, it comes back at the page and zoom it was left at.
  await items.filter({ hasText: "Report" }).getByTestId("open-document").click();
  await window.getByTestId("pdf-zoom-in").click();
  const zoomLevel = await window.getByTestId("pdf-zoom-level").textContent();
  await window.getByTestId("pdf-page-number").fill("3");
  await window.getByTestId("pdf-page-number").press("Enter");
  await writeFile(
    report,
    buildPdf([
      { lines: ["Quarterly report", "Prepared for the board."] },
      { lines: ["Results", "Revenue grew by ten percent."] },
      { lines: ["Outlook, revised", "We expect slower growth next year."] },
    ]),
  );
  // The page in view is the new version's.
  await expect(viewer.locator('[data-page-number="3"] .textLayer')).toContainText(
    "Outlook, revised",
    { timeout: 15_000 },
  );
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("3");
  await expect(window.getByTestId("pdf-zoom-level")).toHaveText(zoomLevel ?? "");
  await expect(window.getByTestId("pdf-fit-width")).toHaveAttribute("aria-pressed", "false");
  await app.close();
});

test("a Document's tab has one 36px toolbar under its group's strip, holding every control in order", async () => {
  const guide = join(sources, "Guide.pdf");
  await writeFile(guide, GUIDE);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [guide]);
  await newMind(window);
  await window.getByTestId("open-document").click();
  const viewer = window.getByTestId("viewer");
  await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "true");

  // One toolbar, 36px tall, right under its group's strip.
  const header = viewer.getByTestId("viewer-header");
  await expect(viewer.locator("header")).toHaveCount(1);
  const headerBox = await boxOf(header);
  const strip = await boxOf(window.getByTestId("tab-strip").nth(1));
  expect(headerBox.height).toBe(36);
  expect(headerBox.y).toBe(strip.y + strip.height);

  // In order: the outline toggle, the name, its Tags, page navigation, zoom, Keep open (it is
  // a preview), its own app, and its ⋯ menu.
  const controls = header.locator("button, input, [data-testid='viewer-title']");
  expect(
    await controls.evaluateAll((elements) =>
      elements.map((each) => each.getAttribute("data-testid")),
    ),
  ).toEqual([
    "pdf-outline-button",
    "viewer-title",
    "document-tags-menu",
    "pdf-previous-page",
    "pdf-page-number",
    "pdf-next-page",
    "pdf-zoom-out",
    "pdf-zoom-in",
    "pdf-fit-width",
    "viewer-keep",
    "viewer-open-externally",
    "document-file-menu",
  ]);
  await expect(window.getByTestId("viewer-title")).toHaveText("Guide");
  const icons = header.locator(
    "button:not([data-testid='viewer-keep']):not([data-testid='viewer-title'])",
  );
  for (const control of await icons.all()) {
    await expect(control).toHaveAttribute("aria-label", /.+/);
    expect((await boxOf(control)).height).toBe(28);
  }

  // Every control is reached with Tab, in that order (Previous page is off on page 1).
  await header.getByTestId("pdf-outline-button").focus();
  const reached: (string | null)[] = [];
  for (let step = 0; step < 8; step++) {
    await window.keyboard.press("Tab");
    reached.push(
      await window.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null),
    );
  }
  expect(reached).toEqual([
    "document-tags-menu",
    "pdf-page-number",
    "pdf-next-page",
    "pdf-zoom-out",
    "pdf-zoom-in",
    "pdf-fit-width",
    "viewer-keep",
    "viewer-open-externally",
  ]);

  // "Open in default app" opens a copy named after the Document, as the sidebar's menu does.
  await interceptOpenPath(app);
  await header.getByTestId("viewer-open-externally").click();
  await expect.poll(() => pathsOpened(app)).toHaveLength(1);
  const [opened] = await pathsOpened(app);
  expect(basename(opened ?? "")).toBe("Guide.pdf");

  await app.close();
  // The app would remove the copy a day later; the test doesn't leave it behind.
  if (opened) await rm(dirname(opened), { recursive: true, force: true });
});

test("below 560 px a Document tab's toolbar hides its Tag chips and keeps the Tags button, in English and Chinese", async () => {
  const notes = join(sources, "Notes.txt");
  await writeFile(notes, "Notes on the quarter.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // As wide as 1,500px was, beside the assistant docked on the right (#253).
  await setWindowSize(app, window, 1868, 800);
  await addDocuments(window, [notes]);
  await (await coreOf(window)).evaluate(async (core) => {
    const [first] = await core.listDocuments();
    if (!first) throw new Error("The Document isn't there.");
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const tag = await core.createTag({ name });
      await core.addDocumentTag(first.id, tag.id);
    }
  });
  await newMind(window);
  await window.getByTestId("open-document").click();
  const viewer = window.getByTestId("viewer");
  const header = viewer.getByTestId("viewer-header");
  const chips = header.getByTestId("tag-chip");
  const more = header.getByTestId("tag-chip-more");
  const tagsButton = header.getByTestId("document-tags-menu");

  for (const language of ["en", "zh-CN"] as const) {
    await (await coreOf(window)).evaluate(
      (core, chosen) => core.updateSettings({ user: { language: chosen } }),
      language,
    );
    // Wide: the first two Tags show as chips, with "+1" for the rest.
    await setViewerWidth(window, 900);
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toBeVisible();
    await expect(more).toBeVisible();
    await expect(tagsButton).toBeVisible();

    // Narrow: no chips, the button still there, and the toolbar keeps its one line.
    await setViewerWidth(window, 540);
    await expect(chips.first()).toBeHidden();
    await expect(more).toBeHidden();
    await expect(tagsButton).toBeVisible();
    expect((await boxOf(header)).height).toBe(36);
    await tagsButton.click();
    const picker = header.getByTestId("document-tags-popover");
    await expect(picker.getByTestId("tag-picker-input")).toBeFocused();
    await expect(picker.getByTestId("tag-token")).toHaveCount(3);
    await window.keyboard.press("Escape");
    await expect(picker).toBeHidden();
  }
  await app.close();
});

/** A Document's name of 120 characters, as long as a toolbar will meet. */
const LONG_NAME =
  `${"Harbour sediment survey, east basin transects 1–14, ".repeat(2)}grain-size tables and core logs`
    .slice(0, 120)
    .trim();

/**
 * Expects no two of a toolbar's drawn controls, kind icon and chips to overlap,
 * and the toolbar not to scroll sideways.
 */
async function expectToolbarClear(header: Locator, where: string): Promise<void> {
  const found = await header.evaluate((element) =>
    [...element.querySelectorAll("button, input, [data-testid='tag-chip'], .viewer-kind")]
      .map((item) => ({
        id: item.getAttribute("data-testid") ?? item.tagName,
        box: item.getBoundingClientRect(),
      }))
      .filter((item) => item.box.width > 0 && item.box.height > 0)
      .map((item) => ({ id: item.id, left: item.box.left, right: item.box.right })),
  );
  const items = found.sort((a, b) => a.left - b.left);
  for (const [index, item] of items.entries()) {
    const next = items[index + 1];
    if (next) {
      expect(item.right, `${where}: ${item.id} / ${next.id}`).toBeLessThanOrEqual(next.left + 0.5);
    }
  }
  await expect
    .poll(() => header.evaluate((element) => element.scrollWidth - element.clientWidth), {
      message: `${where}: the toolbar scrolls`,
    })
    .toBeLessThanOrEqual(0);
}

test("with a 120-character name and three Tags, a Document tab's toolbar gives the name way first, folds Tags into +N, and overlaps nothing from 900 to 1920px, in English and Chinese", async () => {
  const name = LONG_NAME;
  expect(name).toHaveLength(120);
  const survey = join(sources, `${name}.md`);
  await writeFile(survey, "# Harbour\n\nSediment survey notes.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [survey]);
  // As long as a Tag's chip goes before it is cut (10rem), so two of them need a wide toolbar.
  const tagNames = [
    "Harbour sediment cores, 2025 season",
    "East basin transects 1 to 14",
    "Grain-size tables and field logs",
  ];
  await (await coreOf(window)).evaluate(async (core, names) => {
    const [first] = await core.listDocuments();
    if (!first) throw new Error("The Document isn't there.");
    for (const tagName of names) {
      const tag = await core.createTag({ name: tagName });
      await core.addDocumentTag(first.id, tag.id);
    }
  }, tagNames);
  await newMind(window);
  const viewer = window.getByTestId("viewer");
  const header = viewer.getByTestId("viewer-header");
  const title = header.getByTestId("viewer-title");
  const row = header.getByTestId("document-tags");
  const chips = row.getByTestId("tag-chip");
  const more = row.getByTestId("tag-chip-more");

  const expectNoOverlap = (where: string) => expectToolbarClear(header, where);

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const width of [900, 1280, 1920]) {
      await setWindowSize(app, window, width, 800);
      await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(width);
      // A window under 1,100px shows the Document over the Mind: it is opened from the sidebar.
      if (!(await header.isVisible())) await window.getByTestId("open-document").click();
      await expect(header).toBeVisible();
      const where = `${language} at ${width}px`;

      // The name is cut with an ellipsis, and its tooltip gives all of it.
      expect(await title.getAttribute("title"), where).toContain(name);
      expect(
        await title.evaluate((element) => element.scrollWidth > element.clientWidth),
        where,
      ).toBe(true);
      await expectNoOverlap(where);

      // The chips, "+N" and the Tags button sit 4px apart.
      const row4 = await row.evaluate((element) => {
        const boxes = [...element.children]
          .map((child) => child.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0);
        return boxes.slice(1).map((box, index) => box.left - (boxes[index]?.right ?? 0));
      });
      for (const gap of row4) expect(gap, where).toBeCloseTo(4, 0);
    }
  }

  // As the viewer narrows, the last chips fold into "+N" first, and "+N" says how many and which.
  await setWindowSize(app, window, 1868, 800);
  await setViewerWidth(window, 900);
  await expect(chips).toHaveCount(2);
  let before = 2;
  for (const width of [900, 760, 680, 620, 560]) {
    await setViewerWidth(window, width);
    await expectNoOverlap(`viewer ${width}px`);
    const drawn = await chips.evaluateAll((elements) =>
      elements
        .filter((each) => each.getBoundingClientRect().width > 0)
        .map((each) => each.textContent?.trim()),
    );
    expect(drawn.length, `viewer ${width}px`).toBeLessThanOrEqual(before);
    before = drawn.length;
    await expect(more).toHaveText(`+${tagNames.length - drawn.length}`);
    const folded = await more.getAttribute("aria-label");
    for (const hidden of tagNames.filter((each) => !drawn.includes(each))) {
      expect(folded).toContain(hidden);
    }
  }
  expect(before, "the chips fold as the viewer narrows").toBeLessThan(2);
  await app.close();
});

test("a PDF's busier toolbar, with a 120-character name and three Tags, overlaps nothing from 900 to 1920px, in English and Chinese", async () => {
  const guide = join(sources, `${LONG_NAME}.pdf`);
  await writeFile(guide, GUIDE);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [guide]);
  await (await coreOf(window)).evaluate(async (core) => {
    const [first] = await core.listDocuments();
    if (!first) throw new Error("The Document isn't there.");
    for (const name of ["Harbour cores", "East basin transects", "Grain-size tables"]) {
      const tag = await core.createTag({ name });
      await core.addDocumentTag(first.id, tag.id);
    }
  });
  await newMind(window);
  const header = window.getByTestId("viewer").getByTestId("viewer-header");

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const width of [900, 1280, 1920]) {
      await setWindowSize(app, window, width, 800);
      await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(width);
      if (!(await header.isVisible())) await window.getByTestId("open-document").click();
      await expect(header).toBeVisible();
      await expectToolbarClear(header, `${language} at ${width}px`);
    }
  }
  await app.close();
});

test("a Citation's quote is washed in its check's colour, with its mark beside the first highlighted line", async () => {
  const { report, notes } = await writeSources();
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [report, notes]);
  const viewer = window.getByTestId("viewer");
  const mark = viewer.getByTestId("viewer-quote-mark");

  // A found quote across a line break on page 2: green, its mark beside the first line.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Report"),
    pageFrom: 2,
    quote: "Revenue grew by ten percent in the third quarter",
    citation: { check: "found", number: 3 },
  });
  const page2 = viewer.locator('[data-page-number="2"]');
  const highlights = page2.locator("[data-quote-highlight]");
  await expect(highlights).toHaveCount(2);
  await expect(highlights.first()).toHaveCSS("background-color", FOUND_WASH);
  await expect(mark).toHaveText("3");
  await expect(mark).toHaveAttribute("aria-label", "Citation 3: quote found");
  await expect(mark).toHaveAttribute("data-check", "found");
  await expectMarkBeside(mark, highlights.first(), page2);
  // It stays beside the quote through a zoom.
  await window.getByTestId("pdf-zoom-in").click();
  await expect(window.getByTestId("pdf-fit-width")).toHaveAttribute("aria-pressed", "false");
  await expect(async () => expectMarkBeside(mark, highlights.first(), page2)).toPass();

  // Opened anyway after "not found": amber, with the matching mark.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Report"),
    pageFrom: 2,
    quote: "Revenue grew by ten percent … led by exports. Costs stayed flat.",
    citation: { check: "not-found", number: 2 },
  });
  await expect(highlights).toHaveText([
    "Revenue grew by ten percent",
    "led by exports.",
    "Costs stayed flat.",
  ]);
  await expect(highlights.first()).toHaveCSS("background-color", NOT_FOUND_WASH);
  await expect(mark).toHaveAttribute("data-check", "not-found");
  await expect(mark).toHaveText("2");
  await expect(async () => expectMarkBeside(mark, highlights.first(), page2)).toPass();

  // Without the Citation's number, the quote is washed green with no mark.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Report"),
    pageFrom: 2,
    quote: "Costs stayed flat.",
  });
  await expect(highlights).toHaveText(["Costs stayed flat."]);
  await expect(highlights.first()).toHaveCSS("background-color", FOUND_WASH);
  await expect(mark).toHaveCount(0);

  // Markdown, in the Mind's serif on a page: each part of an ellipsis quote is washed,
  // and the mark sits beside the first.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Field notes"),
    quote: "Observation 119: nothing unusual today. ... Observation 120: nothing unusual today.",
    citation: { check: "found", number: 1 },
  });
  const text = window.getByTestId("viewer-text");
  const washed = text.locator("[data-quote-highlight]");
  await expect(washed).toHaveText([
    "Observation 119: nothing unusual today.",
    "Observation 120: nothing unusual today.",
  ]);
  await expect(washed.first()).toHaveCSS("background-color", FOUND_WASH);
  await expect(mark).toHaveText("1");
  await expect(async () =>
    expectMarkBeside(mark, washed.first(), text.locator("article")),
  ).toPass();
  expect(
    await text.locator("h1").evaluate((element) => getComputedStyle(element).fontFamily),
  ).toMatch(/^"Source Serif 4"/);
  await app.close();
});
