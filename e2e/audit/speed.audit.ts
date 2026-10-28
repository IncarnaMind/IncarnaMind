/**
 * UI audit, part B: speed, measured. Startup (cold and warm, 3× each), typing
 * latency in a short and a long Mind, the sidebar and the Library with 2,000
 * Documents, opening big files in the viewer, and whether indexing or Organize
 * stall the UI. Results go to AUDIT_OUT/results.json under "speed.*".
 */
import { readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import type { AgentLaunch, CoreBridge } from "../../src/core/api";
import { BLOCK_ID_ATTRIBUTE, MIND_CONTENT_FIELD } from "../../src/core/api";
import { AGENT_SOCKET_ENV, AGENT_TOKEN_ENV, handshakeLine } from "../../src/shared/agentSocket";
import { writeFixtures } from "./fixtures";
import {
  SHOTS as AUDIT_SHOTS,
  answerOpenDialog,
  busy,
  cdp,
  cdpMetrics,
  click,
  close,
  glide,
  installKeyLatency,
  type Launched,
  launch,
  median,
  memory,
  profile,
  record,
  removeDir,
  sealShell,
  shot,
  startFrames,
  takeKeyLatency,
  tempDir,
} from "./harness";

const RUNS = 3;

test.describe.configure({ mode: "serial" });

/** Renderer timings: navigation, first paint, contentful paint, layout shifts. */
function pageTimings(window: Page) {
  return window.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const paint = Object.fromEntries(
      performance.getEntriesByType("paint").map((e) => [e.name, Math.round(e.startTime)]),
    );
    return new Promise<Record<string, number | null>>((resolve) => {
      let cls = 0;
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            value: number;
            hadRecentInput: boolean;
          }[]) {
            if (!entry.hadRecentInput) cls += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {
        // not supported
      }
      setTimeout(
        () =>
          resolve({
            responseEnd: nav ? Math.round(nav.responseEnd) : null,
            domInteractive: nav ? Math.round(nav.domInteractive) : null,
            domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
            load: nav ? Math.round(nav.loadEventEnd) : null,
            firstPaint: paint["first-paint"] ?? null,
            firstContentfulPaint: paint["first-contentful-paint"] ?? null,
            cls: Math.round(cls * 1000) / 1000,
            timeOrigin: performance.timeOrigin,
          }),
        200,
      );
    });
  });
}

/** One launch: wall-clock launch → FCP and → interactive, plus the renderer's own timings. */
async function timedLaunch(dataDir: string, readyTestId: string, fakeChat = false) {
  const launched = await launch(dataDir, { readyTestId, fakeChat });
  const page = await pageTimings(launched.window);
  const { launchMs, interactiveMs } = launched.timing;
  const fcpAbs =
    page.firstContentfulPaint !== null
      ? (page.timeOrigin as number) + (page.firstContentfulPaint as number)
      : null;
  return {
    launched,
    result: {
      toWindowOriginMs: Math.round((page.timeOrigin as number) - launchMs),
      toFirstContentfulPaintMs: fcpAbs ? Math.round(fcpAbs - launchMs) : null,
      toInteractiveMs: interactiveMs - launchMs,
      renderer: page,
    },
  };
}

/**
 * Times from the next mousedown until `kind`'s condition holds, checked every
 * frame in the page (no polling from the test).
 */
async function armUntil(window: Page, kind: string, arg = "") {
  await window.evaluate(
    ({ kind: k, arg: a }) => {
      // A viewer condition also needs the viewer's title to be the Document's (`a`), when given.
      const titled = () =>
        !a ||
        (document.querySelector('[data-testid="viewer-title"]')?.textContent ?? "").includes(a);
      const conditions: Record<string, () => boolean> = {
        pdfPainted: () => {
          if (!titled()) return false;
          const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="pdf-scroller"] canvas',
          );
          if (!canvas || canvas.width === 0) return false;
          const ctx = canvas.getContext("2d");
          if (!ctx) return false;
          const data = ctx.getImageData(0, 0, canvas.width, Math.min(canvas.height, 400)).data;
          for (let i = 0; i < data.length; i += 16)
            if ((data[i] as number) < 128 && (data[i + 3] as number) > 0) return true;
          return false;
        },
        gridShown: () =>
          titled() && document.querySelectorAll('[data-testid="viewer-grid"] td').length > 20,
        docxShown: () => {
          if (!titled()) return false;
          const host = document.querySelector('[data-testid="viewer-docx"]');
          if (host?.getAttribute("data-rendered") !== "yes") return false;
          const img = host.querySelector("img");
          return !img || (img as HTMLImageElement).complete;
        },
        textShown: () =>
          titled() &&
          (document.querySelector('[data-testid="viewer-text"]')?.textContent?.length ?? 0) > 50,
        libraryShown: () =>
          document.querySelectorAll('[data-testid="library-document"]').length > 0,
        selectorShown: () => document.querySelector(a) !== null,
        selectorGone: () => document.querySelector(a) === null,
        pdfZoomed: () => {
          const level = document.querySelector('[data-testid="pdf-zoom-level"]')?.textContent ?? "";
          const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="pdf-scroller"] canvas',
          );
          return level !== a && canvas !== null && canvas.width > 0;
        },
      };
      const w = window as unknown as { __until?: Promise<number> };
      w.__until = new Promise<number>((resolve) => {
        document.addEventListener(
          "mousedown",
          () => {
            const t0 = performance.now();
            const check = () => {
              if (conditions[k]?.()) {
                // After the paint that shows it.
                requestAnimationFrame(() =>
                  setTimeout(() => resolve(Math.round(performance.now() - t0)), 0),
                );
              } else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          },
          { once: true, capture: true },
        );
      });
    },
    { kind, arg },
  );
  return () => window.evaluate(() => (window as unknown as { __until: Promise<number> }).__until);
}

/** Main-process event-loop lag: a 20ms interval's worst and total drift while it runs. */
async function startMainLag(app: ElectronApplication) {
  await app.evaluate(() => {
    const g = globalThis as {
      __lag?: {
        max: number;
        over50: number;
        over100: number;
        samples: number;
        timer?: NodeJS.Timeout;
      };
    };
    const state = {
      max: 0,
      over50: 0,
      over100: 0,
      samples: 0,
      timer: undefined as NodeJS.Timeout | undefined,
    };
    let last = performance.now();
    state.timer = setInterval(() => {
      const now = performance.now();
      const lag = now - last - 20;
      last = now;
      state.samples++;
      if (lag > state.max) state.max = lag;
      if (lag > 50) state.over50++;
      if (lag > 100) state.over100++;
    }, 20);
    g.__lag = state;
  });
  return () =>
    app.evaluate(() => {
      const g = globalThis as unknown as {
        __lag: {
          max: number;
          over50: number;
          over100: number;
          samples: number;
          timer?: NodeJS.Timeout;
        };
      };
      clearInterval(g.__lag.timer);
      return {
        maxLagMs: Math.round(g.__lag.max),
        over50: g.__lag.over50,
        over100: g.__lag.over100,
        samples: g.__lag.samples,
      };
    });
}

