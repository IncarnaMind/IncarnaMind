/**
 * UI audit, part A: walks the app as a person does (the mouse slides in steps,
 * hovers before it clicks; keys are typed with a person's delays) and saves a
 * screenshot of every surface, with contrast, focus and overflow probes.
 * Each step records its own failure and the walk goes on.
 */
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../../src/core/api";
import { offeredSettingsPages, settingsPages } from "../../src/renderer/src/settingsPages";
import type { TestHooks } from "../../src/shared/testHooks";
import { writeFixtures } from "./fixtures";
import {
  answerOpenDialog,
  click,
  close,
  contrastScan,
  focusWalk,
  glide,
  type Launched,
  launch,
  record,
  removeDir,
  sealShell,
  setWindowSize,
  shot,
  startFrames,
  tempDir,
  typeLike,
} from "./harness";

const failures: { test: string; step: string; error: string }[] = [];
const contrast: Record<string, unknown> = {};

async function step(testName: string, name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    const message =
      error instanceof Error
        ? stripVTControlCharacters(error.message)
            .split("\n")
            .filter((line) => line.trim())
            .slice(0, 4)
            .join(" | ")
        : String(error);
    failures.push({ test: testName, step: name, error: message ?? "" });
    record("walk.failures", failures);
  }
}

async function scan(window: Page, name: string) {
  const result = await contrastScan(window);
  contrast[name] = result;
  record("walk.contrast", contrast);
}

/** Waits until every Document is processed (ready or failed), polling the core every second. */
async function documentsSettled(window: Page, expected: number, timeout = 180_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const states = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const docs = await bridge.listDocuments();
      return docs.map((doc) => doc.status);
    });
    const done = states.filter((s) => s === "ready" || s === "failed").length;
    if (states.length >= expected && done === states.length) return states;
    if (Date.now() > until) throw new Error(`Documents not settled: ${done}/${states.length}`);
    await window.waitForTimeout(1000);
  }
}

