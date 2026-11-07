import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Pictures at full size (#2377): a plot in a Note and in an Answer, and a
 * Document's picture, each opening over the window in one viewer with its
 * source, zoom, steps, Copy and Save picture…, and closing back to the
 * picture. A click on a Note picture still selects it, and a drag in an Answer
 * or a Document still selects.
 */

/** Keeps the window's picture for the pull request, when INCARNAMIND_SHOTS names a folder. */
async function shot(window: Page, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SHOTS;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}

/** A picture of a size a person sees: a gradient, as a PNG, written without a library. */
function gradientPng(size: number, tint: number): Buffer {
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 3 + 1);
    rows[at] = 0;
    for (let x = 0; x < size; x++) {
      rows[at + 1 + x * 3] = (x * 4) % 256;
      rows[at + 2 + x * 3] = (y * 4) % 256;
      rows[at + 3 + x * 3] = (128 + tint) % 256;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 64 × 64 picture, as the `data:` URL a Note keeps. */
const pictureUrl = (tint: number): string =>
  `data:image/png;base64,${gradientPng(64, tint).toString("base64")}`;

/** The natural size of a PNG, read from its header. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/**
 * A Note with two pictures of its own (a plot written into it, and one with
 * no description) and a Question whose Answer holds two plots, made through
 * the core's bridge in the stored shape, as an Analysis's pictures arrive.
 */
async function seedNote(window: Page, title: string): Promise<void> {
  const doc = new Y.Doc();
  const text = (value: string) => {
    const element = new Y.XmlElement("paragraph");
    element.setAttribute("id", crypto.randomUUID());
    element.insert(0, [new Y.XmlText(value)]);
    return element;
  };
  const picture = (alt: string, tint: number) => {
    const element = new Y.XmlElement("picture");
    element.setAttribute("id", crypto.randomUUID());
    element.setAttribute("src", pictureUrl(tint));
    element.setAttribute("alt", alt);
    element.setAttribute("width", "64");
    element.setAttribute("height", "64");
    return element;
  };
  const questionId = crypto.randomUUID();
  const question = new Y.XmlElement("question");
  question.setAttribute("id", questionId);
  question.insert(0, [new Y.XmlText("What did the tides do?")]);
  const answer = new Y.XmlElement("answer");
  answer.setAttribute("id", crypto.randomUUID());
  answer.setAttribute("questionId", questionId);
  answer.setAttribute("status", "done");
  answer.insert(0, [
    text("The plot:"),
    picture("Revenue against ad spend", 20),
    picture("", 40),
    text("That is all."),
  ]);
  doc
    .getXmlFragment("blocks")
    .push([
      text("The harbour at dawn."),
      picture("A chart of spring tides", 0),
      picture("", 10),
      question,
      answer,
    ]);
  await window.evaluate(
    async ({ name, update }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await bridge.createMind({ title: name });
      await bridge.applyMindUpdate(mind.id, new Uint8Array(update));
    },
    { name: title, update: Array.from(Y.encodeStateAsUpdate(doc)) },
  );
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
  await expect(frontMindName(window)).toHaveText(title);
  await expect(window.getByTestId("mind-picture")).toHaveCount(4);
}

/** Starts the app on a Note with the two pictures of its own and the Answer's two. */
async function startWithNote(language: "en" | "zh-CN", width: number) {
  const running = await launchApp(dataDir);
  const { app, window } = running;
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 760);
  await seedNote(window, language === "en" ? "Tide notes" : "潮汐笔记");
  return { ...running, window };
}

const viewer = (window: Page) => window.getByTestId("picture-viewer");
const viewerImage = (window: Page) => window.getByTestId("picture-viewer-image");
const source = (window: Page) => window.getByTestId("picture-viewer-source");
const count = (window: Page) => window.getByTestId("picture-viewer-count");

/** Stubs the clipboard, so a test reads the image Copy wrote and the computer's own stays as it was. */
async function stubPictureClipboard(window: Page) {
  await window.evaluate(() => {
    const copied: { type: string; bytes: number[] }[] = [];
    (globalThis as { copiedPictures?: unknown }).copiedPictures = copied;
    navigator.clipboard.write = async (items: ClipboardItem[]) => {
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          copied.push({ type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
        }
      }
    };
  });
}

const copiedPictures = (window: Page) =>
  window.evaluate(
    () =>
      (globalThis as { copiedPictures?: { type: string; bytes: number[] }[] }).copiedPictures ?? [],
  );

/** The picture's own size, as the viewer shows it. */
async function shownWidth(window: Page): Promise<number> {
  return Math.round((await viewerImage(window).boundingBox())?.width ?? 0);
}

test("a Note's two pictures open from the keyboard, step, zoom, copy, save and close back to the picture", async () => {
  const { app, window } = await startWithNote("en", 1600);
  try {
    const pictures = window.getByTestId("mind-picture");
    const first = pictures.nth(0);
    const second = pictures.nth(1);
    await shot(window, "picture-viewer-before");

    // A click selects the picture like any Block, and opens nothing.
    await pointAndClick(window, first.getByTestId("mind-picture-image"));
    await expect(first).toHaveAttribute("data-picture-selected", "true");
    await expect(viewer(window)).toBeHidden();

    // Space opens it at full size; it grows out of the picture, never past twice its pixels.
    await window.keyboard.press("Space");
    await expect(viewer(window)).toBeVisible();
    await motionSettled(window);
    await expect(source(window)).toHaveText("A chart of spring tides");
    await expect(count(window)).toHaveText("1 of 2");
    expect(
      await viewerImage(window).evaluate((image: HTMLImageElement) => ({
        width: image.naturalWidth,
        height: image.naturalHeight,
      })),
    ).toEqual({ width: 64, height: 64 });
    expect(await shownWidth(window)).toBeGreaterThan(120);
    expect(await shownWidth(window)).toBeLessThanOrEqual(128.5);
    // Fitted 48 px clear of the window's edges, under a 44 px bar.
    const panel = await window.locator("[data-picture-viewer-panel]").boundingBox();
    const screen = await window.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    expect(panel?.x ?? 0).toBeGreaterThanOrEqual(47);
    expect(panel?.y ?? 0).toBeGreaterThanOrEqual(47);
    expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(screen.width - 47);
    expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual(screen.height - 47);
    await expect(window.getByTestId("picture-viewer-bar")).toHaveCSS("height", "44px");
    await shot(window, "picture-viewer-note-en");

    // ⌘+ zooms in; ⌘0 fits it again.
    await window.keyboard.press("ControlOrMeta+=");
    await expect.poll(() => shownWidth(window)).toBeGreaterThan(128);
    await window.keyboard.press("ControlOrMeta+0");
    await expect.poll(() => shownWidth(window)).toBe(128);

    // → steps to the Note's next picture and stops at the end; ← comes back.
    await window.keyboard.press("ArrowRight");
    await expect(source(window)).toHaveText("Picture 2 in this Note");
    await expect(count(window)).toHaveText("2 of 2");
    await window.keyboard.press("ArrowRight");
    await expect(count(window)).toHaveText("2 of 2");
    await window.keyboard.press("ArrowLeft");
    await expect(source(window)).toHaveText("A chart of spring tides");

    // ⌘C copies the picture as a PNG at its own pixels.
    await stubPictureClipboard(window);
    await window.keyboard.press("ControlOrMeta+c");
    await expect.poll(async () => (await copiedPictures(window)).length).toBe(1);
    const [copied] = await copiedPictures(window);
    expect(copied?.type).toBe("image/png");
    expect(pngSize(Buffer.from(copied?.bytes ?? []))).toEqual({ width: 64, height: 64 });
    await expect(window.getByTestId("copied-line")).toContainText("Copied");

    // The Edit menu's Copy is the picture's while the viewer is open, and copies the same image.
    await stubPictureClipboard(window);
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("picture.copy") !== null,
        ),
      )
      .toBe(true);
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.getMenuItemById("picture.copy")?.click(),
    );
    await expect.poll(async () => (await copiedPictures(window)).length).toBe(1);
    expect((await copiedPictures(window))[0]?.type).toBe("image/png");

    // Esc closes it, and the focus goes back to the picture.
    await window.keyboard.press("Escape");
    await expect(viewer(window)).toBeHidden();
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.getAttribute("data-testid")))
      .toBe("mind-picture-image");

    // Space closes it too.
    await window.keyboard.press("Space");
    await expect(viewer(window)).toBeVisible();
    await window.keyboard.press("Space");
    await expect(viewer(window)).toBeHidden();
    await expect
      .poll(() => window.evaluate(() => document.querySelectorAll("dialog[open]").length))
      .toBe(0);

    // ⌘K offers "Open picture" while a picture is selected, and opens it.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(">open picture");
    const offered = window.locator('[data-key="command:picture.open"]');
    await expect(offered).toContainText("Open picture");
    await pointAndClick(window, offered);
    await expect(viewer(window)).toBeVisible();
    await motionSettled(window);

    // The bar's buttons are in Tab order: Copy, Save picture…, ✕. ✕ closes from the keyboard.
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("picture-viewer-copy")).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("picture-viewer-save")).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("picture-viewer-close")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(viewer(window)).toBeHidden();

    // Saving by keyboard writes a PNG named after the picture's source, at its own pixels.
    const savedPath = join(dataDir, "plot.png");
    await app.evaluate(({ dialog }, chosen) => {
      const asked: { defaultPath?: string }[] = [];
      (globalThis as { saveAsked?: unknown }).saveAsked = asked;
      dialog.showSaveDialog = (async (_window: unknown, options: { defaultPath?: string }) => {
        asked.push(options);
        return { canceled: false, filePath: chosen };
      }) as unknown as typeof dialog.showSaveDialog;
    }, savedPath);
    await window.keyboard.press("Space");
    await expect(viewer(window)).toBeVisible();
    await window.keyboard.press("Tab");
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("picture-viewer-save")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect
      .poll(() => {
        try {
          return pngSize(readFileSync(savedPath));
        } catch {
          return null;
        }
      })
      .toEqual({ width: 64, height: 64 });
    const [asked] = await app.evaluate(
      () => (globalThis as { saveAsked?: { defaultPath?: string }[] }).saveAsked ?? [],
    );
    expect(asked?.defaultPath?.endsWith("A chart of spring tides.png")).toBe(true);
    await expect(window.getByTestId("copied-line")).toContainText("Saved the picture");
    await window.keyboard.press("Escape");
    await expect(viewer(window)).toBeHidden();

    // A double-click and the hover button open it from the Note too.
    await second.getByTestId("mind-picture-image").dblclick();
    await expect(viewer(window)).toBeVisible();
    await expect(source(window)).toHaveText("Picture 2 in this Note");
    await window.keyboard.press("Escape");
    await expect(viewer(window)).toBeHidden();
    await first.hover();
    await pointAndClick(window, first.getByTestId("picture-expand"));
    await expect(viewer(window)).toBeVisible();

    // A press on the scrim closes it.
    await motionSettled(window);
    await window.mouse.click(20, 300);
    await expect(viewer(window)).toBeHidden();
    await shot(window, "picture-viewer-after");

    // Under reduced motion it still opens and closes, by the shared module's fade.
    await window.emulateMedia({ reducedMotion: "reduce" });
    await expect(window.locator("html")).toHaveAttribute("data-motion", "reduced");
    await first.hover();
    await pointAndClick(window, first.getByTestId("picture-expand"));
    await expect(viewer(window)).toBeVisible();
    await motionSettled(window);
    await window.keyboard.press("Escape");
    await expect(viewer(window)).toBeHidden();
  } finally {
    await app.close();
  }
});

