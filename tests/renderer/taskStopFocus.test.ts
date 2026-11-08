import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../../src/core/api";

/*
 * A Task's Stop takes its button out with the Task's answer, a failed Stop's
 * included: the focus it had goes to the composer, where the User was (#2125).
 */

const spies = vi.hoisted(() => ({ focusComposer: vi.fn() }));

vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => {}, stopTask: () => new Promise(() => {}) },
}));
vi.mock("../../src/renderer/src/commands/assistant", () => ({
  focusComposer: spies.focusComposer,
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => "en",
  useT: () => (key: string) => key,
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) }),
}));

const AT = "2026-11-08T10:00:00.000Z";
const task = (over: Partial<Task> = {}): Task => ({
  id: "task-1",
  kind: "scripted",
  mindId: null,
  blockId: null,
  question: null,
  review: null,
  status: "running",
  pausedReason: null,
  resetsAt: null,
  ask: null,
  progress: null,
  problem: null,
  cost: null,
  actions: ["stop"],
  steps: [],
  stepCount: 0,
  queued: [],
  remaining: [],
  summary: null,
  startedAt: AT,
  finishedAt: null,
  updatedAt: AT,
  ...over,
});

let container: HTMLElement;
let focused: Element | null;
let root: Root;
let Progress: ComponentType<{ task: Task }>;
let window: Window & typeof globalThis;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  window = document.defaultView;
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  // The browser's rule linkedom leaves out: a removed element no longer holds the focus.
  focused = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused !== null && focused.isConnected ? focused : document.body),
  });
  root = createRoot(container);
  // Stop's tooltip asks the command's keys, so the command is registered as the app registers it.
  const { commands } = await import("../../src/renderer/src/commands/registry");
  const { taskCommands } = await import("../../src/renderer/src/commands/tasks");
  for (const command of taskCommands) commands.register(command);
  const modulePath = "../../src/renderer/src/components/assistant/TaskProgress.tsx";
  const module = (await import(modulePath)) as { TaskProgress: ComponentType<{ task: Task }> };
  Progress = module.TaskProgress;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  spies.focusComposer.mockClear();
});

async function show(shown: Task): Promise<void> {
  await act(async () => {
    root.render(createElement(Progress, { task: shown }));
  });
}

// protects=a Stop whose Task failed as it stopped, its button taken out with the answer, puts the focus in the composer (#2125); fails_when=the focus lands on the page body and the keyboard goes nowhere; no_claim=the successful Stop's landing, in e2e/tasks.spec.ts, English and Simplified Chinese.
test("a Stop whose Task fails as it stops gives the focus back to the composer", async () => {
  await show(task());
  const stop = container.querySelector<HTMLButtonElement>('[data-testid="task-progress-stop"]');
  if (!stop) throw new Error("No Stop button.");
  focused = stop;
  expect(window.document.activeElement).toBe(stop);

  await act(async () => {
    stop.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  // The Task failed as it was stopped: its answer takes the Stop button out.
  await show(
    task({
      status: "failed",
      problem: "unknown",
      finishedAt: AT,
      updatedAt: "2026-11-08T10:00:05.000Z",
    }),
  );
  expect(container.querySelector('[data-testid="task-progress-stop"]')).toBeNull();
  // Its button went with the answer, so nothing holds the focus but the page.
  expect(window.document.activeElement).toBe(window.document.body);
  expect(spies.focusComposer).toHaveBeenCalledTimes(1);
});