/** Overflow probe: elements whose text is cut off or that spill out of their parent. */
function overflowProbe(window: Page) {
  return window.evaluate(() => {
    const out: { where: string; text: string; kind: string }[] = [];
    const describe = (el: Element) => {
      const id =
        el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid");
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}`;
    };
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight) continue;
      const style = getComputedStyle(el);
      if (
        style.visibility === "hidden" ||
        el.closest("[aria-hidden='true'],svg,canvas,.katex,[data-testid='viewer']")
      )
        continue;
      const text =
        el.childNodes.length &&
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())
          ? (el.textContent ?? "").trim().slice(0, 50)
          : "";
      if (!text) continue;
      const clipsX = el.scrollWidth > el.clientWidth + 1 && style.overflowX !== "visible";
      const ellipsis = style.textOverflow === "ellipsis";
      if (clipsX && !ellipsis)
        out.push({ where: describe(el), text, kind: "clipped without ellipsis" });
      if (
        el.scrollHeight > el.clientHeight + 2 &&
        style.overflowY === "hidden" &&
        !style.webkitLineClamp?.match(/\d/)
      ) {
        out.push({ where: describe(el), text, kind: "cut vertically" });
      }
      // Spills out of the window.
      if (rect.right > innerWidth + 1)
        out.push({ where: describe(el), text, kind: "past the window's right edge" });
    }
    return out.slice(0, 40);
  });
}

/** Hover / pressed / disabled styles of a control. */
async function states(window: Page, target: Locator) {
  const read = () =>
    target.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        bg: s.backgroundColor,
        color: s.color,
        cursor: s.cursor,
        opacity: s.opacity,
        outline: s.outlineStyle,
      };
    });
  const rest = await read();
  await glide(window, target);
  await window.waitForTimeout(150);
  const hover = await read();
  await window.mouse.down();
  await window.waitForTimeout(60);
  const active = await read();
  // Move off before releasing, so nothing is clicked.
  await window.mouse.move(2, 400, { steps: 6 });
  await window.mouse.up();
  return { rest, hover, active };
}

async function chooseFakeModel(window: Page) {
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
  });
}

/** Writes a Question in the composer (⌘J), asks it with Enter, and waits for its Answer in the assistant. */
async function ask(window: Page, question: string, index: number) {
  await window.keyboard.press("ControlOrMeta+j");
  await typeLike(window, question, 45);
  await window.keyboard.press("Enter");
  const answer = window.getByTestId("assistant-answer").nth(index);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  return answer;
}

/** Puts the cursor at the end of the Mind, on a fresh line. */
async function endOfMind(window: Page) {
  const editor = window.getByTestId("mind-editor");
  const last = editor.locator(":scope > p").last();
  await click(window, last, { x: 6, y: 14 });
  await window.keyboard.press("End");
}

test.describe.configure({ mode: "serial" });

test("A1 first run: the example Mind and its Citation card", async () => {
  const T = "A1";
  const dataDir = tempDir("data");
  let app: Launched | undefined;
  try {
    app = await launch(dataDir, { examples: true });
    const { window } = app;
    await sealShell(app.app);
    await step(T, "example mind", async () => {
      await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
        "Draft: credit committee paper",
        { timeout: 20_000 },
      );
      await expect(window.getByTestId("claim-mark")).toHaveCount(1, { timeout: 20_000 });
      await window.mouse.move(700, 400);
      await shot(window, "A01-first-run-example-mind");
      await scan(window, "A01-first-run-example-mind");
    });
    await step(T, "hover a citation marker", async () => {
      const chip = window.getByTestId("citation-chip").first();
      await glide(window, chip);
      await window.waitForTimeout(300);
      await shot(window, "A02-citation-marker-hover");
    });
    await step(T, "citation card from keyboard focus", async () => {
      await window.mouse.move(700, 400, { steps: 6 });
      await window.getByTestId("citation-chip").first().focus();
      const card = window.getByTestId("citation-card");
      await expect(card).toBeVisible();
      await window.waitForTimeout(250);
      await shot(window, "A03-citation-card");
      await scan(window, "A03-citation-card");
      await window.keyboard.press("Escape");
      await window.waitForTimeout(250);
      record("walk.escape.citationCard", { closes: !(await card.isVisible()) });
    });
    await step(T, "the first open's steps", async () => {
      const card = window.getByTestId("first-open-steps");
      await expect(card).toBeVisible();
      await shot(card, "A04-first-open-steps");
    });
    await step(T, "focus walk from the window", async () => {
      await window.mouse.click(5, 5);
      const stops = await focusWalk(window, 45, "focus/A05");
      record("walk.focus.exampleMind", stops);
    });
    await step(
      T,
      "the ready question: the assistant with its Answer, written in advance",
      async () => {
        await window.keyboard.press("Escape");
        await click(window, window.getByTestId("first-open-ready"));
        const answer = window.getByTestId("assistant-answer").last();
        await expect(answer).toHaveAttribute("data-status", "done");
        await window.waitForTimeout(300);
        await shot(window, "A06-ready-question");
      },
    );
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
  }
});

test("A2 first run without examples: chat setup, the empty Mind, Settings", async () => {
  const T = "A2";
  const dataDir = tempDir("data");
  let app: Launched | undefined;
  try {
    app = await launch(dataDir);
    const { window } = app;
    await sealShell(app.app);
    await step(T, "model setup card at the first own Question", async () => {
      await click(window, window.getByTestId("plus-menu"));
      await click(window, window.getByTestId("plus-new-mind"));
      await window.getByTestId("mind-editor").click();
      await window.keyboard.press("ControlOrMeta+j");
      await window.keyboard.type("What is in my Documents?");
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("model-setup")).toBeVisible({ timeout: 15_000 });
      await shot(window, "A10-model-setup");
      await scan(window, "A10-model-setup");
      const stops = await focusWalk(window, 14, "focus/A10");
      record("walk.focus.modelSetup", stops);
    });
    await step(T, "set up later", async () => {
      await click(window, window.getByTestId("setup-later"));
      await expect(window.getByTestId("model-setup")).toBeHidden();
      await window.waitForTimeout(400);
      await shot(window, "A11-after-set-up-later");
      await scan(window, "A11-after-set-up-later");
    });
    await step(T, "empty Mind", async () => {
      await click(window, window.getByTestId("plus-menu"));
      await click(window, window.getByTestId("plus-new-mind"));
      await expect(window.getByTestId("mind-editor")).toBeVisible();
      await window.waitForTimeout(500);
      await shot(window, "A12-empty-mind");
      await scan(window, "A12-empty-mind");
      record("walk.emptyMind.readiness", {
        chatReadinessNotice: await window.getByTestId("chat-readiness").count(),
      });
    });
    await step(T, "documents empty state", async () => {
      await shot(window.getByTestId("sidebar"), "A13-sidebar-empty");
    });
    await step(T, "Settings, every page", async () => {
      await click(window, window.getByRole("button", { name: "Settings", exact: true }));
      const settings = window.getByTestId("settings");
      await expect(settings).toBeVisible();
      for (const page of settingsPages) {
        const nav = settings.getByTestId(`settings-nav-${page}`);
        if (!(await nav.count())) continue;
        await click(window, nav);
        await expect(settings).toHaveAttribute("data-page", page);
        await window.waitForTimeout(700);
        await shot(window, `A14-settings-${page}`);
        await scan(window, `A14-settings-${page}`);
        // Long pages: the bottom too.
        const body = settings.getByTestId(`settings-page-${page}`);
        const tall = await body
          .evaluate((el) => el.scrollHeight > el.clientHeight + 40)
          .catch(() => false);
        if (tall) {
          await glide(window, body);
          await window.mouse.wheel(0, 4000);
          await window.waitForTimeout(300);
          await shot(window, `A14-settings-${page}-end`);
        }
      }
      const stops = await focusWalk(window, 20, "focus/A14");
      record("walk.focus.settings", stops);
      await window.keyboard.press("Escape");
      await window.waitForTimeout(300);
      record("walk.escape.settings", { closes: !(await settings.isVisible()) });
    });
    await step(T, "focus walk in an empty Mind window", async () => {
      await window.mouse.click(5, 5);
      record("walk.focus.emptyMind", await focusWalk(window, 30));
    });
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
  }
});

test("A3 a working session: a Linked folder, Answers with Citations, the viewer, Library, Tags, export, states", async () => {
  test.setTimeout(25 * 60_000);
  const T = "A3";
  const dataDir = tempDir("data");
  const root = tempDir("fixtures");
  const fixtures = writeFixtures(root, 0);
  let app: Launched | undefined;
  try {
    app = await launch(dataDir, { fakeChat: true });
    const { window } = app;
    await sealShell(app.app);
    await chooseFakeModel(window);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
      for (const [name, description] of [
        ["Field research", "Field notes, surveys and measurements"],
        ["Reports", "Reports and reviews for a board or a client"],
        ["Reading", "Papers, articles and reading notes"],
      ]) {
        await bridge.createLibraryGroup({
          name: name as string,
          description: description as string,
        });
      }
      await bridge.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
        automatic: true,
      });
    });

    await step(T, "link a folder", async () => {
      await answerOpenDialog((app as Launched).app, fixtures.formats);
      await click(window, window.getByTestId("plus-menu"));
      await click(window, window.getByTestId("plus-link-folder"));
      const dialog = window.getByTestId("link-folder-dialog");
      await expect(dialog.getByTestId("link-folder-files")).toBeVisible({ timeout: 20_000 });
      await window.waitForTimeout(300);
      await shot(window, "A20-link-folder-dialog");
      await scan(window, "A20-link-folder-dialog");
      await click(window, dialog.getByTestId("link-folder-confirm"));
      await expect(dialog).toBeHidden();
      await window.waitForTimeout(600);
      await shot(window, "A21-indexing");
      await shot(window.getByTestId("sidebar"), "A21-sidebar-indexing");
    });
    await step(T, "documents settle", async () => {
      const states = await documentsSettled(window, 14);
      record("walk.formats.states", states);
      await window.waitForTimeout(1500);
      await shot(window.getByTestId("sidebar"), "A22-sidebar-folders");
      const sources = window.getByRole("button", { name: "Folders on disk", exact: true });
      if (await sources.count()) {
        await click(window, sources);
        await window.waitForTimeout(300);
        await shot(window.getByTestId("sidebar"), "A23-sidebar-source-locations");
        await scan(window, "A23-sidebar-source-locations");
        record("walk.overflow.sidebar", await overflowProbe(window));
      }
    });

    await step(T, "a Mind: a heading, a Note, Questions", async () => {
      await click(window, window.getByTestId("plus-menu"));
      await click(window, window.getByTestId("plus-new-mind"));
      await typeLike(window, "# Harbour survey: what the documents say", 50);
      await window.keyboard.press("Enter");
      await typeLike(
        window,
        "Notes for the board meeting. Start with the tides, then the sediment cores.",
        25,
      );
      await window.keyboard.press("Enter");
      // The first Question: answered with one Citation.
      await window.keyboard.press("ControlOrMeta+j");
      await typeLike(window, "When do spring tides happen?", 50);
      await window.keyboard.press("Enter");
      const first = window.getByTestId("assistant-answer").first();
      await expect(first).toHaveAttribute("data-status", "streaming", { timeout: 15_000 });
      const stop = await startFrames(window);
      await window.waitForTimeout(500);
      await shot(window, "A24-answer-streaming");
      await expect(first).toHaveAttribute("data-status", "done", { timeout: 30_000 });
      record("walk.fakeStreaming.frames", await stop());
      await window.waitForTimeout(800);
      await shot(window, "A25-answer-with-citation");
      await scan(window, "A25-answer-with-citation");
    });
    await step(T, "more Questions: many Citations, a misquote", async () => {
      await endOfMind(window);
      await ask(window, "What does each document say about tides and the harbour?", 1);
      await endOfMind(window);
      await ask(window, "Find a misquote about spring tides", 2);
      await window.waitForTimeout(800);
      await shot(window, "A26-answers-many-citations");
      await shot(window, "A26-answers-many-citations-full", true);
      await scan(window, "A26-answers-many-citations");
    });
    await step(T, "the Citation card and its page", async () => {
      const chip = window.getByTestId("assistant-answer").first().getByTestId("citation-chip");
      await glide(window, chip);
      const card = window.getByTestId("citation-card");
      await expect(card).toBeVisible();
      await window.waitForTimeout(250);
      await shot(window, "A27-citation-card");
      const open = card.getByTestId("citation-open");
      record("walk.states.citationOpen", await states(window, open));
      await glide(window, chip);
      await expect(card).toBeVisible();
      await click(window, open);
      await expect(window.getByTestId("viewer")).toBeVisible();
      await window.waitForTimeout(1500);
      await shot(window, "A28-viewer-from-citation");
      await scan(window, "A28-viewer-from-citation");
    });
    await step(T, "Escape closes the viewer", async () => {
      await glide(window, window.getByTestId("viewer"));
      await window.keyboard.press("Escape");
      await window.waitForTimeout(400);
      record("walk.escape.viewer", { closes: !(await window.getByTestId("viewer").isVisible()) });
    });

    const formats: [string, string, string][] = [
      ["pdf", fixtures.names.pdf, "[data-testid=pdf-scroller]"],
      ["pdf-300-pages", fixtures.names.bigPdf, "[data-testid=pdf-scroller]"],
      ["docx", fixtures.names.docx, "[data-testid=viewer-docx]"],
      ["docx-images", fixtures.names.imageDocx, "[data-testid=viewer-docx]"],
      ["xlsx", fixtures.names.xlsx, "[data-testid=viewer-grid]"],
      ["xlsx-50k", fixtures.names.bigXlsx, "[data-testid=viewer-grid]"],
      ["csv", fixtures.names.csv, "[data-testid=viewer-grid]"],
      ["pptx", fixtures.names.pptx, "[data-testid=viewer-slides]"],
      ["markdown", fixtures.names.md, "[data-testid=viewer-text]"],
      ["text", fixtures.names.txt, "[data-testid=viewer-text]"],
      ["chinese", fixtures.names.chinese, "[data-testid=viewer-text]"],
      ["long-name", fixtures.names.long, "[data-testid=viewer-text]"],
    ];
    const viewerOpen: Record<string, number> = {};
    for (const [kind, name, selector] of formats) {
      await step(T, `viewer ${kind}`, async () => {
        const row = window
          .getByTestId("document-list-item")
          .filter({ has: window.getByTestId("row-text").getByText(name, { exact: true }) })
          .first();
        const start = Date.now();
        await click(window, row.getByTestId("open-document"));
        await expect(window.locator(selector).first()).toBeVisible({ timeout: 20_000 });
        viewerOpen[kind] = Date.now() - start;
        await window.waitForTimeout(kind.startsWith("pdf") || kind.startsWith("docx") ? 1500 : 600);
        await shot(window, `A30-viewer-${kind}`);
        await scan(window, `A30-viewer-${kind}`);
      });
    }
    record("walk.viewerOpenMs", viewerOpen);

    await step(T, "viewer controls: hover and states", async () => {
      const header = window.getByTestId("viewer-header");
      const buttons = header.locator("button");
      const out: unknown[] = [];
      for (let i = 0; i < Math.min(await buttons.count(), 6); i++) {
        const button = buttons.nth(i);
        if (!(await button.isVisible())) continue;
        out.push({
          label: await button.getAttribute("aria-label"),
          ...(await states(window, button)),
        });
      }
      record("walk.states.viewerHeader", out);
      await shot(header, "A31-viewer-header");
    });

    await step(T, "a Document's More menu and Tags", async () => {
      const row = window
        .getByTestId("document-list-item")
        .filter({ hasText: fixtures.names.md })
        .first();
      await glide(window, row);
      await window.waitForTimeout(200);
      await shot(window.getByTestId("sidebar"), "A32-sidebar-row-hover");
      await click(window, row.getByTestId("document-file-menu"));
      await window.waitForTimeout(250);
      await shot(window, "A33-document-more-menu");
      await window.keyboard.press("Escape");
      await window.waitForTimeout(200);
      await glide(window, row);
      await click(window, row.getByTestId("document-tags-menu"));
      await window.waitForTimeout(250);
      await shot(window, "A34-document-tags-popover");
      await scan(window, "A34-document-tags-popover");
      // "Manage Tags…" at the foot of the Document's Tags popover.
      await click(window, window.getByTestId("open-tags-dialog"));
      await expect(window.getByTestId("tags-dialog")).toBeVisible();
      await window.waitForTimeout(300);
      await shot(window, "A35-tags-dialog");
      await scan(window, "A35-tags-dialog");
      await window.keyboard.press("Escape");
    });

    await step(T, "the Library (document sheet)", async () => {
      await click(window, window.getByTestId("open-library"));
      await expect(window.getByTestId("library")).toBeVisible();
      await window.waitForTimeout(800);
      await shot(window, "A36-library");
      await scan(window, "A36-library");
      record("walk.overflow.library", await overflowProbe(window));
      const organize = window
        .getByTestId("library")
        .getByRole("button", { name: /Organize/ })
        .first();
      if (await organize.count()) {
        record("walk.states.organize", {
          disabled: await organize.isDisabled(),
          style: await organize.evaluate((el) => {
            const s = getComputedStyle(el);
            return { bg: s.backgroundColor, opacity: s.opacity, cursor: s.cursor };
          }),
        });
      }
      await click(window, window.getByTestId("library-tab").getByTestId("tab-close"));
      await expect(window.getByTestId("library")).toBeHidden();
    });

    await step(T, "export dialog", async () => {
      const tab = window.getByTestId("mind-tab").filter({ hasText: "Harbour survey" });
      await click(window, tab);
      await click(window, window.getByTestId("export-mind"));
      await click(window, window.getByTestId("export-options"));
      const dialog = window.getByTestId("export-dialog");
      await expect(dialog).toBeVisible();
      await window.waitForTimeout(500);
      await shot(window, "A37-export-dialog");
      await scan(window, "A37-export-dialog");
      await window.keyboard.press("Escape");
      await window.waitForTimeout(300);
      record("walk.escape.export", { closes: !(await dialog.isVisible()) });
    });

    await step(T, "shortcuts", async () => {
      const tabs = window.getByTestId("mind-tab");
      const before = await tabs.count();
      await window.keyboard.press("ControlOrMeta+t");
      await window.waitForTimeout(500);
      const afterNew = await tabs.count();
      await window.keyboard.press("ControlOrMeta+1");
      await window.waitForTimeout(300);
      const firstSelected = await tabs.first().getAttribute("aria-selected");
      await window.keyboard.press("Control+Tab");
      await window.waitForTimeout(300);
      const cycled = await tabs.nth(1).getAttribute("aria-selected");
      await window.keyboard.press("ControlOrMeta+w");
      await window.waitForTimeout(500);
      record("walk.shortcuts", {
        cmdT: { before, after: afterNew },
        cmd1: firstSelected,
        ctrlTab: cycled,
        cmdW: await tabs.count(),
      });
      await shot(window.getByTestId("tab-strip").first(), "A38-tabs");
    });

    // Window sizes: see A6.

    await step(T, "dark mode", async () => {
      await (app as Launched).app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = "dark";
      });
      await window.emulateMedia({ colorScheme: "dark" });
      await window.waitForTimeout(600);
      await shot(window, "A41-dark-mode");
      record("walk.dark", {
        prefersDark: await window.evaluate(
          () => matchMedia("(prefers-color-scheme: dark)").matches,
        ),
        colorScheme: await window.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
        bodyBg: await window.evaluate(() => getComputedStyle(document.body).backgroundColor),
      });
      await click(window, window.getByRole("button", { name: "Settings", exact: true }));
      await window.waitForTimeout(500);
      await shot(window, "A41-dark-mode-settings");
      await window.keyboard.press("Escape");
      await (app as Launched).app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = "system";
      });
      await window.emulateMedia({ colorScheme: "light" });
    });

    await step(T, "Chinese", async () => {
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.updateSettings({ user: { language: "zh-CN" } } as never);
      });
      await window.waitForTimeout(1000);
      await shot(window, "A42-zh-main-viewer");
      record("walk.overflow.zh-main", await overflowProbe(window));
      await scan(window, "A42-zh-main-viewer");
      const row = window
        .getByTestId("document-list-item")
        .filter({ hasText: fixtures.names.chinese })
        .first();
      await click(window, row.getByTestId("open-document"));
      await window.waitForTimeout(800);
      await shot(window, "A43-zh-viewer-chinese-doc");
      // A Chinese Note: line height of CJK text in the Mind.
      await click(window, window.getByTestId("mind-tab").filter({ hasText: "Harbour survey" }));
      await endOfMind(window);
      await window.keyboard.press("Enter");
      await window.keyboard.insertText(
        "大潮发生在新月和满月时，此时太阳和月球的引力叠加，潮差最大。小潮发生在上弦月和下弦月时，潮差最小。港口每年都会公布高潮和低潮的时间。",
      );
      await window.waitForTimeout(400);
      record(
        "walk.zh.lineHeight",
        await window
          .getByTestId("mind-editor")
          .locator(":scope > p")
          .last()
          .evaluate((el) => {
            const s = getComputedStyle(el);
            return {
              fontFamily: s.fontFamily,
              fontSize: s.fontSize,
              lineHeight: s.lineHeight,
              height: el.getBoundingClientRect().height,
            };
          }),
      );
      await shot(window, "A44-zh-mind-note");
      await click(
        window,
        window.getByTestId("sidebar").getByRole("button", { name: "设置" }).first(),
      );
      await window.waitForTimeout(500);
      const settings = window.getByTestId("settings");
      for (const page of offeredSettingsPages) {
        await click(window, settings.getByTestId(`settings-nav-${page}`));
        await window.waitForTimeout(600);
        await shot(window, `A45-zh-settings-${page}`);
        record(`walk.overflow.zh-settings-${page}`, await overflowProbe(window));
      }
      await window.keyboard.press("Escape");
      await click(window, window.getByTestId("open-library"));
      await window.waitForTimeout(800);
      await shot(window, "A46-zh-library");
      record("walk.overflow.zh-library", await overflowProbe(window));
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.updateSettings({ user: { language: "en" } } as never);
      });
      await window.waitForTimeout(600);
      await click(window, window.getByTestId("library-tab").getByTestId("tab-close"));
    });

    await step(
      T,
      "error states: a Missing Document, an Unavailable folder, a failed action",
      async () => {
        rmSync(join(fixtures.formats, "Interview transcript.txt"));
        await window.waitForTimeout(4000);
        await shot(window.getByTestId("sidebar"), "A47-sidebar-missing-document");
        const missing = window
          .getByTestId("document-list-item")
          .filter({ hasText: fixtures.names.txt })
          .first();
        if (await missing.count()) {
          await click(window, missing.getByTestId("open-document"));
          await window.waitForTimeout(800);
          await shot(window, "A48-viewer-missing-document");
        }
        const moved = `${fixtures.formats}-moved`;
        renameSync(fixtures.formats, moved);
        await window.waitForTimeout(6000);
        await shot(window, "A49-unavailable-folder");
        renameSync(moved, fixtures.formats);
        await window.evaluate(async () => {
          const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
          await hooks
            ?.addPaths(["/nonexistent/folder/that-was-removed.pdf"])
            .catch(() => undefined);
        });
        await window.waitForTimeout(1200);
        await shot(window, "A50-action-error-toast");
        const alert = window.getByRole("alert");
        record("walk.toast", { shown: await alert.count(), text: await alert.allTextContents() });
      },
    );

    await step(T, "focus walk in a working Mind", async () => {
      await window.mouse.click(5, 5);
      record("walk.focus.workingMind", await focusWalk(window, 60, "focus/A51"));
    });
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
    removeDir(root);
  }
});

test("A4 approvals and consent", async () => {
  const T = "A4";
  const dataDir = tempDir("data");
  let app: Launched | undefined;
  try {
    app = await launch(dataDir, { fakeChat: true });
    const { window } = app;
    await sealShell(app.app);
    await chooseFakeModel(window);
    await window.evaluate(
      async ({ node, server }) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const connector = await bridge.addConnector({
          name: "Tides",
          command: node,
          args: [server],
        });
        for (let tries = 0; tries < 300; tries++) {
          const found = (await bridge.listConnectors()).find((each) => each.id === connector.id);
          if (found?.state === "ready") break;
          await new Promise((done) => setTimeout(done, 100));
        }
        // Adding it allowed its Tool calls (ADR-0022); the step shows the dialog that asks.
        await bridge.revokeConsent("connectors", `connector:${connector.id}`);
      },
      {
        node: process.execPath,
        server: join(__dirname, "..", "..", "tests", "fixtures", "mcp-server.mjs"),
      },
    );
    await step(T, "approval card", async () => {
      await click(window, window.getByTestId("plus-menu"));
      await click(window, window.getByTestId("plus-new-mind"));
      await click(window, window.getByTestId("mind-editor"));
      await window.keyboard.press("ControlOrMeta+j");
      await typeLike(window, "Please book_boat from Dover", 45);
      await window.keyboard.press("Enter");
      const card = window.getByTestId("approval-card");
      await expect(card).toBeVisible({ timeout: 20_000 });
      await window.waitForTimeout(400);
      await shot(window, "A60-approval-card");
      await scan(window, "A60-approval-card");
      await shot(window.getByTestId("assistant"), "A61-assistant-waiting-dot");
      await click(window, card.getByTestId("approval-allow-once"));
      const consent = window.getByTestId("consent-dialog");
      await expect(consent).toBeVisible({ timeout: 10_000 });
      await window.waitForTimeout(300);
      await shot(window, "A62-consent-dialog");
      await scan(window, "A62-consent-dialog");
      await click(window, consent.getByTestId("consent-allow"));
      await window.waitForTimeout(3000);
      await shot(window, "A63-after-approval");
    });
    await step(T, "connectors settings", async () => {
      await click(window, window.getByRole("button", { name: "Settings", exact: true }));
      await click(window, window.getByTestId("settings-nav-connectors"));
      await window.waitForTimeout(800);
      await shot(window, "A64-settings-connectors-with-one");
      await click(window, window.getByTestId("settings-nav-privacy"));
      await window.getByTestId("approvals").scrollIntoViewIfNeeded();
      await window.waitForTimeout(600);
      await shot(window, "A65-settings-approvals");
      await window.keyboard.press("Escape");
    });
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
  }
});

test("A6 window sizes, the three steps, the @ and / menus, hover states", async () => {
  test.setTimeout(8 * 60_000);
  const T = "A6";
  const dataDir = tempDir("data");
  const root = tempDir("fixtures");
  const fixtures = writeFixtures(root, 0);
  let app: Launched | undefined;
  try {
    app = await launch(dataDir, { examples: true, fakeChat: true });
    const { window } = app;
    await sealShell(app.app);
    await step(T, "an empty Mind (Get started showing)", async () => {
      await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
        "Draft: credit committee paper",
        { timeout: 20_000 },
      );
      await click(window, window.getByTestId("new-tab"));
      // No second start guide in an empty note of the User's own (#1940).
      await expect(window.getByTestId("start-guide")).toHaveCount(0);
      await window.mouse.move(700, 600, { steps: 6 });
      await window.waitForTimeout(400);
      await shot(window, "A80-empty-mind");
      await scan(window, "A80-empty-mind");
    });
    await chooseFakeModel(window);
    await window.evaluate(async (folder) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.addLinkedFolder(folder);
    }, fixtures.formats);
    await documentsSettled(window, 16);
    await step(T, "the / menu and the @ scope picker", async () => {
      await click(window, window.getByTestId("mind-editor"));
      await window.keyboard.type("/", { delay: 80 });
      await window.waitForTimeout(400);
      await shot(window, "A81-slash-menu");
      await window.keyboard.press("Escape");
      await window.keyboard.press("Backspace");
      await window.keyboard.press("ControlOrMeta+j");
      await typeLike(window, "What do the reports say ", 40);
      await window.keyboard.type("@", { delay: 80 });
      await window.waitForTimeout(500);
      await shot(window, "A82-scope-picker");
      await scan(window, "A82-scope-picker");
      await window.keyboard.press("Escape");
    });
    await step(T, "hover states: tabs, Ask, rows", async () => {
      // The composer's Ask button, with something written to ask.
      await window.getByTestId("composer-input").fill("When do spring tides happen?");
      const ask = window.getByTestId("composer-ask");
      record("walk.states.ask", await states(window, ask));
      const tab = window.getByTestId("mind-tab").first();
      record("walk.states.tab", await states(window, tab));
      const row = window.getByTestId("mind-list-item").first();
      record("walk.states.sidebarRow", await states(window, row));
    });
    await step(T, "a failed action: the toast", async () => {
      // Renaming a Document to a pasted name that is too long fails in the core.
      const row = window
        .getByTestId("document-list-item")
        .filter({ hasText: fixtures.names.csv })
        .first();
      await glide(window, row);
      await click(window, row.getByTestId("document-file-menu"));
      await click(window, window.getByRole("menuitem", { name: /Rename/ }).first());
      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.insertText("Orders ".repeat(90));
      await window.keyboard.press("Enter");
      const alert = window.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 5_000 });
      await window.waitForTimeout(300);
      await shot(window, "A84-action-error-toast");
      await scan(window, "A84-action-error-toast");
      record("walk.toast", { text: await alert.allTextContents() });
      await window.waitForTimeout(6000);
      record("walk.toastAfter6s", { stillShown: await alert.isVisible() });
      await click(window, alert.getByRole("button", { name: "Dismiss" }));
    });
    await step(T, "window sizes", async () => {
      await window.keyboard.press("Escape");
      // Back to the example Mind, with a Citation's page open beside it.
      await click(
        window,
        window.getByTestId("mind-list-item").filter({ hasText: "Draft: credit committee paper" }),
      );
      await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
        "Draft: credit committee paper",
      );
      await click(window, window.getByTestId("citation-chip").first());
      await window.waitForTimeout(600);
      const open = window.getByTestId("citation-card").getByTestId("citation-open");
      if (await open.isVisible()) await click(window, open);
      await expect(window.getByTestId("viewer")).toBeVisible();
      const screen = await (app as Launched).app.evaluate(
        ({ screen: s }) => s.getPrimaryDisplay().workAreaSize,
      );
      record("walk.size.screen", screen);
      const sizes = [
        [900, 560],
        [1280, 800],
        [1920, 1200],
      ] as const;
      const resize = async (w: number, h: number) => {
        await setWindowSize((app as Launched).app, w, h);
        await window.waitForTimeout(800);
        const actual = await window.evaluate(() => [innerWidth, innerHeight]);
        const emulated = actual[0] !== w || actual[1] !== h;
        if (emulated) {
          // The screen is smaller than the window asked for: emulate the viewport instead.
          await window.setViewportSize({ width: w, height: h });
          await window.waitForTimeout(800);
        }
        return { actual, emulated };
      };
      // With the viewer open at each size, then without it.
      for (const [w, h] of sizes) {
        const size = await resize(w, h);
        await shot(window, `A83-size-${w}x${h}-viewer`);
        record(`walk.size.${w}x${h}`, {
          ...size,
          overflow: await overflowProbe(window),
          horizontalScroll: await window.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        });
      }
      // Earlier steps can leave more than one Document open: close them all.
      const documentTabs = window.getByTestId("document-tab");
      while (await documentTabs.count()) {
        await click(window, documentTabs.first().getByTestId("tab-close"));
      }
      await expect(window.getByTestId("viewer")).toBeHidden();
      for (const [w, h] of sizes) {
        await resize(w, h);
        await shot(window, `A83-size-${w}x${h}`);
      }
    });
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
    removeDir(root);
  }
});

test("A7 what the window shows while it starts", async () => {
  const dataDir = tempDir("data");
  let app: Launched | undefined;
  try {
    // A data folder from an earlier run, as on any later start.
    const first = await launch(dataDir, { readyTestId: "plus-menu" });
    await close(first);
    app = await launch(dataDir, { readyTestId: null });
    const frames: { ms: number; blank: boolean }[] = [];
    const started = app.timing.launchMs;
    for (let i = 0; i < 12; i++) {
      const buffer = await app.window.screenshot({ timeout: 5_000 }).catch(() => null);
      if (!buffer) continue;
      const blank = await app.window.evaluate(
        () => document.querySelector("#root")?.childElementCount === 0,
      );
      if (i < 4) await shot(app.window, `A90-startup-${i}`);
      frames.push({ ms: Date.now() - started, blank });
      if (!blank && i > 3) break;
    }
    record("walk.startupFrames", frames);
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
  }
});

test("A5 offline: the chat model can't be reached", async () => {
  const T = "A5";
  const dataDir = tempDir("data");
  let app: Launched | undefined;
  try {
    app = await launch(dataDir);
    const { window } = app;
    await sealShell(app.app);
    // An Ollama on a closed local port: nothing leaves the machine.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({
        kind: "ollama",
        modelId: "qwen3:0.6b",
        baseUrl: "http://127.0.0.1:9",
      } as never);
    });
    await step(T, "an Answer that errors", async () => {
      await click(window, window.getByTestId("plus-menu"));
      await click(window, window.getByTestId("plus-new-mind"));
      await click(window, window.getByTestId("mind-editor"));
      await window.waitForTimeout(500);
      await shot(window, "A70-model-unreachable-notice");
      await window.keyboard.press("ControlOrMeta+j");
      await typeLike(window, "What is in my documents?", 45);
      await window.keyboard.press("Enter");
      await window.waitForTimeout(6000);
      await shot(window, "A71-answer-error");
      await scan(window, "A71-answer-error");
      record("walk.offline", {
        answerError: await window.getByTestId("answer-error").allTextContents(),
        readiness: await window.getByTestId("chat-readiness").allTextContents(),
      });
    });
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
  }
});
