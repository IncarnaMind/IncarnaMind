/**
 * The UI audit's harness: launching the test build on a temporary data folder
 * and a temporary HOME, moving and typing like a person, and the probes the
 * audit reads (contrast, focus, frames, long tasks, memory). Not a test suite.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CDPSession,
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
// Vite's own source-map reader (the audit adds no dependency of its own).
import { SourceMapConsumer } from "source-map-js";
import { APP_ARGS, homeEnv, KEYCHAIN_ARGS } from "../../tests/helpers/home";
import { launchEnvironment } from "../launchEnvironment";

const appDir = resolve(__dirname, "..", "..");

export const AUDIT_OUT = resolve(process.env.AUDIT_OUT ?? join(appDir, "test-results", "ui-audit"));

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export const SHOTS = ensureDir(join(AUDIT_OUT, "screenshots"));

/** A fresh temporary folder under the system's temp dir. */
export const tempDir = (prefix: string) =>
  mkdtempSync(join(tmpdir(), `incarnamind-audit-${prefix}-`));

export const removeDir = (path: string) =>
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });

/** Measurements, merged into AUDIT_OUT/results.json under `key`. */
export function record(key: string, value: unknown): void {
  const file = join(AUDIT_OUT, "results.json");
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    all = {};
  }
  all[key] = value;
  writeFileSync(file, JSON.stringify(all, null, 2));
}

export interface Launched {
  app: ElectronApplication;
  window: Page;
  /** Wall-clock ms: before launch, the window's first paint (approx.), and the sidebar ready. */
  timing: { launchMs: number; firstPaintMs: number | null; interactiveMs: number };
  home: string;
}

export interface LaunchOptions {
  fakeChat?: boolean;
  examples?: boolean;
  /** Wait for this test id before returning (default "plus-menu"); null: don't wait. */
  readyTestId?: string | null;
  /** More environment variables, e.g. NODE_OPTIONS for the startup hook. */
  extraEnv?: Record<string, string>;
  /** Another app folder to launch (the baseline Electron app). */
  appPath?: string;
  /** Command-line arguments before the app folder, e.g. ["-r", hook]. */
  extraArgs?: string[];
}

/**
 * Launches the built app (out/) on `dataDir` with a temporary HOME, test hooks
 * on and the fake embedding model (no download). Times the launch.
 */
export async function launch(
  dataDir: string,
  {
    fakeChat = false,
    examples = false,
    readyTestId = "plus-menu",
    extraEnv = {},
    appPath = appDir,
    extraArgs = [],
  }: LaunchOptions = {},
): Promise<Launched> {
  const home = tempDir("home");
  const env = launchEnvironment({
    INCARNAMIND_TEST_EXAMPLES: examples ? "1" : undefined,
    INCARNAMIND_FAKE_CHAT: fakeChat ? "1" : undefined,
    INCARNAMIND_DATA_DIR: dataDir,
    INCARNAMIND_TEST_HOOKS: "1",
    INCARNAMIND_TEST_EMBEDDER: "fake",
    ...homeEnv(home),
    ...extraEnv,
  });

  const launchMs = Date.now();
  const app = await electron.launch({
    args: [...KEYCHAIN_ARGS, ...extraArgs, appPath, ...APP_ARGS],
    env,
  });
  const window = await app.firstWindow();
  let interactiveMs = Date.now();
  if (readyTestId) {
    await window.getByTestId(readyTestId).waitFor({ timeout: 60_000 });
    interactiveMs = Date.now();
  }
  const firstPaintMs = await window
    .evaluate(() => {
      const paint = performance
        .getEntriesByType("paint")
        .find((entry) => entry.name === "first-contentful-paint");
      return paint ? performance.timeOrigin + paint.startTime : null;
    })
    .catch(() => null);
  return { app, window, timing: { launchMs, firstPaintMs, interactiveMs }, home };
}

