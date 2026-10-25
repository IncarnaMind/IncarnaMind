import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Keeping a saved web page as it looks, from a local server standing in for
 * the web at every host: off unless the User asks; asked, a PDF of the page
 * as a browser shows it, opened in the PDF view and back to its text. The
 * page's own script reports what the hidden page let it do, into the PDF,
 * and tries to reach this computer by a local name, by addresses written
 * for it, and by a name that resolves to it: the server hears none of that.
 * The hidden page is never one of the app's windows, and one that never
 * loads is given up at the time limit and closed. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

const ARTICLE = `<h1>Harbour trade in 2026</h1>
<p>${"The harbour handled more cargo in the first half of 2026 than in any half year since records began, the port authority said on Monday. ".repeat(3)}</p>
<p>${"Container traffic rose fastest, while bulk cargo held steady through the spring and the new berth opened a month ahead of plan. ".repeat(3)}</p>`;

/** Requests that would reach this computer: a local name, addresses written for it, a name resolving to it. */
const PROBES = ["/probe-localhost", "/probe-mapped", "/probe-nat64", "/probe-loopback"];

/**
 * Its script runs only in a browser: what it can do goes into the page, and
 * so into the PDF; its print would block it if a dialog opened; and its
 * requests to /beacon, /popup and /elsewhere tell the server it ran, or tried
 * to leave.
 */
const page = (
  title: string,
  port: number,
) => `<!DOCTYPE html><html lang="en"><head><title>${title}</title></head>
<body><article>${ARTICLE}<p id="sandbox"></p></article>
<script>
(async () => {
  const report = [];
  report.push("node:" + (typeof require === "undefined" && typeof process === "undefined" ? "none" : "present"));
  report.push("cookie:" + (document.cookie.includes("visited=") ? "kept" : "none"));
  document.cookie = "visited=1; path=/";
  let stored = "none";
  try { stored = localStorage.getItem("visited") ? "kept" : "none"; localStorage.setItem("visited", "1"); } catch { stored = "none"; }
  report.push("storage:" + stored);
  window.print();
  report.push("print:returned");
  const worker = new Worker(URL.createObjectURL(new Blob(['postMessage("worker:ran")'], { type: "text/javascript" })));
  report.push(await new Promise((resolve) => { worker.onmessage = (event) => resolve(event.data); }));
  const probe = (address) => fetch(address, { mode: "no-cors" }).catch(() => undefined);
  await Promise.all([
    probe("http://localhost.:${port}/probe-localhost"),
    probe("http://[::ffff:7f00:1]:${port}/probe-mapped"),
    probe("http://[64:ff9b::7f00:1]:${port}/probe-nat64"),
    probe("http://rebind.loopback.test:${port}/probe-loopback"),
    probe("http://other.example:${port}/probe-public"),
  ]);
  document.getElementById("sandbox").textContent = "Sandbox " + report.join(" ");
  new Image().src = "/beacon";
  window.open("/popup");
  location.href = "/elsewhere";
})();
</script></body></html>`;

let dataDir: string;
let home: string;
let server: Server;
let port: number;
let heard: { path: string; cookie: string | undefined }[];
/** Requests to /slow after the first never get an answer. */
let slowServed = 0;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  heard = [];
  slowServed = 0;
  server = createServer((request: IncomingMessage, response) => {
    const path = request.url ?? "";
    heard.push({ path, cookie: request.headers.cookie });
    const send = (body: string) => {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "served=1; Path=/",
        Connection: "close",
      });
      response.end(body);
    };
    if (path === "/report") return send(page("Harbour trade in 2026", port));
    if (path === "/again") return send(page("Harbour trade, again", port));
    if (path === "/slow") {
      slowServed += 1;
      if (slowServed === 1) return send(page("A page that never loads", port));
      return;
    }
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

async function add(window: Page, path: string, title: string, keepLook: boolean) {
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const dialog = window.getByTestId("add-web-page-dialog");
  await dialog.getByTestId("add-web-page-addresses").fill(`http://look.example:${port}${path}`);
  await dialog.getByTestId("add-web-page-keep-look").setChecked(keepLook);
  await dialog.getByTestId("add-web-page-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const row = window.getByTestId("document-list-item").filter({ hasText: title });
  await expect(row).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await row.getByTestId("open-document").click();
}

/** The app's windows, and every window, the hidden ones included. */
const windowCounts = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow, BrowserWindow }) => ({
    app: BrowserWindow.getAllWindows().length,
    all: BaseWindow.getAllWindows().length,
  }));

