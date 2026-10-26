/**
 * How to run the feel check and what to do when it fails: docs/agents/testing.md › The feel check.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { type LaunchOptions, launchApp } from "./app";

/** A step's layout shifts that no recent input caused fail above this sum: less is rounding. */
export const SHIFT_LIMIT = 0.001;
/**
 * Input to next paint above which a step fails. The target is 100 ms on a laptop; CI's runners
 * are two to five times slower and share their cores, so the build fails only five times over.
 */
export const INPUT_CEILING_MS = 500;
/** A long task above which a step fails: ten times the 100 ms target, never reached by chance. */
export const LONG_TASK_CEILING_MS = 1000;

export const FEEL_FOLDER = join(__dirname, "..", "test-results", "feel");

/**
 * A problem main has today, filed as its issue, bounded by what was measured: one that is worse,
 * or in another step, still fails. A shift's bound holds under `SHIFT_LIMIT` too. A time's bound
 * is twice the slowest CI measured, since runners vary two to five times. `sometimes`: it
 * depends on timing, so a run without it doesn't make the entry stale. Remove the entry in the
 * pull request that closes the issue.
 */
type Known = { flow: string; step: string; issue: number; sometimes?: true } & (
  | { kind: "shift"; moved: readonly string[]; max: number }
  | {
      kind: "focus";
      landed: string;
    }
  | { kind: "input" | "long-task"; max: number }
);

/** Slow steps fail only on CI, whose ceilings they were set for: a busy laptop varies too much. */
const TIMES_FAIL = process.env.CI !== undefined;

export const KNOWN: readonly Known[] = [
  {
    flow: "first-open",
    step: "check the Mind",
    kind: "shift",
    moved: ["check-card", "tab-group"],
    max: 0.0083,
    issue: 1312,
  },
  {
    flow: "assistant-writes",
    step: "ask for a section",
    kind: "shift",
    moved: [
      "mind-changes",
      "mind-changes-left",
      "mind-changes-review",
      "mind-changes-undo",
      "tab-group",
    ],
    max: 0.01,
    sometimes: true,
    issue: 1325,
  },
  {
    flow: "library-2000",
    step: "add 2,000 Documents",
    kind: "shift",
    moved: ["library-row-count", "tagging-waiting", "tagging-waiting-setup", "document-list-item"],
    max: 0.0413,
    sometimes: true,
    issue: 1329,
  },
  { flow: "library-2000", step: "show all 2,000", kind: "input", max: 2900, issue: 1313 },
  { flow: "library-2000", step: "show all 2,000", kind: "long-task", max: 2500, issue: 1313 },
];

interface Shift {
  value: number;
  moved: string[];
}

interface StepRecord {
  name: string;
  shifts: Shift[];
  inputMs: number | null;
  longTasks: number[];
  focus: string | null;
}

type Problem = { step: string } & (
  | { kind: "shift"; value: number; moved: string[] }
  | { kind: "focus"; at: string; expected: string }
  | { kind: "input" | "long-task"; ms: number }
);

function detailOf(problem: Problem): string {
  switch (problem.kind) {
    case "shift":
      return `${problem.value.toFixed(4)} moving ${problem.moved.join(", ") || "(unknown)"}`;
    case "focus":
      return `on ${problem.at}, not the expected ${problem.expected}`;
    case "input":
      return `${Math.round(problem.ms)} ms to next paint`;
    case "long-task":
      return `${Math.round(problem.ms)} ms`;
  }
}

function excuses(known: Known, problem: Problem): boolean {
  if (known.step !== problem.step || known.kind !== problem.kind) return false;
  switch (problem.kind) {
    case "shift":
      return (
        known.kind === "shift" &&
        problem.value <= known.max &&
        problem.moved.every((each) => known.moved.includes(each))
      );
    case "focus":
      return (
        known.kind === "focus" &&
        (problem.at === known.landed || problem.at.startsWith(`${known.landed} `))
      );
    default:
      return (known.kind === "input" || known.kind === "long-task") && problem.ms <= known.max;
  }
}

interface FeelEntries {
  shifts: { at: number; value: number; moved: string[] }[];
  events: { at: number; duration: number }[];
  longTasks: { at: number; duration: number }[];
  take(): void;
}

