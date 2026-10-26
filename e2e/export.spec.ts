import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { footnotesOf, paragraphsOf, part, unzip } from "../tests/helpers/docx";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  closeSettings,
  coreOf,
  createDataFolder,
  DEFAULT_FOLDER_ZH,
  dismissChatSetup,
  editFolderInLibrary,
  exportFromMenu,
  frontMindName,
  interceptOpenDialog,
  interceptOpenPath,
  interceptShowItemInFolder,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openDocumentMenu,
  openSettings,
  pathsOpened,
  pathsShown,
  pointAndClick,
  pointAt,
  removeDataFolder,
  savedLine,
  setWindowSize,
  showSourceLocations,
  useLocalChatModel,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of the questions and Settings. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await target.screenshot({ path: join(folder, `${name}.png`) });
}

/** The core's bridge, as the window has it. */
const bridge = (window: Page) => ({
  link: (path: string) =>
    window.evaluate(
      (folder) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(folder),
      path,
    ),
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
});

/** Spring tides are on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
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

test("Export opens a short menu: Word and PDF, the last one used first with ⇧⌘E, the rest under More formats, which moving to another item closes, by mouse and keyboard, in Chinese too", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await newMind(window);
  await nameMind(window, "Tides");
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Spring tides come twice a month.");
  await useOutputLocation(window, sources);
  const done = window.getByTestId("export-result").getByTestId("export-done");
  const menu = window.getByTestId("export-menu");
  const items = menu.getByRole("menuitem");
  const shortcut = /(⇧⌘E|Ctrl\+Shift\+E)$/;

  await pointAndClick(window, window.getByTestId("export-mind"));
  await expect(items).toHaveText([
    /^Word \(\.docx\)/,
    "Not checked since your last edit · Check first",
    "PDF",
    "More formats",
    "Citation styleNumbered (Document and Location)",
    "Export options…",
  ]);
  await expect(items.first()).toHaveText(shortcut);
  await motionSettled(window);
  // Under the button, its right edge by the button's, so it stays over the Mind.
  const button = await window.getByTestId("export-mind").boundingBox();
  const opened = await menu.boundingBox();
  expect(
    Math.abs((opened?.x ?? 0) + (opened?.width ?? 0) - (button?.x ?? 0) - (button?.width ?? 0)),
  ).toBeLessThan(2);
  expect(opened?.y ?? 0).toBeGreaterThan(button?.y ?? 0);
  await screenshot(window, "export-menu-en");
  await pointAndClick(window, menu.getByTestId("export-as-docx"));
  await expect(done).toHaveText(savedLine("Tides.docx", sources));

  await exportFromMenu(window, "pdf");
  await expect(done).toHaveText(savedLine("Tides.pdf", sources));
  await pointAndClick(window, window.getByTestId("export-mind"));
  await expect(items).toHaveText([
    new RegExp(`^PDF${shortcut.source}`),
    "Word (.docx)",
    "Not checked since your last edit · Check first",
    "More formats",
    /^Citation style/,
    "Export options…",
  ]);

  const moreItem = menu.getByTestId("export-more");
  for (let step = 0; step < 3; step++) await window.keyboard.press("ArrowDown");
  await expect(moreItem).toBeFocused();
  await window.keyboard.press("ArrowRight");
  const more = window.getByTestId("export-more-menu");
  await expect(more.getByRole("menuitem")).toHaveText([
    "Source pack (PDF)",
    "HTML",
    "Web page to share (.html)",
    "Markdown (.md)",
  ]);
  await expect(more.getByTestId("export-as-source-pack")).toBeFocused();
  await motionSettled(window);
  await screenshot(window, "export-more-en");
  await window.keyboard.press("End");
  await expect(more.getByTestId("export-as-markdown")).toBeFocused();
  await window.keyboard.press("Home");
  await expect(more.getByTestId("export-as-source-pack")).toBeFocused();
  await window.keyboard.press("ArrowLeft");
  await expect(more).toBeHidden();
  await expect(moreItem).toBeFocused();

  await pointAt(window, moreItem);
  await expect(more).toBeVisible();
  await pointAt(window, menu.getByTestId("export-as-pdf"));
  await expect(more).toBeHidden();
  await pointAt(window, moreItem);
  await expect(more).toBeVisible();
  await window.keyboard.press("ArrowUp");
  await expect(more).toBeHidden();
  await expect(menu.getByTestId("export-note-state")).toBeFocused();
  await expect(menu).toBeVisible();

  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("ArrowRight");
  await window.keyboard.press("End");
  await window.keyboard.press("Enter");
  await expect(done).toHaveText(savedLine("Tides.md", sources));

  await bridge(window).language("zh-CN");
  await pointAndClick(window, window.getByTestId("export-mind"));
  await expect(items).toHaveText([
    /^Markdown（\.md）/,
    "Word（.docx）",
    "上次编辑后未核对 · 先核对",
    "PDF",
    "更多格式",
    /^引用格式/,
    "导出选项…",
  ]);
  await motionSettled(window);
  await screenshot(window, "export-menu-zh");
  // The pointer opens More formats as it comes onto it; the click that follows keeps it open.
  await pointAndClick(window, menu.getByTestId("export-more"));
  await motionSettled(window);
  await expect(more).toBeVisible();
  await expect(menu.getByTestId("export-more")).toHaveAttribute("aria-expanded", "true");
  await window.keyboard.press("Escape");
  await expect(more).toBeHidden();
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("Export saves a .docx from its menu: the first goes to Documents › IncarnaMind without asking and says so, with Open and Change folder…; the Mind says a quote wasn't found, and the next goes there under a free name", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);

  // A Note, then an Answer that misquotes its Document, added from the assistant.
  await newMind(window);
  await nameMind(window, "Tides");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Notes on tides.");
  await window.keyboard.press("Enter");
  const answer = await askInAssistant(window, "When do spring tides happen? Misquote it.");
  await expect(answer.getByTestId("citation")).toHaveAttribute("data-check", "not-found");
  await addToNote(window, answer);
  await expect(editor.getByTestId("citation")).toHaveAttribute("data-check", "not-found");

  // Export's first item is the last format, Word to begin with. The first save goes to IncarnaMind
  // in Documents (the test build's own Documents folder) without asking, and the line says so.
  await interceptShowItemInFolder(app);
  await interceptOpenPath(app);
  const exportButton = window.getByTestId("export-mind");
  await expect(exportButton).toHaveAttribute("data-format", "docx");
  await exportFromMenu(window);
  const result = window.getByTestId("export-result");
  const ask = window.getByTestId("file-write-dialog");
  const done = result.getByTestId("export-done");
  await expect(done).toHaveText("Saved “Tides.docx” in Documents › IncarnaMind");
  await expect(done).toHaveAttribute("role", "status");
  await expect(ask).toBeHidden();
  await expect(result.getByTestId("export-unverified")).toHaveText(
    "1 quote not found, marked unverified · Show",
  );
  await expect(result.getByTestId("export-show")).toHaveText(/^Show in (Finder|folder)$/);
  await screenshot(result, "export-first-save-en");
  await screenshot(window, "export-first-save-window-en");
  const target = join(await realpath(join(dataDir, "Documents", "IncarnaMind")), "Tides.docx");
  await result.getByTestId("export-open").click();
  await expect.poll(() => pathsOpened(app)).toEqual([target]);

  // The file is there: the Notes, the one added from the Answer too, its Citation a footnote.
  const files = unzip(await readFile(target));
  const paragraphs = paragraphsOf(part(files, "word/document.xml")).map((each) => each.text);
  expect(paragraphs).toContain("Notes on tides.");
  expect(paragraphs).toContain("Your Documents answer this[1].");
  expect(paragraphs.join("\n")).not.toContain("When do spring tides happen?");
  expect(footnotesOf(part(files, "word/footnotes.xml"))).toEqual({
    "1": "Tides, p. 2 [unverified]",
  });

  // Change folder… opens Settings › General at the Output location, which shows that folder.
  await result.getByTestId("export-change-folder").click();
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "general");
  const output = settings.getByTestId("output-location-settings");
  await expect(output).toBeInViewport();
  await expect(output.getByTestId("output-location-path")).toHaveText(dirname(target));
  await expect(output.getByTestId("output-location-change")).toBeFocused();
  await screenshot(window, "settings-output-location-from-export-en");
  await closeSettings(window);

  // The next export doesn't ask either, names the same folder, and leaves the first file as it was.
  const first = await readFile(target);
  await exportFromMenu(window);
  await expect(done).toHaveText("Saved “Tides 2.docx” in Documents › IncarnaMind");
  await expect(ask).toBeHidden();
  await expect(result.getByTestId("export-change-folder")).toHaveCount(0);
  await result.getByTestId("export-show").click();
  await expect.poll(() => pathsShown(app)).toEqual([join(dirname(target), "Tides 2.docx")]);
  expect((await readFile(target)).equals(first)).toBe(true);
  await app.close();
});

test("the Saved line names the folder, goes by itself after ten seconds unless the pointer is on it, and doesn't come back when the Mind is opened again", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1100, 760);
  await newMind(window);
  await nameMind(window, "Tides");
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Spring tides come twice a month.");
  await useOutputLocation(window, sources);
  await window.clock.install();
  const result = window.getByTestId("export-result");
  const done = result.getByTestId("export-done");

  await exportFromMenu(window);
  await expect(done).toHaveText(savedLine("Tides.docx", sources));
  await expect(result.getByTestId("export-open")).toBeVisible();
  await expect(result.getByTestId("export-show")).toBeVisible();

  // The pointer on the line keeps it; ten seconds after it leaves, the line goes.
  await pointAt(window, result);
  await window.clock.fastForward("00:30");
  await expect(result).toBeVisible();
  await window.mouse.move(2, 2);
  await window.clock.fastForward("00:09");
  await expect(result).toBeVisible();
  await window.clock.fastForward("00:02");
  await expect(result).toHaveCount(0);

  // Another export, then another Mind for a minute: the line is not there when this one is opened again.
  await exportFromMenu(window);
  await expect(done).toHaveText(savedLine("Tides 2.docx", sources));
  await newMind(window);
  await window.clock.fastForward("01:00");
  await window.getByRole("tab", { name: "Tides" }).click();
  await expect(frontMindName(window)).toHaveText("Tides");
  await expect(result).toHaveCount(0);
  await app.close();
});

test("in Chinese, at the narrowest window, the first export says it went to 文稿 (文档 off macOS) › IncarnaMind, its long name cut in the middle; if that folder can't be made, the save asks where instead, in plain words, and Esc saves nothing", async () => {
  // A file where the folder would be made.
  await mkdir(join(dataDir, "Documents"), { recursive: true });
  const blocked = join(dataDir, "Documents", "IncarnaMind");
  await writeFile(blocked, "Not a folder.");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const title =
    "Contract review notes for the fourth-quarter credit committee 信贷委员会合同审阅笔记";
  await nameMind(window, title);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Spring tides come twice a month.");

  const result = window.getByTestId("export-result");
  const ask = window.getByTestId("file-write-dialog");
  await exportFromMenu(window);
  await expect(ask).toHaveAttribute("data-kind", "output-location");
  await expect(ask.getByRole("heading")).toHaveText("Where should new files go?");
  await expect(ask.getByTestId("file-write-unusable")).toHaveText(
    `Couldn’t save “${title}.docx” in Documents › IncarnaMind: IncarnaMind couldn’t make that folder.`,
  );
  await expect(ask.getByRole("button")).toHaveText(["Cancel", "Choose another folder…"]);
  await screenshot(ask, "file-write-output-location-en");
  await window.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  await expect(result).toHaveCount(0);

  await bridge(window).language("zh-CN");
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await exportFromMenu(window);
  await expect(ask.getByRole("heading")).toHaveText("新文件保存到哪里？");
  await expect(ask.getByTestId("file-write-unusable")).toHaveText(
    `无法把“${title}.docx”保存到“${DEFAULT_FOLDER_ZH}”：IncarnaMind 无法创建这个文件夹。`,
  );
  await screenshot(ask, "file-write-output-location-zh");
  await ask.getByRole("button", { name: "取消" }).click();
  await expect(ask).toBeHidden();
  await expect(result).toHaveCount(0);

  // With the file out of the way, the save goes there and says so, the name cut in the middle
  // to fit the line, and whole in the line's accessible name.
  await rm(blocked);
  await exportFromMenu(window);
  const done = result.getByTestId("export-done");
  await expect(done).toHaveText(/^已保存“Contract review[^…]*…[^…]*笔记\.docx”到“/);
  await expect(done).toHaveAccessibleName(`已保存“${title}.docx”到“${DEFAULT_FOLDER_ZH}”`);
  await expect(result.getByTestId("export-open")).toHaveText("打开");
  await expect(result.getByTestId("export-change-folder")).toHaveText("更改文件夹…");
  await expect(ask).toBeHidden();
  const [line, saved, windowWidth] = await Promise.all([
    result.boundingBox(),
    done.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  if (!line || !saved) throw new Error("The line isn't laid out.");
  expect(saved.x + saved.width).toBeLessThanOrEqual(line.x + line.width);
  expect(line.x + line.width).toBeLessThanOrEqual(windowWidth);
  expect(await done.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await screenshot(result, "export-first-save-zh");
  await screenshot(window, "export-first-save-window-zh-narrow");
  await result.getByTestId("export-change-folder").click();
  await expect(window.getByTestId("output-location-settings")).toBeInViewport();
  await app.close();
});

test("maths exports to .docx as Word equations, which a Word viewer shows as equations", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Gravity");
  const editor = window.getByTestId("mind-editor");
  await editor.click();

  // A formula on its own line, then one in a sentence, from the slash menu.
  await window.keyboard.type("/math");
  await window.keyboard.press("Enter");
  await window.getByTestId("math-editor").fill("F = G\\frac{m_1 m_2}{r^2}");
  await window.getByTestId("math-editor").press("Enter");
  await expect(editor.locator('[data-type="block-math"] .katex')).toBeVisible();
  // The cursor comes back after the formula a frame later: type once the editor has it.
  await expect(editor).toBeFocused();
  await window.keyboard.press("Enter");
  await window.keyboard.type("The tide-raising pull falls off as /inline");
  await expect(window.getByTestId("slash-item-inline-math")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await window.keyboard.press("Enter");
  await window.getByTestId("math-editor").fill("\\frac{1}{r^3}");
  await window.getByTestId("math-editor").press("Enter");
  await expect(editor.locator('[data-type="inline-math"] .katex')).toBeVisible();

  const target = join(sources, "Gravity.docx");
  await useOutputLocation(window, sources);
  await exportFromMenu(window);
  await expect(window.getByTestId("export-done")).toHaveText(savedLine("Gravity.docx", sources));

  // Word equations, not "$…$" text: one on its own line, one in the sentence.
  const document = part(unzip(await readFile(target)), "word/document.xml");
  expect(document.match(/<m:oMathPara>/g)).toHaveLength(1);
  expect(document.match(/<m:oMath>/g)).toHaveLength(2);
  expect(document).not.toContain("$");
  expect(paragraphsOf(document).map((each) => each.text)).toContain(
    "The tide-raising pull falls off as ",
  );

  // Opened as a Document, the Word viewer draws them as equations.
  await addDocuments(window, [target]);
  await window.getByTestId("open-document").click();
  const viewer = window.getByTestId("viewer");
  const docx = viewer.getByTestId("viewer-docx");
  await expect(docx).toHaveAttribute("data-rendered", "yes");
  const equations = docx.locator("math");
  await expect(equations).toHaveCount(2);
  await expect(equations.first().locator("mfrac")).toHaveCount(1);
  await expect(equations.nth(1).locator("mfrac")).toHaveCount(1);
  if (process.env.INCARNAMIND_SCREENSHOTS) {
    await viewer.screenshot({
      path: join(process.env.INCARNAMIND_SCREENSHOTS, "export-docx-equations.png"),
    });
  }
  await app.close();
});

test("saving inside a Linked folder asks once; Settings › General shows where new files go and the answer, and turning it off makes the export say so, with Allow", async () => {
  const papers = join(sources, "Papers");
  await mkdir(join(papers, "Exports"), { recursive: true });
  await writeFile(join(papers, "Lease.txt"), "Rent is due monthly.");
  const original = await readFile(join(papers, "Lease.txt"));
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await bridge(window).link(papers);
  await newMind(window);
  await nameMind(window, "Tides");
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Spring tides come twice a month.");

  // Settings › General: the default until a folder is chosen; Change… picks one inside the
  // Linked folder.
  const settings = await openSettings(window, "general");
  const output = settings.getByTestId("output-location-settings");
  await expect(output.getByTestId("output-location-path")).toHaveText(
    join(dataDir, "Documents", "IncarnaMind"),
  );
  await expect(output.getByTestId("output-location-default")).toHaveText(
    "Default: new files go here.",
  );
  await interceptOpenDialog(app, join(papers, "Exports"));
  await output.getByTestId("output-location-change").click();
  await expect(output.getByTestId("output-location-path")).toHaveText(
    await realpath(join(papers, "Exports")),
  );
  await expect(output.getByTestId("output-location-default")).toHaveCount(0);
  await expect(output.getByTestId("linked-folder-writing")).toHaveCount(0);
  await closeSettings(window);

  // The first save there asks about the Linked folder; the next doesn't.
  const result = window.getByTestId("export-result");
  const ask = window.getByTestId("file-write-dialog");
  const exportOnce = () => exportFromMenu(window);
  await exportOnce();
  await expect(ask).toHaveAttribute("data-kind", "linked-folder");
  await expect(ask.getByRole("heading")).toHaveText("Add files to “Papers”?");
  await screenshot(ask, "file-write-linked-folder-en");
  await ask.getByTestId("file-write-allow").click();
  await expect(result.getByTestId("export-done")).toHaveText(
    savedLine("Tides.docx", join(papers, "Exports")),
  );
  await exportOnce();
  await expect(result.getByTestId("export-done")).toHaveText(
    savedLine("Tides 2.docx", join(papers, "Exports")),
  );
  await expect(ask).toBeHidden();

  // Settings shows the answer, and turns it off.
  await openSettings(window, "general");
  const row = output.getByTestId("linked-folder-writing-row");
  await expect(row).toContainText("Papers");
  const allowed = row.getByRole("switch", { name: "Allow new files in Papers" });
  await expect(allowed).toBeChecked();
  await screenshot(settings, "settings-general-output-location-en");
  await allowed.click();
  await expect(allowed).not.toBeChecked();
  await closeSettings(window);

  // The export says it isn't allowed, without asking; its Allow saves it.
  await exportOnce();
  const problem = result.getByTestId("export-problem");
  await expect(problem).toHaveText(
    "Couldn’t save: you haven’t allowed new files in “Papers”, a Linked folder · Allow",
  );
  await expect(ask).toBeHidden();
  await screenshot(result, "export-not-allowed-en");
  await problem.getByTestId("export-allow").click();
  await expect(result.getByTestId("export-done")).toHaveText(
    savedLine("Tides 3.docx", join(papers, "Exports")),
  );
  expect((await readFile(join(papers, "Lease.txt"))).equals(original)).toBe(true);

  // In Chinese, for another Linked folder: asked, and Don't allow is said where it happened.
  const notes = join(sources, "Notes");
  await mkdir(notes);
  await bridge(window).language("zh-CN");
  await bridge(window).link(notes);
  await useOutputLocation(window, notes);
  await exportOnce();
  await expect(ask.getByRole("heading")).toHaveText("在“Notes”中添加文件？");
  await screenshot(ask, "file-write-linked-folder-zh");
  await ask.getByTestId("file-write-deny").click();
  await expect(problem).toHaveText("无法保存：你没有允许在同步文件夹“Notes”中添加文件 · 允许");
  await screenshot(result, "export-not-allowed-zh");
  await app.close();
});

test("an export saved into a Linked folder is IncarnaMind's file: its viewer says checks don't count it, Count it counts it with Undo, its menu takes that back, and Settings or a folder can count such files", async () => {
  const papers = join(sources, "Papers");
  await mkdir(papers);
  await writeFile(join(papers, "Moon.txt"), "Spring tides happen at new moon and at full moon.");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const linked = await bridge(window).link(papers);
  await window.evaluate(
    (id) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLinkedFolderWriting(
        id,
        true,
      ),
    linked.id,
  );
  await useOutputLocation(window, papers);
  await newMind(window);
  await nameMind(window, "Tides");
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Spring tides come twice a month.");
  await exportFromMenu(window);
  await expect(window.getByTestId("export-done")).toHaveText(savedLine("Tides.docx", papers));

  // The Linked folder picks the export up, beside the User's own file, both in Not in a Folder.
  await showSourceLocations(window);
  const items = window.getByTestId("not-in-a-folder").getByTestId("document-list-item");
  const exported = items.filter({ hasText: "Tides" });
  const moon = items.filter({ hasText: "Moon" });
  await expect(exported).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await expect(moon).toHaveAttribute("data-status", "ready");

  // The User's file says nothing; the export's viewer says checks don't count it.
  const viewer = window.getByTestId("viewer");
  const line = viewer.getByTestId("viewer-own-file");
  await moon.getByTestId("open-document").click();
  await expect(viewer.getByTestId("viewer-title")).toHaveText("Moon");
  await expect(line).toHaveCount(0);
  await exported.getByTestId("open-document").click();
  await expect(viewer.getByTestId("viewer-title")).toHaveText("Tides");
  await expect(line).toHaveText(
    "IncarnaMind wrote this file, so checks don’t count it as evidence · Count it",
  );
  await screenshot(viewer, "own-file-viewer-en");

  // Count it: the line goes, the undo line says so, and Undo takes it back.
  await line.getByTestId("count-it").click();
  await expect(line).toHaveCount(0);
  const undo = window.getByTestId("undo-line");
  await expect(undo.getByTestId("undo-message")).toHaveText("“Tides” counts as evidence now");
  await undo.getByTestId("undo-action").click();
  await expect(line).toBeVisible();

  // Its menu shows the choice both ways.
  const countItem = exported.getByTestId("document.countAsEvidence");
  const leaveOutItem = exported.getByTestId("document.leaveOutOfEvidence");
  await openDocumentMenu(exported);
  await expect(countItem).toHaveText("Count as evidence");
  await countItem.click();
  await expect(line).toHaveCount(0);
  await openDocumentMenu(exported);
  await expect(leaveOutItem).toHaveText("Don’t count as evidence");
  await leaveOutItem.click();
  await expect(line).toBeVisible();
  await expect(undo.getByTestId("undo-message")).toHaveText("“Tides” no longer counts as evidence");
  // The User's own file has no such choice.
  await openDocumentMenu(moon);
  await expect(moon.getByTestId("document.countAsEvidence")).toHaveCount(0);
  await expect(moon.getByTestId("document.leaveOutOfEvidence")).toHaveCount(0);
  await window.keyboard.press("Escape");

  // In Chinese, at the narrowest window, the line wraps by word inside the viewer.
  await bridge(window).language("zh-CN");
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await expect(line).toHaveText("这个文件由 IncarnaMind 导出，核对时不计为依据 · 计为依据");
  await expect(line).toBeVisible();
  const [lineBox, viewerBox] = await Promise.all([line.boundingBox(), viewer.boundingBox()]);
  if (!lineBox || !viewerBox) throw new Error("The line or the viewer isn't laid out.");
  expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(viewerBox.x + viewerBox.width);
  await screenshot(viewer, "own-file-viewer-zh-narrow");
  await bridge(window).language("en");
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);

  // Settings › Search counts such files everywhere, and a folder's own switch has nothing to do.
  const settings = await openSettings(window, "search");
  const checks = settings.getByTestId("evidence-settings");
  const leaveOut = checks.getByRole("switch", { name: "Leave out files IncarnaMind wrote" });
  await expect(leaveOut).toBeChecked();
  await checks.scrollIntoViewIfNeeded();
  await screenshot(checks, "settings-search-checks-en");
  await leaveOut.click();
  await expect(leaveOut).not.toBeChecked();
  await closeSettings(window);
  await expect(line).toHaveCount(0);
  await openDocumentMenu(exported);
  await expect(exported.getByTestId("document.countAsEvidence")).toHaveCount(0);
  await expect(exported.getByTestId("document.leaveOutOfEvidence")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await (await coreOf(window)).evaluate((core) =>
    core.createLibraryGroup({ name: "Reports", description: "" }),
  );
  await editFolderInLibrary(window, "Reports");
  const library = window.getByTestId("library");
  const counts = library.getByTestId("folder-counts-own-files");
  await expect(counts).toBeChecked();
  await expect(counts).toBeDisabled();
  await expect(library).toContainText("Counted in every Folder");

  // On again: a new folder leaves them out unless it says otherwise; in Chinese too.
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { leaveOutOwnFiles: true },
    }),
  );
  await expect(counts).not.toBeChecked();
  await expect(counts).toBeEnabled();
  await bridge(window).language("zh-CN");
  await expect(library.getByText("在此文件夹中，将 IncarnaMind 导出的文件计为依据")).toBeVisible();
  await screenshot(library, "folder-counts-own-files-zh");
  await app.close();
});

test("Settings opens the data folder in the file manager", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await interceptOpenPath(app);

  await window.getByRole("button", { name: "Settings" }).click();
  await window.getByTestId("settings").getByTestId("open-data-folder").click();

  await expect.poll(() => pathsOpened(app)).toHaveLength(1);
  const [opened] = await pathsOpened(app);
  expect(await realpath(opened ?? "")).toBe(await realpath(dataDir));
  await app.close();
});

const NEWCOMER = {
  en: {
    first: "Write a short summary of this agreement.",
    second: "Make the summary longer.",
  },
  "zh-CN": {
    first: "为这份协议写一份简短摘要。",
    second: "把摘要写长一点。",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  const words = NEWCOMER[language];

  test(`a Mind the User never named is named by its first line, not by the last instruction, and Export saves it so (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await bridge(window).language(language);
    await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
    await useOutputLocation(window, sources);
    await newMind(window);

    await askInAssistant(window, words.first);
    await expect(window.getByTestId("mind-editor").locator("h2")).toHaveText("Summary");
    await expect(frontMindName(window)).toHaveText("Summary");

    const second = await askInAssistant(window, words.second);
    await expect(second.getByTestId("mind-changes-title")).toContainText("“Summary”");
    await expect(frontMindName(window)).toHaveText("Summary");
    await screenshot(window, `mind-named-by-first-line-${language}`);

    await exportFromMenu(window);
    await expect(window.getByTestId("export-result").getByTestId("export-done")).toContainText(
      savedLine("Summary.docx", sources, language),
    );
    await app.close();
  });

  test(`a Mind the User renamed keeps its name through both requests and Export (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await bridge(window).language(language);
    await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
    await useOutputLocation(window, sources);
    await newMind(window);
    await nameMind(window, "Agreement notes");

    await askInAssistant(window, words.first);
    const second = await askInAssistant(window, words.second);
    await expect(second.getByTestId("mind-changes-title")).toContainText("“Agreement notes”");
    await expect(frontMindName(window)).toHaveText("Agreement notes");

    await exportFromMenu(window);
    await expect(window.getByTestId("export-result").getByTestId("export-done")).toContainText(
      savedLine("Agreement notes.docx", sources, language),
    );
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  const instruction =
    language === "en" ? "Summarise this agreement for me." : "为这份协议写一份摘要。";

  test(`a new Mind made from an Answer is named by its first line, not by the conversation's name from the first instruction; a name the User gave the conversation is kept (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await bridge(window).language(language);
    await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
    const core = await coreOf(window);
    const minds = () => core.evaluate((each) => each.listMinds());

    const answer = await askInAssistant(window, instruction);
    const addToNew = async () => {
      await pointAt(window, answer.getByTestId("assistant-answer-text"));
      await pointAndClick(window, answer.getByTestId("answer-add-to"));
      await pointAndClick(
        window,
        window.getByTestId("add-to-picker").getByTestId("add-to-option").last(),
      );
    };

    await addToNew();
    await expect.poll(async () => (await minds()).length).toBe(1);
    const [first] = await minds();
    expect(first?.title).toBe("");
    expect(first?.autoTitle).toMatch(/^This is a scripted Answer to/);
    const preview = await core.evaluate(
      (each, mindId) => each.previewMindExport(mindId, { format: "docx" }),
      first?.id ?? "",
    );
    expect(preview.fileName).toMatch(/^This is a scripted Answer to/);
    expect(preview.fileName).not.toMatch(/^Summarise this agreement|^为这份协议/);

    const conversationId = (await core.evaluate((each) => each.listConversations()))[0]?.id ?? "";
    await core.evaluate(
      (each, id) => each.renameConversation(id, "Agreement review"),
      conversationId,
    );
    await addToNew();
    await expect.poll(async () => (await minds()).length).toBe(2);
    expect((await minds()).map((each) => each.title)).toContain("Agreement review");
    await app.close();
  });
}
