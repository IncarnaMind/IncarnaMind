import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { EmbeddingModelStatus } from "../src/core/api";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  emit,
  lastLineBoxOf,
  launchApp,
  makeTagOnDocument,
  newMind,
  pointAt,
  removeDataFolder,
  renameInTab,
  setLanguage,
  setSidebarWidth,
  setWindowSize,
  tabTo,
  textBoxOf,
} from "./app";

/*
 * The sidebar's rows, its two rules and its status line (#615): a row that
 * is pointed at or focused ends its name with "…" before its actions; the
 * rule above Settings is inset like the header's; a long name is cut in the
 * middle of the undo line, which keeps Undo whole; and a model's download keeps its figure whole
 * at the narrowest sidebar, in both languages.
 */

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

/** Keeps a screenshot of the window, once it has settled, when INCARNAMIND_SCREENSHOTS names a folder. */
async function screenshot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

const NARROWEST = 165;
const DEFAULT = 248;
const WIDE = 300;

const NAMES = {
  en: {
    document: "Coastal Flood Risk Reassessment for the Eastern Basin",
    mind: "Harbour survey: what the documents say about the east basin transects",
    renamed: `Harbour survey: ${"what the documents say about sediment transport, ".repeat(2)}east basin`,
  },
  "zh-CN": {
    document: "东部海湾沿岸洪水风险重新评估报告（含补充数据）",
    mind: "港口沉积物调查：文档对东部海湾断面的说明汇总",
    renamed: "港口沉积物调查：".repeat(15),
  },
} as const;

async function boxOf(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

/** How visible an element is: its opacity times those of the ancestors that hold it. */
const shownOpacity = (target: Locator) =>
  target.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  });

