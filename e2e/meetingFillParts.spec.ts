import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  useLocalChatModel as selectLocalChatModel,
  setWindowSize,
  startRecording,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to keep a still of the line there. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const PART = /^Filling in the note on this computer, part (\d+) of (\d+)…$/;

/** Lines of `talk` that pass one part's size at any window, so the notes are asked for in two. */
const LINES_FOR_TWO_PARTS = 44;

/** A stretch of talk a side says in a breath: each differs, so no line repeats another. */
const talk = (side: string, index: number) =>
  Array.from(
    { length: 15 },
    (_, sentence) =>
      `${side} point ${index + 1}.${sentence + 1} on the rollout plan: the team agreed who does it and by when.`,
  ).join(" ");

const meetingOf = (window: Page): Promise<Meeting | undefined> =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listMeetings()).find((each) => each.kind === "meeting");
  });

// protects=a call too long for one request has its notes asked for in parts, and the line under the stopped Meeting says which part the note is on and how many there are (#2839); fails_when=the line says only "Filling in the note…" through every part, the count goes backwards, or the fill ends with a part still shown; no_claim=how long a part takes on a real model.
test("a long call's line says which part the note is on", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: {
      lines: Array.from({ length: 30 }, (_, index) => talk("Our", index)),
      theirLines: Array.from({ length: 30 }, (_, index) => talk("Their", index)),
      maxSpeechMs: 400,
    },
  });
  try {
    await setWindowSize(app, window, 1200, 800);
    await dismissChatSetup(window);
    await selectLocalChatModel(window);
    const seen: { at: number; of: number }[] = [];
    let still: Promise<unknown> | null = null;
    await window.exposeFunction("partShown", (at: number, of: number) => {
      seen.push({ at, of });
      if (SCREENSHOTS && !still) {
        still = mkdir(SCREENSHOTS, { recursive: true }).then(() =>
          window.screenshot({ path: join(SCREENSHOTS, "meeting-fill-part.png") }),
        );
      }
    });
    await window.evaluate((pattern) => {
      const shown = new RegExp(pattern);
      let last = "";
      new MutationObserver(() => {
        const text = document.querySelector('[data-testid="meeting-fill-line"]')?.textContent ?? "";
        const found = text === last ? null : shown.exec(text);
        last = text;
        if (found) {
          void (
            globalThis as unknown as { partShown(at: number, of: number): Promise<void> }
          ).partShown(Number(found[1]), Number(found[2]));
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, PART.source);
    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await expect
      .poll(async () => (await meetingOf(window))?.transcript?.lines ?? 0, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(LINES_FOR_TWO_PARTS);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    await expect
      .poll(async () => (await meetingOf(window))?.fill?.state, { timeout: 60_000 })
      .toBe("filled");
    await still;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.of ?? 0).toBeGreaterThan(1);
    for (const [index, part] of seen.entries()) {
      expect(part.at).toBeLessThanOrEqual(part.of);
      expect(part.at).toBeGreaterThanOrEqual(seen[index - 1]?.at ?? 1);
      expect(part.of).toBeGreaterThanOrEqual(seen[index - 1]?.of ?? 2);
    }
    const fill = (await meetingOf(window))?.fill;
    expect(fill).toMatchObject({ state: "filled", unfinishedParts: 0 });
    expect(fill?.part).toBeUndefined();
  } finally {
    await app.close();
  }
});