export async function close(launched: Launched): Promise<void> {
  await launched.app.close().catch(() => undefined);
  removeDir(launched.home);
}

// --- Moving like a person -------------------------------------------------

/**
 * Slides the mouse onto an element in steps, checks the element itself is
 * what is under the pointer (nothing covers it, it isn't hidden), and pauses
 * as a person does before clicking.
 */
export async function glide(window: Page, target: Locator, at?: { x?: number; y?: number }) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  const x = box.x + (at?.x ?? box.width / 2);
  const y = box.y + (at?.y ?? box.height / 2);
  await window.mouse.move(x, y, { steps: 12 });
  const hit = await target.evaluate(
    (element, [px, py]) => {
      const under = document.elementFromPoint(px as number, py as number);
      return under !== null && (under === element || element.contains(under));
    },
    [x, y],
  );
  if (!hit) throw new Error("Something covers the element under the pointer.");
  await window.waitForTimeout(120);
  return { x, y };
}

/** Glide, hover, then press and release, as a person clicks. */
export async function click(window: Page, target: Locator, at?: { x?: number; y?: number }) {
  const { x, y } = await glide(window, target, at);
  await window.mouse.down();
  await window.waitForTimeout(40);
  await window.mouse.up();
  return { x, y };
}

/** Types with a person's rhythm (key delays around `delay` ms). */
export async function typeLike(window: Page, text: string, delay = 70) {
  for (const char of text) {
    await window.keyboard.type(char);
    await window.waitForTimeout(delay * (0.6 + Math.random() * 0.8));
  }
}

export async function shot(target: Page | Locator, name: string, fullPage = false) {
  const path = join(SHOTS, `${name}.png`);
  if ("screenshot" in target && "mouse" in target) {
    await (target as Page).screenshot({ path, fullPage });
  } else {
    await (target as Locator).screenshot({ path });
  }
  return path;
}

// --- Probes ---------------------------------------------------------------

export interface ContrastIssue {
  text: string;
  ratio: number;
  need: number;
  color: string;
  background: string;
  size: string;
  weight: string;
  where: string;
}

/**
 * WCAG contrast of every visible text (and of icons, against 3:1) on the page:
 * the text's colour, with opacity, over the nearest opaque background behind it.
 */
