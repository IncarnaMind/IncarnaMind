import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  emit,
  frontMind,
  launchApp,
  type MindChild,
  markSteps,
  mindNode,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The assistant writes into the open Mind with its lines in the page's own top margin: "Writing…"
 * while it goes, then the applied edit's line. The first line of text stays where it is.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const paragraph = (...children: MindChild[]) =>
  mindNode("paragraph", { id: randomUUID() }, children);
const cell = (kind: "tableHeader" | "tableCell", text: string) =>
  mindNode(kind, { colspan: 1, rowspan: 1 }, [paragraph(text)]);

const LONG_LINE =
  "The quarter was good, and every line of the report that follows says so at some length, so that this first paragraph runs over more than one line at the narrowest window.";

const MINDS = {
  "a long first line": () => [paragraph(LONG_LINE), paragraph("Sales rose and the margin held.")],
  "a heading first": () => [
    mindNode("heading", { id: randomUUID(), level: 2 }, ["Summary"]),
    paragraph("The quarter was good. Sales rose and the margin held."),
  ],
  "a table first": () => [
    mindNode("table", { id: randomUUID() }, [
      mindNode("tableRow", {}, [cell("tableHeader", "Quarter"), cell("tableHeader", "Margin")]),
      mindNode("tableRow", {}, [cell("tableCell", "Q3"), cell("tableCell", "Held")]),
    ]),
    paragraph("The quarter was good. Sales rose and the margin held."),
  ],
  "a nested list": () => [
    mindNode("bulletList", { id: randomUUID() }, [
      mindNode("listItem", {}, [paragraph("A nested list paragraph")]),
    ]),
    paragraph("The quarter was good. Sales rose and the margin held."),
  ],
} as const;

async function mindOf(window: Page, kind: keyof typeof MINDS): Promise<string> {
  const blocks = MINDS[kind]();
  const update = Array.from(blocksUpdate([...blocks]));
  const mindId = await window.evaluate(
    async ([change]) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await core.createMind({ title: "Q3 review" });
      await core.applyMindUpdate(mind.id, new Uint8Array(change ?? []));
      await core.closeMind(mind.id);
      return mind.id;
    },
    [update] as const,
  );
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Q3 review" }),
  );
  await expect(window.locator('[data-testid="mind-editor"]:visible')).toBeVisible();
  return mindId;
}

interface Frame {
  editor: number;
  first: number;
  writing: [number, number] | null;
  line: [number, number] | null;
  writingVisible: boolean;
  lineVisible: boolean;
}

/** Every frame from now on: where the text starts, and where the two lines are, if shown. */
const sampleFrames = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { frames: Frame[]; sampling: boolean };
    holder.frames = [];
    holder.sampling = true;
    const span = (element: Element | null): [number, number] | null => {
      const box = element?.getBoundingClientRect();
      return box ? [box.top, box.bottom] : null;
    };
    const visible = (element: Element | null) =>
      element !== null &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible";
    const sample = () => {
      const editor = [...document.querySelectorAll('[data-testid="mind-editor"]')].find(
        (each) => each.getClientRects().length > 0,
      );
      const first = editor?.firstElementChild;
      const real = [...(editor?.children ?? [])].find(
        (each) =>
          !each.matches('[data-testid="mind-writing"], [data-testid="applied-line"]') &&
          !each.className.includes("ProseMirror-widget"),
      );
      const writing = editor?.querySelector('[data-testid="mind-writing"]') ?? null;
      const line = editor?.querySelector('[data-testid="applied-line"]') ?? null;
      if (editor && (first || real)) {
        holder.frames.push({
          editor: editor.getBoundingClientRect().top,
          first: (real ?? first)?.getBoundingClientRect().top ?? 0,
          writing: span(writing),
          line: span(line),
          writingVisible: visible(writing),
          lineVisible: visible(line),
        });
      }
      if (holder.sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

const stopSampling = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { frames: Frame[]; sampling: boolean };
    holder.sampling = false;
    return holder.frames;
  });