test("an Answer's plot opens on a click at 900 px in Chinese, and a drag still selects its words", async () => {
  const { app, window } = await startWithNote("zh-CN", 900);
  try {
    const plot = window.getByTestId("mind-picture").nth(2);
    await plot.getByTestId("mind-picture-image").click();
    await expect(viewer(window)).toBeVisible();
    await motionSettled(window);
    await expect(source(window)).toHaveText("本回答中的第 1 张图");
    await expect(count(window)).toHaveText("1 / 2");
    await shot(window, "picture-viewer-answer-zh-900");
    await window.keyboard.press("ArrowRight");
    await expect(source(window)).toHaveText("本回答中的第 2 张图");
    await window.keyboard.press("Escape");
    await expect(viewer(window)).toBeHidden();

    // A drag across the Answer's picture selects its words, as every drag in an Answer does, and opens nothing.
    const answer = window.getByTestId("answer");
    const from = await answer.locator("p").first().boundingBox();
    const to = await answer.locator("p").last().boundingBox();
    if (!from || !to) throw new Error("The Answer's words aren't in view.");
    await window.mouse.move(from.x + 2, from.y + from.height / 2);
    await window.mouse.down();
    await window.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 12 });
    await window.mouse.up();
    await expect(viewer(window)).toBeHidden();
    expect(await window.evaluate(() => globalThis.getSelection()?.toString() ?? "")).not.toBe("");
  } finally {
    await app.close();
  }
});

