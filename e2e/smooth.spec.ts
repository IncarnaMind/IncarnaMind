import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Nothing moves that the User didn't move (DESIGN.md › Feel): adding Documents,
 * through their processing and Tagging, moves no row of the sidebar; a status
 * is shown only once it has lasted 300 ms; a Tag's dot has its place kept; and
 * the Question doesn't jump when its Answer starts. Measured with the browser's
 * own layout-shift entries, and with a frame by frame sample where an entry
 * can't see the change (a name cut shorter).
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

/** What the page keeps while a test watches: shifts, and the sidebar's rows frame by frame. */
interface Watch {
  firstRowAt: number | null;
  shifts: { at: number; moved: string[] }[];
  frames: {
    at: number;
    status: string;
    names: Record<string, { width: number; status: string; tagging: string; marked: boolean }>;
  }[];
}

/** Starts the watch: from now on the page records its layout shifts and, each frame, its rows. */
const watchSidebar = (window: Page) =>
  window.evaluate(() => {
    const watch: Watch = { firstRowAt: null, shifts: [], frames: [] };
    (globalThis as unknown as { watch: Watch }).watch = watch;
    const sidebar = () => document.querySelector('[data-testid="sidebar"]');
    const tree = () => sidebar()?.querySelector('[role="tree"]') ?? null;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        startTime: number;
        hadRecentInput: boolean;
        sources: { node: Node | null }[];
      }[]) {
        if (entry.hadRecentInput) continue;
        const moved = entry.sources.flatMap((source) => {
          const node = source.node;
          const element = node instanceof Element ? node : (node?.parentElement ?? null);
          if (!element || !tree()?.contains(element)) return [];
          const row = element.closest("li, [data-testid]");
          return [row?.getAttribute("data-testid") ?? element.tagName];
        });
        if (moved.length > 0) watch.shifts.push({ at: entry.startTime, moved });
      }
    }).observe({ type: "layout-shift", buffered: true });
    const tick = () => {
      const names: Watch["frames"][number]["names"] = {};
      for (const row of sidebar()?.querySelectorAll('[data-testid="document-list-item"]') ?? []) {
        const name = row.querySelector('[data-testid="row-text"]');
        if (name) {
          names[row.getAttribute("data-document-id") ?? ""] = {
            width: Math.round(name.getBoundingClientRect().width * 10) / 10,
            status: row.getAttribute("data-status") ?? "",
            tagging: row.getAttribute("data-tagging") ?? "",
            marked: row.querySelector('[data-testid="tag-marks"]') !== null,
          };
        }
      }
      if (watch.firstRowAt === null && Object.keys(names).length > 0) {
        watch.firstRowAt = performance.now();
      }
      watch.frames.push({
        at: performance.now(),
        status: sidebar()?.querySelector('[data-testid="sidebar-status"]')?.textContent ?? "",
        names,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const watched = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { watch: Watch }).watch);

const settled = (frame: Watch["frames"][number]) => {
  const rows = Object.values(frame.names);
  return (
    rows.length > 0 &&
    frame.status === "" &&
    rows.every(
      (row) => row.status === "ready" && row.tagging !== "pending" && row.tagging !== "tagging",
    )
  );
};

// The watch ends on what the sampler saw, not on what the page shows now: a check that lands
// within a frame of the last change would end it before any frame held the finished rows. Two
// frames in a row, so the last change's layout shift has been reported by the time it is read.
const untilSettled = (window: Page) =>
  expect.poll(async () => (await watched(window)).frames.slice(-2).filter(settled).length).toBe(2);

/** The statuses the footer showed for less than `leastMs`, by their text, from the sampled frames. */
function shownTooShort(frames: Watch["frames"], leastMs: number): string[] {
  const short: string[] = [];
  let runStart: number | null = null;
  let text = "";
  for (const frame of frames) {
    if (frame.status !== "" && runStart === null) {
      runStart = frame.at;
      text = frame.status;
    } else if (frame.status === "" && runStart !== null) {
      if (frame.at - runStart < leastMs) short.push(text);
      runStart = null;
    }
  }
  return short;
}

/** Documents with names long enough to be cut in the sidebar, one a Chinese name; six unless fewer are asked for. */
async function someDocuments(count = 6): Promise<string[]> {
  const names = [
    "Harbour sediment survey, east basin transects, combined field notes, part 1",
    "Harbour sediment survey, east basin transects, combined field notes, part 2",
    "港口潮汐观测报告：东部盆地断面的综合现场记录与实验室结果第三部分",
    "Harbour sediment survey, east basin transects, combined field notes, part 4",
    "Harbour sediment survey, east basin transects, combined field notes, part 5",
    "Harbour sediment survey, east basin transects, combined field notes, part 6",
  ];
  const paths: string[] = [];
  for (const [index, name] of names.slice(0, count).entries()) {
    const path = join(sources, `${name}.md`);
    await writeFile(
      path,
      `# ${name}\n\nThe harbour master publishes the tide tables for berth ${index + 1}. ${"Spring tides come at new and full moon. ".repeat(30)}\n`,
    );
    paths.push(path);
  }
  return paths;
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [1100, 1440]) {
    test(`adding six Documents moves no row of the sidebar, through processing and Tagging; a status shows only after 300 ms and stays 500 ms, and a Tag's dot has its place kept (${language}, ${width}px)`, async () => {
      test.setTimeout(120_000);
      const paths = await someDocuments();
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await setWindowSize(app, window, width, 900);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await newMind(window);
      await setLanguage(window, language);
      // The line that says a Mind was made goes by itself, and with it the footer's place moves.
      await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveCount(0, {
        timeout: 15_000,
      });
      await watchSidebar(window);

      await window.getByTestId("add-documents-input").setInputFiles(paths);
      await expectReadyDocuments(window, 6);
      await untilSettled(window);
      const seen = await watched(window);

      // The User's own action: their files arriving, and the sidebar making room for them, at once.
      const arrived = seen.firstRowAt ?? 0;
      const unasked = seen.shifts.filter((shift) => shift.at > arrived + 100);
      expect(unasked, "layout shifts in the sidebar's rows").toEqual([]);

      // A status shows only after 300 ms, and stays at least 500 ms (a frame is about 17 ms).
      expect(shownTooShort(seen.frames, 480), "a status shown for under 500 ms").toEqual([]);

      // Once a Document is read, its name keeps its width while its Tags arrive; one that ends
      // with none only gets the room back its dot's place held.
      const widths = new Map<string, { each: number[]; marked: boolean }>();
      for (const frame of seen.frames) {
        for (const [id, row] of Object.entries(frame.names)) {
          if (row.status !== "ready") continue;
          const kept = widths.get(id) ?? { each: [], marked: false };
          if (kept.each.at(-1) !== row.width) kept.each.push(row.width);
          kept.marked = row.marked;
          widths.set(id, kept);
        }
      }
      expect(widths.size).toBeGreaterThan(0);
      for (const [id, { each, marked }] of widths) {
        if (marked) expect(each, `the name's width of ${id}, once tagged`).toHaveLength(1);
        else
          expect(each, `the name's width of ${id}, untagged`).toEqual(
            each.toSorted((a, b) => a - b),
          );
      }
      await app.close();
    });
  }
}