export function contrastScan(window: Page): Promise<{ checked: number; issues: ContrastIssue[] }> {
  return window.evaluate(() => {
    const parse = (value: string): [number, number, number, number] | null => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) {
        const c = value.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
        if (!c) return null;
        return [
          Number(c[1]) * 255,
          Number(c[2]) * 255,
          Number(c[3]) * 255,
          c[4] === undefined ? 1 : Number(c[4]),
        ];
      }
      const parts = (m[1] as string)
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0);
    };
    const blend = (top: number[], bottom: number[]) => {
      const a = top[3] ?? 1;
      return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a));
    };
    const opacityOf = (element: Element) => {
      let opacity = 1;
      for (let e: Element | null = element; e; e = e.parentElement) {
        opacity *= Number(getComputedStyle(e).opacity);
      }
      return opacity;
    };
    const backgroundOf = (element: Element): number[] => {
      const layers: number[][] = [];
      for (let e: Element | null = element; e; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg && bg[3] > 0) {
          layers.push(bg);
          if (bg[3] >= 1) break;
        }
      }
      let colour = [255, 255, 255];
      for (const layer of layers.reverse()) colour = blend(layer, colour);
      return colour;
    };
    const describe = (element: Element) => {
      const parts: string[] = [];
      for (let e: Element | null = element; e && parts.length < 3; e = e.parentElement) {
        const id = e.getAttribute("data-testid");
        parts.push(id ? `[${id}]` : e.tagName.toLowerCase());
      }
      return parts.reverse().join(" > ");
    };
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
        return false;
      }
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const issues: ContrastIssue[] = [];
    let checked = 0;
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const parent = node.parentElement;
      if (!text || !parent || seen.has(parent)) continue;
      seen.add(parent);
      if (!visible(parent) || parent.closest("[aria-hidden='true'],canvas,svg,.katex")) continue;
      if (opacityOf(parent) < 0.1) continue;
      // Placeholders and disabled text are exempt from 4.5:1 (WCAG 1.4.3).
      if (parent.closest("[disabled],[aria-disabled='true']")) continue;
      const style = getComputedStyle(parent);
      const fg = parse(style.color);
      if (!fg) continue;
      const bg = backgroundOf(parent);
      const fgOver = blend([fg[0], fg[1], fg[2], fg[3] * opacityOf(parent)], bg);
      const l1 = lum(fgOver);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      checked++;
      if (ratio + 0.005 < need) {
        issues.push({
          text: text.slice(0, 60),
          ratio: Math.round(ratio * 100) / 100,
          need,
          color: style.color,
          background: `rgb(${bg.map((v) => Math.round(v)).join(", ")})`,
          size: style.fontSize,
          weight: style.fontWeight,
          where: describe(parent),
        });
      }
    }
    // Icons that carry meaning (buttons' only content): 3:1 against their background.
    for (const svg of document.querySelectorAll("button svg, [role='button'] svg, a svg")) {
      const button = svg.closest("button,[role='button'],a");
      if (!button || (button.textContent ?? "").trim()) continue;
      if (!visible(svg) || button.closest("[disabled],[aria-hidden='true']")) continue;
      // Shown only on hover or focus (opacity 0 now): not judged here.
      if (opacityOf(svg) < 0.1) continue;
      const shape = svg.querySelector("path,polygon,circle,rect,line,polyline") ?? svg;
      const style = getComputedStyle(shape);
      const paint = style.stroke !== "none" && style.stroke !== "" ? style.stroke : style.fill;
      const stroke = parse(paint) ?? parse(getComputedStyle(svg).color);
      if (!stroke) continue;
      const bg = backgroundOf(button);
      const fgOver = blend([stroke[0], stroke[1], stroke[2], stroke[3] * opacityOf(svg)], bg);
      const l1 = lum(fgOver);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      checked++;
      if (ratio + 0.005 < 3) {
        issues.push({
          text: `(icon) ${button.getAttribute("aria-label") ?? button.getAttribute("title") ?? ""}`,
          ratio: Math.round(ratio * 100) / 100,
          need: 3,
          color: paint,
          background: `rgb(${bg.map((v) => Math.round(v)).join(", ")})`,
          size: "",
          weight: "",
          where: describe(button),
        });
      }
    }
    return { checked, issues };
  });
}

export interface FocusStop {
  step: number;
  what: string;
  visibleFocus: boolean;
  indicator: string;
  box: { x: number; y: number; w: number; h: number } | null;
}

