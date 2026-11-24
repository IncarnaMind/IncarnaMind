/**
 * A deck edited by hand, on its slides (#149), as a User of their own .pptx does it: one click
 * selects a shape and a drag moves it, a corner sizes it, the arrow keys nudge it, a double click
 * opens its text for typing; each gesture is written into the file at once, says where, and is one
 * step of Undo and Redo; a drag across words still selects them. A file that can't be written keeps
 * the edit for a copy beside it, and the deck is put back as it was in one step. English and
 * Chinese. Set INCARNAMIND_SCREENSHOTS to a folder to keep a picture of each state.
 */
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { part, unzip } from "../tests/helpers/docx";
import { gradientPng } from "../tests/helpers/png";
import { para, pptxOf, rel, sp, txBody, xfrm } from "../tests/helpers/pptx";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  launchApp,
  openDocumentAt,
  pointAndClick,
  removeDataFolder,
  runFromPalette,
  setLanguage,
  setWindowSize,
} from "./app";

const NAME = "Harbour plan.pptx";
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
const BLUE = `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2A5BD7"/></a:solidFill>`;
const run = (text: string, bold = false) =>
  `<a:r><a:rPr lang="en-GB" sz="2400"${bold ? ` b="1"` : ""}/><a:t>${text}</a:t></a:r>`;
const zhRun = (text: string, bold = false) =>
  `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="2400"${bold ? ` b="1"` : ""}/><a:t>${text}</a:t></a:r>`;