/** The name ends before the first action and is cut with "…", the row still one 28px line. */
async function expectNameEndsBeforeActions(row: Locator, actions: Locator[]) {
  for (const action of actions) await expect.poll(() => shownOpacity(action)).toBe(1);
  const name = row.getByTestId("row-text");
  const [nameBox, firstAction, rowBox] = await Promise.all([
    boxOf(name),
    boxOf(actions[0] as Locator),
    boxOf(row),
  ]);
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(firstAction.x + 0.5);
  expect(rowBox.height).toBeCloseTo(28, 0);
  expect(
    await name.evaluate(
      (element) =>
        element.scrollWidth > element.clientWidth &&
        getComputedStyle(element).textOverflow === "ellipsis",
    ),
  ).toBe(true);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: a row pointed at or focused ends its name with … before its actions, and a Document's Tag dots step aside`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1100, 700);
      const names = NAMES[language];
      const path = join(sources, `${names.document}.txt`);
      await writeFile(path, "Observations of tides at the harbour.");
      await addDocuments(window, [path]);
      await (await coreOf(window)).evaluate(async (core, name) => {
        const tags = await core.listTags();
        const item = (await core.listDocuments()).find((each) => each.name === name);
        for (const tag of ["Paper", "Notes", "Report"]) {
          const found = tags.find((each) => each.name === tag);
          if (item && found) await core.addDocumentTag(item.id, found.id);
        }
        await core.createMind({ title: name });
      }, names.document);
      await setLanguage(window, language);

      const documentRow = window.getByTestId("document-list-item");
      const mindRow = window.getByTestId("mind-row");
      const marks = documentRow.getByTestId("tag-marks");
      // The Tags arrive one by one: wait for all three dots.
      await expect(marks.getByTestId("tag-dot")).toHaveCount(3);

      for (const width of [DEFAULT, NARROWEST]) {
        await setSidebarWidth(window, width);
        await window.mouse.move(700, 400, { steps: 6 });
        const atRest = await boxOf(documentRow);
        const restingName = await boxOf(documentRow.getByTestId("row-text"));
        const restingMarks = await boxOf(marks);
        // At rest the Tag dots follow the name, inside the row.
        expect(restingMarks.x).toBeGreaterThanOrEqual(restingName.x);
        expect(restingMarks.x + restingMarks.width).toBeLessThanOrEqual(atRest.x + atRest.width);

        // Pointed at: the Tag button and ⋯ come in, the dots step aside, the name gives way.
        await pointAt(window, documentRow.getByTestId("row-text"));
        const tags = documentRow.getByTestId("document-tags-menu");
        const more = documentRow.getByTestId("document-file-menu");
        await expectNameEndsBeforeActions(documentRow, [tags, more]);
        await expect(marks).toBeHidden();
        expect(await boxOf(documentRow)).toEqual(atRest);

        // A Mind's name gives way before its ⋯ too.
        await pointAt(window, mindRow.getByTestId("row-text"));
        await expectNameEndsBeforeActions(mindRow, [mindRow.getByTestId("mind-menu")]);

        // Away, the dots are back and the name has its room again.
        await window.mouse.move(700, 400, { steps: 6 });
        await expect(marks).toBeVisible();
        expect(await boxOf(documentRow.getByTestId("row-text"))).toEqual(restingName);

        // With its menu open they stay, though the pointer has gone.
        await pointAt(window, documentRow.getByTestId("row-text"));
        await pointAt(window, more);
        await window.mouse.down();
        await window.mouse.up();
        await expect(more).toHaveAttribute("aria-expanded", "true");
        await window.mouse.move(700, 400, { steps: 6 });
        await expectNameEndsBeforeActions(documentRow, [tags, more]);
        await expect(marks).toBeHidden();
        await window.keyboard.press("Escape");
        await expect(more).toHaveAttribute("aria-expanded", "false");

        // Reached by keyboard, the same.
        await tabTo(window, documentRow.getByTestId("open-document"));
        await expectNameEndsBeforeActions(documentRow, [tags, more]);
        await expect(marks).toBeHidden();
        await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expect(marks).toBeVisible();
      }
    } finally {
      await app.close();
    }
  });

  test(`${language}: a long name is cut in the middle of the undo line, which keeps Undo whole inside the sidebar, and its tooltip gives the whole name`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1100, 700);
      await setLanguage(window, language);
      const { renamed } = NAMES[language];
      expect(renamed.length).toBeGreaterThanOrEqual(120);
      await newMind(window);

      const message = window.getByTestId("undo-message");
      const undo = window.getByTestId("undo-action");
      const sidebar = window.getByTestId("sidebar");
      // The line goes after a few seconds: each width gets a rename of its own.
      for (const [index, width] of [DEFAULT, NARROWEST].entries()) {
        await setSidebarWidth(window, width);
        const name = `${renamed} ${index + 1}`;
        const characters = [...name];
        await renameInTab(window, name);
        await expect(undo).toBeVisible();
        const [lastBox, undoBox, sidebarBox] = await Promise.all([
          lastLineBoxOf(message),
          textBoxOf(undo),
          boxOf(sidebar),
        ]);
        // Undo ends inside the sidebar, after the message's last words, and nothing is cut at its end.
        expect(undoBox.x + undoBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);
        expect(undoBox.x).toBeGreaterThanOrEqual(lastBox.x + lastBox.width - 0.5);
        // The name is cut in the middle: its start and its end show, and the tooltip has all of it.
        const said = (await message.textContent()) ?? "";
        expect(said).toContain(characters.slice(0, 3).join(""));
        expect(said).toContain("…");
        expect(said).toContain(characters.slice(-3).join(""));
        expect(said).not.toContain(name);
        expect(await message.getAttribute("title")).toContain(name);
      }
    } finally {
      await app.close();
    }
  });

  test(`${language}: names within the line's limit show whole in the undo line at the narrowest sidebar, and all of it stays inside`, async () => {
    test.setTimeout(90_000);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1100, 700);
      await setLanguage(window, language);
      await newMind(window);
      await setSidebarWidth(window, NARROWEST);
      const message = window.getByTestId("undo-message");
      const undo = window.getByTestId("undo-action");
      const sidebar = await boxOf(window.getByTestId("sidebar"));
      const thirty = "Harbour dues review, volume 22";
      expect([...thirty]).toHaveLength(30);
      for (const name of ["Boardpack", thirty]) {
        await renameInTab(window, name);
        await expect(undo).toBeVisible();
        // D304: a name within the limit is never cut for a narrow pane or a wide system font;
        // the line wraps instead, so the whole message is its text and it needs no tooltip.
        await expect(message).toContainText(name);
        expect((await message.textContent()) ?? "").not.toContain("…");
        expect(await message.getAttribute("title")).toBeNull();
        for (const each of [message, undo]) {
          const box = await boxOf(each);
          expect(box.x).toBeGreaterThanOrEqual(sidebar.x - 0.5);
          expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 0.5);
          expect(box.y).toBeGreaterThanOrEqual(sidebar.y - 0.5);
          expect(box.y + box.height).toBeLessThanOrEqual(sidebar.y + sidebar.height + 0.5);
        }
      }
    } finally {
      await app.close();
    }
  });

  test(`${language}: a 60-column name is cut in the middle in the undo line, keeping its extension and the whole in the tooltip`, async () => {
    test.setTimeout(90_000);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1100, 700);
      await setLanguage(window, language);
      await newMind(window);
      await setSidebarWidth(window, NARROWEST);
      const name = "Quarterly review of harbour dues and the wider coastal levy.docx";
      expect([...name].length).toBeGreaterThan(40);
      await renameInTab(window, name);
      const message = window.getByTestId("undo-message");
      await expect(message).toContainText("…");
      const said = (await message.textContent()) ?? "";
      expect(said).toContain([...name].slice(0, 4).join(""));
      expect(said).toMatch(/…[^…]*\.docx”/);
      expect(said).not.toContain(name);
      expect(await message.getAttribute("title")).toContain(name);
      const sidebar = await boxOf(window.getByTestId("sidebar"));
      const box = await boxOf(message);
      expect(box.x).toBeGreaterThanOrEqual(sidebar.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 0.5);
      expect(box.y).toBeGreaterThanOrEqual(sidebar.y - 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(sidebar.y + sidebar.height + 0.5);
    } finally {
      await app.close();
    }
  });
}