/** IPC round trips (getSettings) every 250ms while it runs: does the main process answer the UI quickly? */
async function startIpcProbe(window: Page) {
  await window.evaluate(() => {
    const w = window as unknown as { __ipc?: { times: number[]; running: boolean } };
    const state = { times: [] as number[], running: true };
    w.__ipc = state;
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const tick = async () => {
      while (state.running) {
        const t0 = performance.now();
        await bridge.getSettings();
        state.times.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    void tick();
  });
  return () =>
    window.evaluate(() => {
      const w = window as unknown as { __ipc: { times: number[]; running: boolean } };
      w.__ipc.running = false;
      const t = [...w.__ipc.times].sort((a, b) => a - b);
      const q = (p: number) => Math.round(t[Math.min(t.length - 1, Math.floor(p * t.length))] ?? 0);
      return { samples: t.length, p50: q(0.5), p95: q(0.95), max: Math.round(t.at(-1) ?? 0) };
    });
}

/** Types `count` characters into the focused editor with a person's ~80ms rhythm. */
async function typeFor(window: Page, count: number, delay = 80) {
  const text =
    "the tide rose over the harbour wall and the survey team waited for the morning light ";
  for (let i = 0; i < count; i++) {
    await window.keyboard.type(text[i % text.length] as string);
    await window.waitForTimeout(delay * (0.7 + Math.random() * 0.6));
  }
}

/**
 * Has the core write into the Mind a word at a time, every `everyMs`, as an
 * Answer or an edit streams in: a new paragraph at its end, through the
 * core's bridge, so each word reaches the editor from outside it (#200).
 * Returns what stops it, with how many writes were made.
 */
async function streamIntoMind(
  window: Page,
  mindId: string,
  everyMs: number,
): Promise<() => Promise<number>> {
  const state = await window.evaluate(async (id) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return Array.from((await core.openMind(id)).state);
  }, mindId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(state));
  const send = async (change: () => void) => {
    const before = Y.encodeStateVector(doc);
    change();
    const update = Array.from(Y.encodeStateAsUpdate(doc, before));
    await window.evaluate(
      ([id, bytes]) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.applyMindUpdate(
          id,
          new Uint8Array(bytes),
        ),
      [mindId, update] as const,
    );
  };
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute(BLOCK_ID_ATTRIBUTE, crypto.randomUUID());
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  await send(() => doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]));
  const words =
    "The survey found that the salt marsh edge had moved about four metres inland since the last report".split(
      " ",
    );
  let running = true;
  let sent = 0;
  const writing = (async () => {
    while (running) {
      await send(() => text.insert(text.length, `${words[sent % words.length]} `));
      sent++;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  })();
  return async () => {
    running = false;
    await writing;
    return sent;
  };
}

/**
 * Beside the open, focused Mind: asks a Question in the assistant (answered
 * with Citations by the fake model) and adds its Answer to the note with
 * ⌘⇧A, as a person keeps one (#201).
 */
async function askAndKeep(window: Page, question: string, index: number, timeout: number) {
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question, { delay: 20 });
  await window.keyboard.press("Enter");
  const answer = window.getByTestId("assistant-answer").nth(index);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout });
  await window.keyboard.press("ControlOrMeta+Shift+A");
  await expect(answer.getByTestId("answer-added")).toBeVisible();
}

/**
 * In the open, focused Mind: asks Questions and keeps their Answers
 * (`askAndKeep`), then pastes their cited sentences and Notes through the
 * editor's own clipboard HTML until it has ~300 top-level blocks.
 */
async function buildLongMind(window: Page, questions: string[]) {
  for (const [i, question] of questions.entries()) await askAndKeep(window, question, i, 60_000);
  await window.getByTestId("mind-editor").evaluate((dom) => {
    const { view, commands } = (dom as unknown as { editor: Editor }).editor;
    const sentences: string[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "citation") {
        const at = view.state.doc.resolve(pos);
        commands.setTextSelection({ from: at.start(), to: at.end() });
        const { dom: copied } = view.serializeForClipboard(view.state.selection.content());
        sentences.push(copied.innerHTML);
      }
    });
    const filler = (n: number) =>
      `<h2>Section ${n}</h2><p>The survey team recorded tide heights at every transect; sediment cores were taken at low water and logged before the review. Field notes for site ${n}.</p><ul><li>Transect ${n}: salt marsh edge moved</li><li>Cores logged and sent to the lab</li></ul>`;
    let html = "";
    for (let n = 0; n < 72; n++) html += filler(n) + (sentences[n % sentences.length] ?? "");
    commands.setTextSelection(view.state.doc.content.size - 1);
    view.pasteHTML(html);
  });
  await window.waitForTimeout(3000);
  return window.getByTestId("mind-editor").evaluate((dom) => {
    const { view } = (dom as unknown as { editor: Editor }).editor;
    let citations = 0;
    view.state.doc.descendants((node) => {
      if (node.type.name === "citation") citations++;
    });
    return { topLevel: view.state.doc.childCount, citations };
  });
}

async function documentsReady(window: Page, expected: number, timeout: number) {
  const started = Date.now();
  for (;;) {
    const states = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const docs = await bridge.listDocuments();
      return {
        total: docs.length,
        done: docs.filter((d) => d.status === "ready" || d.status === "failed").length,
      };
    });
    if (states.total >= expected && states.done >= states.total) return Date.now() - started;
    if (Date.now() - started > timeout)
      throw new Error(`Not ready: ${states.done}/${states.total}`);
    await window.waitForTimeout(1000);
  }
}

