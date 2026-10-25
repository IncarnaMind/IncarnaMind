import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, LinkedFolder } from "../src/core/api";
import {
  addDocuments,
  confirmLink,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  linkedFolderRow,
  nameMind,
  newMind,
  openLinkedFolderMenu,
  previewLink,
  removeDataFolder,
  showSourceLocations,
  turnOnEmbeddings,
  useLocalChatModel,
} from "./app";

/*
 * The app's chrome lines up (DESIGN.md, Layout): every sidebar row puts its
 * icon at x 16 and its text at x 40, a Folder's children are one 24px step
 * deeper, section labels share the icon column, and every pane header is
 * 44px. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of
 * the sidebar, first run and each Settings page there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** The tiny MCP server the core tests use: `book_boat` may change something, so it asks. */
const TIDE_SERVER = resolve(__dirname, "../tests/fixtures/mcp-server.mjs");

let dataDir: string;
/** Where the files a test adds are written: outside the data folder. */
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function screenshot(page: Page, name: string, clip?: Locator): Promise<void> {
  if (!SCREENSHOTS) return;
  const path = join(SCREENSHOTS, `${name}.png`);
  if (clip) await clip.screenshot({ path });
  else await page.screenshot({ path });
}

/** Where an element's text starts, in CSS pixels from the window's left edge. */
function textLeft(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const first = range.getClientRects()[0];
    if (!first) throw new Error("The element has no text.");
    return first.left;
  });
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

/**
 * Each row's icon and text, from the sidebar's left edge, and its depth: all
 * read at one moment, as rows come in while a folder is indexed, and a row
 * read a piece at a time could be another row by its next piece.
 */
async function rowEdges(sidebar: Locator, rows: Locator) {
  const left = (await boxOf(sidebar)).x;
  return rows.evaluateAll(
    (elements, from) =>
      elements.map((row) => {
        const icon = row.querySelector("svg");
        const text = row.querySelector('[data-testid="row-text"]');
        const range = document.createRange();
        if (text) range.selectNodeContents(text);
        const first = text ? range.getClientRects()[0] : undefined;
        if (!icon || !first) throw new Error("A row has no icon or no text.");
        return {
          icon: icon.getBoundingClientRect().x - from,
          text: first.left - from,
          depth: Number(row.getAttribute("data-depth") ?? "0"),
        };
      }),
    left,
  );
}

/** Links a folder through the core's bridge, as "Add folder…" does once the User picked it. */
const linkFolder = (page: Page, path: string) =>
  page.evaluate(
    async (wanted) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(wanted),
    path,
  ) as Promise<LinkedFolder>;

/** Writes `files` (relative paths) under `root`, each holding its own name. */
async function writeTree(root: string, files: string[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), `${basename(file, ".txt")}.\n`);
  }
}

/** Long enough for a few dozen Passages, so "Embedding…" stays on screen for a moment. */
const LONG_TEXT = Array.from(
  { length: 4000 },
  (_, index) => `Line ${index}: test loss falls as a power law in model size and data.`,
).join("\n");

/** The sidebar's Folder, group and Document rows. */
const treeRows = (window: Page) =>
  window
    .getByTestId("sidebar-tree")
    .locator(
      '[data-testid="folder-item"], [data-testid="other-documents"], [data-testid="document-list-item"]',
    );

/**
 * Every Folder, group and Document row is 28px, puts its icon at x 16 and
 * its text at x 40 (24px deeper per level), and keeps its name, its status
 * at the end and a Linked folder's bar on its one line. Returns how many rows.
 * Each row is read with its parts in one pass, as `rowEdges` reads its edges:
 * while a folder is indexed, a status or bar found first could be gone by the
 * time it was measured.
 */