test("the rule above Settings is inset like the header's rule, at every sidebar width", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 700);
    const rule = (testId: string, pseudo: "::before" | "::after") =>
      window.getByTestId(testId).evaluate((element, which) => {
        const style = getComputedStyle(element, which);
        return {
          drawn: style.content !== "none",
          left: style.left,
          right: style.right,
          height: style.height,
          colour: style.backgroundColor,
          // A border would run edge to edge.
          border: getComputedStyle(element).borderTopWidth,
        };
      }, pseudo);
    for (const width of [DEFAULT, NARROWEST]) {
      await setSidebarWidth(window, width);
      const header = await rule("sidebar-header", "::after");
      const footer = await rule("sidebar-footer", "::before");
      expect(header).toMatchObject({ drawn: true, left: "8px", right: "8px", height: "1px" });
      expect(footer).toMatchObject({ drawn: true, left: "8px", right: "8px", height: "1px" });
      expect(footer.colour).toBe(header.colour);
      expect(footer.border).toBe("0px");
    }
  } finally {
    await app.close();
  }
});

/** What a model's download reports, `done` of `total` bytes in. */
const downloading = (model: EmbeddingModelStatus, done: number, total: number) => ({
  ...model,
  state: "downloading" as const,
  downloadedBytes: done,
  totalBytes: total,
  error: null,
});