for (const count of [3, 4, 5]) {
  test(`a status for ${count} Documents is shown for 500 ms or not at all, however long their work lasts`, async () => {
    test.setTimeout(120_000);
    const paths = await someDocuments(count);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await newMind(window);
    await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveCount(0, {
      timeout: 15_000,
    });
    await watchSidebar(window);

    await window.getByTestId("add-documents-input").setInputFiles(paths);
    await expectReadyDocuments(window, count);
    await untilSettled(window);
    const seen = await watched(window);
    expect(shownTooShort(seen.frames, 480), "a status shown for under 500 ms").toEqual([]);
    await app.close();
  });
}

test("the Question doesn't jump when its Answer starts", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await newMind(window);
  await window.evaluate(() => {
    const frames: { question: number | null; answer: boolean }[] = [];
    (globalThis as unknown as { frames: typeof frames }).frames = frames;
    const tick = () => {
      const question = document.querySelector('[data-testid="assistant-question"]');
      frames.push({
        question: question ? question.getBoundingClientRect().top : null,
        answer: document.querySelector('[data-testid="assistant-answer"]') !== null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("When do spring tides happen?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 30_000,
  });
  const frames = await window.evaluate(
    () =>
      (globalThis as unknown as { frames: { question: number | null; answer: boolean }[] }).frames,
  );
  const starts = frames.findIndex((frame) => frame.answer);
  expect(starts).toBeGreaterThan(0);
  // Drawn in the same frame as the Answer, as a busy computer can, the Question has nowhere to jump from.
  const drawn = frames.findIndex((frame) => frame.question !== null);
  if (drawn < starts) {
    const before = frames[starts - 1]?.question;
    const after = frames[starts]?.question;
    expect(before).not.toBeNull();
    expect(Math.abs((after ?? 0) - (before ?? 0))).toBeLessThanOrEqual(1);
  }
  await app.close();
});
