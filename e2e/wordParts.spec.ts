import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { unzip } from "../tests/helpers/docx";
import { note, noteMark, paragraph, run, tracked, wordFile } from "../tests/helpers/word";
import {
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  importWordFromMenu,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A Word file's footnotes, endnotes and breaks are the Note's own (#746): a
 * note is edited where the Note shows its footnotes and in the popover at
 * its marker, numbered as the file numbers them, and written back into the
 * file; page and section breaks show as a line; a page break deletes like a
 * Block and comes back with ⌘Z, and ⌘K, the selection menu and ⌘↵ put one
 * in any Note, but ⌘↵ in a waiting change accepts it. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

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

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await target.screenshot({ path: join(folder, `${name}.png`) });
}

/** The only Mind, as Export would write it into its Word file. */
const exportDocx = async (window: Page) =>
  unzip(
    new Uint8Array(
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const [mind] = await core.listMinds();
        if (!mind) throw new Error("There is no Mind.");
        return Array.from((await core.exportMind(mind.id, { format: "docx" })).data);
      }),
    ),
  );

const noteXml = (xml: string, kind: "footnote" | "endnote", id: number) =>
  new RegExp(`<w:${kind} w:id="${id}">[\\s\\S]*?</w:${kind}>`).exec(xml)?.[0] ?? null;

function brief(): Buffer {
  return wordFile({
    body: [
      paragraph("Lease brief", { style: "Heading1" }),
      paragraph(`${run("The lease ends in 2030.")}${noteMark("footnote", 1)}`),
      paragraph(`${run("Rent is reviewed every year.")}${noteMark("footnote", 2)}`),
      paragraph(`${run("The fittings are listed in the schedule.")}${noteMark("endnote", 1)}`),
    ].join(""),
    footnotes: [
      note("footnote", 1, [`${run("See ")}${run("Hale v Nair", { i: true })}${run(", 2019.")}`]),
      note("footnote", 2, ["Clause 4.2."]),
    ].join(""),
    endnotes: note("endnote", 1, ["Schedule 3 lists the fittings."]),
    settings: '<w:endnotePr><w:numFmt w:val="lowerRoman"/></w:endnotePr>',
  });
}

async function importFile(
  app: Parameters<typeof interceptOpenDialog>[0],
  window: Page,
  path: string,
) {
  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();
}

test("a Word file's footnotes and endnotes are edited where the Note shows them, numbered as the file numbers them, and written back into the file", async () => {
  const bytes = brief();
  const path = join(files, "Lease brief.docx");
  await writeFile(path, bytes);
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importFile(app, window, path);

  const editor = window.getByTestId("mind-editor");
  const markers = editor.getByTestId("footnote-marker");
  await expect(markers).toHaveText(["1", "2", "i"]);
  await expect(markers.nth(2)).toHaveAttribute(
    "aria-label",
    "Endnote i: Schedule 3 lists the fittings.",
  );
  const area = window.getByTestId("footnote-area");
  await expect(area.locator(".footnote-area-title")).toHaveText(["Footnotes", "Endnotes"]);
  const footnotes = area.getByTestId("footnote-row").getByTestId("footnote-text");
  await expect(footnotes).toHaveText(["See Hale v Nair, 2019.", "Clause 4.2."]);
  await expect(area.getByTestId("endnote-row").getByTestId("footnote-text")).toHaveText(
    "Schedule 3 lists the fittings.",
  );

  // Written in place, in the area, as any footnote of the Note's is.
  await clickEndOf(window, footnotes.first());
  await window.keyboard.type(" Affirmed in 2021.");
  await expect(footnotes.first()).toHaveText("See Hale v Nair, 2019. Affirmed in 2021.");
  await expect(markers.first()).toHaveAttribute(
    "aria-label",
    "Footnote 1: See Hale v Nair, 2019. Affirmed in 2021.",
  );

  // And in the popover at its marker: an endnote is named as one.
  await pointAndClick(window, markers.nth(2));
  const popover = window.getByTestId("footnote-popover");
  await expect(popover).toHaveAttribute("aria-label", "Text of endnote i");
  await window.keyboard.press("End");
  await window.keyboard.type(" and the keys");
  await expect(popover.getByTestId("footnote-text")).toHaveText(
    "Schedule 3 lists the fittings. and the keys",
  );
  await motionSettled(window);
  await screenshot(window, "word-footnote-editing-en");
  await window.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // The file takes each edit in its own note, under its own id; what wasn't touched is as it was.
  const before = unzip(bytes);
  await expect
    .poll(async () =>
      noteXml((await exportDocx(window)).get("word/endnotes.xml")?.toString() ?? "", "endnote", 1),
    )
    .toContain("and the keys");
  const after = await exportDocx(window);
  expect(
    after.get("word/document.xml")?.equals(before.get("word/document.xml") ?? Buffer.alloc(0)),
  ).toBe(true);
  const footnotesXml = after.get("word/footnotes.xml")?.toString() ?? "";
  expect(noteXml(footnotesXml, "footnote", 1)).toContain("Affirmed in 2021.");
  expect(noteXml(footnotesXml, "footnote", 2)).toBe(
    noteXml(before.get("word/footnotes.xml")?.toString() ?? "", "footnote", 2),
  );

  // In Chinese.
  await setLanguage(window, "zh-CN");
  await expect(area.locator(".footnote-area-title")).toHaveText(["脚注", "尾注"]);
  await pointAndClick(window, markers.nth(2));
  await expect(popover).toHaveAttribute("aria-label", "尾注 i 的内容");
  await motionSettled(window);
  await screenshot(window, "word-footnote-editing-zh");
  await app.close();
});

