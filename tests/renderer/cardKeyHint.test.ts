import { DOMParser } from "linkedom";
import { act, type ComponentType, type ReactNode, createElement as reactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CitationAttributes } from "../../src/core/api";
import type { CitationState } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";

/*
 * The keycap at a card's foot is the last thing in the card's own tree, so what lands in the card
 * while it shows (a check ending, a row landing) goes in before it; it shows only while the card has
 * a control (#3102).
 */

vi.mock("../../src/renderer/src/store", () => {
  const store = { status: { kind: "ready" }, documents: [] };
  return {
    useAppStore: Object.assign((select: (value: typeof store) => unknown) => select(store), {
      getState: () => store,
    }),
  };
});
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => "en",
  useT: () => (key: Parameters<typeof translate>[1], values: Parameters<typeof translate>[2]) =>
    translate("en", key, values),
}));
vi.mock("../../src/renderer/src/editor/ChangedSourceNotice", () => ({
  ChangedSourceNotice: () => null,
}));

const cited = (passageId: string): CitationAttributes => ({
  passageId,
  documentId: "acme",
  documentName: "Acme",
  contentHash: "hash",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: "Quarterly revenue was 289.4.",
  check: "found",
  checkReason: null,
});
const found: CitationState = {
  check: "found",
  reason: null,
  documentId: "acme",
  changedAfterCited: false,
};
const row = (passageId: string) => ({ citation: cited(passageId), state: found });

let root: Root | null = null;
let container: HTMLElement;
beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  window.HTMLElement.prototype.checkVisibility = () => true;
  for (const [name, value] of Object.entries({
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  container = globalThis.document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

interface CardProps {
  title: string;
  position: null;
  value: string;
  detail: null;
  notDrawn: null;
  cut: null;
  citation: null;
  state: null;
  citations: { citation: CitationAttributes; state: CitationState }[];
  figure: null;
  onOpen(): void;
  hint: ReactNode;
}

async function card(
  citations: CardProps["citations"],
  shown = true,
): Promise<{ card: Element; hint: Element | null }> {
  const cardPath = "../../src/renderer/src/editor/ChartPointCard.tsx";
  const hintPath = "../../src/renderer/src/editor/CardKeyHint.tsx";
  const { ChartPointCard }: { ChartPointCard: ComponentType<CardProps> } = await import(cardPath);
  const { CardKeyHint }: { CardKeyHint: ComponentType<{ shown: boolean }> } = await import(
    hintPath
  );
  root ??= createRoot(container);
  await act(() =>
    root?.render(
      reactElement(ChartPointCard, {
        title: "Q1 · 2024",
        position: null,
        value: "289.4",
        detail: null,
        notDrawn: null,
        cut: null,
        citation: null,
        state: null,
        citations,
        figure: null,
        onOpen: () => {},
        hint: reactElement(CardKeyHint, { shown }),
      }),
    ),
  );
  const body = container.querySelector('[data-testid="chart-card-body"]');
  if (!body) throw new Error("No card is drawn.");
  return { card: body, hint: body.querySelector('[data-testid="card-key-hint"]') };
}

test("a row that lands in the card while the keycap shows goes in before it, and the keycap stays last", async () => {
  const first = await card([row("p1")]);
  expect(first.hint?.textContent).toBe("Spaceto use");
  expect(first.card.lastElementChild).toBe(first.hint);

  const next = await card([row("p1"), row("p2")]);
  expect(next.card.querySelectorAll('[data-testid="chart-card-source"]')).toHaveLength(2);
  expect(next.card.lastElementChild).toBe(next.hint);
  const children = [...next.card.children];
  const hintAt = children.findIndex((each) => each.getAttribute("data-testid") === "card-key-hint");
  const sourcesAt = children.flatMap((each, at) =>
    each.getAttribute("data-testid") === "chart-card-source" ? [at] : [],
  );
  expect(sourcesAt).toHaveLength(2);
  expect(hintAt).toBe(children.length - 1);
  expect(Math.max(...sourcesAt)).toBeLessThan(hintAt);
});

test("it shows only while the card has a control, and when a control lands it shows", async () => {
  const none = await card([]);
  expect(none.hint?.className).toContain("hidden");

  const open = await card([row("p1")]);
  expect(open.hint?.className).toContain("flex");
  expect(open.hint?.className).not.toContain("hidden");

  const gone = await card([]);
  expect(gone.hint?.className).toContain("hidden");
});

test("with the keyboard's focus not showing the card, there is no keycap", async () => {
  const { hint } = await card([row("p1")], false);
  expect(hint).toBeNull();
});
