import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  lastLineBoxOf,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  textBoxOf,
} from "./app";

/*
 * The undo line after Move (into a Folder with a 70-character name too), Rename and Delete of a
 * Document with a 70-character name (#1122, #1154, D304): a name past about 40 columns is cut in
 * the middle, its start and end kept; a shorter one shows whole and the line wraps, a third line
 * allowed for a narrow pane or a wide system font. The line's own words and Undo stay whole, with
 * the full names in the tooltip and in Undo's accessible name. A language switch rewrites the
 * line's words; the names keep the same cut. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(target.page());
  await mkdir(SCREENSHOTS, { recursive: true });
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
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

const WORDS = {
  en: {
    name: (tag: string) =>
      `Quarterly review of harbour dues and the wider coastal levy schedule ${tag}`,
    folder: "Harbour authority finance committee minutes and the dues archives 2026",
    moved: { start: "Moved “", between: "” to ", end: "" },
    renamed: { start: "Renamed to “", between: "", end: "”" },
    deleted: { start: "Moved “", between: "", end: "” to Recently deleted" },
  },
  "zh-CN": {
    name: (tag: string) => `${"信贷委员会合同审阅笔记".repeat(7).slice(0, 69)}${tag}`,
    folder: "港口管理局财务委员会纪要与费用审阅档案".repeat(5).slice(0, 70),
    moved: { start: "已将“", between: "”移动到“", end: "”" },
    renamed: { start: "已重命名为“", between: "", end: "”" },
    deleted: { start: "已将“", between: "", end: "”移到回收站" },
  },
} as const;

/** The words of `line` that lie outside the sidebar. */
function outsideSidebar(line: Locator): Promise<string[]> {
  return line.evaluate((element) => {
    const edge = document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect();
    if (!edge) throw new Error("The sidebar isn't showing.");
    const outside: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const inside =
          rect.left >= edge.left - 0.5 &&
          rect.right <= edge.right + 0.5 &&
          rect.top >= edge.top - 0.5 &&
          rect.bottom <= edge.bottom + 0.5;
        if (!inside) outside.push(node.textContent ?? "");
      }
    }
    return outside;
  });
}

async function chooseFromRow(window: Page, command: string): Promise<void> {
  const row = window.getByTestId("library-document");
  await row.hover();
  await pointAndClick(window, row.getByTestId("document-file-menu"));
  await pointAndClick(
    window,
    window.getByTestId("document-file-actions").filter({ visible: true }).getByTestId(command),
  );
}

async function moveRowTo(window: Page, folder: string): Promise<void> {
  await chooseFromRow(window, "document.moveTo");
  const picker = window.getByTestId("move-to-picker");
  await expect(picker.getByTestId("move-to-search")).toBeFocused();
  await pointAndClick(window, picker.getByTestId("move-to-option").filter({ hasText: folder }));
  await expect(picker).toBeHidden();
}

