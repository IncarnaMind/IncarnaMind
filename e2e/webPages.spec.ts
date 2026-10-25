import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  newMind,
  openDocumentMenu,
  removeDataFolder,
  setLanguage,
  sidebarFolder,
  urlsOpened,
  useLocalChatModel,
} from "./app";

/*
 * Web pages saved as Documents (#261), from a local test server: added from
 * the "+" menu and by a paste or a drop on a Folder, opened as their snapshot, cited
 * by section and paragraph, and refused, saying why, when they can't be
 * fetched. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const ARTICLE = readFileSync(join(__dirname, "../tests/fixtures/web/article.html"));
const TITLE = "Tea - The Open Encyclopedia";

let dataDir: string;
let home: string;
let server: Server;
let site: string;
/** The server's port: it stands in for the web too, so a page's pictures are asked of it (#756). */
let port: number;
/** What the server was asked for. */
let hits: string[];
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  hits = [];
  server = createServer((request, response) => {
    hits.push(decodeURIComponent(request.url ?? ""));
    if (request.url?.startsWith("/tea")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(ARTICLE);
    } else {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  site = `http://127.0.0.1:${port}`;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** "Add a web page…" from the sidebar's "+", with these addresses, one per line. Returns the dialog. */
async function addWebPages(window: Page, addresses: string[]): Promise<Locator> {
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const dialog = window.getByTestId("add-web-page-dialog");
  await dialog.getByTestId("add-web-page-addresses").fill(addresses.join("\n"));
  await screenshot(window, "add-web-page-dialog");
  await dialog.getByTestId("add-web-page-confirm").click();
  return dialog;
}

/**
 * Pastes text on the element with the focus, as ⌘V does, without the
 * system's clipboard, which is the machine's.
 */
const paste = (window: Page, text: string) =>
  window.evaluate((pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
  }, text);

/** Drags a link from a browser over the element, as the system does, and drops it unless `drop` is false. */
const dragLink = (target: Locator, address: string, drop = true) =>
  target.evaluate(
    (element, [link, dropping]) => {
      const transfer = new DataTransfer();
      transfer.setData("text/uri-list", link);
      transfer.setData("text/plain", link);
      const types = dropping ? ["dragenter", "dragover", "drop"] : ["dragenter", "dragover"];
      for (const type of types) {
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
    },
    [address, drop] as const,
  );

test("a web page added from the + menu is a Document named by its title, opened as its snapshot; one that can't be fetched says why", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await dismissChatSetup(window);
  await interceptOpenExternal(app);

  const dialog = await addWebPages(window, [`${site}/tea`, `${site}/gone`]);

  // The dialog says how each went, a page that couldn't be fetched with why and "Try again".
  const results = dialog.getByTestId("add-web-page-result");
  await expect(results.filter({ hasText: `${site}/tea` })).toContainText("Added");
  await expect(dialog.getByTestId("add-web-page-problem")).toHaveText(
    "Couldn’t fetch: the page doesn’t exist · Try again",
  );
  await screenshot(window, "add-web-page-results");
  await dialog.getByTestId("add-web-page-done").click();
  await expect(dialog).toBeHidden();
  await expect(window.locator('[data-testid^="web-page-problem"]')).toHaveCount(0);

  const row = window.getByTestId("document-list-item").filter({ hasText: TITLE });
  await expect(row).toHaveAttribute("data-status", "ready");
  await expect(row.getByTestId("open-document")).toHaveAttribute("title", `${TITLE}\n${site}/tea`);

  // It opens as a clean reading page, its title over the article, when it was fetched above.
  await row.getByTestId("open-document").click();
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-web-title")).toHaveText(TITLE);
  await expect(viewer.getByTestId("viewer-web-fetched")).toHaveText(
    /^Fetched \d{1,2} \w{3,4} \d{4}$/,
  );
  const article = viewer.getByTestId("viewer-web-article");
  await expect(article).toContainText("Tea was first introduced to Portuguese priests");
  await expect(article.locator("script, iframe, img")).toHaveCount(0);
  await expect(article.locator(".document-image-placeholder")).toContainText(
    "A tea plantation on a hillside",
  );
  await screenshot(window, "web-page-viewer");

  // The header opens the live page; the menu fetches it again, opens it and copies its address.
  await viewer.getByTestId("viewer-open-externally").click();
  await openDocumentMenu(row);
  const menu = window.getByTestId("document-file-actions");
  await expect(menu.getByTestId("document.fetchAgain")).toBeVisible();
  await expect(menu.getByTestId("document.showInFolder")).toHaveCount(0);
  await menu.getByTestId("document.openLivePage").click();
  await expect.poll(() => urlsOpened(app)).toEqual([`${site}/tea`, `${site}/tea`]);
  await app.close();
});

test("a link pasted or dropped on a Folder in the sidebar is saved there; one that can't be fetched says why below", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await dismissChatSetup(window);
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createLibraryGroup({
      name: "Reading",
      description: "",
    }),
  );
  const folder = sidebarFolder(window, "Reading");
  const row = folder.getByTestId("folder-row");
  await row.click();
  await expect(folder).toHaveAttribute("data-expanded", "true");

  await row.focus();
  await paste(window, `${site}/tea-again`);
  await expect(folder).toHaveAttribute("data-count", "1");
  await expect(folder.getByTestId("document-list-item")).toContainText(TITLE);

  // Dragged over the window, the Folders stay in sight; dropped on one, it is saved there.
  await dragLink(row, `${site}/tea-dropped`, false);
  await expect(window.getByTestId("drop-overlay")).toContainText("drop it on a Folder");
  await expect(folder).toHaveAttribute("data-drop-target", "true");
  await screenshot(window, "web-page-drag");
  await dragLink(row, `${site}/tea-dropped`);
  await expect(window.getByTestId("drop-overlay")).toBeHidden();
  await expect(folder).toHaveAttribute("data-count", "2");

  await paste(window, `${site}/gone`);
  const problem = window.locator('[data-testid^="web-page-problem"]');
  await expect(problem).toContainText("Couldn’t fetch: the page doesn’t exist");
  await expect(problem.getByTestId("web-page-try-again")).toBeVisible();
  await screenshot(window, "web-page-pasted");
  await app.close();
});

test("with “Keep everything on this computer” on, a link pasted in the sidebar isn't fetched either: the status says so, in both languages, and Fetch this page once adds it", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await dismissChatSetup(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setLocalOnly(true);
    await bridge.createLibraryGroup({ name: "Reading", description: "" });
  });
  const folder = sidebarFolder(window, "Reading");
  await folder.getByTestId("folder-row").click();
  await folder.getByTestId("folder-row").focus();

  await paste(window, `${site}/tea-pasted`);
  const problem = window.locator('[data-testid^="web-page-problem"]');
  await expect(problem).toContainText(
    "Not fetched: “Keep everything on this computer” is on. It would contact",
  );
  expect(hits).toEqual([]);
  await expect(problem.getByRole("button", { name: "Don’t fetch" })).toBeVisible();
  await setLanguage(window, "zh-CN");
  await expect(problem).toContainText("未抓取：已开启“所有内容都留在这台电脑上”。抓取会连接");
  await expect(problem.getByTestId("web-page-fetch-once")).toHaveText("只抓取这一次");
  await setLanguage(window, "en");

  await problem.getByTestId("web-page-fetch-once").click();
  await expect(folder).toHaveAttribute("data-count", "1");
  await expect(problem).toHaveCount(0);
  await app.close();
});

