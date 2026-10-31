import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Meeting, MeetingFill } from "../../src/core/api";

/*
 * The line under a stopped Meeting (#142): with "Fill sections my notes don't cover" off and
 * nothing typed, nothing was asked of the model (#2306), so no line shows; one that couldn't run
 * still says why.
 */

let root: Root | null = null;
let container: HTMLElement;
let MeetingFillLine: ComponentType<{ meeting: Meeting }>;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    { get: (each, name) => (name === "on" ? each.on : () => Promise.resolve(undefined)) },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const linePath = "../../src/renderer/src/components/MeetingFillLine.tsx";
  ({ MeetingFillLine } = await import(linePath));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function show(fill: MeetingFill) {
  const meeting = { id: "meeting-1", kind: "meeting", fill } as Meeting;
  await act(() => root?.render(createElement(MeetingFillLine, { meeting })));
}

const line = () => container.querySelector('[data-testid="meeting-fill-line"]');

describe("the fill line of a Meeting nothing was asked to fill", () => {
  test("shows nothing when nothing was asked, and says why when it couldn't run", async () => {
    await show({ state: "off", mode: null, local: false, problem: null });
    expect(line()).toBeNull();

    await show({
      state: "off",
      mode: null,
      local: false,
      problem: { kind: "no-transcript", message: "the transcript has no lines." },
    });
    expect(line()?.textContent).toContain("the transcript has no lines.");
  });
});