test("B0 startup breakdown: Electron's own baseline, and the main process's marks", async () => {
  test.setTimeout(6 * 60_000);
  // The smallest Electron app: how long Electron itself takes here.
  const baseline: unknown[] = [];
  for (let i = 0; i < RUNS; i++) {
    const dataDir = tempDir("baseline");
    const { launched, result } = await (async () => {
      const l = await launch(dataDir, { appPath: join(__dirname, "baseline") });
      const page = await pageTimings(l.window);
      return {
        launched: l,
        result: {
          toWindowOriginMs: Math.round((page.timeOrigin as number) - l.timing.launchMs),
          toInteractiveMs: l.timing.interactiveMs - l.timing.launchMs,
        },
      };
    })();
    let typing: unknown = null;
    if (i === 0) {
      // The floor for typing: a bare contenteditable in a bare Electron window.
      await click(launched.window, launched.window.getByTestId("plain-editor"));
      await installKeyLatency(launched.window);
      await typeFor(launched.window, 120);
      typing = await takeKeyLatency(launched.window);
    }
    baseline.push({ ...result, typing });
    await close(launched);
    removeDir(dataDir);
  }
  record("speed.startup.electronBaseline", baseline);

  // The app, on a data folder made by an earlier launch, with the startup hook.
  const dataDir = tempDir("data");
  const firstRun = await launch(dataDir, { readyTestId: "plus-menu" });
  await close(firstRun);
  const marks: unknown[] = [];
  for (let i = 0; i < RUNS; i++) {
    const hookDir = tempDir("startup");
    const out = join(hookDir, "startup.json");
    const { launched, result } = await (async () => {
      const l = await launch(dataDir, {
        extraArgs: ["-r", join(__dirname, "startup-hook.cjs")],
        extraEnv: { AUDIT_STARTUP_OUT: out },
      });
      const page = await pageTimings(l.window);
      return {
        launched: l,
        result: {
          toWindowOriginMs: Math.round((page.timeOrigin as number) - l.timing.launchMs),
          toInteractiveMs: l.timing.interactiveMs - l.timing.launchMs,
          renderer: page,
        },
      };
    })();
    await launched.window.waitForTimeout(2500);
    let hook: unknown = null;
    try {
      hook = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      hook = "the startup hook didn't write (NODE_OPTIONS --require not honoured?)";
    }
    marks.push({ ...result, hook });
    await close(launched);
    removeDir(hookDir);
  }
  record("speed.startup.breakdown", marks);
  removeDir(dataDir);
});

test("B1 startup: cold (fresh data folder) and warm, 3× each", async () => {
  test.setTimeout(10 * 60_000);
  const cold: unknown[] = [];
  for (let i = 0; i < RUNS; i++) {
    const dataDir = tempDir("data");
    const { launched, result } = await timedLaunch(dataDir, "plus-menu");
    cold.push({
      ...result,
      memoryAtIdle: await (async () => {
        await launched.window.waitForTimeout(3000);
        return memory(launched.app);
      })(),
    });
    await close(launched);
    removeDir(dataDir);
  }
  record("speed.startup.cold", cold);

  // Warm: the same data folder, with a Linked folder, a Mind and an Answer, relaunched.
  const dataDir = tempDir("data");
  const root = tempDir("fixtures");
  const fixtures = writeFixtures(root, 0);
  let first: Launched | undefined;
  try {
    first = await launch(dataDir, { fakeChat: true, readyTestId: "plus-menu" });
    await sealShell(first.app);
    await first.window.evaluate(async (folder) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
      await bridge.addLinkedFolder(folder);
    }, fixtures.formats);
    await documentsReady(first.window, 14, 120_000);
    await click(first.window, first.window.getByTestId("plus-menu"));
    await click(first.window, first.window.getByTestId("plus-new-mind"));
    await click(first.window, first.window.getByTestId("mind-editor"));
    await askAndKeep(first.window, "When do spring tides happen?", 0, 30_000);
    await first.window.waitForTimeout(1500);
  } finally {
    if (first) await close(first);
  }
  const warm: unknown[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { launched, result } = await timedLaunch(dataDir, "mind-editor", true);
    // The open Mind's Citations, kept from the Answer, are back on screen.
    await expect(
      launched.window.getByTestId("mind-editor").getByTestId("citation").first(),
    ).toBeVisible();
    warm.push({ ...result, answerShownMs: Date.now() - launched.timing.launchMs });
    if (i === 0) await shot(launched.window, "B01-warm-start");
    await close(launched);
  }
  record("speed.startup.warm", warm);
  // The median of the runs that have the timing, or null: a first run, behind its modal
  // chat setup, may record no contentful paint.
  const pick = (runs: unknown[], key: string) => {
    const values = runs
      .map((r) => (r as Record<string, number | null>)[key])
      .filter((v): v is number => typeof v === "number");
    return values.length ? median(values) : null;
  };
  record("speed.startup.summary", {
    coldFcpMedian: pick(cold, "toFirstContentfulPaintMs"),
    coldInteractiveMedian: pick(cold, "toInteractiveMs"),
    warmFcpMedian: pick(warm, "toFirstContentfulPaintMs"),
    warmInteractiveMedian: pick(warm, "toInteractiveMs"),
    warmAnswerShownMedian: pick(warm, "answerShownMs"),
  });
  removeDir(dataDir);
  removeDir(root);
});

