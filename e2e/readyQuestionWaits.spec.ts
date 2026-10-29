import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { EXAMPLE_SETS } from "../src/core/exampleSets";
import { buildPdf } from "../tests/helpers/pdf";
import {
  assistantAnswers,
  createDataFolder,
  launchApp,
  markSteps,
  paletteFound,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  welcomeStep as step,
} from "./app";

/**
 * The first frame of a first run: the card's ready Question, pressed before its Documents have
 * been read (#2218). The press says what it is reading at once, with Stop, and answers when the
 * read finishes; Stop keeps the Question and says Stopped. The reading is held still by the
 * Documents themselves: pages enough that reading them outlasts a press.
 */

/** Pages enough that reading the example's Documents outlasts the first frame and a press. */
const PAGES = 4_000;

/** The example's two Documents, each with the quote it is cited for, repeated over many pages. */
function slowDocuments(language: "en" | "zh-CN"): Map<string, Uint8Array> {
  const set = EXAMPLE_SETS.credit[language];
  const files = new Map<string, Uint8Array>();
  for (const quote of set.ready?.quotes ?? []) {
    const page = language === "zh-CN" ? { chineseLines: [quote.quote] } : { lines: [quote.quote] };
    files.set(`${quote.document}.pdf`, buildPdf(Array.from({ length: PAGES }, () => page)));
  }
  return files;
}

/**
 * A data folder that will make the example in `language`, whose Documents are the slow ones: the
 * copy keeps files already in the folder. The language and the card's step 1 are set on a run
 * without the example, so the next one shows the card's Ask step before anything is read.
 */
async function prepared(language: "en" | "zh-CN"): Promise<string> {
  const dataDir = await createDataFolder();
  const first = await launchApp(dataDir);
  await setWindowSize(first.app, first.window, 900, 900);
  await setLanguage(first.window, language);
  await markSteps(first.window, { started: true, indexed: true });
  await first.app.close();
  const folder = join(dataDir, EXAMPLE_SETS.credit[language].folder);
  await mkdir(folder, { recursive: true });
  for (const [name, pdf] of slowDocuments(language)) await writeFile(join(folder, name), pdf);
  return dataDir;
}

