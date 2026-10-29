import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { contractFile, resumeFile } from "../tests/helpers/wordLookFiles";
import {
  chooseLook,
  createDataFolder,
  dismissChatSetup,
  importWordFile,
  launchApp,
  motionSettled,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let home: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  files = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(files);
});

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** The line drawn on each side of a table or cell, in px: its own, the neighbouring cell's, or on the table's edge the table's. */
const sidesOf = (target: Locator) =>
  target.evaluate((element) => {
    const width = (of: Element, side: string) => {
      const style = getComputedStyle(of);
      return ["none", "hidden"].includes(style.getPropertyValue(`border-${side}-style`))
        ? 0
        : Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
    };
    const table = element.closest("table") ?? element;
    const box = element.getBoundingClientRect();
    const outer = table.getBoundingClientRect();
    const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const sides = {
      top: { x: middle.x, y: box.top - 2, opposite: "bottom" },
      right: { x: box.right + 2, y: middle.y, opposite: "left" },
      bottom: { x: middle.x, y: box.bottom + 2, opposite: "top" },
      left: { x: box.left - 2, y: middle.y, opposite: "right" },
    } as const;
    const side = (name: keyof typeof sides) => {
      const { x, y, opposite } = sides[name];
      const next = document.elementFromPoint(x, y)?.closest("td, th");
      const neighbour =
        next && next !== element && table.contains(next) ? width(next, opposite) : 0;
      const edge = Math.abs(box[name] - outer[name]) < 2 ? width(table, name) : 0;
      return Math.max(width(element, name), neighbour, edge);
    };
    return { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
  });

const widthOf = (target: Locator) =>
  target.evaluate((element) => element.getBoundingClientRect().width);

const frameIn = (window: Page) => window.locator(".mind-editor-frame:visible").first();

/** The content's point over the frame's, which stays whole. */
const zoomOf = (frame: Locator) =>
  frame.evaluate((element) => {
    const unit = (of: Element) =>
      Number.parseFloat(getComputedStyle(of).getPropertyValue("--word-pt"));
    const editor = element.querySelector(".mind-editor");
    return editor ? unit(editor) / unit(element) : 1;
  });

const fitsItsFrame = (table: Locator) =>
  table.evaluate((element) => {
    const wrapper = element.closest(".tableWrapper");
    return wrapper !== null && wrapper.scrollWidth <= wrapper.clientWidth + 1;
  });

test("the résumé's tables as the file draws them: layout tables without lines, the skills table with its own, columns in proportion, zoomed to fit its column", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "林晓_简历.docx", resumeFile());

  const editor = window.getByTestId("mind-editor");
  const internship = editor.locator("table", { hasText: "某证券公司研究所" });
  const skills = editor.locator("table", { hasText: "语言" });
  await expect(skills).toBeVisible();

  expect(await sidesOf(internship)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  for (const cell of await internship.locator("td").all()) {
    expect(await sidesOf(cell)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  }
  await expect(internship).toHaveCSS("border-top-left-radius", "0px");
  await expect(internship.locator("td").first()).toHaveCSS("min-width", "0px");
  await expect(internship.locator("td").last().locator("p")).toHaveCSS("text-align", "right");

  await expect(skills).toHaveCSS("border-collapse", "collapse");
  const language = skills.locator("td", { hasText: "语言" });
  const tools = skills.locator("td", { hasText: "工具" });
  const english = skills.locator("td", { hasText: "英语" });
  expect((await sidesOf(skills)).top).toBeGreaterThan(0);
  expect((await sidesOf(skills)).left).toBeGreaterThan(0);
  expect((await sidesOf(tools)).top).toBeGreaterThan(0);
  expect((await sidesOf(english)).left).toBeGreaterThan(0);
  await expect(language).toHaveCSS("background-color", "rgb(242, 242, 242)");
  await expect(english).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // 2000 and 7638 twips: the columns keep the file's proportion.
  const ratio = (await widthOf(language)) / (await widthOf(english));
  expect(ratio).toBeGreaterThan((2000 / 7638) * 0.97);
  expect(ratio).toBeLessThan((2000 / 7638) * 1.03);

  // The file's text is 780 px at the Mind's writing size, wider than the 680 px measure: it zooms to fit.
  const zoom = await zoomOf(frameIn(window));
  expect(zoom).toBeGreaterThanOrEqual(0.8);
  expect(zoom).toBeLessThan(1);
  expect(await fitsItsFrame(skills)).toBe(true);
  expect(await fitsItsFrame(internship)).toBe(true);
  await shot(window, "word-look-tables-resume-1440");

  await setLanguage(window, "zh-CN");
  await expect(window.getByTestId("page-menu")).toHaveAttribute("aria-label", /的更多操作$/);
  await shot(window, "word-look-tables-resume-zh-1440");
  // As on the 1,100 px board, with the assistant folded.
  await window.getByTestId("assistant-fold").click();
  await expect(window.getByTestId("assistant")).toHaveAttribute("data-folded", "true");
  await setWindowSize(app, window, 1100, 900);
  await expect.poll(() => fitsItsFrame(skills)).toBe(true);
  expect(await zoomOf(frameIn(window))).toBeGreaterThanOrEqual(0.8);
  await shot(window, "word-look-tables-resume-zh-1100");
  await setLanguage(window, "en");
  await shot(window, "word-look-tables-resume-1100");

  await window.getByTestId("split-group").click();
  await window
    .getByRole("region", { name: "Group 1" })
    .getByRole("tab", { name: "林晓_简历" })
    .click();
  const pane = window.locator('[data-testid="mind-pane"]:visible').first();
  const narrowSkills = pane.locator("table", { hasText: "语言" });
  // Half the window zooms past 80%, as far as an 11 px body, and the tables wrap their cells to fit.
  await expect.poll(() => zoomOf(frameIn(window))).toBeLessThan(0.8);
  expect(
    await narrowSkills
      .locator("p")
      .first()
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(11);
  expect(await fitsItsFrame(narrowSkills)).toBe(true);
  const frame = pane.locator(".mind-editor-frame");
  const bullet = pane.locator("li p", { hasText: "跟踪 12 家" });
  const frameBox = await frame.boundingBox();
  const bulletBox = await bullet.boundingBox();
  expect(bulletBox && frameBox && bulletBox.x + bulletBox.width).toBeLessThanOrEqual(
    (frameBox?.x ?? 0) + (frameBox?.width ?? 0) + 1,
  );
  const scroller = pane.locator("xpath=..");
  expect(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await shot(window, "word-look-tables-resume-narrow");
  await app.close();
});

test("the contract's tables: the bordered definitions with a shaded heading row and a centred cell, the signatures' lines under each name; Plain Mind draws them as any Mind's", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(
    app,
    window,
    files,
    "Supply agreement v5 (from Northwind).docx",
    contractFile(),
  );

  const editor = window.getByTestId("mind-editor");
  const definitions = editor.locator("table", { hasText: "Meaning" });
  const signatures = editor.locator("table", { hasText: "Signed for" });
  await expect(definitions).toBeVisible();

  const term = definitions.locator("td", { hasText: "Term" }).first();
  const meaning = definitions.locator("td", { hasText: "Meaning" });
  const clauseNine = definitions.locator("td", { hasText: "clause 9" });
  for (const cell of [term, meaning, clauseNine]) {
    const sides = await sidesOf(cell);
    expect(Object.values(sides).every((width) => width > 0)).toBe(true);
  }
  await expect(meaning).toHaveCSS("background-color", "rgb(242, 242, 242)");
  await expect(clauseNine).toHaveCSS("vertical-align", "middle");
  await expect(meaning.locator("strong")).toHaveText("Meaning");
  const ratio = (await widthOf(term)) / (await widthOf(meaning));
  expect(ratio).toBeGreaterThan((2600 / 6426) * 0.97);
  expect(ratio).toBeLessThan((2600 / 6426) * 1.03);
  // A table 100% wide fills the file's text width, which fits the measure unzoomed.
  expect(await zoomOf(frameIn(window))).toBeCloseTo(1, 3);
  const frameWidth = await widthOf(frameIn(window));
  expect(Math.abs((await widthOf(definitions)) - frameWidth)).toBeLessThan(2);

  for (const cell of await signatures.locator("td").all()) {
    const sides = await sidesOf(cell);
    expect(sides.bottom).toBeGreaterThan(0);
    expect([sides.top, sides.left, sides.right]).toEqual([0, 0, 0]);
  }
  await shot(window, "word-look-tables-contract-1440");
  await window.getByTestId("assistant-fold").click();
  await setWindowSize(app, window, 1100, 900);
  await expect.poll(() => fitsItsFrame(definitions)).toBe(true);
  await shot(window, "word-look-tables-contract-1100");
  await setLanguage(window, "zh-CN");
  await expect(window.getByTestId("page-menu")).toHaveAttribute("aria-label", /的更多操作$/);
  await shot(window, "word-look-tables-contract-zh-1100");

  await chooseLook(window, "plain");
  await expect(definitions).toHaveCSS("border-top-left-radius", "8px");
  await expect(signatures.locator("td").first()).toHaveCSS("min-width", "96px");
  await chooseLook(window, "word");
  await expect(definitions).toHaveCSS("border-top-left-radius", "0px");
  await app.close();
});

/** Sets the first table's look in this pane's editor, which the Mind's other panes get as a sync. */
const setTableLook = (pane: Locator, key: string | null) =>
  pane.locator(".ProseMirror").evaluate((dom, value) => {
    const { view } = (dom as unknown as { editor: Editor }).editor;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === "table") at = pos;
      return at < 0;
    });
    const table = view.state.doc.nodeAt(at);
    if (!table) throw new Error("No table.");
    view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...table.attrs, wordLook: value }));
  }, key);

test("a table look that arrives while the Mind is open, as the start-up backfill or a sync gives it, redraws the table", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Supply agreement.docx", contractFile());
  await window.getByTestId("split-group").click();
  const panes = window.locator('[data-testid="mind-pane"]:visible');
  await expect(panes).toHaveCount(2);
  const [here, there] = [panes.nth(0), panes.nth(1)];
  const table = there.locator("table", { hasText: "Meaning" });
  const key = await table.getAttribute("data-word-look");
  expect(key).toBeTruthy();

  await setTableLook(here, null);
  await expect(table).not.toHaveAttribute("data-word-look");
  await expect(table).toHaveCSS("border-top-left-radius", "8px");
  await setTableLook(here, key);
  await expect(table).toHaveAttribute("data-word-look", key ?? "");
  await expect(table).toHaveCSS("border-top-left-radius", "0px");
  await app.close();
});