async function observe(window: Page): Promise<void> {
  await window.evaluate(() => {
    const holder = globalThis as unknown as { feel?: FeelEntries };
    if (holder.feel) return;
    const describe = (node: Node | null): string => {
      const element = node instanceof Element ? node : (node?.parentElement ?? null);
      if (!element) return "(gone)";
      const named = element.closest("[data-testid]");
      if (named) return named.getAttribute("data-testid") ?? "";
      const classes = [...element.classList].slice(0, 2).join(".");
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
    };
    // TypeScript's DOM types have no layout shift yet.
    const isShift = (
      entry: PerformanceEntry,
    ): entry is PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
      sources?: { node: Node | null }[];
    } => "value" in entry && "hadRecentInput" in entry;
    const onShifts = (entries: PerformanceEntryList) => {
      for (const shift of entries) {
        if (!isShift(shift) || shift.hadRecentInput) continue;
        feel.shifts.push({
          at: shift.startTime,
          value: shift.value,
          moved: [...new Set((shift.sources ?? []).map((source) => describe(source.node)))],
        });
      }
    };
    const onLongTasks = (entries: PerformanceEntryList) => {
      for (const entry of entries) {
        feel.longTasks.push({ at: entry.startTime, duration: entry.duration });
      }
    };
    const onEvents = (entries: PerformanceEntryList) => {
      for (const event of entries) {
        if (!(event instanceof PerformanceEventTiming) || event.interactionId === 0) continue;
        feel.events.push({ at: event.startTime, duration: event.duration });
      }
    };
    const shifts = new PerformanceObserver((list) => onShifts(list.getEntries()));
    const longTasks = new PerformanceObserver((list) => onLongTasks(list.getEntries()));
    const events = new PerformanceObserver((list) => onEvents(list.getEntries()));
    const feel: FeelEntries = {
      shifts: [],
      events: [],
      longTasks: [],
      take: () => {
        onShifts(shifts.takeRecords());
        onLongTasks(longTasks.takeRecords());
        onEvents(events.takeRecords());
      },
    };
    holder.feel = feel;
    shifts.observe({ type: "layout-shift", buffered: true });
    longTasks.observe({ type: "longtask", buffered: true });
    // Every input slower than a frame, not only those over the default 104 ms.
    const everyInput: PerformanceObserverInit & { durationThreshold: number } = {
      type: "event",
      buffered: true,
      durationThreshold: 16,
    };
    events.observe(everyInput);
  });
}

// Two frames: what the last step changed has been painted by then.
const paintedAt = (window: Page) =>
  window.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
      ),
  );

const entriesBetween = (window: Page, from: number, to: number) =>
  window.evaluate(
    ({ from, to }) => {
      const { feel } = globalThis as unknown as { feel: FeelEntries };
      feel.take();
      const inside = (entry: { at: number }) => entry.at >= from && entry.at < to;
      return {
        shifts: feel.shifts.filter(inside),
        events: feel.events.filter(inside),
        longTasks: feel.longTasks.filter(inside),
      };
    },
    { from, to },
  );

// Named by test id and the start of the text, so two rows of one kind tell apart.
const focusOn = (target: Locator) =>
  target.evaluate((expected) => {
    const named = (element: Element) => {
      const near = element.closest("[data-testid]") ?? element;
      const id = near.getAttribute("data-testid") ?? near.tagName.toLowerCase();
      const text = near.textContent?.trim().slice(0, 24);
      return text ? `${id} “${text}”` : id;
    };
    const active = document.activeElement;
    return {
      at: !active || active === document.body ? "body" : named(active),
      expected: named(expected),
      onTarget: active !== null && (expected === active || expected.contains(active)),
    };
  });

export interface Feel {
  /** Runs one step of the flow, its action waiting for the state it leads to, and records it. */
  step(name: string, action: () => Promise<void>): Promise<void>;
  /** After a close, a create or a delete: focus must be on `target`, never on the page body. */
  expectFocus(step: string, target: Locator): Promise<void>;
  /**
   * Records what is left and writes the report. `failing`: what no known entry excuses. `stale`:
   * shift and focus entries that didn't happen. `unseen`: the known times, and focus that depends
   * on timing, that didn't happen this run, which CI lists without failing.
   */
  finish(): Promise<{ failing: string[]; stale: string[]; unseen: string[] }>;
}

