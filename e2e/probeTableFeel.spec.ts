// Temporary probe for the 504 ms composer keyup while a table streams. Not part of the pull request.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
} from "./app";

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

const editorOf = (window: import("@playwright/test").Page) =>
  window.locator('[data-testid="mind-editor"]:visible');

const THROTTLE = Number(process.env.PROBE_THROTTLE ?? "1");

interface Probe {
  events: { name: string; duration: number; startTime: number; on: string; phase: string }[];
  tasks: { startTime: number; duration: number; phase: string }[];
  loaves: {
    startTime: number;
    duration: number;
    renderStart: number;
    styleAndLayoutStart: number;
    blockingDuration: number;
    phase: string;
    scripts: string[];
  }[];
  frames: { at: number; phase: string }[];
  marks: { name: string; at: number }[];
  keys: { key: string; at: number; phase: string }[];
}

test("probe: a table that widens as it is written", async () => {
  test.setTimeout(400_000);
  await writeFile(
    join(sources, "Tides.pdf"),
    buildPdf([{ lines: ["Harbour times", "Spring tides come at new moon and at full moon."] }]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 760);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  await expect(editorOf(window)).toBeFocused();

  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday"]) {
    await askInAssistant(window, `What do tides do on ${day}`);
  }
  const nine = await askInAssistant(window, "What do tides do in nine rows");
  await expect(nine.locator("table tr")).toHaveCount(10);
  await expect(nine.getByTestId("answer-open-table")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );

  const gpu = await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus());
  const cdp = await window.context().newCDPSession(window);
  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  await window.evaluate(() => {
    const holder = globalThis as unknown as { probe: Probe };
    holder.probe = { events: [], tasks: [], loaves: [], frames: [], marks: [], keys: [] };
    for (const name of ["keydown", "keyup"]) {
      globalThis.addEventListener(
        name,
        (event) => {
          const target = event.target;
          if (!(target instanceof Element) || !target.closest("[data-testid=composer]")) return;
          holder.probe.keys.push({
            key: `${name}:${(event as KeyboardEvent).key}`,
            at: event.timeStamp,
            phase: holder.probe.marks.at(-1)?.name ?? "before",
          });
        },
        { capture: true, passive: true },
      );
    }
    const phase = () => holder.probe.marks.at(-1)?.name ?? "before";
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.interactionId === 0) continue;
        const target = entry.target;
        const own = ["type", "role", "data-testid"].flatMap((attribute) => {
          const value = target instanceof Element ? target.getAttribute(attribute) : null;
          return value === null ? [] : [`[${attribute}=${value}]`];
        });
        holder.probe.events.push({
          name: entry.name,
          duration: entry.duration,
          startTime: entry.startTime,
          on: target instanceof Element ? `${target.tagName.toLowerCase()}${own.join("")}` : "",
          phase: phase(),
        });
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        holder.probe.tasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          phase: phase(),
        });
      }
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        startTime: number;
        duration: number;
        renderStart: number;
        styleAndLayoutStart: number;
        blockingDuration: number;
        scripts?: { invoker: string; sourceFunctionName: string; sourceURL: string }[];
      }[]) {
        holder.probe.loaves.push({
          startTime: entry.startTime,
          duration: entry.duration,
          renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          blockingDuration: entry.blockingDuration,
          phase: phase(),
          scripts: (entry.scripts ?? []).map(
            (script) =>
              `${script.sourceFunctionName || script.invoker || "?"} ${script.sourceURL.split("/").pop()}`,
          ),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
    const frame = () => {
      holder.probe.frames.push({ at: performance.now(), phase: phase() });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  const mark = (name: string) =>
    window.evaluate(
      (each) =>
        (globalThis as unknown as { probe: Probe }).probe.marks.push({
          name: each,
          at: performance.now(),
        }),
      name,
    );

  let filming = false;
  const film = async (mode: "full" | "off" | "small") => {
    if (filming) {
      filming = false;
      await cdp.send("Page.stopScreencast").catch(() => undefined);
    }
    if (mode === "off") return;
    cdp.on("Page.screencastFrame", ({ sessionId }: { sessionId: number }) => {
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      everyNthFrame: 1,
      ...(mode === "small" ? { maxWidth: 720, maxHeight: 380 } : {}),
    });
    filming = true;
  };

  for (const phase of ["A-film", "B-nofilm", "C-smallfilm"] as const) {
    await film(phase === "A-film" ? "full" : phase === "B-nofilm" ? "off" : "small");
    await mark(`${phase}:start`);
    const wide = await askInAssistant(window, "What do tides do, narrow then wide");
    await expect(wide.locator("table tr")).toHaveCount(8);
    await expect(wide.getByTestId("answer-open-table")).toBeVisible();
    await mark(`${phase}:done`);
  }
  await film("off");

  const probe = await window.evaluate(() => (globalThis as unknown as { probe: Probe }).probe);
  const windowOf = (name: string) => {
    const start = probe.marks.find((each) => each.name === `${name}:start`)?.at ?? 0;
    const done = probe.marks.find((each) => each.name === `${name}:done`)?.at ?? Number.MAX_VALUE;
    return { start, done };
  };
  const inPhase = (name: string, at: number) => {
    const { start, done } = windowOf(name);
    return at >= start && at <= done;
  };
  const gaps = probe.frames
    .slice(1)
    .map((frame, index) => ({
      phase: frame.phase,
      at: Math.round(frame.at),
      gap: Math.round(frame.at - probe.frames[index].at),
    }))
    .filter((each) => each.gap > 120);
  const summary = ["A-film", "B-nofilm", "C-smallfilm"].map((name) => {
    const events = probe.events.filter((each) => inPhase(name, each.startTime));
    const slowest = [...events].sort((a, b) => b.duration - a.duration)[0];
    const tasks = probe.tasks.filter((each) => inPhase(name, each.startTime));
    const typing = events.filter((each) => each.on.startsWith("textarea"));
    return {
      phase: name,
      events: events.length,
      slowest: slowest ? `${Math.round(slowest.duration)} ms ${slowest.name} @${Math.round(slowest.startTime)}` : null,
      keyups: typing
        .filter((each) => each.name === "keyup")
        .map((each) => Math.round(each.duration))
        .sort((a, b) => b - a)
        .slice(0, 8),
      longestTask: tasks.length > 0 ? Math.round(Math.max(...tasks.map((each) => each.duration))) : 0,
    };
  });
  console.log(
    JSON.stringify({
      kind: "probe.tableFeel",
      throttle: THROTTLE,
      gpuCompositing: gpu.gpu_compositing,
      summary,
      marks: probe.marks.map((each) => ({ name: each.name, at: Math.round(each.at) })),
      keys: probe.keys.map((each) => `${Math.round(each.at)} ${each.key}`),
      events: probe.events.map(
        (each) =>
          `${Math.round(each.startTime)} ${Math.round(each.duration)}ms ${each.name} ${each.on}`,
      ),
      slowEvents: probe.events
        .filter((each) => each.duration > 100)
        .map(
          (each) =>
            `${each.phase} ${Math.round(each.duration)}ms ${each.name} @${Math.round(each.startTime)} ${each.on}`,
        ),
      tasks: probe.tasks.map(
        (each) => `${each.phase} ${Math.round(each.duration)}ms @${Math.round(each.startTime)}`,
      ),
      frameGaps: gaps,
      loaves: probe.loaves
        .filter((each) => each.duration > 80)
        .map((each) => {
          const script = each.renderStart ? Math.round(each.renderStart - each.startTime) : 0;
          const styleLayout = each.styleAndLayoutStart
            ? Math.round(each.styleAndLayoutStart - (each.renderStart || each.startTime))
            : 0;
          const paint = Math.round(
            each.duration - (each.styleAndLayoutStart || each.renderStart || each.startTime),
          );
          return `${Math.round(each.duration)}ms = script ${script} + style/layout ${styleLayout} + paint ${paint} @${Math.round(each.startTime)} [${each.scripts.join(", ") || "no script"}]`;
        }),
    }),
  );
  await app.close();
});