for (const [kind, width, language] of [
  ["a heading first", 1440, "en"],
  ["a heading first", 900, "en"],
  ["a heading first", 1440, "zh-CN"],
  ["a heading first", 900, "zh-CN"],
  ["a long first line", 1440, "en"],
  ["a long first line", 900, "en"],
  ["a table first", 1440, "en"],
  ["a table first", 900, "en"],
] as const) {
  test(`with ${kind}, at ${width}px in ${language}, the lines of the assistant's write come in the top margin and the text doesn't move`, async () => {
    test.setTimeout(90_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, width, 800);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await mindOf(window, kind);

    await sampleFrames(window);
    await askInAssistant(window, "Add a section on the risks");
    await expect(window.getByTestId("applied-line")).toBeVisible();
    const frames = await stopSampling(window);

    // The text starts in one place from the first frame to the last.
    expect(frames.length).toBeGreaterThan(20);
    expect(new Set(frames.map((frame) => Math.round(frame.first))).size).toBe(1);
    expect(new Set(frames.map((frame) => Math.round(frame.editor))).size).toBe(1);
    // Both lines sit above it, in the margin, and "Writing…" was shown.
    const lines = frames.flatMap((frame) => [frame.writing, frame.line]).filter((span) => span);
    expect(frames.some((frame) => frame.writing)).toBe(true);
    expect(frames.some((frame) => frame.line)).toBe(true);
    for (const span of lines) {
      expect(span?.[0]).toBeGreaterThanOrEqual((frames[0]?.editor ?? 0) - 1);
      expect(span?.[1]).toBeLessThanOrEqual((frames[0]?.first ?? 0) + 1);
    }
    await app.close();
  });
}

test("the bar of changes waiting never shows for what the User's own Question is writing", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 800);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await mindOf(window, "a heading first");

  await window.evaluate(() => {
    const holder = globalThis as unknown as { barShown: number };
    holder.barShown = 0;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="proposals-bar"]')) holder.barShown += 1;
    }).observe(document.body, { subtree: true, childList: true });
  });
  await askInAssistant(window, "Add a section on the risks");
  await expect(window.getByTestId("applied-line")).toBeVisible();
  expect(
    await window.evaluate(() => (globalThis as unknown as { barShown: number }).barShown),
  ).toBe(0);
  await app.close();
});

test("the first-run guide keeps the band's padding, so a Writing line shows above its first line and over no text", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 900, 800);
  await dismissChatSetup(window);
  const exampleId = await frontMind(window).getAttribute("data-mind-id");
  if (!exampleId) throw new Error("No Mind is in front.");
  const exampleTab = window.locator(`[data-testid="mind-tab"][data-mind-id="${exampleId}"]`);
  await newMind(window);
  await pointAndClick(window, exampleTab.getByTestId("tab-close"));
  await markSteps(window, { seen: false });
  await expect(window.getByTestId("start-guide")).toBeVisible();
  const editor = window.locator('[data-testid="mind-editor"]:visible');
  const mindId = await frontMind(window).getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is in front.");

  await emit(app, "mind.writing", { mindId, place: { after: null } });
  const writing = editor.getByTestId("mind-writing");
  await expect(writing).toBeVisible();

  expect(
    await editor.evaluate((element) => ({
      paddingTop: getComputedStyle(element).paddingTop,
      minHeight: getComputedStyle(element).minHeight,
    })),
  ).toEqual({ paddingTop: "26px", minHeight: "0px" });
  const band = await writing.boundingBox();
  const editorBox = await editor.boundingBox();
  const first = await editor.locator(":scope > p").first().boundingBox();
  if (!band || !editorBox || !first)
    throw new Error("The writing line, the editor or the guide's first line has no box.");
  expect(band.y).toBeGreaterThanOrEqual(editorBox.y - 1);
  expect(band.y + band.height).toBeLessThanOrEqual(first.y + 1);
  await expect(window.getByTestId("start-guide")).toBeVisible();
  await app.close();
});

for (const [kind, label, selector, nestedText] of [
  ["a nested list", "list", "li p", "A nested list paragraph"],
  ["a table first", "table", "td p", "Q3"],
] as const) {
  test(`Writing over or after a nested ${label} paragraph uses the top-level Block edge in the page band without moving following text`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 900, 800);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    const mindId = await mindOf(window, kind);
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    const nested = editor.locator(selector).filter({ hasText: nestedText });
    await expect(nested).toHaveCount(1);
    const nestedId = await nested.getAttribute("data-id");
    if (!nestedId) throw new Error(`The nested ${label} paragraph has no Block id.`);
    const following = editor.locator(":scope > p");
    await expect(following).toHaveCount(1);
    const followingTops = () =>
      following.evaluateAll((all) =>
        all.map((each) => Math.round(each.getBoundingClientRect().top)),
      );
    const writing = editor.getByTestId("mind-writing");

    for (const place of ["over", "after"] as const) {
      const before = await followingTops();
      await emit(app, "mind.writing", {
        mindId,
        place: place === "over" ? { over: nestedId } : { after: nestedId },
      });
      await expect(writing).toBeVisible();
      expect(await followingTops()).toEqual(before);
      const placement = await writing.evaluate((line, text) => {
        const editor = line.closest('[data-testid="mind-editor"]');
        const nested = [...(editor?.querySelectorAll("p") ?? [])].find(
          (each) => each.textContent === text,
        );
        if (!editor || !nested) return { relation: "missing", inBand: false };
        let top: Element = nested;
        while (top.parentElement && top.parentElement !== editor) top = top.parentElement;
        const band = line.getBoundingClientRect();
        const relation =
          line.parentElement !== editor
            ? "nested"
            : line.nextElementSibling === top
              ? "before"
              : line.previousElementSibling === top
                ? "after"
                : "top-level";
        return {
          relation,
          inBand:
            band.top >= editor.getBoundingClientRect().top - 1 &&
            band.bottom <= top.getBoundingClientRect().top + 1,
        };
      }, nestedText);
      expect(placement).toEqual({ relation: place === "over" ? "before" : "after", inBand: true });
      await emit(app, "mind.writing", { mindId, place: null });
      await expect(writing).toBeHidden();
      expect(await followingTops()).toEqual(before);
    }
    await app.close();
  });
}

