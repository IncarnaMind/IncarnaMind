import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A saved web page's chart is read on this computer (#756): a Question about
 * what it shows gets a Citation to "§ Results, figure 1", whose card says it
 * was read from a picture, and opening it outlines the chart, in English and
 * Chinese. The stand-in for the text recognition model reads the chart.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const REPORT = readFileSync(join(__dirname, "../tests/fixtures/web/report.html"));
const CHART_LINES = ["Container revenue by quarter", "Second quarter container revenue: 44.9"];

function chart(): Buffer {
  const canvas = createCanvas(400, 300);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 400, 300);
  context.fillStyle = "#1d3557";
  context.font = "18px sans-serif";
  context.fillText("Container revenue by quarter", 24, 36);
  for (const [index, height] of [150, 170, 190, 210].entries()) {
    context.fillStyle = index === 1 ? "#e76f51" : "#457b9d";
    context.fillRect(48 + index * 84, 270 - height, 56, height);
  }
  context.fillStyle = "#1d3557";
  context.font = "16px sans-serif";
  context.fillText("44.9", 140, 92);
  return canvas.toBuffer("image/png");
}

const photo = () => createCanvas(640, 480).toBuffer("image/png");

let dataDir: string;
let home: string;
let server: Server;
let port: number;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  server = createServer((request, response) => {
    const send = (body: Buffer | string, type: string) => {
      response.writeHead(200, { "Content-Type": type, Connection: "close" });
      response.end(body);
    };
    if (request.url === "/report") return send(REPORT, "text/html; charset=utf-8");
    if (request.url === "/charts/revenue.png") return send(chart(), "image/png");
    if (request.url === "/harbour/berth.jpg") return send(photo(), "image/png");
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

async function addPage(window: Page): Promise<void> {
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const dialog = window.getByTestId("add-web-page-dialog");
  await dialog.getByTestId("add-web-page-addresses").fill(`http://127.0.0.1:${port}/report`);
  await dialog.getByTestId("add-web-page-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "Harbour trade in 2026" }),
  ).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
}

test("a chart's text is cited as its section and figure, its card says it was read from a picture, and opening it outlines the chart, in English and Chinese", async () => {
  const script = join(home, "scans.json");
  await writeFile(script, JSON.stringify({ pages: { "1": { lines: CHART_LINES } } }));
  const { app, window } = await launchApp(dataDir, {
    home,
    web: port,
    fakeChat: true,
    scans: script,
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addPage(window);

  await newMind(window);
  await window.getByTestId("mind-editor").click();
  const answer = await askInAssistant(window, "What was the second quarter container revenue?");
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
    "aria-label",
    /§ Results, figure\s1/,
  );

  await citation.getByTestId("citation-chip").hover();
  const card = window.getByTestId("citation-card");
  await expect(card.getByTestId("citation-scan")).toHaveText("Read from a picture");

  await citation.getByTestId("citation-chip").click();
  const chart = window
    .getByTestId("viewer")
    .getByTestId("web-picture")
    .and(window.locator('[data-figure="1"]'));
  await expect(chart).toHaveAttribute("data-cited", "");
  await expect(chart).toBeInViewport();
  const outline = await chart.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).toBe("solid");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "picture-cited-en.png") });

  await setLanguage(window, "zh-CN");
  await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
    "aria-label",
    /§ Results，图 1/,
  );
  await expect(chart).toHaveAttribute("data-cited", "");
  await expect(chart).toBeInViewport();
  await citation.getByTestId("citation-chip").hover();
  await expect(card.getByTestId("citation-scan")).toHaveText("从图片中识别");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "picture-cited-zh-CN.png") });
  await app.close();
});