/** Starts recording a flow in `window`, from now: what happened before its first step is its "start". */
export async function feelOf(window: Page, flow: string): Promise<Feel> {
  await observe(window);
  const steps: StepRecord[] = [];
  const problems: Problem[] = [];
  let from = 0;

  const record = async (name: string) => {
    const to = await paintedAt(window);
    const entries = await entriesBetween(window, from, to);
    from = to;
    const shifts = entries.shifts
      .filter((shift) => shift.value > 0)
      .map(({ value, moved }) => ({ value, moved }));
    const input = entries.events.length
      ? Math.max(...entries.events.map((event) => event.duration))
      : null;
    const longTasks = entries.longTasks.map((task) => task.duration);
    steps.push({ name, shifts, inputMs: input, longTasks, focus: null });
    // Summed over the step: two small shifts in one frame move as much as one big one.
    const shifted = shifts.reduce((sum, each) => sum + each.value, 0);
    const bounded = KNOWN.some(
      (known) => known.flow === flow && known.step === name && known.kind === "shift",
    );
    if (shifted > SHIFT_LIMIT || (bounded && shifted > 0)) {
      const moved = [...new Set(shifts.flatMap((each) => each.moved))];
      problems.push({ kind: "shift", step: name, value: shifted, moved });
    }
    if (input !== null && input > INPUT_CEILING_MS) {
      problems.push({ kind: "input", step: name, ms: input });
    }
    for (const ms of longTasks.filter((each) => each > LONG_TASK_CEILING_MS)) {
      problems.push({ kind: "long-task", step: name, ms });
    }
  };

  return {
    async step(name, action) {
      if (steps.length === 0) await record("start");
      await test.step(`${flow}: ${name}`, action);
      await record(name);
    },

    async expectFocus(step, target) {
      const { at, expected, onTarget } = await focusOn(target);
      const last = steps.findLast((each) => each.name === step);
      if (last) last.focus = at;
      if (!onTarget) problems.push({ kind: "focus", step, at, expected });
    },

    async finish() {
      await record("end");
      const listed = KNOWN.filter((each) => each.flow === flow);
      const knownFor = (problem: Problem) => listed.find((each) => excuses(each, problem));
      const happened = (known: Known) =>
        problems.some((problem) => problem.step === known.step && problem.kind === known.kind);
      // A time depends on the runner, and some focus on timing: those may not happen every run.
      const always = (known: Known) =>
        (known.kind === "shift" || known.kind === "focus") && !known.sometimes;
      const fails = (problem: Problem) =>
        !knownFor(problem) &&
        (TIMES_FAIL || (problem.kind !== "input" && problem.kind !== "long-task"));
      const missing = listed.filter((each) => !happened(each));
      const report = tableOf(flow, steps, problems, knownFor, fails, missing);
      await mkdir(FEEL_FOLDER, { recursive: true });
      await writeFile(join(FEEL_FOLDER, `${flow}.md`), report);
      await writeFile(
        join(FEEL_FOLDER, `${flow}.json`),
        JSON.stringify({ steps, problems }, null, 2),
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
      const named = (known: Known) => `#${known.issue} (${flow} › ${known.step}, ${known.kind})`;
      return {
        failing: problems
          .filter(fails)
          .map((problem) => `${problem.step}: ${problem.kind} ${detailOf(problem)}`),
        stale: missing
          .filter(always)
          .map((known) => `${named(known)} no longer reproduces: remove this entry`),
        unseen: missing
          .filter((known) => !always(known))
          .map((known) => `${named(known)} didn't happen in this run`),
      };
    },
  };
}

function tableOf(
  flow: string,
  steps: readonly StepRecord[],
  problems: readonly Problem[],
  knownFor: (problem: Problem) => Known | undefined,
  fails: (problem: Problem) => boolean,
  missing: readonly Known[],
): string {
  const cell = (step: StepRecord) => {
    const shift = step.shifts.reduce((sum, each) => sum + each.value, 0);
    const marks = [
      ...problems
        .filter((problem) => problem.step === step.name)
        .map((problem) => {
          const known = knownFor(problem);
          const mark = known
            ? `known #${known.issue}`
            : fails(problem)
              ? "**fails**"
              : "fails on CI";
          return `${mark}: ${problem.kind} ${detailOf(problem)}`;
        }),
      ...missing
        .filter((known) => known.step === step.name)
        .map((known) => `known #${known.issue}: no ${known.kind} problem this run`),
    ];
    return [
      step.name,
      shift === 0 ? "0" : shift.toFixed(4),
      step.inputMs === null ? "–" : `${Math.round(step.inputMs)} ms`,
      step.longTasks.length === 0
        ? "–"
        : `${step.longTasks.length}, longest ${Math.round(Math.max(...step.longTasks))} ms`,
      step.focus ?? "–",
      marks.join("; ") || "ok",
    ].join(" | ");
  };
  return [
    `### Feel: ${flow}`,
    "",
    "Step | Unexpected shift | Input to next paint | Long tasks | Focus | Result",
    "--- | --- | --- | --- | --- | ---",
    ...steps.map(cell),
    "",
    "",
  ].join("\n");
}

async function film(window: Page, folder: string): Promise<() => Promise<void>> {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const session = await window.context().newCDPSession(window);
  const frames: { file: string; at: number }[] = [];
  const writing: Promise<void>[] = [];
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = `${String(frames.length).padStart(5, "0")}.jpg`;
    frames.push({ file, at: metadata.timestamp ?? 0 });
    writing.push(writeFile(join(folder, file), Buffer.from(data, "base64")));
    // A frame can arrive as the window closes, when there is nothing left to acknowledge.
    void session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  return async () => {
    await session.send("Page.stopScreencast").catch((error: unknown) => {
      console.warn(`The film of ${folder} may stop short: ${String(error)}`);
    });
    await session.detach().catch((error: unknown) => {
      console.warn(`The film of ${folder} wasn't let go: ${String(error)}`);
    });
    await Promise.all(writing);
    // Each frame stays on screen until the next was painted: ffmpeg's concat list keeps that time.
    const list = frames.flatMap((frame, index) => {
      const next = frames[index + 1];
      return [
        `file '${frame.file}'`,
        `duration ${next ? Math.max(next.at - frame.at, 0.001) : 0.5}`,
      ];
    });
    const last = frames.at(-1);
    if (last) list.push(`file '${last.file}'`);
    await writeFile(join(folder, "frames.txt"), `${list.join("\n")}\n`);
  };
}

async function encode(folder: string, video: string): Promise<void> {
  const made = await new Promise<boolean>((resolve) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        ["-y", "-loglevel", "error"],
        ["-f", "concat", "-safe", "0", "-i", "frames.txt"],
        // H.264 needs even sides; the window's may be odd.
        ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"],
        ["-fps_mode", "vfr", "-pix_fmt", "yuv420p", video],
      ].flat(),
      { cwd: folder, stdio: "ignore" },
    );
    let missing = false;
    ffmpeg.on("error", (error) => {
      missing = true;
      console.warn(`No video of ${video}, its frames are in ${folder}: ${error.message}`);
      resolve(false);
    });
    ffmpeg.on("close", (code) => {
      if (code !== 0 && !missing) console.warn(`ffmpeg stopped with ${code} making ${video}`);
      resolve(code === 0);
    });
  });
  if (made) await rm(folder, { recursive: true, force: true });
}