test("B2 typing: a short Mind and a long one (~300 blocks, many Citations)", async () => {
  test.setTimeout(15 * 60_000);
  const dataDir = tempDir("data");
  const root = tempDir("fixtures");
  const fixtures = writeFixtures(root, 0);
  const app = await launch(dataDir, { fakeChat: true, readyTestId: "plus-menu" });
  const { window } = app;
  try {
    await sealShell(app.app);
    await window.evaluate(async (folder) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
      await bridge.addLinkedFolder(folder);
    }, fixtures.formats);
    await documentsReady(window, 14, 120_000);
    const session = await cdp(window);
    record("speed.cdpAvailable", session !== null);

    // A short Mind.
    await click(window, window.getByTestId("plus-menu"));
    await click(window, window.getByTestId("plus-new-mind"));
    await click(window, window.getByTestId("mind-editor"));
    await installKeyLatency(window);
    const m0 = await cdpMetrics(session);
    const stopFrames = await startFrames(window);
    await typeFor(window, 160);
    const shortFrames = await stopFrames();
    const short = await takeKeyLatency(window);
    record("speed.typing.short", {
      ...short,
      frames: shortFrames,
      mainThread: busy(m0, await cdpMetrics(session)),
    });

    // The same Mind with suggestions as the User writes on (#282): typing with a pause every
    // 40 keys, so suggestions are asked for, shown and typed over while the keys are timed.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { suggestWhileWriting: true } });
    });
    await window.keyboard.press("Enter");
    await takeKeyLatency(window);
    const m3 = await cdpMetrics(session);
    const stopSuggestFrames = await startFrames(window);
    for (let i = 0; i < 4; i++) {
      await typeFor(window, 40);
      await window.waitForTimeout(1500);
    }
    const suggestFrames = await stopSuggestFrames();
    record("speed.typing.shortSuggestions", {
      ...(await takeKeyLatency(window)),
      frames: suggestFrames,
      mainThread: busy(m3, await cdpMetrics(session)),
      shown: await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.getSuggestionStatus()).today.shown;
      }),
    });
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { suggestWhileWriting: false } });
    });

    // A long Mind: Questions answered with Citations in the assistant and kept in the note,
    // then their cited sentences and Notes pasted (through the editor's own clipboard HTML)
    // until ~300 blocks.
    await window.keyboard.press("Enter");
    for (const [i, question] of [
      "When do spring tides happen?",
      "What does each document say about tides and the harbour?",
      "What does each report say about the harbour survey rows?",
    ].entries()) {
      await askAndKeep(window, question, i, 30_000);
    }
    const blocks = await window.getByTestId("mind-editor").evaluate((dom) => {
      const { view, commands } = (dom as unknown as { editor: Editor }).editor;
      const sentences: string[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === "citation") {
          const at = view.state.doc.resolve(pos);
          commands.setTextSelection({ from: at.start(), to: at.end() });
          const { dom: copied } = view.serializeForClipboard(view.state.selection.content());
          sentences.push(copied.innerHTML);
        }
      });
      const filler = (n: number) =>
        `<h2>Section ${n}</h2><p>The survey team recorded tide heights at every transect; sediment cores were taken at low water and logged before the review. Field notes for site ${n}.</p><ul><li>Transect ${n}: salt marsh edge moved</li><li>Cores logged and sent to the lab</li></ul>`;
      let html = "";
      for (let n = 0; n < 72; n++) html += filler(n) + (sentences[n % sentences.length] ?? "");
      commands.setTextSelection(view.state.doc.content.size - 1);
      view.pasteHTML(html);
      return { citationsSource: sentences.length, topLevel: view.state.doc.childCount };
    });
    await window.waitForTimeout(3000);
    const counts = await window.getByTestId("mind-editor").evaluate((dom) => {
      const { view } = (dom as unknown as { editor: Editor }).editor;
      let citations = 0;
      let nodes = 0;
      view.state.doc.descendants((node) => {
        if (node.type.name === "citation") citations++;
        if (node.isBlock) nodes++;
      });
      return {
        topLevel: view.state.doc.childCount,
        blocks: nodes,
        citations,
        domNodes: document.querySelectorAll("*").length,
      };
    });
    record("speed.longMind.shape", { ...blocks, ...counts });
    await shot(window, "B10-long-mind");

    // Type at the end of the long Mind.
    await window
      .getByTestId("mind-editor")
      .locator(":scope > p")
      .last()
      .click({ position: { x: 4, y: 14 } });
    await window.keyboard.press("End");
    await window.keyboard.press("Enter");
    await takeKeyLatency(window);
    const m1 = await cdpMetrics(session);
    const stopLongFrames = await startFrames(window);
    await typeFor(window, 160);
    const longFrames = await stopLongFrames();
    record("speed.typing.longEnd", {
      ...(await takeKeyLatency(window)),
      frames: longFrames,
      mainThread: busy(m1, await cdpMetrics(session)),
    });

    // Type in the middle of the long Mind (Citations below the cursor move with it).
    const middle = window.getByTestId("mind-editor").locator(":scope > p").nth(40);
    await middle.scrollIntoViewIfNeeded();
    await click(window, middle, { x: 20, y: 12 });
    await window.keyboard.press("End");
    await takeKeyLatency(window);
    const m2 = await cdpMetrics(session);
    const stopMidFrames = await startFrames(window);
    await typeFor(window, 120);
    const midFrames = await stopMidFrames();
    record("speed.typing.longMiddle", {
      ...(await takeKeyLatency(window)),
      frames: midFrames,
      mainThread: busy(m2, await cdpMetrics(session)),
    });

    // Typing in the middle while the core writes into the same Mind a word every 50 ms, as an
    // Answer streams in (#200): y-tiptap 3.0.6 and later rebuild the whole view for each write
    // that doesn't come from the editor (ueberdosis/y-tiptap#54).
    const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
    if (!mindId) throw new Error("No Mind is open.");
    await takeKeyLatency(window);
    const stopWriting = await streamIntoMind(window, mindId, 50);
    const m4 = await cdpMetrics(session);
    const stopStreamFrames = await startFrames(window);
    const streamProfile = await profile(session, () => typeFor(window, 160));
    const streamFrames = await stopStreamFrames();
    const writes = await stopWriting();
    record("speed.typing.longWhileStreaming", {
      ...(await takeKeyLatency(window)),
      frames: streamFrames,
      mainThread: busy(m4, await cdpMetrics(session)),
      writes,
      profile: streamProfile,
    });

    // Pressing Enter (a new block) in the middle.
    const enterProfile = await profile(session, async () => {
      for (let i = 0; i < 20; i++) {
        await window.keyboard.press("Enter");
        await window.waitForTimeout(150);
      }
    });
    record("speed.typing.longEnter", { ...(await takeKeyLatency(window)), profile: enterProfile });

    // Scrolling the long Mind with the wheel.
    await glide(window, window.getByTestId("mind-editor").locator(":scope > p").nth(20));
    const stopScroll = await startFrames(window);
    const hot = await profile(session, async () => {
      for (let i = 0; i < 60; i++) {
        await window.mouse.wheel(0, i < 30 ? 120 : -120);
        await window.waitForTimeout(16);
      }
      await window.waitForTimeout(300);
    });
    record("speed.scroll.longMind", { ...(await stopScroll()), profile: hot });
    record("speed.memory.afterLongMind", await memory(app.app));
  } finally {
    await close(app);
    removeDir(dataDir);
    removeDir(root);
  }
});

