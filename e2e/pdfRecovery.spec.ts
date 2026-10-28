import { realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const QUOTE = "The approved forecast is GBP 47,500.";
const ORIGINAL = buildPdf([
  { lines: ["Forecast review", "Prepared for the annual review."] },
  { lines: ["Approved forecast", QUOTE] },
  { lines: ["Review complete", "The forecast has three pages."] },
]);
const BROKEN = "%PDF-1.7\nSynthetic interrupted write: no catalog or pages.\n";
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function replaceFile(path: string, bytes: string | Uint8Array) {
  const next = `${path}.next`;
  await writeFile(next, bytes);
  await rename(next, path);
}

const documentState = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [document] = await bridge.listDocuments();
    if (!document) throw new Error("No Document.");
    const { id, contentHash, status, fileStatus } = document;
    return { id, contentHash, status, fileStatus };
  });

for (const language of ["en", "zh-CN"] as const) {
  test(`an open PDF recovers after exact-byte repair, including a background tab, in ${language}`, async () => {
    const path = join(sources, "Forecast review.pdf");
    await writeFile(path, ORIGINAL);
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1600, 800);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    const requests: string[] = [];
    window.on("request", (request) => {
      if (request.url().startsWith("incarnamind-document:")) requests.push(request.url());
    });
    const states: unknown[] = [];
    try {
      await window.getByTestId("add-documents-input").setInputFiles(path);
      const item = window.getByTestId("document-list-item");
      await expect(item).toHaveAttribute("data-status", "ready");
      const original = await documentState(window);
      const bridge = await coreOf(window);
      const indexed = await bridge.evaluate((core, id) => core.readDocumentText(id), original.id);
      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      const citation = {
        passageId: "forecast-page-2",
        documentId: original.id,
        documentName: "Forecast review",
        contentHash: original.contentHash,
        pageFrom: 2,
        pageTo: 2,
        location: null,
        quote: QUOTE,
        check: "found",
        checkReason: null,
      };
      await editor.evaluate((dom, attrs) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, {
          type: "paragraph",
          content: [
            { type: "text", text: attrs.quote },
            { type: "citation", attrs },
          ],
        });
      }, citation);
      const noteTab = window.locator('[role="tab"][data-kind="mind"]');
      await expect(editor.getByTestId("citation-chip")).toBeVisible();
      await pointAndClick(window, window.getByTestId("sidebar-home"));
      await expect(editor).toHaveCount(0);
      await pointAndClick(window, item.getByTestId("open-document"));
      const viewer = window.getByTestId("viewer");
      await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "true");
      for (let cycle = 1; cycle <= 2; cycle++) {
        await setWindowSize(app, window, 900, 800);
        await pointAndClick(window, window.getByTestId("sidebar-home"));
        await expect(viewer).toHaveCount(0);
        await replaceFile(path, BROKEN);
        await expect(item).toHaveAttribute("data-status", "failed", { timeout: 20_000 });
        states.push({
          stage: "failed",
          cycle,
          ...(await documentState(window)),
          requests: requests.length,
        });
        await pointAndClick(window, item.getByTestId("open-document"));
        // A damaged PDF says so in the same plain words as its Library row (#763), with the
        // reader's own message only on hover.
        const problem = viewer.getByTestId("viewer-problem");
        await expect(problem).toContainText(
          language === "en"
            ? "Damaged file: save a copy from your PDF app, then add it"
            : "文件已损坏：用 PDF 应用另存一份，再添加副本",
        );
        await expect(viewer.getByTestId("viewer-fix-open")).toHaveText(
          language === "en" ? "Open in default app" : "用默认应用打开",
        );
        await expect(problem.locator("[title]")).toHaveAttribute("title", /Invalid PDF structure/);
        expect(await bridge.evaluate((core, id) => core.readDocumentText(id), original.id)).toEqual(
          indexed,
        );
        if (cycle === 1) {
          await setWindowSize(app, window, 1600, 800);
          const retry = viewer.getByTestId("viewer-retry");
          if (SCREENSHOTS) {
            for (const width of [1600, 900]) {
              await setWindowSize(app, window, width, 800);
              await window.screenshot({
                path: join(SCREENSHOTS, `${language}-${width}-failed.png`),
              });
            }
          }
          for (const method of ["pointer", "keyboard", "palette"]) {
            const before = requests.length;
            if (method === "pointer") await pointAndClick(window, retry);
            else if (method === "keyboard") {
              // The line's two ways on, in order: open the file in its app, then read it again.
              await viewer.getByTestId("document-file-menu").focus();
              await window.keyboard.press("Tab");
              await expect(viewer.getByTestId("viewer-fix-open")).toBeFocused();
              await window.keyboard.press("Tab");
              await expect(retry).toBeFocused();
              await window.keyboard.press("Enter");
            } else {
              await retry.focus();
              await window.keyboard.press("ControlOrMeta+k");
              await expect(window.getByTestId("palette-search")).toBeFocused();
              await window.keyboard.type(language === "en" ? "Retry" : "重试");
              await expect(window.locator('[data-key="command:document.retry"]')).toHaveAttribute(
                "aria-selected",
                "true",
              );
              await window.keyboard.press("Enter");
              await expect(window.getByTestId("palette-search")).toHaveCount(0);
            }
            await expect.poll(() => requests.length).toBeGreaterThan(before);
            await expect(problem.locator("[title]")).toHaveAttribute(
              "title",
              /Invalid PDF structure/,
            );
            await expect(item).toHaveAttribute("data-status", "failed", { timeout: 20_000 });
          }
        }
        await replaceFile(path, ORIGINAL);
        await expect(item).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
        expect(await documentState(window)).toEqual(original);
        states.push({
          stage: "repaired",
          cycle,
          ...(await documentState(window)),
          requests: requests.length,
        });
        await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute(
          "data-drawn",
          "true",
        );
        await window.getByTestId("pdf-page-number").fill("2");
        await window.getByTestId("pdf-page-number").press("Enter");
        const page = viewer.locator('[data-page-number="2"]');
        await expect(page).toHaveAttribute("data-drawn", "true");
        await expect(page.locator(".textLayer")).toContainText(QUOTE);
        await expect(page).toBeInViewport();
        if (SCREENSHOTS && cycle === 1) {
          for (const width of [1600, 900]) {
            await setWindowSize(app, window, width, 800);
            await window.screenshot({
              path: join(SCREENSHOTS, `${language}-${width}-repaired.png`),
            });
          }
        }
        await pointAndClick(window, noteTab);
        await expect(editor.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
        const attributes = await editor.evaluate((dom) => {
          const citations: Record<string, unknown>[] = [];
          (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
            if (node.type.name === "citation") citations.push(node.attrs);
          });
          return citations;
        });
        expect(attributes).toHaveLength(1);
        expect(attributes[0]).toMatchObject(citation);
        await pointAt(window, editor.getByTestId("citation-chip"));
        const card = window.getByTestId("citation-card");
        await expect(card).toBeVisible();
        await pointAndClick(window, card.getByTestId("citation-open"));
        await expect(page).toHaveAttribute("data-drawn", "true");
        await expect(page.locator(".textLayer")).toContainText(QUOTE);
        await expect(page.locator("[data-quote-highlight]")).toContainText(QUOTE);
        await expect(page.locator("[data-quote-highlight]")).toBeInViewport();
        expect(await bridge.evaluate((core, id) => core.readDocumentText(id), original.id)).toEqual(
          indexed,
        );
        states.push({
          stage: "reopened",
          cycle,
          ...(await documentState(window)),
          requests: requests.length,
        });
      }
      await setWindowSize(app, window, 900, 800);
      await pointAndClick(window, window.getByTestId("sidebar-home"));
      await replaceFile(path, BROKEN);
      await expect(item).toHaveAttribute("data-status", "failed", { timeout: 20_000 });
      await pointAndClick(window, item.getByTestId("open-document"));
      await expect(viewer.getByTestId("viewer-retry")).toBeVisible();
      await pointAndClick(window, window.getByTestId("sidebar-home"));
      await replaceFile(path, ORIGINAL);
      await expect(item).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
      await pointAndClick(window, item.getByTestId("open-document"));
      await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "true");
      expect(await documentState(window)).toEqual(original);
    } finally {
      await test.info().attach("lifecycle", {
        body: JSON.stringify({ states, requests }, null, 2),
        contentType: "application/json",
      });
      if (SCREENSHOTS) {
        await writeFile(
          join(SCREENSHOTS, `${language}-lifecycle.json`),
          JSON.stringify({ states, requests }, null, 2),
        );
      }
      await replaceFile(path, ORIGINAL);
      await app.close();
    }
  });
}