async function expectRowsAligned(window: Page): Promise<number> {
  const rows = treeRows(window);
  for (const { icon, text, depth } of await rowEdges(window.getByTestId("sidebar"), rows)) {
    expect(icon).toBeCloseTo(16 + depth * 24, 0);
    expect(text).toBeCloseTo(40 + depth * 24, 0);
  }
  const measured = await rows.evaluateAll((elements) =>
    elements.map((row) => {
      const box = row.getBoundingClientRect();
      const text = row.querySelector('[data-testid="row-text"]');
      if (!text) throw new Error("A row has no text.");
      const ends = row.querySelectorAll(
        ':scope > button [data-testid$="-status"], :scope > div [data-testid$="-status"], [data-testid="folder-progress"]',
      );
      return {
        top: box.top,
        height: box.height,
        textHeight: text.getBoundingClientRect().height,
        ends: [...ends].map((end) => {
          const part = end.getBoundingClientRect();
          return { top: part.top, bottom: part.bottom };
        }),
      };
    }),
  );
  for (const row of measured) {
    expect(row.height).toBeCloseTo(28, 0);
    // One line of text, never wrapped.
    expect(row.textHeight).toBeLessThanOrEqual(20.5);
    for (const part of row.ends) {
      expect(part.top).toBeGreaterThanOrEqual(row.top - 0.5);
      expect(part.bottom).toBeLessThanOrEqual(row.top + row.height + 0.5);
    }
  }
  return measured.length;
}