/** Presses Tab `count` times and says where focus went, and whether it can be seen. */
export async function focusWalk(
  window: Page,
  count: number,
  shotPrefix?: string,
): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  for (let step = 1; step <= count; step++) {
    await window.keyboard.press("Tab");
    await window.waitForTimeout(90);
    const stop = await window.evaluate((n) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) {
        return { step: n, what: "(body)", visibleFocus: false, indicator: "none", box: null };
      }
      // The accent colour as the browser computes it, to recognise a rule that turns accent.
      const probe = document.createElement("span");
      probe.style.color = "var(--color-accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      // The ring may be drawn on the element, on its ::before or ::after, or on a child
      // (a tab draws it on its inner shape), or on the row a sidebar row's main button is
      // in; a divider turns accent instead.
      const style = getComputedStyle(el);
      const row = el.matches(".row-main") ? el.closest(".group") : null;
      const styles = [
        style,
        getComputedStyle(el, "::before"),
        getComputedStyle(el, "::after"),
        ...[...el.children].slice(0, 4).map((child) => getComputedStyle(child)),
        ...(row ? [getComputedStyle(row)] : []),
      ];
      const ringed = styles.find(
        (s) => s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0,
      );
      const outline = ringed ? `outline ${ringed.outlineWidth} ${ringed.outlineColor}` : "";
      // A shadow counts on the element only: a pseudo-element or child may carry one at rest.
      const shadow = style.boxShadow !== "none" ? `shadow ${style.boxShadow.slice(0, 50)}` : "";
      const filled = style.backgroundColor === accent ? `fill ${accent}` : "";
      // A text field shows its caret (and, by DESIGN.md, an accent edge).
      const textField =
        el.isContentEditable ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement &&
          !["button", "checkbox", "radio", "submit", "reset", "range", "file"].includes(el.type));
      const rect = el.getBoundingClientRect();
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        (el.textContent ?? "").trim().slice(0, 40) ||
        el.getAttribute("placeholder") ||
        "";
      const testid =
        el.getAttribute("data-testid") ||
        el.closest("[data-testid]")?.getAttribute("data-testid") ||
        "";
      return {
        step: n,
        what: `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} ${testid ? `[${testid}]` : ""} "${label}"`,
        visibleFocus: Boolean(outline || shadow || filled) || textField,
        indicator:
          outline ||
          shadow ||
          filled ||
          (textField
            ? `caret, edge ${style.borderColor === accent ? "accent" : "unchanged"}`
            : "none"),
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    }, step);
    stops.push(stop);
    if (shotPrefix && stop.box && step <= 40) {
      const pad = 24;
      const clip = {
        x: Math.max(0, stop.box.x - pad),
        y: Math.max(0, stop.box.y - pad),
        width: Math.max(10, stop.box.w + pad * 2),
        height: Math.max(10, stop.box.h + pad * 2),
      };
      await window
        .screenshot({
          path: join(SHOTS, `${shotPrefix}-${String(step).padStart(2, "0")}.png`),
          clip,
        })
        .catch(() => undefined);
    }
  }
  return stops;
}

/** Starts collecting frame times and long tasks in the page; `stop` returns the stats. */
export async function startFrames(window: Page): Promise<() => Promise<FrameStats>> {
  await window.evaluate(() => {
    const w = window as unknown as {
      __audit?: {
        frames: number[];
        longTasks: number[];
        running: boolean;
        observer?: PerformanceObserver;
      };
    };
    const state = {
      frames: [] as number[],
      longTasks: [] as number[],
      running: true,
      observer: undefined as PerformanceObserver | undefined,
    };
    w.__audit = state;
    let last = performance.now();
    const tick = (now: number) => {
      if (!state.running) return;
      state.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame((now) => {
      last = now;
      requestAnimationFrame(tick);
    });
    try {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      });
      state.observer.observe({ type: "longtask", buffered: false });
    } catch {
      // longtask isn't supported
    }
  });
  return async () =>
    window.evaluate(() => {
      const w = window as unknown as {
        __audit: {
          frames: number[];
          longTasks: number[];
          running: boolean;
          observer?: PerformanceObserver;
        };
      };
      const state = w.__audit;
      state.running = false;
      state.observer?.disconnect();
      const frames = [...state.frames].sort((a, b) => a - b);
      const q = (p: number) =>
        frames[Math.min(frames.length - 1, Math.floor(p * frames.length))] ?? 0;
      const round = (v: number) => Math.round(v * 10) / 10;
      return {
        frames: frames.length,
        p50: round(q(0.5)),
        p95: round(q(0.95)),
        p99: round(q(0.99)),
        max: round(frames.at(-1) ?? 0),
        over50: frames.filter((f) => f > 50).length,
        over100: frames.filter((f) => f > 100).length,
        longTasks: state.longTasks.length,
        longTaskTotal: round(state.longTasks.reduce((a, b) => a + b, 0)),
        longTaskMax: round(Math.max(0, ...state.longTasks)),
      };
    });
}

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over50: number;
  over100: number;
  longTasks: number;
  longTaskTotal: number;
  longTaskMax: number;
}

