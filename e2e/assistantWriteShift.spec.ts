import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The assistant writes into the open Mind (#1325): the line at the Mind's top and the Question in
 * the assistant stay where they are as the write lands, and the Answer's card keeps its height as
 * its waiting row becomes the applied one. Relations, not pixels: the same box before and after.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

interface Frame {
  /** The height of the one line in the Mind's top band, "Writing…" or the applied change's line. */
  band: number | null;
  writing: boolean;
  line: boolean;
  /** The top of the Mind's first line of text. */
  first: number | null;
  /** The newest Question's top, and the Answer's card's top and height. */
  question: number | null;
  card: number | null;
  cardHeight: number | null;
  /** The card's own count of what waits is drawn: its waiting row is complete. */
  counted: boolean;
  undo: boolean;
}

/** Every frame from now on: the Mind's band, its text, the Question and the Answer's card. */
const sampleFrames = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { frames: Frame[]; sampling: boolean };
    holder.frames = [];
    holder.sampling = true;
    const shown = (element: Element | null | undefined): element is Element =>
      element !== null &&
      element !== undefined &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible";
    const top = (element: Element | null | undefined) =>
      element ? Math.round(element.getBoundingClientRect().top) : null;
    const sample = () => {
      const editor = [...document.querySelectorAll('[data-testid="mind-editor"]')].find(
        (each) => each.getClientRects().length > 0,
      );
      const writing = editor?.querySelector('[data-testid="mind-writing"]') ?? null;
      const line = editor?.querySelector('[data-testid="applied-line"]') ?? null;
      const band = shown(writing) ? writing : shown(line) ? line : null;
      const first = [...(editor?.children ?? [])].find(
        (each) =>
          !each.matches('[data-testid="mind-writing"], [data-testid="applied-line"]') &&
          !each.className.includes("ProseMirror-widget"),
      );
      const questions = [...document.querySelectorAll('[data-testid="assistant-question"]')];
      const card = [...document.querySelectorAll('[data-testid="mind-changes"]')].find(shown);
      const undo = card?.querySelector('[data-testid="mind-changes-undo"]');
      holder.frames.push({
        band: band ? Math.round(band.getBoundingClientRect().height) : null,
        writing: shown(writing),
        line: shown(line),
        first: top(first),
        question: top(questions.at(-1)),
        card: top(card),
        cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
        counted: shown(card?.querySelector('[data-testid="mind-changes-left"]')),
        undo: shown(undo),
      });
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

const heightsOf = (frames: readonly Frame[], pick: (frame: Frame) => number | null) => [
  ...new Set(frames.map(pick).filter((each): each is number => each !== null)),
];

for (const language of ["en", "zh-CN"] as const) {
  test(`at 1440px in ${language}, the assistant's write leaves the Mind's top line and the Question where they were`, async () => {
    test.setTimeout(90_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await mindWrittenBefore(window, "Q3 review", [
      { heading: "Summary" },
      { note: "The quarter was good. Sales rose and the margin held." },
    ]);
    await pointAndClick(
      window,
      window.getByTestId("mind-list-item").filter({ hasText: "Q3 review" }),
    );
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    await expect(editor).toContainText("The quarter was good.");

    await sampleFrames(window);
    await askInAssistant(window, "Add a section on the risks");
    await expect(editor).toContainText("The supplier is late.");
    await expect(editor.getByTestId("applied-line")).toBeVisible();
    await expect(window.getByTestId("mind-changes-undo")).toBeVisible();
    // Two frames after the last of it is painted.
    await window.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const frames = await stopSampling(window);

    // Both lines of the band and both rows of the card were on screen, and the Question beside its Answer.
    expect(frames.some((frame) => frame.writing)).toBe(true);
    expect(frames.some((frame) => frame.line && !frame.writing)).toBe(true);
    expect(frames.some((frame) => frame.card !== null && !frame.undo)).toBe(true);
    expect(frames.some((frame) => frame.card !== null && frame.undo)).toBe(true);
    expect(frames.some((frame) => frame.card === null)).toBe(true);
    const questions = frames.filter((frame) => frame.question !== null);
    expect(questions.some((frame) => frame.card === null)).toBe(true);

    // The Mind's top line is one line high whether it says "Writing…" or shows the change, and the
    // text under it never moves.
    const writing = heightsOf(
      frames.filter((frame) => frame.writing),
      (frame) => frame.band,
    );
    const applied = heightsOf(
      frames.filter((frame) => frame.line && !frame.writing),
      (frame) => frame.band,
    );
    expect(writing).toHaveLength(1);
    expect(applied).toEqual(writing);
    expect(heightsOf(frames, (frame) => frame.first)).toHaveLength(1);

    // The Question stays where it was while the Answer's card arrives.
    expect(questions.some((frame) => frame.card !== null)).toBe(true);
    expect(heightsOf(questions, (frame) => frame.question)).toHaveLength(1);

    // The card keeps its height as its waiting row becomes the applied one, so nothing under it moves.
    const waiting = heightsOf(
      frames.filter((frame) => frame.card !== null && !frame.undo && frame.counted),
      (frame) => frame.cardHeight,
    );
    const done = heightsOf(
      frames.filter((frame) => frame.card !== null && frame.undo),
      (frame) => frame.cardHeight,
    );
    expect(waiting).toHaveLength(1);
    expect(done).toEqual(waiting);

    await app.close();
  });
}
