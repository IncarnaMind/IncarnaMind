import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * Under the rows, a whole-Note check counts the sentences it couldn't tell are claims (#2447): a
 * count only, in English and Chinese, with no action of its own; the card's Check runs it again.
 * The check's own line, at the card's top, says only when and how many it checked (#3756).
 */

vi.mock("../../src/renderer/src/editor/opinionChecks", () => ({ useOpinionChecks: () => [] }));

let root: Root | null = null;
let container: HTMLElement;
let CheckedWhen: ComponentType<Record<string, unknown>>;
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
  ({ CheckedWhen, CheckedMore } = await import(linePath));
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
      createElement(
        Fragment,
        null,
        createElement(CheckedWhen, { run }),
        createElement(CheckedMore, { run, editor: {}, doc: {}, mindId: "mind-1", unexamined }),
      ),
    ),
  );
  if (!container.querySelector('[data-testid="health-checked-all"]'))
    throw new Error("The check's line isn't drawn.");
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

  test("says nothing of sentences it couldn't tell when there are none", async () => {
    const line = await lineOf(language, 0);
    expect(line.textContent).toContain(language === "en" ? "Checked 2 sentences" : "已核对 2 句");
    expect(line.textContent).not.toContain(one);
  });
});
