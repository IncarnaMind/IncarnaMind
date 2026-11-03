import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { paragraph, run, W_NS, wordFile } from "../tests/helpers/word";
import { contractFile, RESUME_TEXT_WIDTH_TWIPS, resumeFile } from "../tests/helpers/wordLookFiles";
import {
  chooseLook,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  importWordFile,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
/** The résumé's body size, which the Mind's writing size stands for. */
const RESUME_BODY = 10.5;
const RESUME_WIDTH = RESUME_TEXT_WIDTH_TWIPS / 20;

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

/** Where `text` starts and ends in the paragraph holding it, from the paragraph's left edge; `pt` is a point in pixels for a file whose body size is `body`. */
function placeOf(window: Page, text: string, body = RESUME_BODY) {
  return window.evaluate(
    ([wanted, size]) => {
      const editor = document.querySelector('[data-testid="mind-editor"]');
      const walker = document.createTreeWalker(editor ?? document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const box = range.getBoundingClientRect();
        const paragraph = node.parentElement?.closest("p");
        const line = paragraph?.getBoundingClientRect();
        if (!paragraph || !line) return null;
        return {
          left: box.left - line.left + paragraph.scrollLeft,
          right: box.right - line.left + paragraph.scrollLeft,
          width: paragraph.scrollWidth,
          shown: paragraph.clientWidth,
          overflow: getComputedStyle(paragraph).overflowX,
          // The look's point, zoomed to fit the column; in Plain Mind, the writing size's.
          pt:
            Number.parseFloat(
              getComputedStyle(editor ?? paragraph).getPropertyValue("--word-pt"),
            ) || Number.parseFloat(getComputedStyle(editor ?? paragraph).fontSize) / size,
        };
      }
      return null;
    },
    [text, body] as const,
  );
}

/** Whether the window or a Mind's scroller scrolls sideways, and the text of each line that does in its own frame. */
const sideways = (window: Page) =>
  window.evaluate(() => {
    const wide = (element: Element) => element.scrollWidth > element.clientWidth + 1;
    return {
      page:
        wide(document.scrollingElement ?? document.documentElement) ||
        [...document.querySelectorAll(".mind-scroller")].some(wide),
      lines: [...document.querySelectorAll('[data-testid="mind-editor"] p')]
        .filter(wide)
        .map((line) => line.textContent ?? ""),
    };
  });

/** A paragraph with its own tab stops, `[align, twips, leader?]`, and its runs. */
const stopped = (stops: [string, number, string?][], content: string) =>
  paragraph(content).replace(
    "<w:p>",
    `<w:p><w:pPr><w:tabs>${stops
      .map(
        ([align, at, leader]) =>
          `<w:tab w:val="${align}"${leader ? ` w:leader="${leader}"` : ""} w:pos="${at}"/>`,
      )
      .join("")}</w:tabs></w:pPr>`,
  );
const TAB = "<w:r><w:tab/></w:r>";
/** An A4 page with 1 in margins: a text width of 451.3 pt. */
const A4 =
  '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>';
const TWELVE_POINT =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>';

test("a résumé's tab stops line its columns up at the file's stops, its dates ending at the right margin's stop, and stay so as you type", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "林晓_简历.docx", resumeFile());

  const date = "2023.09 – 2026.06";
  await expect.poll(async () => (await placeOf(window, date))?.right).toBeDefined();
  // The right stop is at the text width; the subject and degree start at their left stops.
  const offStop = async (text: string, edge: "left" | "right", at: number) => {
    const place = await placeOf(window, text);
    return place ? Math.abs(place[edge] - at * place.pt) : Number.POSITIVE_INFINITY;
  };
  await expect.poll(() => offStop(date, "right", RESUME_WIDTH)).toBeLessThan(3);
  expect(await offStop("金融学", "left", 120)).toBeLessThan(3);
  expect(await offStop("硕士", "left", 210)).toBeLessThan(3);
  const subject = await placeOf(window, "金融学");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "word-tabs-resume.png") });

  // Typing at the line's start moves the text before the first stop, not the columns after it.
  const before = subject?.left ?? 0;
  await window
    .getByText("复旦大学", { exact: false })
    .first()
    .click({ position: { x: 2, y: 8 } });
  await window.keyboard.press("Home");
  await window.keyboard.type("A");
  await expect.poll(async () => (await placeOf(window, "金融学"))?.left).toBeCloseTo(before, 0);
  await expect.poll(() => offStop(date, "right", RESUME_WIDTH)).toBeLessThan(3);

  // Typed right after a tab, a letter is text in the column, not part of the tab.
  await focusSettled(window, window.getByTestId("mind-editor"));
  for (let key = 0; key < "复旦大学\t".length; key++) await window.keyboard.press("ArrowRight");
  await window.keyboard.type("B");
  await expect.poll(() => offStop("B金融学", "left", 120)).toBeLessThan(3);
  const tabs = window
    .getByTestId("mind-editor")
    .locator("p", { hasText: "B金融学" })
    .locator("[data-word-tab]");
  await expect(tabs).toHaveCount(3);
  for (const text of await tabs.allTextContents()) expect(text).toBe("\t");
  await expect.poll(() => offStop(date, "right", RESUME_WIDTH)).toBeLessThan(3);

  // Plain Mind draws a tab as any Mind does; the file's look lines the columns up again.
  await chooseLook(window, "plain");
  await expect.poll(() => offStop(date, "right", RESUME_WIDTH)).toBeGreaterThan(20);
  await chooseLook(window, "word");
  await expect.poll(() => offStop(date, "right", RESUME_WIDTH)).toBeLessThan(3);
  await app.close();
});

