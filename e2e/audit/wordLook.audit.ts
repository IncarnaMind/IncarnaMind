/**
 *   npx electron-vite build --mode test
 *   AUDIT_OUT=/tmp/word-look npx playwright test -c e2e/audit/playwright.audit.config.ts wordLook.audit.ts
 *
 * TAB_CLAUSES sets how many clauses the tabbed contract has, a tab in each of its paragraphs: 550 make about 6,000 tabs.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import {
  type CoreBridge,
  MIND_CONTENT_FIELD,
  MIND_WORD_LOOK_FIELD,
  WORD_LOOK_ATTRIBUTE,
  WORD_RUN_MARK,
  WORD_TAB_MARK,
} from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
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
    // From the press on Plain note until the look's rules are gone, and the frame after.
    await window.evaluate(() => {
      const w = window as unknown as { __redrawn?: Promise<number> };
      w.__redrawn = new Promise<number>((resolve) => {
        document.addEventListener(
          "mousedown",
          () => {
            const start = performance.now();
            const check = () => {
              if (document.querySelector(".mind-editor-frame > style")) {
                requestAnimationFrame(check);
              } else {
                requestAnimationFrame(() => resolve(Math.round(performance.now() - start)));
              }
            };
            requestAnimationFrame(check);
          },
          { once: true, capture: true },
        );
      });
    });
    await click(window, window.getByTestId("look-plain"));
    const redrawnMs = await window.evaluate(
      () => (window as unknown as { __redrawn: Promise<number> }).__redrawn,
    );
    await expect(window.locator(".mind-editor-frame > style")).toHaveCount(0);
    return { redrawnMs, ...(await timedOpens(mindId, selector, async () => blocks)) };
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

/** In ms after `launchMs`, when the log has each of `events` since then; waits up to a minute for `until`. */
async function loggedAfter(dataDir: string, launchMs: number, until: string, events: string[]) {
  const file = join(dataDir, "logs", "incarnamind.log");
  const since = (event: string) => {
    if (!existsSync(file)) return null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes(` ${event}`)) continue;
      const at = Date.parse(line.slice(0, line.indexOf(" "))) - launchMs;
      if (at >= 0) return at;
    }
    return null;
  };
  for (let waited = 0; waited < 60_000 && since(until) === null; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Object.fromEntries([until, ...events].map((event) => [event, since(event)]));
}

/** The log's entries since `launchMs`, each its ms after it, level and event: where a start's time went. */
function logSince(dataDir: string, launchMs: number): string[] {
  const file = join(dataDir, "logs", "incarnamind.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => {
      const [at, level, event] = line.split(/\s+/);
      return { ms: Date.parse(at ?? "") - launchMs, said: `${level} ${event}` };
    })
    .filter(({ ms }) => ms >= 0)
    .map(({ ms, said }) => `${ms} ${said}`);
}

test("starting with the 304-page contract's look still to add, as the first start after an update that keeps more of a Word file's look", async () => {
  const prepared = tempDir("data");
  const files = tempDir("files");
  const contract = join(files, "Framework Services Agreement.docx");
  writeFileSync(contract, longContract());
  const first = await launch(prepared);
  try {
    const { window } = first;
    const mindId = await importWord(window, contract);
    await msToOpen(window, mindId, ".ProseMirror h1", 241);
    await expect(window.getByTestId("mind-word-progress")).toHaveCount(0, { timeout: 120_000 });
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await core.createMind({ title: "Elsewhere" });
      await core.changeLayout("main", {
        type: "open",
        item: { kind: "mind", mindId: mind.id },
        where: { in: "place" },
      });
    });
    // The Note as an import from before its look was kept stored it: no look in its Blocks.
    const state = await window.evaluate(async (id) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return Array.from((await core.openMind(id)).state);
    }, mindId);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(state));
    const known = Y.encodeStateVector(doc);
    const strip = (element: Y.XmlElement) => {
      if (element.getAttribute(WORD_LOOK_ATTRIBUTE) !== undefined) {
        element.removeAttribute(WORD_LOOK_ATTRIBUTE);
      }
      for (const child of element.toArray()) {
        if (child instanceof Y.XmlElement) strip(child);
        else if (child instanceof Y.XmlText)
          child.format(0, child.length, { [WORD_RUN_MARK]: null, [WORD_TAB_MARK]: null });
      }
    };
    doc.transact(() => {
      for (const child of doc.getXmlFragment(MIND_CONTENT_FIELD).toArray()) {
        if (child instanceof Y.XmlElement) strip(child);
      }
      doc.getMap(MIND_WORD_LOOK_FIELD).clear();
    });
    const update = Array.from(Y.encodeStateAsUpdate(doc, known));
    await window.evaluate(
      async ([id, bytes]) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.applyMindUpdate(id, new Uint8Array(bytes));
        await core.closeMind(id);
      },
      [mindId, update] as const,
    );
  } finally {
    await close(first);
  }
  const db = openDatabase(join(prepared, "incarnamind.db"));
  try {
    db.run("UPDATE word_packages SET look_version = NULL");
  } finally {
    db.close();
  }

  const timed = async (dataDir: string) => {
    const launched = await launch(dataDir);
    const { launchMs, firstPaintMs, interactiveMs } = launched.timing;
    await launched.window.getByTestId("home").waitFor({ timeout: 60_000 });
    const homeMs = Date.now() - launchMs;
    const logged = await loggedAfter(dataDir, launchMs, "word.look.done", ["word.look.added"]);
    const log = logSince(dataDir, launchMs);
    await close(launched);
    return {
      toFirstContentfulPaintMs: firstPaintMs === null ? null : Math.round(firstPaintMs - launchMs),
      toInteractiveMs: interactiveMs - launchMs,
      toHomeMs: homeMs,
      lookDoneMs: logged["word.look.done"],
      lookAddedMs: logged["word.look.added"],
      log,
    };
  };
  // Each run on its own copy, so each has the look to add; then the same copy again, with none left.
  const runs: { withLookToAdd: unknown; again: unknown }[] = [];
  for (let run = 0; run < 3; run++) {
    const dataDir = tempDir("data");
    cpSync(prepared, dataDir, { recursive: true });
    try {
      const withLookToAdd = await timed(dataDir);
      runs.push({ withLookToAdd, again: await timed(dataDir) });
    } finally {
      removeDir(dataDir);
    }
  }
  const result = { runs };
  record("wordLookAtStart", result);
  console.log(JSON.stringify(result, null, 2));
  removeDir(prepared);
  removeDir(files);
});