/** An invented deck: a title, a line with a bold figure, a blue box; a Chinese line; a box that can't grow. */
const DECK = pptxOf({
  slides: [
    {
      shapes:
        sp({
          id: 2,
          name: "Title",
          spPr: xfrm(457200, 300000, 8000000, 700000),
          body: txBody(para([run("Harbour plan 2027")])),
        }) +
        sp({
          id: 3,
          name: "Revenue",
          txBox: true,
          spPr: xfrm(457200, 1300000, 5200000, 600000),
          body: txBody(
            para([run("Revenue grew "), run("4 per cent", true), run(", checked.")]),
            `<a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr>`,
          ),
        }) +
        sp({ id: 4, name: "Box", spPr: xfrm(6400000, 1300000, 1800000, 1200000) + BLUE }) +
        `<p:pic><p:nvPicPr><p:cNvPr id="7" name="Quay" descr="The east quay"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rQuay"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(457200, 3000000, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
      rels: rel("rQuay", "image", "../media/quay.png"),
    },
    {
      shapes:
        sp({
          id: 5,
          name: "收入",
          txBox: true,
          spPr: xfrm(457200, 600000, 6000000, 600000),
          body: txBody(
            para([zhRun("收入增长"), zhRun("百分之四", true), zhRun("，已核对。")]),
            `<a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr>`,
          ),
        }) +
        sp({
          id: 6,
          name: "Note",
          txBox: true,
          spPr: xfrm(457200, 2000000, 3000000, 500000),
          body: txBody(para([run("Moorings stay as they are.")]), `<a:bodyPr wrap="square"/>`),
        }),
    },
  ],
  parts: [
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "ppt/media/quay.png", data: gradientPng(64) },
  ],
});

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

/** Keeps a picture of the window when INCARNAMIND_SCREENSHOTS names a folder. */
async function still(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

/** The deck added on its own, opened beside the Mind, its slides drawn. */
async function opened(language: "en" | "zh-CN" = "en") {
  const path = join(sources, NAME);
  await writeFile(path, DECK);
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await addDocuments(window, [path]);
  const item = window.getByTestId("document-list-item").filter({ hasText: "Harbour plan" });
  await pointAndClick(window, item.getByTestId("open-document"));
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-slides")).toHaveAttribute("data-drawn", "yes");
  const slides = viewer.getByTestId("viewer-slide-editor");
  await expect(slides).toHaveCount(2);
  return { app, window, viewer, path, first: slides.nth(0), second: slides.nth(1) };
}

/** A slide part of the file on disk, as text. */
async function slideOnDisk(path: string, number: number): Promise<string> {
  return part(unzip(await readFile(path)), `ppt/slides/slide${number}.xml`);
}

/** The offset and size of a shape in a slide's XML, in EMU. */
function placeOf(xml: string, id: number) {
  const shape = xml.split("<p:sp>").find((each) => each.includes(`<p:cNvPr id="${id}"`)) ?? "";
  const [, x, y] = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(shape) ?? [];
  const [, cx, cy] = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape) ?? [];
  return { x: Number(x), y: Number(y), cx: Number(cx), cy: Number(cy) };
}

const centre = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Not on screen.");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** The pointer the page asks for at a point: what tells the User what a press there will do. */
const pointerAt = (window: Page, at: { x: number; y: number }) =>
  window.evaluate(({ x, y }) => {
    const under = document.elementFromPoint(x, y);
    return under ? getComputedStyle(under).cursor : null;
  }, at);

async function drag(window: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 6 });
  await window.mouse.move(from.x + by.x, from.y + by.y, { steps: 6 });
  await window.mouse.up();
}

const undoLine = (window: Page) => window.getByTestId("undo-line");

/** To the end of the text being typed, as the platform's keys do it. */
const LINE_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

test("a User's own deck: select, move, resize, nudge and type on the slide, each written into the file, with Undo and Redo", async () => {
  const { app, window, viewer, path, first } = await opened();
  try {
    await still(window, "01-rest-en");
    const before = await slideOnDisk(path, 1);

    // Over words, the pointer is the text cursor: a drag selects them, as it always did.
    const words = first.getByText("Revenue grew");
    // "auto" over text is the text cursor.
    expect(["auto", "text"]).toContain(await pointerAt(window, await centre(words)));
    const wordsBox = await words.boundingBox();
    if (!wordsBox) throw new Error("No words.");
    await window.mouse.move(wordsBox.x + 2, wordsBox.y + wordsBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(wordsBox.x + wordsBox.width - 2, wordsBox.y + wordsBox.height / 2, {
      steps: 8,
    });
    await window.mouse.up();
    expect(await window.evaluate(() => document.getSelection()?.toString())).toContain("Revenue");
    expect(await slideOnDisk(path, 1)).toBe(before);
    await still(window, "02-words-selected-en");

    // A picture: one click selects it, a double click opens it in the picture viewer.
    const picture = first.locator('[data-shape-id="7"]');
    await picture.click();
    await expect(first.getByTestId("viewer-slide-selection")).toBeVisible();
    await expect(window.getByTestId("picture-viewer")).toBeHidden();
    await picture.dblclick();
    await expect(window.getByTestId("picture-viewer")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("picture-viewer")).toBeHidden();
    expect(await slideOnDisk(path, 1)).toBe(before);

    // One click selects the blue box; over it the pointer says it moves.
    const box = first.locator('[data-shape-id="4"]');
    await box.click();
    const frame = first.getByTestId("viewer-slide-selection");
    await expect(frame).toBeVisible();
    expect(await pointerAt(window, await centre(box))).toBe("move");
    const handle = frame.locator('[data-corner="se"]');
    expect(await pointerAt(window, await centre(handle))).toBe("nwse-resize");
    await still(window, "03-selected-en");

    // A drag moves it; the file holds it where it was put, and the line says where it was saved.
    const was = placeOf(before, 4);
    const from = await centre(box);
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(from.x - 60, from.y + 30, { steps: 8 });
    await still(window, "04-dragging-en");
    await window.mouse.move(from.x - 120, from.y + 60, { steps: 8 });
    await window.mouse.up();
    await expect.poll(async () => placeOf(await slideOnDisk(path, 1), 4).x).toBeLessThan(was.x);
    const moved = placeOf(await slideOnDisk(path, 1), 4);
    expect(moved.y).toBeGreaterThan(was.y);
    expect({ cx: moved.cx, cy: moved.cy }).toEqual({ cx: was.cx, cy: was.cy });
    await expect(undoLine(window)).toContainText(`Moved a shape on slide 1 · saved in “${NAME}”`);
    // Once, the first time: the file itself is changed, and how to put it back.
    await expect(window.getByTestId("tip")).toContainText(
      "Your changes are saved in the file itself.",
    );
    await still(window, "05-saved-en");

    // A corner sizes it.
    await drag(window, await centre(frame.locator('[data-corner="se"]')), { x: 80, y: 40 });
    await expect
      .poll(async () => placeOf(await slideOnDisk(path, 1), 4).cx)
      .toBeGreaterThan(moved.cx);
    await expect(undoLine(window)).toContainText("Resized a shape on slide 1");
    const sized = placeOf(await slideOnDisk(path, 1), 4);

    // The arrow keys nudge it, one step for the run of presses.
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("Shift+ArrowRight");
    await expect
      .poll(async () => placeOf(await slideOnDisk(path, 1), 4).x)
      .toBe(sized.x + 12 * 9525);

    // A double click opens the text where it was clicked; the run's formatting is kept.
    const figure = first.getByText("4 per cent");
    const at = await centre(first.getByText(", checked."));
    await window.mouse.dblclick(at.x, at.y);
    const typing = first.locator('[contenteditable="true"]');
    await expect(typing).toBeFocused();
    await window.keyboard.press(LINE_END);
    await window.keyboard.type(" Rising");
    await still(window, "06-typing-en");
    await window.keyboard.press("Escape");
    await expect.poll(async () => slideOnDisk(path, 1)).toContain(", checked. Rising");
    const typed = await slideOnDisk(path, 1);
    expect(typed).toContain(`b="1"/><a:t>4 per cent</a:t>`);
    await expect(figure).toBeVisible();
    await expect(undoLine(window)).toContainText("Changed the text on slide 1");

    // Undo takes back one gesture and writes the file; Redo does it again.
    await viewer.getByTestId("viewer-slide-editor").first().focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => slideOnDisk(path, 1)).not.toContain("Rising");
    expect(placeOf(await slideOnDisk(path, 1), 4).x).toBe(sized.x + 12 * 9525);
    await still(window, "07-after-undo-en");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => slideOnDisk(path, 1)).toContain(", checked. Rising");

    // The rest of the deck is as it was: its second slide's part is the file's own.
    const original = unzip(DECK);
    const now = unzip(await readFile(path));
    expect(part(now, "ppt/slides/slide2.xml")).toBe(part(original, "ppt/slides/slide2.xml"));
  } finally {
    await app.close();
  }
});

test("in Chinese: typing in a Chinese line keeps its bold run, and the lines read in Chinese", async () => {
  const { app, window, path, second } = await opened("zh-CN");
  try {
    const at = await centre(second.getByText("，已核对。"));
    await window.mouse.dblclick(at.x, at.y);
    const typing = second.locator('[contenteditable="true"]');
    await expect(typing).toBeFocused();
    await window.keyboard.press(LINE_END);
    // Through an input method: nothing is redrawn while the composition is open.
    const session = await window.context().newCDPSession(window);
    try {
      await session.send("Input.imeSetComposition", {
        text: "quanbu",
        selectionStart: 6,
        selectionEnd: 6,
      });
      await still(window, "08-composing-zh");
      await session.send("Input.insertText", { text: "全部" });
    } finally {
      await session.detach();
    }
    await window.keyboard.press("Escape");
    await expect.poll(async () => slideOnDisk(path, 2)).toContain("，已核对。全部");
    expect(await slideOnDisk(path, 2)).toContain(`b="1"/><a:t>百分之四</a:t>`);
    expect((await slideOnDisk(path, 2)).match(/全部/g)).toHaveLength(1);
    await expect(undoLine(window)).toContainText(`已修改第 2 张幻灯片上的文字 · 已保存到“${NAME}”`);
    await expect(window.getByTestId("tip")).toContainText("修改会直接保存到文件中。");
    await still(window, "09-saved-zh");
  } finally {
    await app.close();
  }
});

test("a text box that can't grow says when its text runs past it, and shrinks it to fit in one step", async () => {
  const { app, window, path, second } = await opened();
  try {
    const at = await centre(second.getByText("Moorings stay as they are."));
    await window.mouse.dblclick(at.x, at.y);
    await expect(second.locator('[contenteditable="true"]')).toBeFocused();
    await window.keyboard.press(LINE_END);
    await window.keyboard.type(
      " The east quay is dredged in spring, the west quay in autumn, and both reopen by June.",
    );
    await window.keyboard.press("Escape");
    const line = window.getByTestId("viewer-deck-overflow");
    await expect(line).toContainText("The text on slide 2 runs past its box");
    await still(window, "10-overflow-en");
    await line.getByTestId("viewer-deck-shrink").click();
    await expect.poll(async () => slideOnDisk(path, 2)).toContain("<a:normAutofit fontScale=");
    await expect(undoLine(window)).toContainText("Shrank the text to fit on slide 2");
  } finally {
    await app.close();
  }
});

test("a file that can't be written keeps the edit and saves it as a copy beside it; the deck is put back as it was in one step", async () => {
  const { app, window, viewer, path, first } = await opened();
  try {
    // Put back: one step to the file as it stood before the sitting, which Undo takes back.
    await first.locator('[data-shape-id="4"]').click();
    await window.keyboard.press("Shift+ArrowDown");
    await expect
      .poll(async () => slideOnDisk(path, 1))
      .not.toBe(part(unzip(DECK), "ppt/slides/slide1.xml"));
    const edited = await readFile(path);
    await runFromPalette(window, "Put back as it was");
    await expect.poll(async () => Buffer.compare(await readFile(path), DECK)).toBe(0);
    await expect(undoLine(window)).toContainText(`Put “Harbour plan” back as it was`);
    await still(window, "11-put-back-en");
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => Buffer.compare(await readFile(path), edited)).toBe(0);

    // Read-only: the line says so where it happened, and the edit waits for a copy beside it.
    await chmod(path, 0o444);
    const shown = await readFile(path);
    const box = viewer.getByTestId("viewer-slide-editor").first().locator('[data-shape-id="4"]');
    await box.click();
    await window.keyboard.press("Shift+ArrowRight");
    const problem = window.getByTestId("viewer-deck-unwritable");
    await expect(problem).toContainText(`“${NAME}” can’t be changed`);
    await expect(problem).toContainText("Your change is kept here until it’s saved");
    expect(Buffer.compare(await readFile(path), shown)).toBe(0);
    await still(window, "12-cannot-write-en");
    await problem.getByTestId("viewer-deck-save-copy").click();
    await expect(undoLine(window)).toContainText(
      "Made a copy with your change · saved in “Harbour plan 2.pptx”",
    );
    expect(await readdir(sources)).toContain("Harbour plan 2.pptx");
    expect(Buffer.compare(await readFile(path), shown)).toBe(0);
    await still(window, "13-copy-saved-en");
  } finally {
    await app.close();
  }
});

test("a Citation's mark stays on its words after an edit elsewhere, and says when the words it checked were changed", async () => {
  const { app, window, viewer, path, first } = await opened();
  try {
    const documentId = await documentIdOf(window, "Harbour plan");
    const contentHash = await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.listDocuments()).find((each) => each.id === id)?.contentHash ?? "";
    }, documentId);
    await openDocumentAt(window, {
      documentId,
      pageFrom: 1,
      pageTo: 1,
      quote: "Revenue grew 4 per cent",
      citation: { check: "found", number: 1, label: "slide 1", contentHash },
    });
    const mark = viewer.getByTestId("viewer-quote-mark");
    await expect(mark).toHaveAttribute("data-check", "found");
    const before = await slideOnDisk(path, 1);

    // A move elsewhere on the slide: the deck stays the one edited, the mark on its words.
    await first.locator('[data-shape-id="4"]').click();
    await window.keyboard.press("Shift+ArrowDown");
    await expect.poll(async () => slideOnDisk(path, 1)).not.toBe(before);
    await expect(undoLine(window)).toContainText("Moved a shape on slide 1");
    await expect(viewer.getByTestId("viewer-as-cited")).toHaveCount(0);
    await expect(first.locator("[data-quote-highlight]").first()).toBeVisible();
    await expect(mark).toHaveAttribute("data-check", "found");

    // The words it checked are changed: its earlier check is no longer shown as current.
    const at = await centre(first.getByText("4 per cent"));
    await window.mouse.dblclick(at.x, at.y);
    await expect(first.locator('[contenteditable="true"]')).toBeFocused();
    await window.keyboard.type("0");
    await window.keyboard.press("Escape");
    await expect.poll(async () => slideOnDisk(path, 1)).not.toContain("<a:t>4 per cent</a:t>");
    await expect(mark).toHaveAttribute("data-check", "cant-check");
    await expect(mark).toHaveAttribute("aria-label", /changed since it was checked/);
    await expect(viewer.getByTestId("viewer-as-cited")).toHaveCount(0);
    await still(window, "15-citation-changed-en");
  } finally {
    await app.close();
  }
});

for (const [language, index, shape, words, moved] of [
  ["en", 0, 3, "Revenue grew", "Moved a shape on slide 1"],
  ["zh-CN", 1, 5, "收入增长", "已移动第 2 张幻灯片上的形状"],
] as const) {
  test(`a text box moves by its edge, as in PowerPoint; a drag over its words selects them, selected or not (${language})`, async () => {
    const { app, window, viewer, path } = await opened(language);
    try {
      const slide = viewer.getByTestId("viewer-slide-editor").nth(index);
      await slide.scrollIntoViewIfNeeded();
      const number = index + 1;
      const before = await slideOnDisk(path, number);

      // One click on its words selects the box; a drag over them then selects words, and writes nothing.
      const text = slide.getByText(words);
      await text.click();
      const frame = slide.getByTestId("viewer-slide-selection");
      await expect(frame).toBeVisible();
      const span = await text.boundingBox();
      if (!span) throw new Error("No words.");
      expect(["auto", "text"]).toContain(await pointerAt(window, await centre(text)));
      await window.mouse.move(span.x + 2, span.y + span.height / 2);
      await window.mouse.down();
      await window.mouse.move(span.x + span.width - 2, span.y + span.height / 2, { steps: 8 });
      await window.mouse.up();
      expect(await window.evaluate(() => document.getSelection()?.toString())).toContain(words);
      await expect(frame).toBeVisible();
      await window.waitForTimeout(700);
      expect(await slideOnDisk(path, number)).toBe(before);
      await expect(undoLine(window)).not.toContainText(moved);

      // Its edge moves it, under the move pointer.
      const edge = slide.locator(`[data-edge="top"][data-shape-id="${shape}"]`);
      const from = await centre(edge);
      expect(await pointerAt(window, from)).toBe("move");
      await drag(window, from, { x: 40, y: 20 });
      await expect
        .poll(async () => placeOf(await slideOnDisk(path, number), shape).x)
        .toBeGreaterThan(placeOf(before, shape).x);
      await expect(undoLine(window)).toContainText(moved);
    } finally {
      await app.close();
    }
  });
}