test("at first open, the Ask row says something in every frame, then the Question (900px)", async () => {
  test.setTimeout(180_000);
  const dataDir = await createDataFolder();
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await setWindowSize(app, window, 900, 900);
    // Step 1 done, as a file of theirs or a connected app makes it: step 2 is open from the first frame.
    await markSteps(window, { started: true, indexed: true });
    const seen = await window.evaluate(async () => {
      const texts: string[] = [];
      const scan = () => {
        const row = document.querySelector('[data-testid="first-open-ready-row"]');
        if (!row) return;
        const text = (row.textContent ?? "").trim();
        if (texts.at(-1) !== text) texts.push(text);
      };
      const observer = new MutationObserver(scan);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      scan();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      observer.disconnect();
      return texts;
    });
    // Never a blank hole while the example's Documents are listed: it says what it is doing.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((text) => text === "")).toEqual([]);
    await expect(window.getByTestId("first-open-ready")).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
    await removeDataFolder(dataDir);
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`pressed before its Documents are read, the ready Question says so at once and then answers (${language}, 900px)`, async () => {
    test.setTimeout(180_000);
    const dataDir = await prepared(language);
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 900);
      // The press, at the first frame, and what the User sees within 100 ms of it.
      const pressed = await window.evaluate(async () => {
        const waitFor = (selector: string, timeout: number) =>
          new Promise<HTMLElement | null>((resolve) => {
            const found = document.querySelector<HTMLElement>(selector);
            if (found) return resolve(found);
            const observer = new MutationObserver(() => {
              const now = document.querySelector<HTMLElement>(selector);
              if (!now) return;
              observer.disconnect();
              resolve(now);
            });
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              characterData: true,
            });
            setTimeout(() => {
              observer.disconnect();
              resolve(null);
            }, timeout);
          });
        const button = await waitFor('[data-testid="first-open-ready"]', 30_000);
        if (!button) return { error: "no ready Question" };
        const at = performance.now();
        button.click();
        const line = await waitFor('[data-testid="first-open-ready-waiting"]', 5_000);
        const stop = document.querySelector('[data-testid="first-open-ready-stop"]');
        return {
          shown: line === null ? null : Math.round(performance.now() - at),
          text: line?.textContent ?? "",
          stop: stop !== null,
        };
      });
      expect(pressed.error).toBeUndefined();
      // A visible pending state within 100 ms, in the interface's words, naming the Document read.
      expect(pressed.shown).not.toBeNull();
      expect(pressed.shown as number).toBeLessThan(100);
      const waiting = (EXAMPLE_SETS.credit[language].ready?.quotes ?? []).map((quote) =>
        language === "zh-CN" ? `正在读取“${quote.document}”…` : `Reading “${quote.document}”…`,
      );
      expect(waiting).toContain(pressed.text);
      expect(pressed.stop).toBe(true);

      // Then the Answer, once the Documents are read: the click was never swallowed.
      const answer = assistantAnswers(window).last();
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 120_000 });
      await expect(answer.getByTestId("answer-example")).toBeVisible();
      await expect(answer.getByTestId("citation-chip")).toHaveCount(2);
      await expect(step(window, "question")).toHaveAttribute("data-state", "done");
    } finally {
      await app.close();
      await removeDataFolder(dataDir);
    }
  });

  test(`a file of one's own that becomes ready while it waits does not swallow the press (${language}, 900px)`, async () => {
    test.setTimeout(180_000);
    const dataDir = await prepared(language);
    const sources = await createDataFolder();
    const own = join(sources, "Own brief.md");
    await writeFile(own, "# Own brief\n\nThe harbour master publishes the tide tables.\n");
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 900);
      await expect(window.getByTestId("first-open-ready")).toBeVisible({ timeout: 30_000 });
      await window.getByTestId("first-open-ready").click();
      await expect(window.getByTestId("first-open-ready-waiting")).toBeVisible({ timeout: 5_000 });
      // The focus moves on to Stop, where the pressed button was.
      await expect(window.getByTestId("first-open-ready-stop")).toBeFocused();

      // Their own file, read at once: the card's Question turns to it while the example's waits.
      await window.getByTestId("add-documents-input").setInputFiles([own]);
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
              return (await bridge.readyQuestion())?.scope !== null;
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      // The row keeps saying what the first press waits for, and offers no button to press again.
      await expect(window.getByTestId("first-open-ready-waiting")).toBeVisible();
      await expect(window.getByTestId("first-open-ready")).toHaveCount(0);

      // One Answer only, the example's: the second press was never taken.
      const answer = assistantAnswers(window).last();
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 120_000 });
      await expect(answer.getByTestId("answer-example")).toBeVisible();
      await expect(window.getByTestId("assistant-question")).toHaveCount(1);
    } finally {
      await app.close();
      await removeDataFolder(dataDir);
      await removeDataFolder(sources);
    }
  });

  test(`Stop while the ready Question waits keeps the Question and says Stopped (${language}, 900px)`, async () => {
    test.setTimeout(180_000);
    const dataDir = await prepared(language);
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 900);
      const stop = step(window, "question").getByTestId("first-open-ready-stop");
      await expect(window.getByTestId("first-open-ready")).toBeVisible({ timeout: 30_000 });
      await window.getByTestId("first-open-ready").click();
      await expect(stop).toBeVisible({ timeout: 5_000 });
      // ⌘K finds the same Stop while it waits.
      await window.keyboard.press("ControlOrMeta+k");
      await window.keyboard.type(language === "zh-CN" ? "停止" : "stop reading");
      await expect(
        paletteFound(window).filter({
          hasText: language === "zh-CN" ? "停止读取文档" : "Stop reading the Documents",
        }),
      ).toBeVisible();
      await window.keyboard.press("Escape");
      await stop.click();

      const answer = assistantAnswers(window).last();
      await expect(answer).toHaveAttribute("data-status", "stopped", { timeout: 60_000 });
      await expect(answer.getByTestId("answer-stopped")).toBeVisible();
      await expect(window.getByTestId("assistant-question")).toContainText(
        EXAMPLE_SETS.credit[language].ready?.question as string,
      );
      // Step 2 stays open: the Question can be asked again.
      await expect(step(window, "question")).toHaveAttribute("data-state", "open");
    } finally {
      await app.close();
      await removeDataFolder(dataDir);
    }
  });
}