async function boxOf(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

/** The line says its own words whole and its names cut in the middle past the limit, with Undo level with its last words. */
async function expectWholeLine(
  window: Page,
  names: readonly string[],
  words: { start: string; between: string; end: string },
): Promise<void> {
  const line = window.getByTestId("undo-line");
  const message = line.getByTestId("undo-message");
  const undo = line.getByTestId("undo-action");
  const sidebar = window.getByTestId("sidebar");
  await expect(message).toHaveText(new RegExp(`^${words.start}`));
  const said = (await message.textContent()) ?? "";

  expect(said.startsWith(words.start)).toBe(true);
  expect(said.endsWith(words.end)).toBe(true);
  expect(said.includes(words.between)).toBe(true);
  expect(said.split("…").length - 1).toBeGreaterThanOrEqual(names.length);
  for (const name of names) {
    const characters = [...name];
    expect(said).toContain(characters.slice(0, 4).join(""));
    expect(said).toContain(characters.slice(-4).join(""));
    expect(said).not.toContain(name);
  }

  // The tooltip and Undo's accessible name have the whole names.
  const tooltip = (await message.getAttribute("title")) ?? "";
  const accessible = (await undo.getAttribute("aria-label")) ?? "";
  for (const name of names) {
    expect(tooltip).toContain(name);
    expect(accessible).toContain(name);
  }

  // The line wraps as a narrow pane or a wide system font needs (a third line is allowed, D304);
  // every word of it stays inside the sidebar and the line.
  const [lineBox, messageBox, undoBox, sidebarBox] = await Promise.all([
    boxOf(line),
    textBoxOf(message),
    textBoxOf(undo),
    boxOf(sidebar),
  ]);
  expect(sidebarBox.width).toBeCloseTo(248, 0);
  expect(await outsideSidebar(message)).toEqual([]);
  expect(await outsideSidebar(undo)).toEqual([]);
  for (const box of [messageBox, undoBox]) {
    expect(box.x).toBeGreaterThanOrEqual(lineBox.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(lineBox.x + lineBox.width + 0.5);
    expect(box.y).toBeGreaterThanOrEqual(lineBox.y - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(lineBox.y + lineBox.height + 0.5);
  }
  // "· Undo" follows the message's last words on the line they end: never alone at the end of a second line.
  const last = await lastLineBoxOf(message);
  expect(last.width).toBeGreaterThan(0);
  expect(undoBox.x).toBeGreaterThanOrEqual(last.x + last.width - 0.5);
  expect(Math.abs(undoBox.y + undoBox.height / 2 - (last.y + last.height / 2))).toBeLessThan(
    last.height,
  );
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: after Move, Rename and Delete of a Document with a 70-character name, the undo line keeps its words and Undo whole, cuts the names in the middle and wraps as it needs, at 900 and 1,440 px`, async () => {
    test.setTimeout(90_000);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 760);
      await setLanguage(window, language);
      const words = WORDS[language];
      expect([...words.folder]).toHaveLength(70);
      await (await coreOf(window)).evaluate(
        (core, name) => core.createLibraryGroup({ name, description: "" }),
        words.folder,
      );

      for (const [index, width] of [900, 1440].entries()) {
        await setWindowSize(app, window, width, 760);
        const first = words.name(index === 0 ? "A" : "C");
        const second = words.name(index === 0 ? "B" : "D");
        expect([...first]).toHaveLength(70);
        await writeFile(join(sources, `${first}.txt`), `${first} notes.\n`);
        await addDocuments(window, [join(sources, `${first}.txt`)]);
        await window.getByTestId("open-library").click();
        const row = window.getByTestId("library-document");
        const label = `${language}-${width}`;

        await moveRowTo(window, words.folder);
        await expect(window.getByTestId("undo-message")).toContainText(words.moved.start);
        await screenshot(window.getByTestId("sidebar"), `${label}-move`);
        await expectWholeLine(window, [first, words.folder], words.moved);

        await chooseFromRow(window, "document.rename");
        const field = row.getByRole("textbox");
        await expect(field).toBeFocused();
        await field.fill(second);
        await window.keyboard.press("Enter");
        await expect(window.getByTestId("undo-message")).toContainText(words.renamed.start);
        await screenshot(window.getByTestId("sidebar"), `${label}-rename`);
        await expectWholeLine(window, [second], words.renamed);

        await chooseFromRow(window, "document.delete");
        await expect(row).toHaveCount(0);
        await expect(window.getByTestId("undo-message")).toContainText(words.deleted.end);
        await screenshot(window.getByTestId("sidebar"), `${label}-delete`);
        await expectWholeLine(window, [second], words.deleted);
      }
    } finally {
      await app.close();
    }
  });
}

/** The line keeps all of it inside the sidebar, however many lines it wraps to. */
async function expectFits(line: Locator): Promise<void> {
  const message = line.getByTestId("undo-message");
  expect(await outsideSidebar(message)).toEqual([]);
  expect(await outsideSidebar(line.getByTestId("undo-action"))).toEqual([]);
}

/*
 * The line's words follow its language; a name keeps the cut of its columns, whatever the words
 * around it.
 */
const SWITCHES = [
  { from: "en", to: "zh-CN", length: 69 },
  { from: "zh-CN", to: "en", length: 30 },
] as const;

const PHRASE = "Quarterly review of harbour dues and the wider coastal levy schedule";

test("a language switch while the undo line shows says the line in the new language, with the same name cut, at 900 and 1,440 px", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const line = window.getByTestId("undo-line");
    const message = line.getByTestId("undo-message");

    for (const [widthIndex, width] of [900, 1440].entries()) {
      await setWindowSize(app, window, width, 760);
      for (const [index, { from, to, length }] of SWITCHES.entries()) {
        const run = widthIndex * SWITCHES.length + index;
        const name = `${PHRASE.slice(0, length - 1)}${"ABCD"[run]}`;
        const folder = `${PHRASE.slice(0, length - 1)}${"WXYZ"[run]}`;
        await setLanguage(window, from);
        await (await coreOf(window)).evaluate(
          (core, group) => core.createLibraryGroup({ name: group, description: "" }),
          folder,
        );
        await writeFile(join(sources, `${name}.txt`), `${name} notes.\n`);
        await addDocuments(window, [join(sources, `${name}.txt`)]);
        await window.getByTestId("open-library").click();
        const inFolder = window
          .getByTestId("library-section")
          .filter({ hasText: folder })
          .getByTestId("library-document");

        await moveRowTo(window, folder);
        await expect(inFolder).toHaveCount(1);
        await expect(message).toContainText(WORDS[from].moved.start);
        await setLanguage(window, to);
        await expect(message).toContainText(WORDS[to].moved.start);
        const switched = await message.textContent();
        await expectFits(line);

        await pointAndClick(window, line.getByTestId("undo-action"));
        await expect(inFolder).toHaveCount(0);
        await moveRowTo(window, folder);
        await expect(message).toContainText(WORDS[to].moved.start);
        await expectFits(line);
        expect(await message.textContent()).toBe(switched);

        await chooseFromRow(window, "document.delete");
        await expect(window.getByTestId("library-document")).toHaveCount(0);
      }
    }
  } finally {
    await app.close();
  }
});