test("sidebar rows share one text edge, in Not in a Folder and in the Linked folders, and pane headers are 44px", async () => {
  // Two Linked folders, one with a folder inside, and a file added on its own.
  const papersPath = join(sources, "Papers");
  const reportsPath = join(sources, "Reports");
  await writeTree(papersPath, [
    "Language Models are Unsupervised Multitask Learners.txt",
    "2026/Attention Is All You Need.txt",
  ]);
  await writeTree(reportsPath, ["Quarterly report.txt"]);
  await writeTree(sources, ["Supervisor meeting notes.txt"]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // On, so a Document shows its embedding progress (they are off by default).
  await turnOnEmbeddings(window);

  for (const title of [
    "Methods: evaluation design",
    "Literature review, chapter 2",
    "Reading notes: LM scaling",
  ]) {
    await newMind(window);
    await nameMind(window, title);
    await expect(window.getByTestId("mind-list-item").first()).toHaveText(title);
  }
  await addDocuments(window, [join(sources, "Supervisor meeting notes.txt")]);
  await linkFolder(window, papersPath);
  const reports = await linkFolder(window, reportsPath);
  const tree = window.getByTestId("sidebar-tree");
  const folderRow = (folderId: string) =>
    tree.locator(`[data-folder-id="${folderId}"][data-testid="folder-item"]`);
  const documents = window.getByTestId("document-list-item");

  const sidebar = window.getByTestId("sidebar");
  // Not in a Folder: the Minds, then the Documents, at x 16 / 40.
  const projectRows = window
    .getByTestId("not-in-a-folder")
    .locator('[data-testid="mind-list-item"], [data-testid="document-list-item"]');
  await expect(projectRows).toHaveCount(3 + 4);
  for (const { icon, text, depth } of await rowEdges(sidebar, projectRows)) {
    expect(depth).toBe(0);
    expect(icon).toBeCloseTo(16, 0);
    expect(text).toBeCloseTo(40, 0);
  }
  for (const row of await projectRows.all()) {
    expect((await boxOf(row)).height).toBeCloseTo(28, 0);
  }

  // The Linked folders: a row each, which doesn't unfold, at x 16 / 40.
  await showSourceLocations(window);
  const linked = window.getByTestId("linked-folders-section");
  const rows = linked.getByTestId("folder-item");
  await expect(rows).toHaveCount(2);
  await expect(linked.getByTestId("document-list-item")).toHaveCount(0);
  for (const { icon, text, depth } of await rowEdges(sidebar, rows)) {
    expect(depth).toBe(0);
    expect(icon).toBeCloseTo(16, 0);
    expect(text).toBeCloseTo(40, 0);
  }

  // "Library", Settings and Not in a Folder's label share the columns.
  const sidebarLeft = (await boxOf(sidebar)).x;
  const allDocuments = window.getByTestId("open-library");
  expect((await boxOf(allDocuments.locator("svg"))).x - sidebarLeft).toBeCloseTo(16, 0);
  expect((await textLeft(allDocuments.locator("span").first())) - sidebarLeft).toBeCloseTo(40, 0);
  const settings = window.getByTestId("sidebar-footer").getByRole("button", { name: "Settings" });
  expect((await boxOf(settings.locator("svg"))).x - sidebarLeft).toBeCloseTo(16, 0);
  expect((await textLeft(settings.locator("span"))) - sidebarLeft).toBeCloseTo(40, 0);
  for (const heading of ["not-in-a-folder-title", "linked-folders-section-heading"]) {
    expect((await textLeft(window.getByTestId(heading))) - sidebarLeft).toBeCloseTo(16, 0);
  }
  // The header starts the window's title bar: macOS's traffic lights there (e2e/titleBar.spec.ts),
  // or else the app's mark, on the icon column.
  const header = window.getByTestId("sidebar-header");
  if (process.platform !== "darwin") {
    expect((await boxOf(header.getByTestId("app-mark"))).x - sidebarLeft).toBeCloseTo(16, 0);
  }

  // Rows are 28px.
  for (const row of [allDocuments, ...(await rows.all())]) {
    expect((await boxOf(row)).height).toBeCloseTo(28, 0);
  }

  // The sidebar's header is 44px; the card's band of tabs is 36px, 8px down, so its bottom
  // lines up with the header's rule.
  const mindHeader = window.getByTestId("tab-strip");
  const sidebarHeader = await boxOf(header);
  const mindHeaderBox = await boxOf(mindHeader);
  expect(sidebarHeader.height).toBe(44);
  expect(mindHeaderBox.height).toBe(36);
  expect(mindHeaderBox.y + mindHeaderBox.height).toBe(sidebarHeader.y + sidebarHeader.height);
  await expect(
    mindHeader.locator('[role="tab"][aria-selected="true"]').getByTestId("tab-title"),
  ).toHaveText("Reading notes: LM scaling");

  const reportsRow = folderRow(reports.folderId);

  // A processing Document shows its progress at the row's end, on one line.
  await writeFile(join(sources, "Scaling Laws for Neural Language Models.txt"), LONG_TEXT);
  await window
    .getByTestId("add-documents-input")
    .setInputFiles([join(sources, "Scaling Laws for Neural Language Models.txt")]);
  const processing = documents.filter({ hasText: "Scaling Laws" });
  await expect(processing).toHaveAttribute("data-status", "embedding");
  await expect(processing.getByTestId("document-status")).toContainText("Embedding…");
  await expect(processing).toHaveAttribute("data-depth", "0");
  expect((await boxOf(processing)).height).toBeCloseTo(28, 0);
  // A row pointed at keeps no highlight once the pointer moves on.
  await reportsRow.hover();
  await window.mouse.move(800, 400);
  await expect
    .poll(() => reportsRow.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  if (SCREENSHOTS) {
    // For the picture, a moment past 0%; no matter if it's done first.
    await processing
      .getByTestId("document-status")
      .filter({ hasText: /Embedding… [1-9]/ })
      .waitFor({ timeout: 5_000 })
      .catch(() => undefined);
  }
  await screenshot(window, "sidebar");
  await screenshot(window, "sidebar-only", sidebar);
  await expect(processing).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await app.close();
});

test("Linked folder and Document rows stay 28px, on the shared text edge, through every state", async () => {
  // Indexing and waiting for the long files takes a while with the test's embedding model.
  test.setTimeout(180_000);
  // Papers: long files, one in a folder, and two online-only files (iCloud Drive's stubs).
  // Drive: two small files, one deleted later, and the whole folder unplugged after a restart.
  // Projects: empty. And a file added on its own.
  const papersPath = join(sources, "Papers");
  const drivePath = join(sources, "Drive");
  const projectsPath = join(sources, "Projects");
  for (const name of ["Scaling laws.txt", "Chinchilla.txt", "2026/Attention.txt"]) {
    await mkdir(dirname(join(papersPath, name)), { recursive: true });
    await writeFile(join(papersPath, name), LONG_TEXT);
  }
  await writeFile(join(papersPath, ".Remote paper.pdf.icloud"), "plist");
  await writeFile(join(papersPath, "2026", ".Remote notes.md.icloud"), "plist");
  await writeTree(drivePath, ["Field notes.txt", "Survey with a very long name about tides.txt"]);
  await mkdir(projectsPath);
  await writeTree(sources, ["Supervisor meeting notes.txt"]);

  let running = await launchApp(dataDir);
  let { window } = running;
  await dismissChatSetup(window);
  await addDocuments(window, [join(sources, "Supervisor meeting notes.txt")]);
  await linkFolder(window, drivePath);
  await linkFolder(window, projectsPath);
  await showSourceLocations(window);
  const drive = linkedFolderRow(window, "Drive");
  const projects = linkedFolderRow(window, "Projects");
  await expect(drive).toHaveAttribute("data-state", "idle");
  await expect(projects).toHaveAttribute("data-state", "empty");
  const sidebar = () => window.getByTestId("sidebar");

  // Indexing: "Indexing 1 of 3" and a thin bar, on the folder's one line.
  const dialog = await previewLink(running.app, window, papersPath);
  await screenshot(window, "linked-folders-link-dialog");
  await confirmLink(dialog);
  const papers = linkedFolderRow(window, "Papers");
  await expect(papers).toHaveAttribute("data-state", "indexing");
  await showSourceLocations(window);
  // Its files' rows come in, in Not in a Folder, as they are found and read: measured once its
  // first five are listed there, beside the three Linked folders' rows.
  await expect.poll(() => treeRows(window).count()).toBeGreaterThanOrEqual(8);
  await expectRowsAligned(window);
  await screenshot(window, "linked-folders-indexing", sidebar());

  // Paused, here with the bar held where it stopped; in a narrow sidebar too.
  await (await openLinkedFolderMenu(papers)).getByTestId("linkedFolder.pause").click();
  await expect(papers).toHaveAttribute("data-state", "paused");
  await expectRowsAligned(window);
  await screenshot(window, "linked-folders-paused", sidebar());
  const setSidebarWidth = (width: number) =>
    window.evaluate(async (sidebarWidth) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ device: { sidebarWidth } });
    }, width);
  await setSidebarWidth(165);
  await expect.poll(async () => (await boxOf(sidebar())).width).toBeCloseTo(165, 0);
  await expectRowsAligned(window);
  await screenshot(window, "linked-folders-paused-narrow", sidebar());
  await setSidebarWidth(248);
  await expect.poll(async () => (await boxOf(sidebar())).width).toBeCloseTo(248, 0);

  // Done: "2 online-only" at the end, no bar.
  await (await openLinkedFolderMenu(papers)).getByTestId("linkedFolder.pause").click();
  await expect(papers).toHaveAttribute("data-state", "online-only", { timeout: 120_000 });
  await expectRowsAligned(window);
  await screenshot(window, "linked-folders-online-only", sidebar());

  // A file deleted on disk: "Missing" at its row's end.
  await rm(join(drivePath, "Field notes.txt"));
  const missing = window
    .getByTestId("not-in-a-folder")
    .getByTestId("document-list-item")
    .filter({ hasText: "Field notes" });
  await expect(missing).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });
  await expectRowsAligned(window);
  await screenshot(window, "linked-folders-missing", sidebar());

  // Papers as one list: its row says so, and stays on its line.
  await (await openLinkedFolderMenu(papers)).getByTestId("linkedFolder.layout").click();
  await expect(papers).toHaveAttribute("data-layout", "flat");
  await expectRowsAligned(window);
  await screenshot(window, "linked-folders-flat", sidebar());
  await running.app.close();

  // Drive unplugged while the app was closed: it and its Documents are unavailable.
  await rename(drivePath, join(sources, "Drive (unplugged)"));
  running = await launchApp(dataDir);
  window = running.window;
  await showSourceLocations(window);
  await expect(linkedFolderRow(window, "Drive")).toHaveAttribute("data-state", "unavailable", {
    timeout: 15_000,
  });
  await expectRowsAligned(window);
  await screenshot(window, "linked-folders-unavailable", sidebar());
  await running.app.close();
});

