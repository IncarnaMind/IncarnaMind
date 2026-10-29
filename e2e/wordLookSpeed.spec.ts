import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { longContract } from "../tests/helpers/longContract";
import {
  chooseLook,
  createDataFolder,
  dismissChatSetup,
  importWordFile,
  installKeyLatency,
  largestCorpusFile,
  launchApp,
  msToOpen,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  takeKeyLatency,
} from "./app";
import { INPUT_CEILING_MS } from "./feel";

/*
 * The Word look is drawn with one rule a style, never one decoration a Block, which ProseMirror
 * looks up for each child in its parent's list: 280 ms a keystroke on a 6,090-Block lease in
 * the Page view spike (#755). These hold it there on CI's slower machines, as relations to the
 * same Note drawn plain and as bounds, and print what they measured. A key is timed twice: how
 * long the app takes to take it (the main process reads keys before the page does, so work
 * there holds every key back, though the page can't see it), and keydown to the page's next
 * frame.
 */

let dataDir: string;
let home: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  files = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(files);
});

const KEYS = 20;
const BETWEEN_KEYS_MS = 40;
/** 100 ms on a laptop; CI's runners are two to five times slower. */
const TAKEN_CEILING_MS = 200;

/** Twenty keys at the end of a paragraph, as a person types them. */
async function typeAt(window: Page, index: number) {
  const target = window.getByTestId("mind-editor").locator(":scope > p").nth(index);
  await target.scrollIntoViewIfNeeded();
  await pointAndClick(window, target);
  await window.keyboard.press("End");
  await takeKeyLatency(window);
  const start = Date.now();
  await window.keyboard.type("x".repeat(KEYS), { delay: BETWEEN_KEYS_MS });
  const taken = Math.round((Date.now() - start) / KEYS - BETWEEN_KEYS_MS);
  return { taken, ...(await takeKeyLatency(window)) };
}

test("typing on the 304-page contract in its look takes each key in a moment, as the same Note drawn plain does", async () => {
  test.setTimeout(480_000);
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Framework Services Agreement.docx", longContract());
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("h1")).toHaveCount(241, { timeout: 120_000 });
  await expect(window.getByTestId("mind-word-progress")).toHaveCount(0);
  await expect(editor.locator("[data-word-look]").first()).toBeVisible();
  await installKeyLatency(window);
  const clauses = await editor.locator(":scope > p").count();

  const word = [await typeAt(window, 2), await typeAt(window, clauses - 2)];
  await chooseLook(window, "plain");
  await expect(window.locator(".mind-editor-frame > style")).toHaveCount(0);
  const plain = [await typeAt(window, 2), await typeAt(window, clauses - 2)];
  const result = { word, plain };
  console.log(`Typing on the 304-page contract (ms): ${JSON.stringify(result)}`);
  test.info().annotations.push({ type: "typing", description: JSON.stringify(result) });

  for (const [at, typed] of [...word, ...plain].entries()) {
    expect(typed.keys).toBeGreaterThanOrEqual(KEYS - 2);
    // About 40 ms on a laptop and 60 to 85 ms on a Linux runner. Work in the main process for
    // every change holds each key back, by seconds on a Note this long.
    expect(
      typed.taken,
      `the app taking each key (${at < word.length ? "Word look" : "plain"})`,
    ).toBeLessThanOrEqual(TAKEN_CEILING_MS);
    expect(typed.p95, "the slowest keystrokes").toBeLessThanOrEqual(INPUT_CEILING_MS);
  }
  for (const [at, typed] of word.entries()) {
    // Per-Block decorations would make the look many times slower than plain, and slower down the page.
    expect(typed.median, "keydown to the next frame, against the plain Note").toBeLessThanOrEqual(
      (plain[at]?.median ?? 0) * 1.5 + 15,
    );
  }
  await app.close();
});

test("the Word corpus's largest file opens in its look about as fast as drawn plain", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const corpus = largestCorpusFile();
  await importWordFile(app, window, files, basename(corpus), readFileSync(corpus));
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator(":scope > *").first()).toBeVisible();
  await expect(window.getByTestId("mind-word-progress")).toHaveCount(0);
  const blocks = await editor.locator(":scope > *").count();
  const ids = await window.evaluate(
    async (title) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const imported = (await core.listMinds()).find((mind) => mind.title === title);
      const elsewhere = await core.createMind({ title: "Elsewhere" });
      return { imported: imported?.id ?? "", elsewhere: elsewhere.id };
    },
    basename(corpus, ".docx"),
  );
  expect(ids.imported).not.toBe("");
  const opens = async () => {
    const runs: number[] = [];
    for (let run = 0; run < 3; run++) {
      await msToOpen(window, ids.elsewhere, ".ProseMirror", 1);
      runs.push(await msToOpen(window, ids.imported, ".ProseMirror > *", blocks));
    }
    return runs.sort((a, b) => a - b)[1] ?? 0;
  };
  const word = await opens();
  await chooseLook(window, "plain");
  const plain = await opens();
  const result = { file: basename(corpus), blocks, word, plain };
  console.log(`Opening the corpus's largest file (ms): ${JSON.stringify(result)}`);
  test.info().annotations.push({ type: "open", description: JSON.stringify(result) });
  // The runs of three vary by a third on CI's runners; a look drawn per Block would be many times plain.
  expect(word).toBeLessThanOrEqual(plain * 2 + 500);
  expect(word).toBeLessThanOrEqual(10_000);
  await app.close();
});