test("a clause's text after its number starts at the clause's hanging indent", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Supply agreement.docx", contractFile());
  const clause = window.getByTestId("mind-editor").locator("p", { hasText: "Prices are fixed" });
  await expect(clause.locator("[data-word-tab]")).toHaveCount(1);
  // The second line starts at the indent, whichever word the face wraps there; so does the first line's text, after "2.1".
  const lines = () =>
    clause.evaluate((element) => {
      const boxes: { text: string; box: DOMRect }[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let at = 0; at < (node.textContent?.length ?? 0); at++) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          boxes.push({
            text: node.textContent?.slice(at) ?? "",
            box: range.getBoundingClientRect(),
          });
        }
      }
      const left = (words: string) =>
        boxes.find((each) => each.text.startsWith(words))?.box.left ?? Number.NaN;
      const top = boxes[0]?.box.top ?? 0;
      const second = boxes.find((each) => each.box.top > top + 4 && each.text.trim())?.box.left;
      return { number: left("2.1"), text: left("Prices"), second: second ?? Number.NaN };
    });
  await expect
    .poll(async () => {
      const { text, second } = await lines();
      return Math.abs(text - second);
    })
    .toBeLessThan(2);
  const { number, text } = await lines();
  expect(text - number).toBeGreaterThan(30);
  // Home from just after the tab goes to the line's start, before the number.
  const caret = () =>
    window.evaluate(() => getSelection()?.getRangeAt(0).getClientRects()[0]?.left ?? Number.NaN);
  const top = await clause.evaluate((element) => element.getBoundingClientRect().top + 8);
  await window.mouse.click(text + 1, top);
  await expect.poll(caret).toBeCloseTo(text, -0.5);
  // A key pressed next acts where the editor's cursor is: wait until it is just after the tab.
  await expect
    .poll(() =>
      clause.evaluate((element) => {
        const root = element.closest(".ProseMirror") as (Element & { editor?: Editor }) | null;
        const state = root?.editor?.view.state;
        if (!state) return "";
        const { from } = state.selection;
        return state.doc.textBetween(from - 1, from);
      }),
    )
    .toBe("\t");
  await window.keyboard.press("Home");
  await window.keyboard.type("X");
  await expect(clause).toContainText("X2.1");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "word-tabs-contract.png") });
  await app.close();
});

