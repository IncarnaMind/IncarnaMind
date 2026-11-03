import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  placeAssistant,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A PDF Citation whose quoted line runs nearly to the page's right margin (#2459): the margin past
 * it is about as wide as the Citation's mark with its label, so the label fits at some window
 * widths and not at others. Opened from an Answer at the default 1280 × 800, the page shows the
 * quote and its mark; through the window widths either side of where the label stops fitting,
 * the panel never stops working. Set INCARNAMIND_SCREENSHOTS to a folder to also keep screenshots.
 */

const QUESTION = "What is the project budget for the harbour survey, and has it changed?";

/** The Chinese label is wider: its line ends earlier, so the label fits at some widths tried. */
const BUDGET_LINES = {
  en: "The project budget is 2.4 million pounds, approved by the steering group on 3 February 2026.",
  "zh-CN": "The project budget is 2.4 million pounds, approved by the board on 3 February 2026.",
} as const;

const brief = (budget: string) =>
  buildPdf([
    {
      lines: [
        "Survey brief",
        "Prepared for the port board.",
        budget,
        "Fieldwork starts in spring.",
      ],
    },
    { lines: ["Timeline", "The fieldwork runs for nine months."] },
  ]);

/**
 * Window widths, with the assistant open beside one group, between which the page widens with
 * the window: past the wider the Document opens beside the Note, below the narrower the sidebar
 * folds away.
 */
const ONE_GROUP = { narrow: 1010, wide: 1310 };

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

async function screenshot(window: Page, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}

/** Waits until the page and the mark stay as they are from one frame to the next. */
function settled(window: Page): Promise<void> {
  return window.evaluate(async () => {
    const look = () =>
      JSON.stringify(
        [
          ...document.querySelectorAll(
            '[data-page-number="1"], [data-testid="viewer-quote-mark"], [data-testid="panel-failed"]',
          ),
        ].map((element) => {
          const box = element.getBoundingClientRect();
          return [element.getAttribute("data-label-shown"), box.left, box.width];
        }),
      );
    let before = look();
    for (;;) {
      await new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn)));
      const now = look();
      if (now === before) return;
      before = now;
    }
  });
}

/**
 * Expects the quote's page with its wash and its ✓ mark, beside the quote's line and inside the
 * page, and no panel that stopped working; returns whether the mark shows its label.
 */
async function expectQuoteAndMark(window: Page, width: number): Promise<boolean> {
  const viewer = window.getByTestId("viewer");
  const mark = viewer.getByTestId("viewer-quote-mark");
  const failed = window.getByTestId("panel-failed");
  await expect(mark.or(failed).first()).toBeVisible();
  await expect(failed, `the panel stopped working at ${width}px`).toHaveCount(0);
  const page = viewer.locator('[data-page-number="1"]');
  // The page drawn again at its new size, its text with it, so the quote is where it ends now.
  await expect(page.locator(".pdf-page-text")).not.toHaveAttribute("style", /transform:/);
  await settled(window);
  await expect(failed, `the panel stopped working at ${width}px`).toHaveCount(0);
  const quote = page.locator("[data-quote-highlight]");
  await expect(quote.first()).toBeVisible();
  await expect(mark).toHaveAttribute("data-check", "found");
  await expect(mark.getByTestId("viewer-quote-mark-number")).toHaveText("1");
  const [markBox, pageBox, lineRight] = await Promise.all([
    mark.boundingBox(),
    page.boundingBox(),
    quote.last().evaluate((element) => element.getBoundingClientRect().right),
  ]);
  if (!markBox || !pageBox) throw new Error(`The page or its mark isn't shown at ${width}px.`);
  expect(markBox.x, `the mark beside the quote at ${width}px`).toBeGreaterThan(lineRight);
  expect(markBox.x + markBox.width, `the mark inside the page at ${width}px`).toBeLessThanOrEqual(
    pageBox.x + pageBox.width,
  );
  return (await mark.getAttribute("data-label-shown")) === "true";
}

async function atWidth(app: ElectronApplication, window: Page, width: number): Promise<boolean> {
  await setWindowSize(app, window, width, 800);
  await settled(window);
  return expectQuoteAndMark(window, width);
}

/**
 * Halves the widths between `from` and `to`, where the mark shows its label at one and not the
 * other, down to two a pixel apart: their rooms differ by less than a pixel, so a room just short
 * of the label's width is among those tried, whatever the fonts make that width.
 */
async function labelEdge(
  app: ElectronApplication,
  window: Page,
  from: number,
  to: number,
): Promise<{ shown: number; hidden: number }> {
  const groups = window.getByTestId("tab-group");
  const fromShown = await atWidth(app, window, from);
  await expect(groups, `one group at ${from}px`).toHaveCount(1);
  const toShown = await atWidth(app, window, to);
  await expect(groups, `one group at ${to}px`).toHaveCount(1);
  expect(toShown, `the label shows at one of ${from}px and ${to}px, not both`).toBe(!fromShown);
  let [shown, hidden] = fromShown ? [from, to] : [to, from];
  while (Math.abs(shown - hidden) > 1) {
    const middle = Math.round((shown + hidden) / 2);
    if (await atWidth(app, window, middle)) shown = middle;
    else hidden = middle;
  }
  return { shown, hidden };
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a PDF Citation opens at its quote at 1280 × 800 and through window widths either side of where its mark's label stops fitting (${language})`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Harbour Survey Brief.pdf"), brief(BUDGET_LINES[language]));
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    if (language === "zh-CN") await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 1280, 800);
    await addDocuments(window, [join(sources, "Harbour Survey Brief.pdf")]);
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    const answer = await askInAssistant(window, QUESTION);

    // Citation › Open the page, as a person does it, at the default window size.
    await pointAt(window, answer.getByTestId("citation").first().getByTestId("citation-chip"));
    const card = window.getByTestId("citation-card");
    await expect(card.locator("blockquote")).toHaveText(BUDGET_LINES[language]);
    await card.getByTestId("citation-open").click();
    await settled(window);
    await expectQuoteAndMark(window, 1280);
    await screenshot(window, `pdf-citation-${language}-1280`);

    for (const width of [1310, 1290, 1280, 1310]) await atWidth(app, window, width);

    // Then across the edge and back, a few pixels clear of it: the text layer, made again at
    // each scale, can move the quote's end by a fraction of a pixel.
    const edge = await labelEdge(app, window, ONE_GROUP.wide, ONE_GROUP.narrow);
    const away = Math.sign(edge.shown - edge.hidden) * 4;
    expect(await atWidth(app, window, edge.hidden - away)).toBe(false);
    await screenshot(window, `pdf-citation-${language}-label-hidden`);
    expect(await atWidth(app, window, edge.shown + away)).toBe(true);
    await screenshot(window, `pdf-citation-${language}-label-shown`);
    expect(await atWidth(app, window, edge.hidden - away)).toBe(false);

    await placeAssistant(window, { folded: true });
    for (const width of [1310, 1290, 1280, 1310]) await atWidth(app, window, width);
    await app.close();
  });
}