/** Records keydown → next paint for each key typed, and Event Timing entries. */
export async function installKeyLatency(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as {
      __keys?: number[];
      __events?: { name: string; duration: number }[];
    };
    if (w.__keys) return;
    w.__keys = [];
    w.__events = [];
    document.addEventListener(
      "keydown",
      (event) => {
        const t0 = event.timeStamp;
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => w.__keys?.push(performance.now() - t0);
          channel.port2.postMessage(0);
        });
      },
      true,
    );
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          w.__events?.push({ name: entry.name, duration: entry.duration });
        }
      }).observe({
        type: "event",
        durationThreshold: 16,
        buffered: false,
      } as PerformanceObserverInit);
    } catch {
      // Event Timing isn't supported
    }
  });
}

export async function takeKeyLatency(window: Page) {
  return window.evaluate(() => {
    const w = window as unknown as {
      __keys: number[];
      __events: { name: string; duration: number }[];
    };
    const keys = [...w.__keys].sort((a, b) => a - b);
    const events = w.__events.filter((e) => /key|input/.test(e.name));
    w.__keys = [];
    w.__events = [];
    const q = (p: number) => keys[Math.min(keys.length - 1, Math.floor(p * keys.length))] ?? 0;
    const round = (v: number) => Math.round(v * 10) / 10;
    return {
      keys: keys.length,
      median: round(q(0.5)),
      p95: round(q(0.95)),
      max: round(keys.at(-1) ?? 0),
      over50: keys.filter((k) => k > 50).length,
      eventTimingOver16: events.length,
      eventTimingMax: round(Math.max(0, ...events.map((e) => e.duration))),
      // Event Timing (to the presented frame) for keydown only; keys it didn't report took < 16ms.
      presented: (() => {
        const downs = events.filter((e) => e.name === "keydown").map((e) => e.duration);
        const all = [
          ...downs,
          ...Array.from({ length: Math.max(0, keys.length - downs.length) }, () => 8),
        ].sort((a, b) => a - b);
        const at = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))] ?? 0;
        return {
          keydownsOver16: downs.length,
          median: at(0.5),
          p95: at(0.95),
          max: Math.max(0, ...downs),
        };
      })(),
    };
  });
}

/** The source maps next to the build's files, read once each (null: the build has none). */
const sourceMaps = new Map<string, SourceMapConsumer | null>();

/**
 * Where a function of the built renderer comes from, by the source map a build
 * made with `--sourcemap` puts beside it: the renderer is minified, so its own
 * names say nothing. Null without a map.
 */