test("the status footer doesn't move the tree when tagging starts or stops", async () => {
  const paper = join(sources, "Report on attention.txt");
  await writeFile(paper, "A report on attention in language models.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Field notes");
  // An empty Linked folder: its own Folder is listed, with nothing in it to tag.
  await mkdir(join(sources, "Projects"));
  await linkFolder(window, join(sources, "Projects"));

  const tree = window.getByTestId("sidebar-tree");
  const footer = window.getByTestId("sidebar-footer");
  const status = window.getByTestId("sidebar-status");
  const watched = [
    window.getByTestId("open-library"),
    window.getByTestId("not-in-a-folder-title"),
    window.getByTestId("mind-list-item"),
  ];
  const layout = async () => ({
    rows: await Promise.all(watched.map(async (each) => (await boxOf(each)).y)),
    tree: await boxOf(tree),
    footer: await boxOf(footer),
    status: await boxOf(status),
  });
  await expect(watched[1] as Locator).toBeVisible();
  const before = await layout();

  // No chat model yet: the Document is ready, and tagging waits. The footer says so.
  // Added by the core, not through the picker, whose step puts an undo line in the footer.
  await (await coreOf(window)).evaluate(async (core, file) => core.addDocuments([file]), paper);
  const item = window.getByTestId("document-list-item");
  await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider");
  await expect(status.getByTestId("tagging-waiting")).toBeVisible();
  await screenshot(window, "sidebar-tagging-waits", window.getByTestId("sidebar"));
  expect(await layout()).toEqual(before);

  // A chat model: tagging starts, then stops. Nothing above the footer moves.
  await useLocalChatModel(window);
  await expect(item).toHaveAttribute("data-tagging", "tagged");
  await expect(status.locator("[role]")).toHaveCount(0);
  expect(await layout()).toEqual(before);
  await app.close();
});