test("B2b typing with 500 changes from Edit with AI waiting in the Mind (#93)", async () => {
  test.setTimeout(10 * 60_000);
  const dataDir = tempDir("data");
  const app = await launch(dataDir, { fakeChat: true, readyTestId: "plus-menu" });
  const { window } = app;
  try {
    await sealShell(app.app);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
    });
    await click(window, window.getByTestId("plus-menu"));
    await click(window, window.getByTestId("plus-new-mind"));
    await click(window, window.getByTestId("mind-editor"));
    // 50 paragraphs with 10 "very" each: Shorten (the scripted model drops them) gives 500 changes.
    await window.getByTestId("mind-editor").evaluate((dom) => {
      const { view } = (dom as unknown as { editor: Editor }).editor;
      const words = [
        "high",
        "strong",
        "wet",
        "cold",
        "late",
        "calm",
        "deep",
        "grey",
        "loud",
        "slow",
      ];
      let html = "";
      for (let n = 0; n < 50; n++) {
        html += `<p>${words.map((word, i) => `At site ${n} mark ${i} the tide was very ${word}`).join(", ")}.</p>`;
      }
      view.pasteHTML(html);
    });
    // Half of it at a time (one request takes up to 12,000 characters), selected as a person
    // would: a click at the start, then Shift and a click at the end.
    const paragraphs = window.getByTestId("mind-editor").locator(":scope > p");
    for (const [first, end, count] of [
      [0, 24, 250],
      [25, 49, 500],
    ] as const) {
      // In the middle of the view: the bar of changes at the Mind's top covers its first lines.
      await paragraphs
        .nth(first)
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await click(window, paragraphs.nth(first), { x: 1, y: 12 });
      await paragraphs.nth(end).evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = await paragraphs.nth(end).boundingBox();
      await window.keyboard.down("Shift");
      await click(window, paragraphs.nth(end), {
        x: (box?.width ?? 2) - 2,
        y: (box?.height ?? 24) - 12,
      });
      await window.keyboard.up("Shift");
      await click(window, window.getByTestId("selection-action-shorten"));
      await expect(window.getByTestId("proposals-count")).toHaveText(
        `${count} changes from the assistant`,
        { timeout: 60_000 },
      );
    }
    const session = await cdp(window);
    await installKeyLatency(window);

    // Type in the middle of the Mind, and at its end.
    const middle = window.getByTestId("mind-editor").locator(":scope > p").nth(25);
    await middle.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await click(window, middle, { x: 20 });
    await window.keyboard.press("End");
    await takeKeyLatency(window);
    const m0 = await cdpMetrics(session);
    const stopFrames = await startFrames(window);
    await typeFor(window, 160);
    const frames = await stopFrames();
    record("speed.typing.proposals500", {
      ...(await takeKeyLatency(window)),
      frames,
      mainThread: busy(m0, await cdpMetrics(session)),
    });
    await shot(window, "B11-proposals-500");

    // Accept all: one step, however many.
    const started = Date.now();
    await click(window, window.getByTestId("proposals-accept-all"));
    await expect(window.getByTestId("proposals-bar")).toHaveCount(0, { timeout: 30_000 });
    record("speed.proposals500.acceptAllMs", Date.now() - started);
  } finally {
    await close(app);
    removeDir(dataDir);
  }
});