test("at the narrowest sidebar a downloading model's figure is whole beside +1, in English and Chinese, and the popover and tooltip give the full sentence", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 700);
    const core = await coreOf(window);
    const model = await core.evaluate((bridge) => bridge.getEmbeddingModel());
    const rerank = await core.evaluate((bridge) => bridge.getRerankSettings());
    const embedding = await core.evaluate((bridge) => bridge.getEmbeddingSettings());
    const sidebar = window.getByTestId("sidebar");
    const more = window.getByTestId("status-more");

    // The downloads, each pushed with a rebuild behind it, so the row says "+1".
    const downloads = [
      {
        testId: "text-recognition-download",
        figure: "3/22 MB",
        full: { en: "3 of 22 MB", "zh-CN": "3 / 22 MB" },
        start: () =>
          emit(app, "textRecognitionModel.status", downloading(model, 3_400_000, 21_500_000)),
        stop: () => emit(app, "textRecognitionModel.status", { ...model, state: "ready" }),
      },
      {
        testId: "reranking-model-download",
        figure: "3/90 MB",
        full: { en: "3 of 90 MB", "zh-CN": "3 / 90 MB" },
        start: () =>
          emit(app, "rerank.changed", {
            ...rerank,
            enabled: true,
            kind: "built-in",
            model: downloading(rerank.model, 3_400_000, 89_200_000),
          }),
        stop: () =>
          emit(app, "rerank.changed", { ...rerank, model: { ...rerank.model, state: "ready" } }),
      },
      {
        testId: "embedding-model-download",
        figure: "3/135 MB",
        full: { en: "3 of 135 MB", "zh-CN": "3 / 135 MB" },
        start: () => emit(app, "embeddingModel.status", downloading(model, 3_400_000, 134_200_000)),
        stop: () => emit(app, "embeddingModel.status", { ...model, state: "ready" }),
      },
    ];
    await emit(app, "embedding.changed", {
      ...embedding,
      rebuild: { reason: "provider-changed", done: 3, total: 20 },
    });

    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      for (const download of downloads) {
        await download.start();
        const row = window.getByTestId(download.testId);
        await expect(row).toBeVisible();

        // The default width keeps the figure whole; a little wider reads the whole label too.
        await setSidebarWidth(window, DEFAULT);
        const label = row.getByTestId("status-label");
        await expect(row.getByTestId("status-figure")).toHaveText(download.figure);
        await setSidebarWidth(window, WIDE);
        expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          false,
        );

        // The narrowest: the label gives way, the figure doesn't, and "+1" sits beside it.
        await setSidebarWidth(window, NARROWEST);
        const figure = row.getByTestId("status-figure");
        await expect(figure).toBeVisible();
        await expect(figure).toHaveText(download.figure);
        await expect(more).toHaveText("+1");
        const [figureBox, moreBox, rowBox, sidebarBox] = await Promise.all([
          boxOf(figure),
          boxOf(more),
          boxOf(row),
          boxOf(sidebar),
        ]);
        expect(figureBox.x + figureBox.width).toBeLessThanOrEqual(moreBox.x);
        expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);
        expect(figureBox.x).toBeGreaterThanOrEqual(rowBox.x);
        expect(
          Math.abs(figureBox.y + figureBox.height / 2 - (moreBox.y + moreBox.height / 2)),
        ).toBeLessThanOrEqual(2);
        // One 28px line, whatever the label's length: the footer's height never moves (#763).
        expect(rowBox.height).toBeCloseTo(28, 0);
        // Whole: nothing of it is clipped.
        expect(await figure.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );

        // The row's tooltip gives the full sentence.
        await expect(row).toHaveAttribute("title", new RegExp(download.full[language]));

        await download.stop();
        await expect(row).toHaveCount(0);
      }

      // The rebuild, first once the downloads are done: its figure is whole too, and the
      // other statuses wait in the popover, each with its full sentence.
      const rebuild = window.getByTestId("embedding-rebuild-notice");
      await expect(rebuild.getByTestId("status-figure")).toHaveText("3/20");
      await expect(more).toHaveCount(0);
      await downloads[0]?.start();
      await pointAt(window, more);
      await window.mouse.down();
      await window.mouse.up();
      const others = window.getByTestId("status-others");
      await expect(others).toBeVisible();
      const listed = others.getByTestId("embedding-rebuild-notice");
      await expect(listed.getByTestId("status-figure")).toHaveText("3/20");
      await expect(listed).toHaveAttribute("title", language === "en" ? /3 of 20/ : /3 \/ 20/);
      await window.keyboard.press("Escape");
      await expect(others).toBeHidden();
      await downloads[0]?.stop();
    }
  } finally {
    await app.close();
  }
});

test("Tags need an AI model keeps one 28px line at the narrowest sidebar, in English and Chinese, its whole sentence on hover", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 700);
    const note = join(sources, "Reading notes.txt");
    await writeFile(note, "Membrane separation figures for the Leeds office.");
    await addDocuments(window, [note]);
    // A Tag of the User's own is what names Tags in the footer (#1942).
    await makeTagOnDocument(window, "Reading notes");
    const row = window.getByTestId("tagging-waiting");
    await expect(row).toBeVisible();

    const label = row.getByTestId("status-label");
    const clipped = () => label.evaluate((element) => element.scrollWidth > element.clientWidth);
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      for (const width of [WIDE, DEFAULT, NARROWEST]) {
        await setSidebarWidth(window, width);
        const [rowBox, sidebarBox] = await Promise.all([
          boxOf(row),
          boxOf(window.getByTestId("sidebar")),
        ]);
        // One line: the row keeps its 28px, and nothing of it runs past the sidebar.
        expect(rowBox.height).toBeCloseTo(28, 0);
        expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);
        // Whole at a little wider; at the narrowest it gives way to an ellipsis, never a wrap.
        if (width === WIDE) expect(await clipped()).toBe(false);
        if (width === NARROWEST) expect(await clipped()).toBe(true);
        if (width !== WIDE) await screenshot(window, `status-tagging-waits-${language}-${width}`);
      }
      // Hover gives the whole sentence, since the line can be cut.
      await expect(row).toHaveAttribute(
        "title",
        language === "en"
          ? "Tags come once you choose an AI model."
          : "选择 AI 模型后会自动打标签。",
      );
    }
  } finally {
    await app.close();
  }
});
