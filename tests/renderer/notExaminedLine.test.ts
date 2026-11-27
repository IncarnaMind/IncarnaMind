import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * Under the rows, a whole-Note check counts the sentences it couldn't tell are claims (#2447): a
 * count only, in English and Chinese, with no action of its own; the card's Check again runs it
 * again. When the check ended is said once, in the card's head (#3840), never on this line.
 */

vi.mock("../../src/renderer/src/editor/opinionChecks", () => ({ useOpinionChecks: () => [] }));

let root: Root | null = null;
let container: HTMLElement;
let CheckedMore: ComponentType<Record<string, unknown>>;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  // The stores the line reads list what waits for the User when they load: nothing does here.
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name === "on"
          ? each.on
          : () => Promise.resolve(String(name).startsWith("list") ? [] : undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    navigator: { languages: ["en"] },
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
  root = createRoot(container);
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const linePath = "../../src/renderer/src/editor/MindCheckLine.tsx";
  ({ CheckedMore } = await import(linePath));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function lineOf(language: "en" | "zh-CN", unexamined: number) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState((state) => ({
    settings: { ...(state.settings ?? {}), language } as typeof state.settings,
  }));
  const run = {
    at: "2026-11-02T21:00:00.000Z",
    sentences: 2,
    stop: null,
    skipped: [],
    unexamined: [],
  };
  await act(() =>
    root?.render(
      createElement(CheckedMore, { run, editor: {}, doc: {}, mindId: "mind-1", unexamined }),
    ),
  );
  return container;
}

describe.each([
  [
    "en",
    "Couldn’t tell whether 1 sentence needs checking",
    "Couldn’t tell whether 3 sentences need checking",
  ],
  ["zh-CN", "1 句未能判断是否需要核对", "3 句未能判断是否需要核对"],
] as const)("the line under the check in %s", (language, one, three) => {
  test("counts one sentence and several it couldn't tell are claims, with no action of its own", async () => {
    const single = await lineOf(language, 1);
    expect(single.textContent).toContain(one);
    expect(single.querySelectorAll("button")).toHaveLength(0);

    const several = await lineOf(language, 3);
    expect(several.textContent).toContain(three);
    expect(several.querySelectorAll("button")).toHaveLength(0);
  });

  // protects=#3840: with nothing it couldn't tell and nothing else left, no line is drawn under the rows, and none says when the check ran: the card's head does, once; fails_when=a line under the rows repeats the check's time or count
  test("draws no line when it left nothing, and never says when it ran", async () => {
    const line = await lineOf(language, 0);
    expect(line.querySelector('[data-testid="health-checked-more"]')).toBeNull();
    expect(line.textContent).toBe("");
  });
});