test("B3 2,000 Documents: linking, the sidebar, the Library, Organize, and a warm start", async () => {
  test.setTimeout(60 * 60_000);
  const dataDir = tempDir("data");
  const root = tempDir("fixtures");
  const fixtures = writeFixtures(root, 2000);
  let app = await launch(dataDir, { fakeChat: true, readyTestId: "plus-menu" });
  try {
    let { window } = app;
    await sealShell(app.app);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
      for (const name of [
        "Coastal ecology",
        "Climate policy",
        "Tea trade",
        "Machine learning",
        "Contract law",
        "Public health",
      ]) {
        await bridge.createLibraryGroup({
          name,
          description: `Documents about ${name.toLowerCase()}`,
        });
      }
      // Organize by hand at first, so indexing is measured on its own.
      await bridge.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
        automatic: false,
      });
    });
    await click(window, window.getByTestId("plus-menu"));
    await click(window, window.getByTestId("plus-new-mind"));
    await click(window, window.getByTestId("mind-editor"));
    await installKeyLatency(window);
    const session = await cdp(window);

    // Link the folder as a person does, then type in the Mind while it indexes.
    await answerOpenDialog(app.app, fixtures.scale);
    await click(window, window.getByTestId("plus-menu"));
    await click(window, window.getByTestId("plus-link-folder"));
    const dialog = window.getByTestId("link-folder-dialog");
    const previewStarted = Date.now();
    await expect(dialog.getByTestId("link-folder-files")).toBeVisible({ timeout: 60_000 });
    const previewMs = Date.now() - previewStarted;
    await shot(window, "B20-link-2000-dialog");
    const stopLag = await startMainLag(app.app);
    const stopIpc = await startIpcProbe(window);
    const m0 = await cdpMetrics(session);
    const stopFrames = await startFrames(window);
    const linkStarted = Date.now();
    await click(window, dialog.getByTestId("link-folder-confirm"));
    await click(window, window.getByTestId("mind-editor"));
    await typeFor(window, 120);
    const typingWhileIndexing = await takeKeyLatency(window);
    await shot(window, "B21-indexing-2000");
    // What a person does meanwhile: open Settings, close it, open the Library, go back. Each timed.
    const actionsWhileIndexing: Record<string, number[]> = { settings: [], library: [], back: [] };
    const indexingProfile = await profile(
      session,
      async () => {
        for (let i = 0; i < 3; i++) {
          let done = await armUntil(window, "selectorShown", '[data-testid="settings"][open]');
          await click(window, window.getByRole("button", { name: "Settings", exact: true }));
          actionsWhileIndexing.settings?.push(await done());
          await window.keyboard.press("Escape");
          await expect(window.getByTestId("settings")).toBeHidden();
          done = await armUntil(window, "selectorShown", '[data-testid="library"]');
          await click(window, window.getByTestId("open-library"));
          actionsWhileIndexing.library?.push(await done());
          done = await armUntil(window, "selectorShown", '[data-testid="mind-editor"]');
          await click(window, window.getByRole("button", { name: "Back to note" }));
          actionsWhileIndexing.back?.push(await done());
        }
      },
      15,
    );
    record("speed.scale.whileIndexing", {
      actions: actionsWhileIndexing,
      profile: indexingProfile,
    });
    const indexMs = await documentsReady(window, fixtures.scaleCount, 25 * 60_000);
    const linkTotalMs = Date.now() - linkStarted;
    record("speed.scale.indexing", {
      documents: fixtures.scaleCount,
      linkPreviewMs: previewMs,
      linkToAllReadyMs: linkTotalMs,
      pollMs: indexMs,
      typingWhileIndexing,
      rendererFrames: await stopFrames(),
      mainProcessLag: await stopLag(),
      ipcRoundTrip: await stopIpc(),
      rendererMainThread: busy(m0, await cdpMetrics(session)),
    });
    await window.waitForTimeout(2000);
    await shot(window, "B22-sidebar-2000");
    record(
      "speed.scale.dom",
      await window.evaluate(() => ({
        domNodes: document.querySelectorAll("*").length,
        sidebarRows: document.querySelectorAll('[data-testid="document-list-item"]').length,
        tabStopsInSidebar: document.querySelectorAll(
          '[data-testid="sidebar"] button, [data-testid="sidebar"] [tabindex="0"]',
        ).length,
      })),
    );
    record("speed.memory.after2000", await memory(app.app));

    // Typing in the Mind with 2,000 Documents in the sidebar, after indexing.
    await click(window, window.getByTestId("mind-editor"));
    await window.keyboard.press("End");
    await takeKeyLatency(window);
    const m1 = await cdpMetrics(session);
    await typeFor(window, 120);
    record("speed.scale.typingAfter", {
      ...(await takeKeyLatency(window)),
      mainThread: busy(m1, await cdpMetrics(session)),
    });

    // A long Mind (~300 blocks, many Citations) with 2,000 Documents in the store.
    await click(window, window.getByTestId("plus-menu"));
    await click(window, window.getByTestId("plus-new-mind"));
    await click(window, window.getByTestId("mind-editor"));
    const longShape = await buildLongMind(window, [
      "What does each document say about the harbour tide survey?",
      "What does each memo say about carbon emissions and the levy?",
      "What does each review say about tea plantation export?",
    ]);
    await window
      .getByTestId("mind-editor")
      .locator(":scope > p")
      .last()
      .click({ position: { x: 4, y: 14 } });
    await window.keyboard.press("End");
    await window.keyboard.press("Enter");
    await takeKeyLatency(window);
    const m1b = await cdpMetrics(session);
    const typingProfile = await profile(session, () => typeFor(window, 120));
    record("speed.scale.typingLongMind", {
      shape: longShape,
      ...(await takeKeyLatency(window)),
      mainThread: busy(m1b, await cdpMetrics(session)),
      profile: typingProfile,
    });
    await shot(window, "B25-long-mind-2000");

    // Scroll the sidebar's tree with the wheel.
    const tree = window.getByTestId("sidebar-tree");
    await glide(window, tree);
    const stopScroll = await startFrames(window);
    const m2 = await cdpMetrics(session);
    for (let i = 0; i < 80; i++) {
      await window.mouse.wheel(0, 140);
      await window.waitForTimeout(16);
    }
    await window.waitForTimeout(300);
    record("speed.scale.sidebarScroll", {
      ...(await stopScroll()),
      mainThread: busy(m2, await cdpMetrics(session)),
    });

    // Sweep the pointer down 40 rows (hover states).
    const box = await tree.boundingBox();
    if (box) {
      const stopHover = await startFrames(window);
      await window.mouse.move(box.x + 60, box.y + 40);
      await window.mouse.move(box.x + 60, box.y + box.height - 40, { steps: 60 });
      record("speed.scale.sidebarHover", await stopHover());
    }

    // Switch the sidebar between Folders and Folders on disk (re-renders every row). With
    // Folders in the Library the sidebar opens on Folders: start from Folders on disk.
    const views = window.getByTestId("browse-views");
    const folders = views.getByRole("button", { name: "Folders", exact: true });
    const sources = views.getByRole("button", { name: "Folders on disk", exact: true });
    const sourcesShown = '[data-testid="folder-item"][data-root="true"]';
    if (await folders.count()) {
      if ((await sources.getAttribute("aria-pressed")) !== "true") await click(window, sources);
      await expect(window.locator(sourcesShown).first()).toBeVisible();
      const done = await armUntil(window, "selectorShown", '[data-testid="library-folders"]');
      await click(window, folders);
      record("speed.scale.toggleFoldersMs", await done());
      const back = await armUntil(window, "selectorShown", sourcesShown);
      await click(window, sources);
      record("speed.scale.toggleSourcesMs", await back());
    }

    // The Library: open it, scroll it, search it.
    const lib = await armUntil(window, "libraryShown");
    await click(window, window.getByTestId("open-library"));
    const libraryOpenMs = await lib();
    await window.waitForTimeout(800);
    await shot(window, "B23-library-2000");
    const libraryRows = await window.getByTestId("library-document").count();
    const scroller = window.getByTestId("library").locator(".overflow-y-auto").first();
    await glide(window, scroller);
    const stopLib = await startFrames(window);
    for (let i = 0; i < 40; i++) {
      await window.mouse.wheel(0, 160);
      await window.waitForTimeout(16);
    }
    await window.waitForTimeout(300);
    const libraryScroll = await stopLib();
    const search = window.getByPlaceholder("Find by name or tag");
    await click(window, search);
    await takeKeyLatency(window);
    for (const ch of "harbour tide") {
      await window.keyboard.type(ch);
      await window.waitForTimeout(120);
    }
    record("speed.scale.library", {
      libraryOpenMs,
      libraryRows,
      libraryScroll,
      searchTyping: await takeKeyLatency(window),
    });
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("Backspace");

    // Organize (the fake model classifies): does the UI stall while it runs?
    const organize = window
      .getByTestId("library")
      .getByRole("button", { name: "Organize", exact: true })
      .first();
    if ((await organize.count()) && (await organize.isEnabled())) {
      const stopLag2 = await startMainLag(app.app);
      const stopIpc2 = await startIpcProbe(window);
      const stopOrg = await startFrames(window);
      const started = Date.now();
      await click(window, organize);
      // Every second until it's done (up to 20 minutes: on a big library it has taken
      // minutes): how long the renderer takes to give one frame, how many Documents are
      // organized, and the renderer's memory; a screenshot at first, and a scroll as a person
      // reading would. The core answers from the main process, which stays responsive.
      const timeline: {
        atMs: number;
        frameMs: number;
        organized: number | null;
        rendererMB: number | null;
        screenshotMs?: number | null;
      }[] = [];
      let organized = false;
      const organizingProfile = await profile(
        session,
        async () => {
          for (let i = 0; !organized && Date.now() - started < 20 * 60_000; i++) {
            const t0 = Date.now();
            await window.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(() => resolve(0))),
            );
            const frameMs = Date.now() - t0;
            const counts = await window.evaluate(async () => {
              const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
              const library = await bridge.getLibrary();
              const busy = library.assignments.filter(
                (a) => a.status === "pending" || a.status === "classifying",
              ).length;
              return { busy, organized: library.assignments.length - busy };
            });
            organized = counts.busy === 0;
            const used = await memory(app.app);
            const point: (typeof timeline)[number] = {
              atMs: t0 - started,
              frameMs,
              organized: counts.organized,
              rendererMB: used.byType.Tab ?? null,
            };
            if (i < 3) {
              const t1 = Date.now();
              point.screenshotMs = await window
                .screenshot({ path: join(AUDIT_SHOTS, `B24-organizing-${i}.png`), timeout: 15_000 })
                .then(() => Date.now() - t1)
                .catch(() => null);
            }
            if (i === 5) {
              for (let k = 0; k < 30; k++) {
                await window.mouse.wheel(0, k % 2 ? -200 : 200);
                await window.waitForTimeout(100);
              }
            }
            timeline.push(point);
            if (!organized) await window.waitForTimeout(1000);
          }
        },
        15,
      );
      const rendererFrames = await stopOrg();
      const stalls = timeline.map((point) => point.frameMs);
      record("speed.scale.organize", {
        finished: organized,
        ms: Date.now() - started,
        worstFrameMs: Math.max(0, ...stalls),
        stalledMs: stalls.filter((ms) => ms > 1000).reduce((sum, ms) => sum + ms, 0),
        peakRendererMB: Math.max(0, ...timeline.map((point) => point.rendererMB ?? 0)),
        rendererFrames,
        mainProcessLag: await stopLag2(),
        ipcRoundTrip: await stopIpc2(),
        timeline,
        profile: organizingProfile,
      });
    } else {
      record("speed.scale.organize", { skipped: "Organize button not available" });
    }
    record("speed.memory.afterLibrary", await memory(app.app));
    await close(app);

    // Warm starts with 2,000 Documents.
    const warm: unknown[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { launched, result } = await timedLaunch(dataDir, "plus-menu", true);
      const rowsShown = Date.now();
      await expect(launched.window.getByTestId("document-list-item").first()).toBeVisible({
        timeout: 60_000,
      });
      warm.push({
        ...result,
        sidebarRowsMs: Date.now() - launched.timing.launchMs,
        afterInteractive: Date.now() - rowsShown,
      });
      if (i === RUNS - 1) {
        await launched.window.waitForTimeout(3000);
        record("speed.memory.idle2000", await memory(launched.app));
      }
      await close(launched);
    }
    record("speed.startup.warm2000", warm);
    app = undefined as unknown as Launched;
    window = undefined as unknown as Page;
  } finally {
    if (app) await close(app);
    removeDir(dataDir);
    removeDir(root);
  }
});