const PAGE = `<!DOCTYPE html><html lang="en"><head><title>Harbour trade in 2026</title></head><body>
<article><h1>Harbour trade in 2026</h1><h2>Results</h2>
<p>The harbour handled more cargo in the first half of 2026 than in any half year since records began, the port authority said on Monday. Container traffic rose fastest, while bulk cargo held steady through the spring.</p>
<figure><img src="http://images.harbour.example/charts/revenue.png" alt="Revenue by quarter" width="64" height="64"></figure>
<p>The new deep-water berth opened in May, a month ahead of plan, and shipping lines added two weekly services. The authority expects the second half to be busier still as the autumn harvest is shipped.</p>
<p>Revenue grew in every quarter, and the chart above shows it by quarter, with the container share marked. Shares of the port operator rose after the figures were published.</p>
<figure><img src="http://cdn.harbour.example/harbour/berth.png" alt="The new deep-water berth at dawn" width="64" height="64"></figure>
<h2>Outlook</h2>
<p>The authority expects cargo volumes to keep growing next year, helped by the new berth and by a rail link to the inland terminal that opens in the spring. It will publish its full-year figures in February.</p>
</article></body></html>`;

test("a Document's picture opens at full size with its figure, and a drag still selects an area to ask about", async () => {
  const picture = gradientPng(64, 30);
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "";
    if (url === "/report") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(PAGE);
      return;
    }
    if (url === "/charts/revenue.png" || url === "/harbour/berth.png") {
      response.writeHead(200, { "Content-Type": "image/png", Connection: "close" });
      response.end(picture);
      return;
    }
    response.writeHead(404, { Connection: "close" });
    response.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const running = await launchApp(dataDir, { web: port });
  const { app, window } = running;
  try {
    await setWindowSize(app, window, 1600, 900);
    await dismissChatSetup(window);
    await window.getByTestId("plus-menu").click();
    await window.getByTestId("plus-more").click();
    await window.getByTestId("plus-add-web-page").click();
    const dialog = window.getByTestId("add-web-page-dialog");
    await dialog.getByTestId("add-web-page-addresses").fill(`http://127.0.0.1:${port}/report`);
    await dialog.getByTestId("add-web-page-confirm").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const row = window
      .getByTestId("document-list-item")
      .filter({ hasText: "Harbour trade in 2026" });
    await expect(row).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    await pointAndClick(window, row.getByTestId("open-document"));

    const pictures = window.getByTestId("web-picture");
    await expect(pictures).toHaveCount(2);
    await pointAndClick(window, pictures.nth(0));
    await expect(viewer(window)).toBeVisible();
    await motionSettled(window);
    await expect(source(window)).toHaveText("Harbour trade in 2026 · figure 1");
    await expect(count(window)).toHaveText("1 of 2");
    await window.keyboard.press("ArrowRight");
    await expect(source(window)).toHaveText("Harbour trade in 2026 · figure 2");
    await shot(window, "picture-viewer-document-en");
    await window.keyboard.press("Escape");
    await expect(viewer(window)).toBeHidden();

    // ⌥ drag over the picture still selects an area to ask about, and opens nothing.
    const box = await pictures.nth(0).boundingBox();
    if (!box) throw new Error("The page's picture isn't in view.");
    await window.keyboard.down("Alt");
    await window.mouse.move(box.x + 2, box.y + 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 12 });
    await window.mouse.up();
    await window.keyboard.up("Alt");
    await expect(window.getByTestId("composer-area-chip")).toBeVisible();
    await expect(viewer(window)).toBeHidden();
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