test("off by default: the box is unticked, a page saved is never loaded for its look, and the setting ticks it", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);

  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const dialog = window.getByTestId("add-web-page-dialog");
  await expect(dialog.getByTestId("add-web-page-keep-look")).not.toBeChecked();
  await expect(dialog.getByTestId("add-web-page-fetch")).toContainText(
    "Fetched once from this computer, kept as a Document.",
  );
  await dialog.getByTestId("add-web-page-fetch-details").click();
  const fetched = dialog.getByTestId("add-web-page-fetch-list");
  await expect(fetched).toContainText("Nothing else on the page is loaded.");
  await dialog.getByTestId("add-web-page-keep-look").check();
  await expect(fetched).not.toContainText("Nothing else on the page is loaded.");
  await expect(dialog).toContainText("the site sees a second visit");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await add(window, "/report", "Harbour trade in 2026", false);
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-web-title")).toHaveText("Harbour trade in 2026");
  await expect(viewer.getByTestId("viewer-web-look")).toHaveCount(0);
  await expect(viewer.getByTestId("viewer-web-look-failed")).toHaveCount(0);
  expect(heard.map((each) => each.path)).toEqual(["/report"]);

  const settings = await openSettings(window, "search");
  const section = settings.getByTestId("saved-web-pages-settings");
  await expect(section).toContainText("Saved web pages");
  const keep = section.getByTestId("keep-web-page-look-switch");
  await expect(keep).not.toBeChecked();
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "look-settings-en.png") });
  await setLanguage(window, "zh-CN");
  await expect(section).toContainText("保存的网页");
  await expect(section).toContainText("保留网页原貌");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "look-settings-zh-CN.png") });
  await keep.check();
  await setLanguage(window, "en");
  await closeSettings(window);

  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  await expect(dialog.getByTestId("add-web-page-keep-look")).toBeChecked();
  await motionSettled(window);
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "look-add-dialog-en.png") });
  await app.close();
});

test("asked, the page as it looked opens in the PDF view and back to its text; its hidden page reached no Node, cookies, storage, print dialog, other pages or this computer", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const windows = await windowCounts(app);

  await add(window, "/report", "Harbour trade in 2026", true);
  const viewer = window.getByTestId("viewer");
  const line = viewer.getByTestId("viewer-web-look");
  await expect(line).toHaveAttribute("data-status", "saved", { timeout: 30_000 });
  await expect(line).toContainText(/^Saved as it looked on \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2}/);
  await expect.poll(() => windowCounts(app)).toEqual(windows);
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "look-saved-en.png") });

  await viewer.getByTestId("viewer-web-show-look").click();
  await expect(viewer.getByTestId("viewer-web-look-bar")).toContainText("As it looked on");
  const pdfText = viewer.locator('[data-page-number="1"] .textLayer');
  await expect(pdfText).toContainText("Harbour trade in 2026");
  await expect(pdfText).toContainText(
    "Sandbox node:none cookie:none storage:none print:returned worker:ran",
  );
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "look-shown-en.png") });

  await setLanguage(window, "zh-CN");
  await expect(viewer.getByTestId("viewer-web-look-bar")).toContainText("的原貌");
  await expect(viewer.getByTestId("viewer-web-show-text")).toHaveText("查看文字");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "look-shown-zh-CN.png") });
  await viewer.getByTestId("viewer-web-show-text").click();
  await expect(viewer.getByTestId("viewer-web-title")).toHaveText("Harbour trade in 2026");
  await expect(viewer.getByTestId("viewer-web-show-look")).toHaveText("查看原貌");
  await setLanguage(window, "en");

  // A second page, in the same hidden window's session: nothing the first one kept is there.
  await add(window, "/again", "Harbour trade, again", true);
  await expect(line).toHaveAttribute("data-status", "saved", { timeout: 30_000 });
  await viewer.getByTestId("viewer-web-show-look").click();
  await expect(pdfText).toContainText(
    "Sandbox node:none cookie:none storage:none print:returned worker:ran",
  );

  const paths = heard.map((each) => each.path);
  expect(paths.filter((path) => path === "/beacon")).toHaveLength(2);
  for (const probe of PROBES) expect(paths).not.toContain(probe);
  // The same request to a public host goes through: what stopped the others is the guard.
  expect(paths).toContain("/probe-public");
  expect(paths).not.toContain("/popup");
  expect(paths).not.toContain("/elsewhere");
  expect(heard.filter((each) => each.path === "/again").map((each) => each.cookie)).toEqual([
    undefined,
    undefined,
  ]);
  await app.close();
});

test("no window of the app gives a site a certificate of the User's, and none asks", async () => {
  const { app } = await launchApp(dataDir, { home, web: port });
  const answered = await app.evaluate(
    ({ app: electron }) =>
      new Promise<{ prevented: boolean; certificate: unknown }>((resolve) => {
        let prevented = false;
        electron.emit(
          "select-client-certificate",
          { preventDefault: () => (prevented = true) },
          null,
          "https://bank.example/",
          [{ subjectName: "Priya Raman", issuerName: "Corporate MDM" }],
          (certificate?: unknown) => resolve({ prevented, certificate: certificate ?? null }),
        );
      }),
  );
  expect(answered).toEqual({ prevented: true, certificate: null });
  await app.close();
});

test("a page that never finishes loading is given up at the time limit, its hidden page, never one of the app's windows, closed, with Try again", async () => {
  const { app, window } = await launchApp(dataDir, { home, web: port, lookLimit: 8_000 });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const windows = await windowCounts(app);

  await add(window, "/slow", "A page that never loads", true);
  await expect.poll(() => windowCounts(app)).toEqual({ app: windows.app, all: windows.all + 1 });
  const viewer = window.getByTestId("viewer");
  const failed = viewer.getByTestId("viewer-web-look-failed");
  await expect(failed).toContainText("didn’t finish loading", { timeout: 30_000 });
  await expect(failed.getByTestId("viewer-web-look-try-again")).toBeVisible();
  await expect.poll(() => windowCounts(app)).toEqual(windows);
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "look-failed-en.png") });
  await setLanguage(window, "zh-CN");
  await expect(failed).toContainText("未能保存网页原貌");
  await app.close();
});
