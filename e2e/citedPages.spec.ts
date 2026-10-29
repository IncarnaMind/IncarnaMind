/**
 * The cited page, saved when a Citation is made (#133), in the built app: the
 * scripted model cites a PDF's page, a slide, a sheet's rows, a CSV's rows and
 * a Word section. The PDF's page is drawn by the page-image worker, the rest
 * by their viewer in a hidden window, and each is kept in the data folder,
 * after its file is deleted, until nothing cites it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import { LOG_FILE } from "../src/main/log";
import type { PageText } from "../src/shared/citedPage";
import { findQuoteInPieces } from "../src/shared/quoteMatch";
import { buildPdf } from "../tests/helpers/pdf";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  linkFolderFromSidebar,
  removeDataFolder,
  useLocalChatModel,
} from "./app";

const FIXTURES = join(__dirname, "..", "tests", "fixtures", "formats");
const WORD = "Coastal Flood Risk Review.docx";
const FILES = [WORD, "Quarterly Research Update.pptx", "Regional Revenue.xlsx", "Orders.csv"];
const PDF = "Tide Gauges.pdf";
const QUESTION =
  "Compare each: the western fastest growth, the barrier crest halves damage, and West totals in rows.";

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

interface SavedPage {
  id: string;
  name: string;
  image_type: string;
  width: number;
  height: number;
  text: string;
}

/** The cited pages saved, with their Documents' names, as the data folder's database has them. */
function savedPages(): SavedPage[] {
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  try {
    return db.all<SavedPage>(
      `SELECT p.id, d.name, p.image_type, p.width, p.height, p.text FROM cited_pages p
       JOIN documents d ON d.id = p.document_id
       WHERE p.deleted_at IS NULL AND p.image_type IS NOT NULL ORDER BY d.name`,
    );
  } finally {
    db.close();
  }
}

const pictureFile = (page: SavedPage) =>
  join(dataDir, "Cited pages", `${page.id}.${page.image_type === "image/png" ? "png" : "jpg"}`);

/** A saved picture's size, and how many of its pixels are dark: some, once something is drawn. */
function pictureOf(app: ElectronApplication, file: string) {
  return app.evaluate(({ nativeImage }, path) => {
    const image = nativeImage.createFromPath(path);
    const bitmap = image.toBitmap();
    let dark = 0;
    for (let at = 0; at < bitmap.length; at += 4) {
      if (
        (bitmap[at] ?? 255) < 96 &&
        (bitmap[at + 1] ?? 255) < 96 &&
        (bitmap[at + 2] ?? 255) < 96
      ) {
        dark++;
      }
    }
    return { ...image.getSize(), dark };
  }, file);
}

/** The core's bridge, as the window has it. */
const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