export interface FeelRun {
  app: ElectronApplication;
  window: Page;
  feel: Feel;
  flow: string;
  stopFilming(): Promise<void>;
}

export async function startFeel(
  dataDir: string,
  flow: string,
  options: LaunchOptions = {},
): Promise<FeelRun> {
  await mkdir(FEEL_FOLDER, { recursive: true });
  const { app, window } = await launchApp(dataDir, options);
  const stopFilming = await film(window, join(FEEL_FOLDER, `${flow}-frames`));
  return { app, window, feel: await feelOf(window, flow), flow, stopFilming };
}

export async function endFeel({ app, feel, flow, stopFilming }: FeelRun): Promise<void> {
  const { failing, stale, unseen } = await feel.finish();
  if (unseen.length > 0) {
    await writeFile(join(FEEL_FOLDER, `${flow}.unseen.txt`), `${unseen.join("\n")}\n`);
  }
  await stopFilming();
  await app.close();
  await encode(join(FEEL_FOLDER, `${flow}-frames`), join(FEEL_FOLDER, `${flow}.mp4`));
  expect(
    failing,
    "Fix what the feel check found, or file it and list it in KNOWN (e2e/feel.ts)",
  ).toEqual([]);
  expect(stale, "Take these out of KNOWN (e2e/feel.ts)").toEqual([]);
}