test("B4 the viewer: a 300-page PDF, a 50k-cell sheet, a Word file with images (3× each)", async () => {
  test.setTimeout(15 * 60_000);
  const dataDir = tempDir("data");
  const root = tempDir("fixtures");
  const fixtures = writeFixtures(root, 0);
  const app = await launch(dataDir, { fakeChat: true, readyTestId: "plus-menu" });
  const { window } = app;
  try {
    await sealShell(app.app);
    await window.evaluate(async (folder) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.addLinkedFolder(folder);
    }, fixtures.formats);
    await documentsReady(window, 14, 120_000);
    await click(window, window.getByTestId("plus-menu"));
    await click(window, window.getByTestId("plus-new-mind"));
    const session = await cdp(window);
    const rowOf = (name: string) =>
      window
        .getByTestId("document-list-item")
        .filter({ has: window.getByTestId("row-text").getByText(name, { exact: true }) })
        .first()
        .getByTestId("open-document");

    const cases: [string, string, string][] = [
      ["pdf300", fixtures.names.bigPdf, "pdfPainted"],
      ["xlsx50k", fixtures.names.bigXlsx, "gridShown"],
      ["docxImages", fixtures.names.imageDocx, "docxShown"],
      ["markdown", fixtures.names.md, "textShown"],
    ];
    const results: Record<string, unknown> = {};
    for (const [key, name, condition] of cases) {
      const runs: number[] = [];
      const busyRuns: unknown[] = [];
      for (let i = 0; i < RUNS; i++) {
        // Start from another Document, so each open is a real switch.
        const from = key === "markdown" ? fixtures.names.csv : fixtures.names.txt;
        await click(window, rowOf(from));
        await expect(window.getByTestId("viewer-title")).toContainText(from);
        await window.waitForTimeout(500);
        await glide(window, rowOf(name));
        const done = await armUntil(window, condition, name);
        const m0 = await cdpMetrics(session);
        await window.mouse.down();
        await window.mouse.up();
        runs.push(await done());
        busyRuns.push(busy(m0, await cdpMetrics(session)));
        await window.waitForTimeout(800);
      }
      results[key] = { openMs: runs, median: median(runs), mainThread: busyRuns };
    }

    // Scrolling the 300-page PDF, and zooming it.
    await click(window, rowOf(fixtures.names.bigPdf));
    await expect(window.getByTestId("pdf-scroller")).toBeVisible();
    await window.waitForTimeout(1500);
    const scroller = window.getByTestId("pdf-scroller");
    await glide(window, scroller);
    const m0 = await cdpMetrics(session);
    const stopPdf = await startFrames(window);
    for (let i = 0; i < 80; i++) {
      await window.mouse.wheel(0, 400);
      await window.waitForTimeout(16);
    }
    await window.waitForTimeout(800);
    results.pdfScroll = { ...(await stopPdf()), mainThread: busy(m0, await cdpMetrics(session)) };
    results.pdfPageAfterScroll = await window
      .getByTestId("pdf-page-number")
      .inputValue()
      .catch(() => null);
    await shot(window, "B30-pdf-scrolled");
    const zooms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const level = (await window.getByTestId("pdf-zoom-level").textContent()) ?? "";
      const done = await armUntil(window, "pdfZoomed", level);
      await click(window, window.getByTestId("pdf-zoom-in"));
      zooms.push(await done());
      await window.waitForTimeout(600);
    }
    results.pdfZoomMs = { runs: zooms, median: median(zooms) };
    await shot(window, "B31-pdf-zoomed");
    // Pinch-style zoom with ctrl+wheel.
    await glide(window, scroller);
    const stopPinch = await startFrames(window);
    await window.keyboard.down("Control");
    for (let i = 0; i < 10; i++) {
      await window.mouse.wheel(0, -40);
      await window.waitForTimeout(30);
    }
    await window.keyboard.up("Control");
    await window.waitForTimeout(800);
    results.pdfPinch = await stopPinch();

    // Scrolling the 50k-cell sheet.
    await click(window, rowOf(fixtures.names.bigXlsx));
    await expect(window.locator('[data-testid="viewer-grid"]')).toBeVisible();
    await window.waitForTimeout(800);
    const grid = window.locator('[data-testid="viewer-grid"]').first();
    await glide(window, grid);
    const stopGrid = await startFrames(window);
    for (let i = 0; i < 80; i++) {
      await window.mouse.wheel(i % 10 === 9 ? 300 : 0, 300);
      await window.waitForTimeout(16);
    }
    await window.waitForTimeout(500);
    results.sheetScroll = await stopGrid();
    results.sheetDom = await window.evaluate(
      () => document.querySelectorAll('[data-testid="viewer-grid"] td').length,
    );
    await shot(window, "B32-sheet-scrolled");

    // The Word file with images: scroll, and how big its text is drawn.
    await click(window, rowOf(fixtures.names.imageDocx));
    await expect(window.locator('[data-testid="viewer-docx"][data-rendered="yes"]')).toBeVisible({
      timeout: 20_000,
    });
    await window.waitForTimeout(800);
    results.docxTextSize = await window.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".docx-view");
      const p = host?.querySelector("p span, p");
      if (!host || !p) return null;
      const zoom = Number(getComputedStyle(host).zoom || 1);
      return {
        zoom,
        fontPx: getComputedStyle(p).fontSize,
        apparentPx: Math.round(Number.parseFloat(getComputedStyle(p).fontSize) * zoom * 10) / 10,
      };
    });
    const docx = window.locator('[data-testid="viewer-docx"]');
    await glide(window, docx);
    const stopDocx = await startFrames(window);
    for (let i = 0; i < 60; i++) {
      await window.mouse.wheel(0, 300);
      await window.waitForTimeout(16);
    }
    await window.waitForTimeout(500);
    results.docxScroll = await stopDocx();
    record("speed.viewer", results);
    record("speed.memory.afterViewer", await memory(app.app));
  } finally {
    await close(app);
    removeDir(dataDir);
    removeDir(root);
  }
});

