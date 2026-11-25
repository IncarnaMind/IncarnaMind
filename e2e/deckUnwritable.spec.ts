/**
 * Unwritable deck flows (#149 part 3), injected via the `DeckFiles` host adapter (no `chmod`):
 * 1. Read-only file → plain-words line in place → Save a copy beside it → continue editing and
 *    Undo in the copy while the original stays byte-identical (EN & ZH).
 * 2. Cloud placeholder (evicted while open, before first edit) → plain-words cloud line →
 *    copy-beside failing (disk full) says so in place without losing the edit → recovers and saves.
 * Set `INCARNAMIND_SCREENSHOTS` to a folder to keep full-window captures at 1440×900 and 900×700.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { part, unzip } from "../tests/helpers/docx";
import { para, pptxOf, sp, txBody, xfrm } from "../tests/helpers/pptx";
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

const NAME = "Harbour plan.pptx";
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
const BLUE = `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2A5BD7"/></a:solidFill>`;
const run = (text: string) => `<a:r><a:rPr lang="en-GB" sz="2400"/><a:t>${text}</a:t></a:r>`;

const DECK = pptxOf({
  slides: [
    {
      shapes:
        sp({
          id: 2,
          name: "Title",
          spPr: xfrm(457200, 300000, 8000000, 700000),
          body: txBody(para([run("Harbour plan 2027")])),
        }) + sp({ id: 4, name: "Box", spPr: xfrm(6400000, 1300000, 1800000, 1200000) + BLUE }),
    },
  ],
  parts: [{ name: "_rels/.rels", data: ROOT_RELS }],
});

const SLIDE_ONE = part(unzip(DECK), "ppt/slides/slide1.xml");

function placeOf(xml: string, id: number): { x: number; y: number } {
  const shape = xml.split("<p:sp>").find((each) => each.includes(`<p:cNvPr id="${id}"`)) ?? "";
  const [, x, y] = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(shape) ?? [];
  return { x: Number(x), y: Number(y) };
}

async function slideOnDisk(path: string): Promise<string> {
  return part(unzip(await readFile(path)), "ppt/slides/slide1.xml");
}

const undoLine = (window: Page) => window.getByTestId("undo-line");

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function still(window: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await window.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
}

let dataDir = "";
let home = "";
let sources = "";

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  sources = await createDataFolder();
});

test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(sources);
});

async function openDeck(language: "en" | "zh-CN", initialRules: Record<string, string>) {
  const path = join(sources, NAME);
  const rulesPath = join(sources, "deck-rules.json");
  await writeFile(path, DECK);
  await writeFile(rulesPath, JSON.stringify(initialRules));
  const { app, window } = await launchApp(dataDir, {
    home,
    extraEnv: { INCARNAMIND_TEST_DECK_FILES: rulesPath },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  if (language === "zh-CN") await setLanguage(window, "zh-CN");
  await addDocuments(window, [path]);
  const item = window.getByTestId("document-list-item").filter({ hasText: "Harbour plan" });
  await pointAndClick(window, item.getByTestId("open-document"));
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-slides")).toHaveAttribute("data-drawn", "yes");
  const first = viewer.getByTestId("viewer-slide-editor").first();
  return { app, window, viewer, first, path, rulesPath };
}

for (const language of ["en", "zh-CN"] as const) {
  test(`read-only deck: says so in place, saves a copy beside it, and edits on in the copy (${language})`, async () => {
    const { app, window, viewer, first, path } = await openDeck(language, { [NAME]: "read-only" });
    try {
      const box = first.locator('[data-shape-id="4"]');
      await box.click();
      await window.keyboard.press("Shift+ArrowDown");

      const problem = viewer.getByTestId("viewer-deck-unwritable");
      await expect(problem).toBeVisible();
      await expect(problem).toContainText(
        language === "en"
          ? `“${NAME}” is read-only, so the change isn’t saved yet.`
          : `“${NAME}”是只读文件，修改尚未保存。`,
      );
      await expect(problem.getByTestId("viewer-deck-save-copy")).toBeVisible();
      await expect(problem.getByTestId("viewer-deck-try-again")).toBeVisible();
      expect(Buffer.compare(await readFile(path), DECK)).toBe(0);

      await still(window, `readonly-1440-${language}`);
      await setWindowSize(app, window, 900, 700);
      await expect(problem).toBeVisible();
      await still(window, `readonly-900-${language}`);
      await setWindowSize(app, window, 1440, 900);

      // Save a copy beside it: copy opens in its own tab with the change already applied.
      await problem.getByTestId("viewer-deck-save-copy").click();
      await expect(undoLine(window)).toContainText(
        language === "en" ? "Made a copy with your change" : "已用你的修改另存了一份副本",
      );
      await expect(problem).toHaveCount(0);

      const copyPath = join(sources, "Harbour plan 2.pptx");
      const basePos = placeOf(SLIDE_ONE, 4);
      await expect
        .poll(async () => placeOf(await slideOnDisk(copyPath), 4))
        .toEqual({ x: basePos.x, y: basePos.y + 10 * 9525 });

      // Continue editing in the copy: saves directly to the copy; original stays untouched.
      const copySlide = viewer.getByTestId("viewer-slide-editor").first();
      await copySlide.locator('[data-shape-id="4"]').click();
      await window.keyboard.press("Shift+ArrowRight");
      await expect
        .poll(async () => placeOf(await slideOnDisk(copyPath), 4))
        .toEqual({ x: basePos.x + 10 * 9525, y: basePos.y + 10 * 9525 });
      expect(Buffer.compare(await readFile(path), DECK)).toBe(0);
      await still(window, `copy-editing-1440-${language}`);

      // Undo takes back only the second edit in the copy.
      await copySlide.focus();
      await window.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => placeOf(await slideOnDisk(copyPath), 4))
        .toEqual({ x: basePos.x, y: basePos.y + 10 * 9525 });
      expect(Buffer.compare(await readFile(path), DECK)).toBe(0);
    } finally {
      await app.close();
    }
  });

  test(`cloud placeholder and copy-beside failure: says so in place, never loses edit, saves once disk recovers (${language})`, async () => {
    const { app, window, viewer, first, path, rulesPath } = await openDeck(language, {});
    try {
      // Simulate the cloud service evicting the open file before the first edit.
      await writeFile(rulesPath, JSON.stringify({ [NAME]: "cloud" }));
      await first.locator('[data-shape-id="4"]').click();
      await window.keyboard.press("Shift+ArrowDown");

      const problem = viewer.getByTestId("viewer-deck-unwritable");
      await expect(problem).toBeVisible();
      await expect(problem).toContainText(
        language === "en"
          ? `“${NAME}” isn’t downloaded from the cloud, so the change isn’t saved yet.`
          : `“${NAME}”尚未从云端下载，修改尚未保存。`,
      );
      expect(Buffer.compare(await readFile(path), DECK)).toBe(0);
      await still(window, `cloud-1440-${language}`);
      await setWindowSize(app, window, 900, 700);
      await still(window, `cloud-900-${language}`);
      await setWindowSize(app, window, 1440, 900);

      // Copy-beside fails too (disk full): says so in place, no detached error toast, edit kept.
      await writeFile(rulesPath, JSON.stringify({ [NAME]: "copy-failed-full" }));
      await problem.getByTestId("viewer-deck-save-copy").click();
      await expect(problem).toContainText(
        language === "en"
          ? "Couldn’t save a copy: the disk is full. Free some space, then try again."
          : "无法另存副本：磁盘已满。腾出空间后重试。",
      );
      await expect(window.getByTestId("error-notice")).toHaveCount(0);
      await still(window, `copy-failed-1440-${language}`);
      await setWindowSize(app, window, 900, 700);
      await still(window, `copy-failed-900-${language}`);
      await setWindowSize(app, window, 1440, 900);

      // Disk recovers: clicking Save a copy beside it now succeeds with the edit intact.
      await writeFile(rulesPath, JSON.stringify({ [NAME]: "cloud" }));
      await problem.getByTestId("viewer-deck-save-copy").click();
      await expect(undoLine(window)).toContainText(
        language === "en" ? "Made a copy with your change" : "已用你的修改另存了一份副本",
      );
      const copyPath = join(sources, "Harbour plan 2.pptx");
      const basePos = placeOf(SLIDE_ONE, 4);
      await expect
        .poll(async () => placeOf(await slideOnDisk(copyPath), 4))
        .toEqual({ x: basePos.x, y: basePos.y + 10 * 9525 });
      expect(Buffer.compare(await readFile(path), DECK)).toBe(0);
    } finally {
      await app.close();
    }
  });
}
