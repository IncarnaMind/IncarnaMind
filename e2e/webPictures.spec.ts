import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A saved web page keeps its article's pictures (#756), from a local server
 * standing in for the web: shown in place in the reader, a picture that
 * wasn't saved a labelled box, and a page over the limit says how many it
 * left out, in English and Chinese. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const REPORT = readFileSync(join(__dirname, "../tests/fixtures/web/report.html"));

function picture(width: number, height: number, label: string): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#e8eef5";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#1d3557";
  context.font = "28px sans-serif";
  context.fillText(label, 24, 48);
  return canvas.toBuffer("image/png");
}

const CHART = picture(400, 300, "Revenue by quarter");
const BERTH = picture(640, 480, "Deep-water berth");
const SMALL = picture(96, 96, "§");

/** A page of `count` pictures, more than a page keeps. */
const crowded = (count: number) =>
  `<!DOCTYPE html><html lang="en"><head><title>Every ship in port</title></head><body><article>
<h1>Every ship in port</h1>
<p>${"The harbour keeps a picture of every ship that calls, and this page shows the whole of the summer's list, one picture each, in the order they arrived. ".repeat(4)}</p>
${Array.from({ length: count }, (_, index) => `<figure><img src="http://images.harbour.example/ships/${index}.png" alt="Ship ${index + 1}"></figure>`).join("\n")}
</article></body></html>`;

let dataDir: string;
let home: string;
let server: Server;
let port: number;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  server = createServer((request, response) => {
    const url = request.url ?? "";
    const send = (body: Buffer | string, type: string) => {
      response.writeHead(200, { "Content-Type": type, Connection: "close" });
      response.end(body);
    };
    if (url === "/report") return send(REPORT, "text/html; charset=utf-8");
    if (url === "/ships") return send(crowded(61), "text/html; charset=utf-8");
    if (url === "/charts/revenue.png") return send(CHART, "image/png");
    if (url === "/harbour/berth.jpg") return send(BERTH, "image/png");
    if (url.startsWith("/ships/")) return send(SMALL, "image/png");
    response.writeHead(404, { Connection: "close" });
    response.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

async function add(window: Page, path: string, title: string) {
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const dialog = window.getByTestId("add-web-page-dialog");
  await dialog.getByTestId("add-web-page-addresses").fill(`http://127.0.0.1:${port}${path}`);
  await dialog.getByTestId("add-web-page-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  return window.getByTestId("document-list-item").filter({ hasText: title });
}

test("the article's pictures show in place in the reader, and one not saved is a labelled box, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const row = await add(window, "/report", "Harbour trade in 2026");
  await expect(row).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await row.getByTestId("open-document").click();

  const article = window.getByTestId("viewer").getByTestId("viewer-web-article");
  const pictures = article.getByTestId("web-picture");
  await expect(pictures).toHaveCount(2);
  await expect(pictures.nth(0)).toHaveAttribute("alt", "Revenue by quarter");
  await expect(pictures.nth(1)).toHaveAttribute("alt", "The new deep-water berth at dawn");
  // Drawn from the page's own files, as data, at their own size within the column.
  for (const each of await pictures.all()) {
    await expect(each).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect
      .poll(() => each.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
  }
  const chart = await pictures.nth(0).boundingBox();
  const column = await article.boundingBox();
  expect(chart?.width ?? 0).toBeLessThanOrEqual(400.5);
  expect((chart?.x ?? 0) + (chart?.width ?? 0)).toBeLessThanOrEqual(
    (column?.x ?? 0) + (column?.width ?? 0) + 0.5,
  );
  // The icon and the picture on a local network weren't saved: their descriptions, in a box.
  const boxes = article.locator(".document-image-placeholder");
  await expect(boxes.filter({ hasText: "thumbs up" })).toContainText("Not saved with the page");
  await expect(boxes.filter({ hasText: "A map from the office network" })).toBeVisible();
  await expect(window.getByTestId("viewer-web-left-out")).toHaveCount(0);
  await pictures.nth(0).scrollIntoViewIfNeeded();
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "web-pictures-en.png") });

  await setLanguage(window, "zh-CN");
  await expect(boxes.filter({ hasText: "thumbs up" })).toContainText("未随网页保存");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "web-pictures-zh-CN.png") });
  await app.close();
});

test("a page with more pictures than a page keeps says while their text is read, shows the first ones and says how many were left out, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const row = await add(window, "/ships", "Every ship in port");
  const status = row.getByTestId("document-status");
  await expect(status).toHaveAttribute(
    "title",
    /^Reading the text in 60 pictures… \d+ read so far\.$/,
  );
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "pictures-reading-en.png") });
  await setLanguage(window, "zh-CN");
  await expect(status).toHaveAttribute("title", /^正在识别 60 张图片中的文字…已识别 \d+ 张。$/);
  if (SCREENSHOTS) {
    await window.screenshot({ path: join(SCREENSHOTS, "pictures-reading-zh-CN.png") });
  }
  await expect(row).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await row.getByTestId("open-document").click();

  const article = window.getByTestId("viewer").getByTestId("viewer-web-article");
  await expect(article.getByTestId("web-picture")).toHaveCount(60);
  await expect(article.getByTestId("web-picture").last()).toHaveAttribute("alt", "Ship 60");
  const leftOut = window.getByTestId("viewer-web-left-out");
  await expect(leftOut).toHaveText("有 1 张图片超出单页上限，未保存");
  await setLanguage(window, "en");
  await expect(leftOut).toHaveText("1 picture wasn’t saved: over the limit for a page");
  await app.close();
});