test("B5 motion: frames while a menu opens and closes (on, reduced, off), and typing with motion on and off", async () => {
  test.setTimeout(10 * 60_000);
  const dataDir = tempDir("data");
  const app = await launch(dataDir, { readyTestId: "plus-menu" });
  const { window } = app;
  const chooseMotion = async (motion: "on" | "reduced" | "off") => {
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ device: { motion: chosen } });
    }, motion);
    await expect(window.locator("html")).toHaveAttribute("data-motion", motion);
  };
  try {
    await sealShell(app.app);
    const plus = window.getByTestId("plus-menu");
    const menus: Record<string, unknown> = {};
    for (const motion of ["on", "reduced", "off"] as const) {
      await chooseMotion(motion);
      // The + menu opened, read and closed ten times, as a person does; frames counted throughout.
      const stop = await startFrames(window);
      for (let i = 0; i < 10; i++) {
        await click(window, plus);
        await window.waitForTimeout(400);
        await window.keyboard.press("Escape");
        await window.waitForTimeout(300);
      }
      menus[motion] = await stop();
    }
    record("speed.motion.menu", menus);

    // Typing in a Mind: nothing moves while the User types, so motion on and off type alike.
    await click(window, plus);
    await click(window, window.getByTestId("plus-new-mind"));
    await click(window, window.getByTestId("mind-editor"));
    await installKeyLatency(window);
    const typing: Record<string, unknown> = {};
    for (const motion of ["on", "off"] as const) {
      await chooseMotion(motion);
      await takeKeyLatency(window);
      const stop = await startFrames(window);
      await typeFor(window, 160);
      const frames = await stop();
      typing[motion] = { ...(await takeKeyLatency(window)), frames };
      await window.keyboard.press("Enter");
    }
    record("speed.motion.typing", typing);
  } finally {
    await close(app);
    removeDir(dataDir);
  }
});

/** Every file under `dir`, at any depth, by its absolute path. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The 50th and 95th percentiles and the slowest of some times, in ms. */
function spread(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return { runs: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)) };
}

/**
 * MCP pings straight to the app's socket, with no shim: the opening line, the
 * 2025 handshake, then `count` pings, each timed from send to answer.
 */
async function directPings(launch: AgentLaunch, count: number): Promise<number[]> {
  const socket = createConnection(launch.env[AGENT_SOCKET_ENV] ?? "");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const waiting = new Map<number, () => void>();
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const message = JSON.parse(pending.slice(0, end)) as { id?: number };
      pending = pending.slice(end + 1);
      if (typeof message.id === "number") waiting.get(message.id)?.();
    }
  });
  const request = (id: number, method: string, params: object = {}) =>
    new Promise<void>((resolve) => {
      waiting.set(id, resolve);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  socket.write(handshakeLine(launch.env[AGENT_TOKEN_ENV] ?? ""));
  await request(0, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "audit", version: "1" },
  });
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const times: number[] = [];
  for (let id = 1; id <= count; id++) {
    const started = performance.now();
    await request(id, "ping");
    times.push(performance.now() - started);
  }
  socket.destroy();
  return times;
}

test("B6 outside agents (#351): an agent's search over 2,000 Documents, through the shim", async () => {
  test.setTimeout(40 * 60_000);
  const dataDir = tempDir("data");
  const root = tempDir("fixtures");
  const fixtures = writeFixtures(root, 2000);
  const paths = filesUnder(fixtures.scale);
  const app = await launch(dataDir, { fakeChat: true, readyTestId: "plus-menu" });
  try {
    const { window } = app;
    const folderId = await window.evaluate(async (all) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: "Research", description: "All" });
      await bridge.addDocuments(all, { groupId: folder.id });
      return folder.id;
    }, paths);
    await documentsReady(window, paths.length, 25 * 60_000);
    const connected = await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      // Linux with no keyring running: the pairing's key is kept as other keys are, once allowed.
      const storage = await bridge.getSecretStorage();
      if (!storage.canSave) await bridge.acceptPlainTextSecretStorage();
      await bridge.setAgentsEnabled(true);
      return bridge.connectAgent({ name: "Audit agent", folderIds: [id] });
    }, folderId);

    // As an agent starts it: the app's own binary runs the shim as Node.
    const client = new Client({ name: "audit-agent", version: "1.0.0" });
    const spawned = performance.now();
    await client.connect(
      new StdioClientTransport({
        command: connected.launch.command,
        args: connected.launch.args,
        env: connected.launch.env,
        stderr: "pipe",
      }),
    );
    const connectMs = performance.now() - spawned;
    try {
      const { tools } = await client.listTools();
      const definitions = JSON.stringify(
        tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      );
      const queries = [
        "tide estuary",
        "salt marsh erosion",
        "seagrass sediment",
        "carbon price",
        "emissions target",
        "tea auction",
        "machine learning model",
        "contract clause",
        "public health survey",
        "harbour shoreline",
        "研究笔记",
        "review of shoreline",
      ];
      // One of each first: the first search of a word list warms SQLite's pages.
      for (const query of queries) await client.callTool({ name: "search", arguments: { query } });
      const searches: number[] = [];
      let passages = 0;
      for (let round = 0; round < 10; round++) {
        for (const query of queries) {
          const started = performance.now();
          const result = await client.callTool({ name: "search", arguments: { query } });
          searches.push(performance.now() - started);
          passages += (result.structuredContent as { passages: unknown[] }).passages.length;
        }
      }
      const shimPings: number[] = [];
      for (let i = 0; i < 200; i++) {
        const started = performance.now();
        await client.ping();
        shimPings.push(performance.now() - started);
      }
      const direct = spread(await directPings(connected.launch, 200));
      const throughShim = spread(shimPings);
      record("speed.agents", {
        documents: paths.length,
        connectMs: Math.round(connectMs),
        search: { ...spread(searches), passagesPerSearch: passages / searches.length },
        pingThroughShim: throughShim,
        pingDirectToSocket: direct,
        shimOverheadP50Ms: Math.round((throughShim.p50 - direct.p50) * 100) / 100,
        toolDefinitions: {
          tools: tools.length,
          characters: definitions.length,
          // English text: about 4 characters a token.
          approximateTokens: Math.ceil(definitions.length / 4),
        },
      });
    } finally {
      await client.close();
    }
  } finally {
    await close(app);
    removeDir(dataDir);
    removeDir(root);
  }
});
