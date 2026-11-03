/**
 *   npx electron-vite build --mode test
 *   AUDIT_OUT=/tmp/word-look npx playwright test -c e2e/audit/playwright.audit.config.ts wordLook.audit.ts
 *
 * TAB_CLAUSES sets how many clauses the tabbed contract has, a tab in each of its paragraphs: 550 make about 6,000 tabs.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../../src/core/api";
import { LONG_CONTRACT_CLAUSES, longContract } from "../../tests/helpers/longContract";
import { resumeFile } from "../../tests/helpers/wordLookFiles";
import { largestCorpusFile, msToOpen } from "../app";
import {
  busy,
  cdp,
  cdpMetrics,
  click,
  close,
  installKeyLatency,
  launch,
  median,
  record,
  removeDir,
  takeKeyLatency,
  tempDir,
} from "./harness";

async function importWord(window: Page, path: string): Promise<string> {
  return window.evaluate(async (file) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const result = await core.importWordFile({ path: file, origin: "own" });
    if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
    return result.mind.id;
  }, path);
}

test("typing in the 304-page contract, and opening it and the corpus's largest file", async () => {
  const dataDir = tempDir("data");
  const files = tempDir("files");
  const contract = join(files, "Framework Services Agreement.docx");
  writeFileSync(contract, longContract());
  const resume = join(files, "林晓_简历.docx");
  writeFileSync(resume, resumeFile());
  const launched = await launch(dataDir);
  const { window } = launched;
  const elsewhere = () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await core.createMind({ title: "Elsewhere" });
      await core.changeLayout("main", {
        type: "open",
        item: { kind: "mind", mindId: mind.id },
        where: { in: "place" },
      });
    });
  const session = await cdp(window);
  const timedOpens = async (mindId: string, selector: string, count: () => Promise<number>) => {
    await msToOpen(window, mindId, selector, 1);
    const blocks = await count();
    const runs: number[] = [];
    const work: ReturnType<typeof busy>[] = [];
    for (let run = 0; run < 3; run++) {
      await elsewhere();
      const before = await cdpMetrics(session);
      runs.push(await msToOpen(window, mindId, selector, blocks));
      work.push(busy(before, await cdpMetrics(session)));
    }
    // Where the main thread's time went, to tell drawing (style and layout) from keeping (script).
    const medianOf = (key: "scriptMs" | "styleMs" | "layoutMs") =>
      median(work.map((each) => each[key]));
    return {
      blocks,
      runs,
      median: median(runs),
      scriptMs: medianOf("scriptMs"),
      styleMs: medianOf("styleMs"),
      layoutMs: medianOf("layoutMs"),
    };
  };
  const plainAgain = async (mindId: string, selector: string, blocks: number) => {
    await click(window, window.locator('[data-testid="page-menu"]:visible'));
    await click(window, window.getByTestId("look-plain"));
    await expect(window.locator(".mind-editor-frame > style")).toHaveCount(0);
    return timedOpens(mindId, selector, async () => blocks);
  };
  try {
    const contractId = await importWord(window, contract);
    const contractOpen = await timedOpens(contractId, ".ProseMirror h1", async () => {
      await expect(window.locator(".ProseMirror h1")).toHaveCount(241, { timeout: 120_000 });
      return 241;
    });

    await installKeyLatency(window);
    const paragraphs = window.locator(".ProseMirror > p");
    const typeIn = async (index: number) => {
      const target = paragraphs.nth(index);
      await target.scrollIntoViewIfNeeded();
      await target.click({ position: { x: 20, y: 6 } });
      await window.keyboard.press("End");
      for (let key = 0; key < 30; key++) {
        await window.keyboard.type("x");
        await window.waitForTimeout(40);
      }
      return takeKeyLatency(window);
    };
    const first = await typeIn(2);
    const last = await typeIn((await paragraphs.count()) - 2);

    const resumeId = await importWord(window, resume);
    const resumeOpen = await timedOpens(resumeId, ".ProseMirror td", async () => {
      await expect(window.locator(".ProseMirror td")).toHaveCount(10);
      return 10;
    });
    const cell = window.locator(".ProseMirror td p", { hasText: "Wind" });
    await cell.click({ position: { x: 20, y: 6 } });
    await window.keyboard.press("End");
    for (let key = 0; key < 30; key++) {
      await window.keyboard.type("x");
      await window.waitForTimeout(40);
    }
    const typingResumeTable = await takeKeyLatency(window);

    const corpus = largestCorpusFile();
    const corpusId = await importWord(window, corpus);
    const corpusOpen = await timedOpens(corpusId, ".ProseMirror > *", async () => {
      // No signal for the import's end that the page can see; wait until Blocks stop coming.
      let blocks = -1;
      for (;;) {
        await window.waitForTimeout(500);
        const now = await window.locator(".ProseMirror > *").count();
        if (now === blocks) return now;
        blocks = now;
      }
    });
    const corpusPlainOpen = await plainAgain(corpusId, ".ProseMirror > *", corpusOpen.blocks);
    await msToOpen(window, contractId, ".ProseMirror h1", 241);
    const contractPlainOpen = await plainAgain(contractId, ".ProseMirror h1", 241);
    const result = {
      contractOpenMs: contractOpen,
      contractPlainOpenMs: contractPlainOpen,
      typingFirstPage: first,
      typingLastPage: last,
      resumeOpenMs: resumeOpen,
      typingResumeTable,
      corpusFile: corpus.slice(corpus.indexOf("eval/word")),
      corpusOpenMs: corpusOpen,
      corpusPlainOpenMs: corpusPlainOpen,
    };
    record("wordLook", result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await close(launched);
    removeDir(dataDir);
    removeDir(files);
  }
});

test("typing in the 304-page contract with a tab after every clause number, and how long its tabs take to draw", async () => {
  const dataDir = tempDir("data");
  const files = tempDir("files");
  const contract = join(files, "Framework Services Agreement (tabbed).docx");
  const clauseCount = Number(process.env.TAB_CLAUSES) || LONG_CONTRACT_CLAUSES;
  writeFileSync(contract, longContract(clauseCount, { tabbed: true }));
  const launched = await launch(dataDir);
  const { window } = launched;
  try {
    const contractId = await importWord(window, contract);
    await msToOpen(window, contractId, ".ProseMirror h1", 1);
    await expect(window.locator(".ProseMirror h1")).toHaveCount(clauseCount + 1, {
      timeout: 120_000,
    });
    const tabs = await window.locator("[data-word-tab]").count();
    const drawn: number[] = [];
    for (let run = 0; run < 3; run++) {
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const mind = await core.createMind({ title: "Elsewhere" });
        await core.changeLayout("main", {
          type: "open",
          item: { kind: "mind", mindId: mind.id },
          where: { in: "place" },
        });
      });
      drawn.push(
        await window.evaluate(
          async ({ id, wanted }) => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const start = performance.now();
            await core.changeLayout("main", {
              type: "open",
              item: { kind: "mind", mindId: id },
              where: { in: "place" },
            });
            for (;;) {
              const measured = document.querySelectorAll('[data-word-tab][style*="width"]').length;
              if (measured >= wanted) break;
              await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return Math.round(performance.now() - start);
          },
          { id: contractId, wanted: tabs },
        ),
      );
    }

    await installKeyLatency(window);
    const clauses = window.locator(".ProseMirror > p:has([data-word-tab])");
    const typeIn = async (index: number) => {
      const target = clauses.nth(index);
      await target.scrollIntoViewIfNeeded();
      await target.click({ position: { x: 120, y: 6 } });
      await window.keyboard.press("End");
      for (let key = 0; key < 30; key++) {
        await window.keyboard.type("x");
        await window.waitForTimeout(40);
      }
      return takeKeyLatency(window);
    };
    const result = {
      tabs,
      tabsDrawnMs: { runs: drawn, median: median(drawn) },
      typingFirstPage: await typeIn(1),
      typingLastPage: await typeIn((await clauses.count()) - 2),
    };
    record("wordTabs", result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await close(launched);
    removeDir(dataDir);
    removeDir(files);
  }
});