function originalOf(url: string, line: number, column: number): string | null {
  if (!url.startsWith("file://")) return null;
  const file = fileURLToPath(url);
  let consumer = sourceMaps.get(file);
  if (consumer === undefined) {
    consumer = existsSync(`${file}.map`)
      ? new SourceMapConsumer(JSON.parse(readFileSync(`${file}.map`, "utf8")))
      : null;
    sourceMaps.set(file, consumer);
  }
  if (!consumer) return null;
  const at = consumer.originalPositionFor({ line: line + 1, column });
  if (!at.source) return null;
  const source = at.source.replace(/^(\.\.\/)+/, "").replace(/^.*node_modules\//, "");
  return `${at.name ?? "(anonymous)"} ${source}:${at.line}`;
}

/**
 * CPU profile of `action` in the renderer: the functions with the most self
 * time, named from the source maps when the build has them. A browser
 * function (such as `getClientRects`) also names the app's function that
 * called it, after "←".
 */
export async function profile(session: CDPSession | null, action: () => Promise<void>, top = 12) {
  if (!session) {
    await action();
    return null;
  }
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 200 });
  await session.send("Profiler.start");
  await action();
  const { profile: cpu } = (await session.send("Profiler.stop")) as {
    profile: {
      nodes: {
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
        children?: number[];
      }[];
      samples: number[];
      timeDeltas: number[];
    };
  };
  type ProfileNode = (typeof cpu.nodes)[number];
  const byId = new Map(cpu.nodes.map((n) => [n.id, n]));
  const parentOf = new Map<number, ProfileNode>();
  for (const node of cpu.nodes) {
    for (const child of node.children ?? []) parentOf.set(child, node);
  }
  const nameOf = ({ callFrame: { functionName, url, lineNumber, columnNumber } }: ProfileNode) =>
    originalOf(url, lineNumber, columnNumber) ??
    `${functionName || "(anonymous)"} ${url.split("/").pop() ?? ""}:${lineNumber + 1}`;
  const self = new Map<string, number>();
  cpu.samples.forEach((id, i) => {
    const node = byId.get(id);
    if (!node) return;
    let key = nameOf(node);
    if (!node.callFrame.url) {
      // A browser function: the nearest caller with a script of its own.
      let caller = parentOf.get(node.id);
      while (caller && !caller.callFrame.url) caller = parentOf.get(caller.id);
      if (caller) key = `${key} ← ${nameOf(caller)}`;
    }
    self.set(key, (self.get(key) ?? 0) + (cpu.timeDeltas[i] ?? 0) / 1000);
  });
  return [...self.entries()]
    .filter(([key]) => !key.startsWith("(idle)") && !key.startsWith("(program)"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
}

export async function cdp(window: Page): Promise<CDPSession | null> {
  try {
    const session = await window.context().newCDPSession(window);
    await session.send("Performance.enable");
    return session;
  } catch {
    return null;
  }
}

export async function cdpMetrics(session: CDPSession | null): Promise<Record<string, number>> {
  if (!session) return {};
  const { metrics } = (await session.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** Main-thread busy time between two metric snapshots, in ms. */
export function busy(before: Record<string, number>, after: Record<string, number>) {
  const d = (name: string) => Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000);
  return {
    taskMs: d("TaskDuration"),
    scriptMs: d("ScriptDuration"),
    layoutMs: d("LayoutDuration"),
    styleMs: d("RecalcStyleDuration"),
    layouts: Math.round((after.LayoutCount ?? 0) - (before.LayoutCount ?? 0)),
    styleRecalcs: Math.round((after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0)),
    domNodes: Math.round(after.Nodes ?? 0),
    jsHeapMB: Math.round(((after.JSHeapUsedSize ?? 0) / 1048576) * 10) / 10,
  };
}

/** Every process's memory, in MB, by type (working set, as Activity Monitor's "Memory" roughly). */
export async function memory(app: ElectronApplication) {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .map((m) => ({ type: m.type, name: m.name ?? "", kb: m.memory.workingSetSize })),
  );
  const byType: Record<string, number> = {};
  for (const m of metrics) {
    const key = m.type === "Utility" && m.name ? `Utility:${m.name}` : m.type;
    byType[key] = Math.round(((byType[key] ?? 0) + m.kb / 1024) * 10) / 10;
  }
  const total = Math.round(metrics.reduce((sum, m) => sum + m.kb / 1024, 0));
  return { totalMB: total, byType };
}

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Sets the window's content size (the minimum the app allows is 900×560). */
export async function setWindowSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

/** What the system's open dialog answers next (the folder a person would pick). */
export async function answerOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog;
  }, path);
}

/** Never let the app open anything outside itself during the audit. */
export async function sealShell(app: ElectronApplication) {
  await app.evaluate(({ shell, dialog }) => {
    const g = globalThis as { opened?: string[] };
    g.opened = [];
    shell.openExternal = async (url: string) => {
      g.opened?.push(url);
    };
    shell.openPath = async (path: string) => {
      g.opened?.push(path);
      return "";
    };
    shell.showItemInFolder = (path: string) => {
      g.opened?.push(path);
    };
    dialog.showSaveDialog = (async () => ({
      canceled: true,
    })) as unknown as typeof dialog.showSaveDialog;
  });
}