test("Writing and the applied line are never visible together, and the applied line returns after Writing ends", async () => {
  test.setTimeout(90_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 900, 800);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await mindOf(window, "a heading first");
  const editor = window.locator('[data-testid="mind-editor"]:visible');
  const line = editor.getByTestId("applied-line");

  await askInAssistant(window, "Add a section on the risks");
  await expect(line).toBeVisible();
  await sampleFrames(window);
  await expect
    .poll(() => window.evaluate(() => (globalThis as unknown as { frames: Frame[] }).frames.length))
    .toBeGreaterThan(0);
  await askInAssistant(window, "make it longer slowly");
  await expect(line).toBeVisible();
  await expect
    .poll(() =>
      window.evaluate(() => {
        const frames = (globalThis as unknown as { frames: Frame[] }).frames;
        const lastWriting = frames.findLastIndex((frame) => frame.writingVisible);
        return (
          lastWriting >= 0 &&
          frames.slice(lastWriting + 1).some((frame) => frame.lineVisible && !frame.writingVisible)
        );
      }),
    )
    .toBe(true);
  const frames = await stopSampling(window);

  expect(frames[0]).toMatchObject({ writingVisible: false, lineVisible: true });
  expect(frames.some((frame) => frame.writingVisible && !frame.lineVisible)).toBe(true);
  expect(frames.every((frame) => !(frame.writingVisible && frame.lineVisible))).toBe(true);
  const lastWriting = frames.findLastIndex((frame) => frame.writingVisible);
  expect(
    frames.slice(lastWriting + 1).some((frame) => frame.lineVisible && !frame.writingVisible),
  ).toBe(true);
  await app.close();
});

for (const [language, longCount] of [
  [
    "en",
    "Changed 1,234,567,890 paragraphs and added 2,345,678,901 tables and 3,456,789,012 charts",
  ],
  ["zh-CN", "修改了 1,234,567,890 个段落，添加了 2,345,678,901 个表格和 3,456,789,012 个图表"],
] as const) {
  test(`at 900px in ${language}, a long change count stays on one line with Undo and Review changes inside the band`, async () => {
    test.setTimeout(90_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 900, 800);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await mindOf(window, "a heading first");
    await askInAssistant(window, "Add a section on the risks");
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    const line = editor.getByTestId("applied-line");
    const count = line.getByTestId("applied-count");
    await expect(line).toBeVisible();
    await count.evaluate((element, text) => {
      element.textContent = text;
    }, longCount);
    await expect(count).toHaveText(longCount);

    expect(
      await count.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const tops = [...range.getClientRects()].map((rect) => Math.round(rect.top));
        return { lines: new Set(tops).size, whiteSpace: getComputedStyle(element).whiteSpace };
      }),
    ).toEqual({ lines: 1, whiteSpace: "nowrap" });
    expect(await count.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await line.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    const band = await line.boundingBox();
    if (!band) throw new Error("The applied line has no box.");
    for (const action of ["applied-undo", "applied-review"] as const) {
      const button = line.getByTestId(action);
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      if (!box) throw new Error(`${action} has no box.`);
      expect(box.x).toBeGreaterThanOrEqual(band.x);
      expect(box.y).toBeGreaterThanOrEqual(band.y);
      expect(box.x + box.width).toBeLessThanOrEqual(band.x + band.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(band.y + band.height + 1);
    }
    expect(
      await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
    ).toBe(true);
    await app.close();
  });
}
