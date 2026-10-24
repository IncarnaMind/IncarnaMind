import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  type MindChild,
  mindNode,
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
} as const;

async function mindOf(window: Page, kind: keyof typeof MINDS): Promise<void> {
  const blocks = MINDS[kind]();
  const update = Array.from(blocksUpdate([...blocks]));
  await window.evaluate(
    async ([change]) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await core.createMind({ title: "Q3 review" });
      await core.applyMindUpdate(mind.id, new Uint8Array(change ?? []));
      await core.closeMind(mind.id);
    },
    [update] as const,
  );
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Q3 review" }),
  );
  await expect(window.locator('[data-testid="mind-editor"]:visible')).toBeVisible();
}

interface Frame {
  editor: number;
  first: number;
  writing: [number, number] | null;
  line: [number, number] | null;
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
      if (editor && (first || real)) {
        holder.frames.push({
          editor: editor.getBoundingClientRect().top,
          first: (real ?? first)?.getBoundingClientRect().top ?? 0,
          writing: span(editor.querySelector('[data-testid="mind-writing"]')),
          line: span(editor.querySelector('[data-testid="applied-line"]')),
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
