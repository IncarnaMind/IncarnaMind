/**
 * The sorting line's held rows (#2138, from #2130): while the list of what sorts is read, the
 * line shows the choice it had, invisibly, so its rows and the buttons under them keep their
 * height. The settled choice then swaps its words in place. A decision model's rows and Jev's
 * are two each, and neither state was exercised: the built app's smoke hook offers neither.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SortingOption } from "../../src/renderer/src/components/providers/sortingOptions";
import { translate } from "../../src/shared/i18n";

const DECISION: SortingOption = {
  classifier: { kind: "decision", host: "openrouter", modelId: "decider" },
  label: "Decider · OpenRouter",
  provider: "OpenRouter",
  decisionModel: true,
};

const JEV: SortingOption = {
  classifier: { kind: "jev" },
  label: "TypeSafe Jev",
  provider: "TypeSafe Jev",
  decisionModel: true,
};

const LANGUAGES = ["en", "zh-CN"] as const;

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

/** The line while its list is read, with `holds` as the choice it had. */
async function reading(language: string, holds: SortingOption) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  const path = "../../src/renderer/src/components/providers/SortingChoice.tsx";
  const { SortingLine }: { SortingLine: ComponentType<Record<string, unknown>> } = await import(
    path
  );
  await act(() => root?.render(createElement(SortingLine, { option: null, holds, reading: true })));
  const line = container.querySelector('[data-testid="models-sorting-line"]');
  const held = line?.querySelector('[aria-hidden="true"]');
  const visible = [...(line?.children ?? [])].filter(
    (each) => each.getAttribute("aria-hidden") !== "true",
  );
  return {
    heldRows: [...(held?.querySelectorAll("p") ?? [])].map((each) => each.textContent),
    visibleRows: visible.flatMap((each) => [...each.querySelectorAll("p")]).length,
  };
}

describe.each(LANGUAGES)("a decision model's held rows (%s)", (language) => {
  // protects=the line keeps a decision model's two rows, invisibly, while the list is read (#2138); fails_when=they stop being held, so the buttons under the line move when the list lands; no_claim=none beyond protects.
  test("hold the two rows while the list is read", async () => {
    const { heldRows, visibleRows } = await reading(language, DECISION);
    expect(heldRows).toEqual([
      translate(language, "setup.sorting.uses"),
      translate(language, "setup.sorting.sends", { service: "OpenRouter" }),
    ]);
    // Nothing is said until the core answers: the held rows hold the room.
    expect(visibleRows).toBe(0);
  });
});

describe.each(LANGUAGES)("Jev's held rows (%s)", (language) => {
  // protects=the line keeps Jev's two rows, invisibly, while the list is read (#2138); fails_when=they stop being held, so the buttons under the line move when the list lands; no_claim=none beyond protects.
  test("hold the two rows while the list is read", async () => {
    const { heldRows, visibleRows } = await reading(language, JEV);
    expect(heldRows).toEqual([
      translate(language, "setup.sorting.uses"),
      translate(language, "setup.sorting.sends", { service: "TypeSafe Jev" }),
    ]);
    expect(visibleRows).toBe(0);
  });
});