test("a tab that wraps onto another line when the column narrows reaches that line's next default stop, as far apart as the file sets them", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // One line in a whole window's column; two in half of it, where the tab follows "Leeds" on the second.
  const sentence = "The supplier delivers the goods to the buyer's warehouse in Leeds";
  await importWordFile(
    app,
    window,
    files,
    "Delivery.docx",
    wordFile({
      styles:
        '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      body: paragraph(`${run(sentence)}<w:r><w:tab/></w:r>${run("Clause 4")}`),
      rels: '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
      parts: [
        {
          name: "word/settings.xml",
          data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="420"/></w:settings>`,
        },
      ],
    }),
  );
  // From the column's edge to "Clause 4", in points: a multiple of the file's 21 pt default stops.
  const offDefaultStop = async () => {
    const place = await placeOf(window, "Clause 4", 12);
    if (!place) return { at: Number.NaN, off: Number.POSITIVE_INFINITY };
    const points = place.left / place.pt;
    return { at: place.left, off: Math.abs(points - Math.round(points / 21) * 21) * place.pt };
  };
  await expect.poll(async () => (await offDefaultStop()).off).toBeLessThan(2);
  const wide = (await offDefaultStop()).at;
  // The Mind open beside itself: its column narrows where it is.
  await pointAndClick(window, window.getByTestId("split-group"));
  await expect(window.locator('[data-testid="mind-pane"]:visible')).toHaveCount(2);
  await expect.poll(async () => (await offDefaultStop()).at).not.toBe(wide);
  await expect.poll(async () => (await offDefaultStop()).off).toBeLessThan(2);
  await app.close();
});

test("two tabs in a row reach two stops, a decimal stop lines up the point, and a centred stop centres its text", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(
    app,
    window,
    files,
    "Stops.docx",
    wordFile({
      styles: TWELVE_POINT,
      sectPr: A4,
      body: [
        paragraph(`${run("Alpha")}${TAB}${TAB}${run("Bravo")}`),
        stopped([["decimal", 4320]], `${run("Total")}${TAB}${run("1234.50")}`),
        stopped([["center", 4320]], `${run("Name")}${TAB}${run("Centred")}`),
      ].join(""),
    }),
  );
  const at = async (text: string, edge: "left" | "right" | "middle") => {
    const place = await placeOf(window, text, 12);
    if (!place) return Number.NaN;
    const x = edge === "middle" ? (place.left + place.right) / 2 : place[edge];
    return x / place.pt;
  };
  // "Alpha" ends before the first default stop, so after the second tab "Bravo" starts at the second.
  await expect.poll(() => at("Bravo", "left")).toBeCloseTo(72, 0);
  await expect.poll(() => at(".50", "left")).toBeCloseTo(216, 0);
  await expect.poll(() => at("Centred", "middle")).toBeCloseTo(216, 0);
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "word-tabs-stops.png") });
  await app.close();
});

test("the caret and a selection of a tab fall where the text is drawn", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(
    app,
    window,
    files,
    "Centred.docx",
    wordFile({
      styles: TWELVE_POINT,
      sectPr: A4,
      body: stopped([["center", 4320]], `${run("Name")}${TAB}${run("Centred")}`),
    }),
  );
  const box = (text: string) =>
    window.evaluate((wanted) => {
      const editor = document.querySelector('[data-testid="mind-editor"]');
      const walker = document.createTreeWalker(editor ?? document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const { left, right, top, bottom } = range.getBoundingClientRect();
        return { left, right, top, bottom };
      }
      return null;
    }, text);
  const selection = () =>
    window.evaluate(() => {
      const range = getSelection()?.getRangeAt(0);
      const rects = range ? [...range.getClientRects()] : [];
      if (rects.length === 0) return null;
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        right: Math.max(...rects.map((rect) => rect.right)),
      };
    });
  await expect.poll(async () => (await box("Centred"))?.left ?? 0).toBeGreaterThan(200);
  const centred = await box("Centred");
  const name = await box("Name");
  if (!centred || !name) throw new Error("The line isn't drawn.");

  // Just before "Centred": the caret is at its first letter, not where the tab's character starts.
  await window.mouse.click(centred.left + 1, (centred.top + centred.bottom) / 2);
  await expect.poll(async () => (await selection())?.left ?? 0).toBeCloseTo(centred.left, -0.5);
  // ← steps over the tab to the end of "Name"; → back to "Centred".
  await window.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await selection())?.left ?? 0).toBeCloseTo(name.right, -0.5);
  await window.keyboard.press("ArrowRight");
  await expect.poll(async () => (await selection())?.left ?? 0).toBeCloseTo(centred.left, -0.5);
  // Selecting the tab highlights the whole gap it draws.
  await window.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => (await selection())?.left ?? 0).toBeCloseTo(name.right, -0.5);
  expect((await selection())?.right ?? 0).toBeCloseTo(centred.left, -0.5);
  await app.close();
});

test("leaders fill their tabs, dots, dashes and underscores alike, and neither they nor a stop past the margin make a line or the page scroll sideways", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(
    app,
    window,
    files,
    "Contents.docx",
    wordFile({
      styles: TWELVE_POINT,
      sectPr: A4,
      body: [
        stopped([["right", 9000, "dot"]], `${run("Introduction")}${TAB}${run("3")}`),
        stopped([["right", 9000, "hyphen"]], `${run("Methods")}${TAB}${run("7")}`),
        stopped([["right", 9000, "underscore"]], `${run("Signed")}${TAB}${run("Date")}`),
        stopped([["left", 7200, "dot"]], `${run("Left")}${TAB}${run("stop")}`),
        stopped([["left", 12000]], `${run("Past")}${TAB}${run("margin")}`),
      ].join(""),
    }),
  );
  const tabs = window.getByTestId("mind-editor").locator("[data-word-tab]");
  await expect(tabs).toHaveCount(5);
  await expect
    .poll(() => tabs.evaluateAll((all) => all.map((tab) => tab.dataset.leader)))
    .toEqual(["dot", "hyphen", "underscore", "dot", undefined]);
  const page = await placeOf(window, "3", 12);
  const title = await placeOf(window, "Introduction", 12);
  expect(page && title && page.left - title.right).toBeGreaterThan(100);
  // The stop past the right margin is drawn at it.
  await expect
    .poll(async () => {
      const place = await placeOf(window, "margin", 12);
      return place ? place.left / place.pt : Number.NaN;
    })
    .toBeLessThan(452);
  expect(await sideways(window)).toEqual({ page: false, lines: [] });
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "word-tabs-leader.png") });
  await app.close();
});

test("at 1,100 px a line of tab stops scrolls in its own frame, in English and Chinese, and the page never does", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1100, 720);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "林晓_简历.docx", resumeFile());
  const date = "2023.09 – 2026.06";
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    await expect.poll(async () => (await placeOf(window, date))?.overflow).toBe("auto");
    const place = await placeOf(window, date);
    expect(place && place.width > place.shown).toBe(true);
    const scrolling = await sideways(window);
    expect(scrolling.page).toBe(false);
    expect(scrolling.lines.some((line) => line.includes(date))).toBe(true);
    // Only lines with tab stops scroll, each in its own frame.
    for (const line of scrolling.lines) expect(line).toContain("\t");
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `word-tabs-1100-${language}.png`) });
    }
  }
  await app.close();
});
