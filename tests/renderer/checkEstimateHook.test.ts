import { DOMParser } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useCheckEstimate } from "../../src/renderer/src/editor/changedSentences";
import type { CheckEstimateView } from "../../src/renderer/src/editor/checkEstimateState";
import type { Planned } from "../../src/renderer/src/mindCheck";

const estimates = vi.hoisted(() => ({
  run: (_planned: unknown): Promise<unknown> => Promise.resolve({ kind: "none" }),
}));
vi.mock("../../src/renderer/src/mindCheck", () => ({
  checkEstimate: (_mindId: string, planned: unknown) => estimates.run(planned),
  planCheckThisMind: () => Promise.reject(new Error("Not used here.")),
}));
vi.mock("../../src/renderer/src/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({}),
    subscribe: () => () => undefined,
  }),
}));

let root: Root | null = null;
let container: HTMLElement;
let view: CheckEstimateView | null = null;

const plan = {} as Planned;
const other = {} as Planned;

function Probe({ planned }: { planned: Planned | null }) {
  view = useCheckEstimate("mind", planned);
  return null;
}

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
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
  root = createRoot(container);
  view = null;
  estimates.run = () => Promise.resolve({ kind: "none" });
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

// protects=#2313: the card shows a price only for the plan it was estimated for; fails_when=the hook hands out the last plan's price for a new one; no_claim=the same plan's settled price.
test("a plan since changed shows pending until its own estimate lands", async () => {
  await act(() => {
    root?.render(createElement(Probe, { planned: plan }));
  });
  await act(async () => {});
  expect(view).toEqual({ line: null, state: "none" });

  let priced: ((estimate: unknown) => void) | undefined;
  estimates.run = () =>
    new Promise((resolve) => {
      priced = resolve;
    });
  await act(() => {
    root?.render(createElement(Probe, { planned: other }));
  });
  expect(view).toEqual({ line: null, state: "pending" });

  const line = { parts: ["About $2.00"], title: "About $2.00" };
  await act(async () => {
    priced?.({ kind: "price", line });
  });
  expect(view).toEqual({ line, state: "price" });
});