test("each cited page is saved as drawn, kept after its file is deleted, and goes once nothing cites it", async () => {
  // Three launches, two Answers and five pages drawn: more than one launch's time on a slow runner.
  test.setTimeout(120_000);
  const library = join(await realpath(sources), "Library");
  await mkdir(library, { recursive: true });
  for (const file of FILES) await copyFile(join(FIXTURES, file), join(library, file));
  const pdf = join(await realpath(sources), PDF);
  await writeFile(
    pdf,
    buildPdf([
      { lines: ["Tide gauges"] },
      { lines: ["Felixstowe", "The Felixstowe gauges recorded the highest readings of the year."] },
    ]),
  );

  let { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await linkFolderFromSidebar(app, window, library);
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(FILES.length);
  for (let index = 0; index < FILES.length; index++) {
    await expect(items.nth(index)).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  }

  // A section, a slide and two sheets' rows, cited in one Answer.
  const core = await bridge(window);
  const asked = await core.evaluate(
    (incarnamind, text) => incarnamind.askInConversation({ text }),
    QUESTION,
  );
  if (!asked.asked) throw new Error("The Question wasn't asked.");
  const pageNames = () => savedPages().map((page) => page.name);
  await expect
    .poll(pageNames, { timeout: 60_000 })
    .toEqual([
      "Coastal Flood Risk Review",
      "Orders",
      "Quarterly Research Update",
      "Regional Revenue",
    ]);

  // A PDF's page, cited in the next.
  await core.evaluate((incarnamind, path) => incarnamind.addDocuments([path]), pdf);
  await expect(items).toHaveCount(FILES.length + 1);
  await expect(items.filter({ hasText: "Tide Gauges" })).toHaveAttribute("data-status", "ready", {
    timeout: 30_000,
  });
  const next = await core.evaluate(
    (incarnamind, { text, conversationId }) =>
      incarnamind.askInConversation({ text, conversationId }),
    { text: "Which gauges recorded the highest readings?", conversationId: asked.conversation.id },
  );
  if (!next.asked) throw new Error("The Question wasn't asked.");
  await expect.poll(pageNames, { timeout: 60_000 }).toContain("Tide Gauges");

  const pages = savedPages();
  expect(pages).toHaveLength(5);
  for (const page of pages) {
    const picture = await pictureOf(app, pictureFile(page));
    expect({ width: picture.width, height: picture.height }).toEqual({
      width: page.width,
      height: page.height,
    });
    expect(picture.dark, `${page.name} is drawn`).toBeGreaterThan(200);
  }
  expect(pages.find((page) => page.name === "Tide Gauges")?.image_type).toBe("image/jpeg");
  // Each Citation's quote is found in the text drawn on its page, where it can be highlighted.
  const { messages } = await core.evaluate(
    (incarnamind, id) => incarnamind.getConversation(id),
    asked.conversation.id,
  );
  const citations = messages.flatMap((message) =>
    message.kind === "answer" ? message.citations : [],
  );
  expect(citations).toHaveLength(5);
  const textOf = (name: string): PageText[] =>
    JSON.parse(pages.find((page) => page.name === name)?.text ?? "[]");
  for (const citation of citations) {
    const found = findQuoteInPieces(textOf(citation.documentName), citation.quote);
    expect(found, `${citation.documentName}: ${citation.quote}`).not.toBeNull();
  }
  // Only the cited rows of the sheet, not the rest of its block.
  const sheet = textOf("Regional Revenue").map((run) => run.text);
  expect(sheet).toContain("£350,200");
  expect(sheet).not.toContain("Change on 2025");

  // The Word file is deleted: its page stays, after a restart too.
  await rm(join(library, WORD));
  await app.close();
  ({ app, window } = await launchApp(dataDir, { fakeChat: true }));
  expect(savedPages().map((page) => page.id)).toEqual(pages.map((page) => page.id));
  for (const page of pages) expect(existsSync(pictureFile(page))).toBe(true);

  // Deleted for good, the conversation cites nothing: its pages go at the next start.
  await (await bridge(window)).evaluate(async (incarnamind, id) => {
    await incarnamind.deleteConversation(id);
    await incarnamind.deletePermanently([{ kind: "conversation", id }]);
  }, asked.conversation.id);
  await app.close();
  ({ app, window } = await launchApp(dataDir));
  expect(savedPages()).toEqual([]);
  expect(readdirSync(join(dataDir, "Cited pages"))).toEqual([]);
});

test("a picture the compositor drops is asked for again on the next frame, and the page is saved", async () => {
  test.setTimeout(90_000);
  const library = join(await realpath(sources), "Library");
  await mkdir(library, { recursive: true });
  for (const file of FILES) await copyFile(join(FIXTURES, file), join(library, file));
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  // The first cited page's first picture is asked for as its hidden window grows by a pixel, as
  // on GitHub's macOS runner (#2161), until Chromium drops one: a real UnknownVizError.
  await app.evaluate(({ BaseWindow, WebContentsView, webContents }) => {
    const sample = webContents.getAllWebContents()[0];
    if (!sample) throw new Error("The app has no page.");
    const prototype: Electron.WebContents = Object.getPrototypeOf(sample);
    const capturePage = prototype.capturePage;
    let dropped = false;
    prototype.capturePage = async function (
      this: Electron.WebContents,
      ...args: Parameters<Electron.WebContents["capturePage"]>
    ) {
      if (dropped || !this.isOffscreen()) return capturePage.apply(this, args);
      const view = BaseWindow.getAllWindows()
        .flatMap((each) => each.contentView.children.map((child) => ({ window: each, child })))
        .find(({ child }) => child instanceof WebContentsView && child.webContents === this);
      if (!view || !(view.child instanceof WebContentsView)) return capturePage.apply(this, args);
      for (let attempt = 0; attempt < 5; attempt++) {
        const [width = 0, height = 0] = view.window.getContentSize();
        view.window.setContentSize(width, height + 1);
        view.child.setBounds({ x: 0, y: 0, width, height: height + 1 });
        try {
          await capturePage.apply(this, args);
        } catch (error) {
          dropped = true;
          throw error;
        }
      }
      return capturePage.apply(this, args);
    };
  });
  await linkFolderFromSidebar(app, window, library);
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(FILES.length);
  for (let index = 0; index < FILES.length; index++) {
    await expect(items.nth(index)).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  }

  const asked = await (await bridge(window)).evaluate(
    (incarnamind, text) => incarnamind.askInConversation({ text }),
    QUESTION,
  );
  if (!asked.asked) throw new Error("The Question wasn't asked.");
  await expect
    .poll(() => savedPages().map((page) => page.name), { timeout: 60_000 })
    .toEqual([
      "Coastal Flood Risk Review",
      "Orders",
      "Quarterly Research Update",
      "Regional Revenue",
    ]);
  for (const page of savedPages()) {
    expect((await pictureOf(app, pictureFile(page))).dark, `${page.name} is drawn`).toBeGreaterThan(
      200,
    );
  }
  const log = readFileSync(join(dataDir, "logs", LOG_FILE), "utf8");
  expect(
    log.match(/citedPage\.pictureFailed kind=\w+ attempt=1 reason=UnknownVizError/g),
  ).toHaveLength(1);
  expect(log).toMatch(/citedPage\.drawing kind=\w+ outcome=drawn .*pictures=2 failed=1/);
  expect(log).not.toContain("citedPage.notSaved");
});