test("an Answer cites a web page by section and paragraph; its card says the site and when it was fetched, and opens the snapshot at the quote", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home, web: port });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await interceptOpenExternal(app);
  await expect(await addWebPages(window, [`${site}/tea`])).toBeHidden();
  await expect(window.getByTestId("document-list-item").filter({ hasText: TITLE })).toHaveAttribute(
    "data-status",
    "ready",
  );

  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Who first brought tea to Amsterdam?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });

  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await citation.getByTestId("citation-chip").click();
  const card = window.getByTestId("citation-card");
  await expect(card.getByTestId("citation-badge")).toHaveText(/^Quote found in § History, ¶\s\d$/);
  await expect(card.getByTestId("citation-web-source")).toHaveText(
    /^The Open Encyclopedia · Fetched \d{1,2} \w{3,4} \d{4}$/,
  );
  const highlight = window.getByTestId("viewer").locator("[data-quote-highlight]").first();
  await expect(highlight).toBeVisible();
  await expect(highlight).toBeInViewport();
  await expect(window.getByTestId("viewer-quote-mark")).toBeVisible();
  await screenshot(window, "web-page-citation");

  await card.getByTestId("citation-open-live").click();
  await expect.poll(() => urlsOpened(app)).toEqual([`${site}/tea`]);
  await app.close();
});

test("with “Keep everything on this computer” on, a web page by address isn't fetched: one line says it would contact the site, and Fetch this page once adds it with the setting still on", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await dismissChatSetup(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setLocalOnly(true);
  });

  const address = `${site}/tea/茶`;
  const dialog = await addWebPages(window, [address]);
  const problem = dialog.getByTestId("add-web-page-problem");
  await expect(problem).toContainText(
    `Not fetched: “Keep everything on this computer” is on. It would contact 127.0.0.1:${port}.`,
  );
  await expect(problem.getByTestId("add-web-page-fetch-once")).toHaveText("Fetch this page once");
  await expect(problem.getByTestId("add-web-page-keep-local")).toHaveText("Don’t fetch");
  await screenshot(window, "web-page-local-mode");
  expect(hits).toEqual([]);
  await window.evaluate(() => document.documentElement.setAttribute("lang", "zh-CN"));

  await problem.getByTestId("add-web-page-fetch-once").click();
  await expect(dialog).toBeHidden();
  await expect(window.getByTestId("document-list-item").filter({ hasText: TITLE })).toHaveAttribute(
    "data-status",
    "ready",
  );
  expect(hits.filter((url) => url === "/tea/茶")).toHaveLength(1);
  expect(
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.getEmbeddingSettings()).localOnly;
    }),
  ).toBe(true);

  // Not fetched: the line goes.
  const second = await addWebPages(window, [`${site}/tea?again`]);
  await second.getByTestId("add-web-page-keep-local").click();
  await expect(second.getByTestId("add-web-page-problem")).toHaveCount(0);
  expect(hits.filter((url) => url.includes("again"))).toEqual([]);
  await app.close();
});