test("page and section breaks show as a line; a page break deletes like a Block and comes back with ⌘Z; ⌘K and ⌘↵ put one in, but ⌘↵ in a waiting change accepts it", async () => {
  const path = join(files, "Two parts.docx");
  await writeFile(
    path,
    wordFile({
      body: [
        paragraph("Part one ends here.", {
          sectPr: '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>',
        }),
        '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
        paragraph(`${run("Rent is ")}${tracked("ins", 3, "Priya Nair", "due monthly")}${run(".")}`),
        paragraph("Part two."),
      ].join(""),
    }),
  );
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importFile(app, window, path);

  const editor = window.getByTestId("mind-editor");
  const pageBreaks = editor.getByTestId("page-break");
  const sectionBreak = editor.getByTestId("section-break");
  await expect(pageBreaks).toHaveCount(1);
  await expect(pageBreaks).toHaveAttribute("aria-label", "Page break");
  await expect(sectionBreak).toHaveAttribute("aria-label", "Section break");
  const shown = (line: Locator) =>
    line
      .locator(".page-break-label")
      .evaluate((label) => getComputedStyle(label, "::before").content);
  expect(await shown(pageBreaks.first())).toBe('"Page break"');
  // A line across the text, as wide as the paragraphs.
  const lineBox = await pageBreaks.first().boundingBox();
  const textBox = await editor.locator("p", { hasText: "Part two." }).boundingBox();
  expect(lineBox && textBox && Math.abs(lineBox.width - textBox.width) < 2).toBe(true);
  // Its name isn't text: the paragraph it ends reads as it does.
  await expect(editor.locator("p").first()).toHaveText("Part one ends here.");
  await motionSettled(window);
  await screenshot(window, "word-page-break-en");

  // Selected by a click and deleted like a Block, its line too; ⌘Z brings it back.
  const lines = await editor.locator("p").count();
  await pointAndClick(window, pageBreaks.first());
  await expect(pageBreaks.first()).toHaveClass(/ProseMirror-selectednode/);
  await window.keyboard.press("Backspace");
  await expect(pageBreaks).toHaveCount(0);
  await expect(editor.locator("p")).toHaveCount(lines - 1);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(pageBreaks).toHaveCount(1);
  await expect(editor.locator("p")).toHaveCount(lines);

  // ⌘K puts one where the cursor is.
  await clickEndOf(window, editor.locator("p", { hasText: "Part two." }));
  await runCommand(window, "pageBreak.insert", "Insert Page Break");
  await expect(pageBreaks).toHaveCount(2);

  // ⌘↵ with the cursor in someone's waiting change accepts it, as its bar says, and adds no break.
  await pointAndClick(window, editor.locator("ins.proposal-theirs", { hasText: "due monthly" }));
  await expect(window.getByTestId("proposal-spoken")).toContainText("Priya Nair’s change");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(editor.locator("ins.proposal-theirs")).toHaveCount(0);
  await expect(editor.locator("p", { hasText: "Rent is" })).toHaveText("Rent is due monthly.");
  await expect(pageBreaks).toHaveCount(2);

  // Anywhere else, ⌘↵ puts a page break in.
  await clickEndOf(window, editor.locator("p", { hasText: "Rent is" }));
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(pageBreaks).toHaveCount(3);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(pageBreaks).toHaveCount(2);

  // In Chinese.
  await setLanguage(window, "zh-CN");
  await expect(pageBreaks.first()).toHaveAttribute("aria-label", "分页符");
  expect(await shown(pageBreaks.first())).toBe('"分页符"');
  await expect(sectionBreak).toHaveAttribute("aria-label", "分节符");
  await motionSettled(window);
  await screenshot(window, "word-page-break-zh");
  await app.close();
});

test("⌘↵ puts a page break in a Note of the User's own, and the selection menu does too", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await newMind(window);
  await window.keyboard.type("Chapter one.");
  await window.keyboard.press("ControlOrMeta+Enter");
  await window.keyboard.type("Chapter two.");
  const editor = window.getByTestId("mind-editor");
  // As Word's Ctrl+Enter: the break ends the line, and the next page's text is a paragraph of its own.
  await expect(editor.getByTestId("page-break")).toHaveCount(1);
  await expect(editor.locator("p")).toHaveText(["Chapter one.", "Chapter two."]);

  // Selected text starts the next page: the break goes before it.
  for (let left = "Chapter two.".length; left > 0; left--) {
    await window.keyboard.press("Shift+ArrowLeft");
  }
  await expect.poll(() => window.evaluate(() => getSelection()?.toString())).toBe("Chapter two.");
  const menu = window.getByTestId("selection-menu");
  await pointAndClick(window, menu.getByTestId("format-page-break"));
  await expect(editor.getByTestId("page-break")).toHaveCount(2);
  await expect(editor.locator("p")).toHaveText(["Chapter one.", "", "Chapter two."]);
  await app.close();
});