test("an Answer that waits for the User's approval shows an amber dot on the assistant, folded too, and none on the Mind", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await window.evaluate(
    async ({ node, server }) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const connector = await core.addConnector({ name: "Tides", command: node, args: [server] });
      for (let tries = 0; tries < 300; tries++) {
        const found = (await core.listConnectors()).find((each) => each.id === connector.id);
        if (found?.state === "ready") return;
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error("The Connector didn't get ready.");
    },
    { node: process.execPath, server: TIDE_SERVER },
  );

  await newMind(window);
  await nameMind(window, "Trip");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Please book_boat from Dover");
  await window.keyboard.press("Enter");

  // The Answer is in the assistant, and so is its dot, by the conversation's title.
  const assistant = window.getByTestId("assistant");
  const card = assistant.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const dot = assistant.getByRole("img", { name: "Waiting for your approval" });
  await expect(dot).toBeVisible();
  expect((await boxOf(dot)).width).toBe(6);
  const header = await boxOf(assistant.getByTestId("assistant-header"));
  const dotBox = await boxOf(dot);
  expect(dotBox.y).toBeGreaterThanOrEqual(header.y);
  expect(dotBox.y + dotBox.height).toBeLessThanOrEqual(header.y + header.height);
  // The Mind it was asked beside has none, in the sidebar or on its tab: the Answer isn't in it.
  await expect(window.getByTestId("mind-approval")).toHaveCount(0);
  await expect(window.getByTestId("mind-tab-status")).toHaveCount(0);
  await screenshot(window, "assistant-approval", assistant);

  // Folded, the card is out of sight; the dot stays on what unfolds it.
  const fold = assistant.getByTestId("assistant-fold");
  await fold.click();
  await expect(card).toBeHidden();
  await expect(dot).toBeVisible();
  await screenshot(window, "assistant-approval-folded", assistant);
  await fold.click();

  await card.getByTestId("approval-deny").click();
  await expect(dot).toHaveCount(0);
  // The Answer goes on and then ends, as slowly as the machine is.
  await expect(assistant.getByTestId("assistant-answer").last()).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 15_000 },
  );
  await app.close();
});

test("first run and every Settings page", async () => {
  test.skip(!SCREENSHOTS, "Only takes screenshots: set INCARNAMIND_SCREENSHOTS to a folder.");
  const { app, window } = await launchApp(dataDir);
  await screenshot(window, "first-run");

  await window.getByRole("button", { name: "Settings" }).click();
  const settings = window.getByTestId("settings");
  for (const page of [
    "general",
    "models",
    "search",
    "meetings",
    "connectors",
    "skills",
    "privacy",
  ]) {
    await settings.getByTestId(`settings-nav-${page}`).click();
    await expect(settings).toHaveAttribute("data-page", page);
    await expect(settings.getByTestId(`settings-page-${page}`)).not.toBeEmpty();
    await screenshot(window, `settings-${page}`);
  }
  await app.close();
});
