import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatProvider } from "../../src/core/api";
import type { EstimateLine } from "../../src/renderer/src/cost";
import { translate } from "../../src/shared/i18n";

/*
 * An estimate says where it comes from (#1257): its price carries a tip naming the provider and
 * the day its prices were checked, the Tab key reaches it and the shared tip shows it at once,
 * and "Pricing ↗" opens the provider's own page. A plan, a model on this computer, or a provider
 * not known gives no estimate to say it.
 */

const shared = vi.hoisted(() => ({
  language: "en" as "en" | "zh-CN",
  providers: [] as unknown[],
  load: vi.fn(),
}));

vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => shared.language,
  useT: () => (key: string, params?: Record<string, string>) =>
    translate(shared.language, key as never, params),
}));
vi.mock("../../src/renderer/src/savedProviders", () => ({
  useSavedProviders: (select: (state: { providers: unknown[] }) => unknown) =>
    select({ providers: shared.providers }),
  loadSavedProviders: shared.load,
}));

// The tip is placed and moved by layout and animation engines linkedom lacks; its Esc and outside-press rules are the real Popover's.
vi.mock("@floating-ui/dom", () => ({
  autoUpdate: () => () => undefined,
  computePosition: () => Promise.resolve({ x: 0, y: 0, middlewareData: {} }),
  flip: () => ({}),
  offset: () => ({}),
  shift: () => ({}),
}));
vi.mock("../../src/renderer/src/motion", () => ({
  enterFrom: () => undefined,
  useExitToward: () => undefined,
}));

const PRICES_URL = "https://api-docs.deepseek.com/quick_start/pricing";
const saved = (over: Partial<ChatProvider>): ChatProvider => ({
  id: "provider-1",
  kind: "deepseek",
  catalogId: null,
  endpoint: null,
  baseUrl: null,
  hasApiKey: true,
  service: { id: "https://api.deepseek.com", name: "api.deepseek.com" },
  ...over,
});

const line = (over: Partial<EstimateLine> = {}): EstimateLine => ({
  parts: ["About $1.40", "310K tokens"],
  title: "About $1.40 · 310K tokens",
  providerId: "provider-1",
  ...over,
});

let container: HTMLElement;
let root: Root;
let EstimateMeta: ComponentType<{ line: EstimateLine; testId?: string }>;

beforeEach(async () => {
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
  // The native popover the tip opens in, which linkedom doesn't have.
  const prototype = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  prototype.showPopover = () => undefined;
  prototype.hidePopover = () => undefined;
  const element = window.Element.prototype as unknown as { matches(selector: string): boolean };
  const matches = element.matches;
  element.matches = function (this: Element, selector: string) {
    return selector === ":popover-open" ? false : matches.call(this, selector);
  };
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const modulePath = "../../src/renderer/src/components/EstimateSource.tsx";
  const module = (await import(modulePath)) as { EstimateMeta: typeof EstimateMeta };
  EstimateMeta = module.EstimateMeta;
  shared.language = "en";
  shared.providers = [saved({})];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  shared.load.mockClear();
});

async function show(shown: EstimateLine): Promise<void> {
  await act(async () => {
    root.render(createElement(EstimateMeta, { line: shown, testId: "check-estimate" }));
  });
}

const price = () => container.querySelector('[data-testid="estimate-price"]');
const link = () => container.querySelector('[data-testid="estimate-pricing"]');
const text = () => container.querySelector('[data-testid="check-estimate"]')?.textContent;
const tooltip = () => container.ownerDocument.querySelector('[role="tooltip"]');

async function fire(target: Element | null, event: Event): Promise<void> {
  await act(async () => {
    target?.dispatchEvent(event);
  });
}
const focusIn = (target: Element | null) =>
  fire(target, new Event("focusin", { bubbles: true, cancelable: false }));
const focusOut = (target: Element | null) =>
  fire(target, new Event("focusout", { bubbles: true, cancelable: false }));

const WORDS = [
  {
    language: "en" as const,
    parts: ["About $1.40", "310K tokens"],
    tip: /^Estimate from DeepSeek’s price, checked \d{1,2}\u00a0\w+\u00a0\d{4}$/,
    shown: "About $1.40 · 310K tokens · Pricing ↗",
  },
  {
    language: "zh-CN" as const,
    parts: ["约 $1.40", "31万 token"],
    tip: /^按 DeepSeek 深度求索的价格估算，核对于 \d{4}年\d{1,2}月\d{1,2}日$/,
    shown: "约 $1.40 · 31万 token · 价格 ↗",
  },
];

// protects=an estimate's price is a Tab stop that describes itself with "Estimate from {provider}'s price, checked {date}" and has no native title beside the shared tip, with "Pricing ↗" ending its line, in English and Chinese (#1257); fails_when=the description or the link is missing, the title comes back, or the tip names another provider; no_claim=that the link opens a browser, which e2e/research.spec.ts, e2e/comparisons.spec.ts and e2e/mindCheck.spec.ts check.
test.each(WORDS)(
  "a priced line says where its price comes from, in $language",
  async ({ language, parts, tip, shown }) => {
    shared.language = language;
    await show(line({ parts }));

    expect(price()?.getAttribute("title")).toBeNull();
    expect(price()?.getAttribute("aria-description")).toMatch(tip);
    // A tip that wraps breaks before its date, never inside it, in both languages.
    const date = price()
      ?.getAttribute("aria-description")
      ?.split(/checked |核对于 /)[1];
    expect(date).toMatch(/\d{4}/);
    expect(date).not.toContain(" ");
    expect(price()?.getAttribute("tabindex")).toBe("0");
    expect(link()?.getAttribute("href")).toBe(PRICES_URL);
    expect(link()?.getAttribute("target")).toBe("_blank");
    expect(text()).toBe(shown);
    expect(shared.load).toHaveBeenCalled();
    expect(tooltip()).toBeNull();
  },
);

// protects=the price's tip is the shared tip: the keyboard's focus shows it at once with the words, the focus moving on takes it away, and Esc closes it alone, handled so the card or sheet around it stays open (#1257); fails_when=the focus shows nothing, the tip stays after the focus leaves, or Esc is left for the card behind it; no_claim=where the tip is drawn or that the focus stays on the price after Esc, which e2e/mindCheck.spec.ts, e2e/comparisons.spec.ts, e2e/research.spec.ts and e2e/modelsSettings.spec.ts check in the built app.
test.each(WORDS)(
  "the price's tip shows on focus and goes on Esc or when the focus moves on, in $language",
  async ({ language, parts, tip }) => {
    shared.language = language;
    await show(line({ parts }));
    expect(tooltip()).toBeNull();

    await focusIn(price());
    expect(tooltip()?.textContent).toMatch(tip);
    expect(tooltip()?.textContent).toBe(price()?.getAttribute("aria-description"));

    const pressed = new Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(pressed, { key: "Escape", isComposing: false });
    await fire(price(), pressed);
    expect(pressed.defaultPrevented).toBe(true);
    expect(tooltip()).toBeNull();

    await focusIn(price());
    expect(tooltip()?.textContent).toMatch(tip);
    await focusOut(price());
    expect(tooltip()).toBeNull();
  },
);

test("a line says nothing of where it comes from when its provider is a plan or on this computer, is not saved, or it shows no price", async () => {
  const tokensOnly: EstimateLine = { parts: ["310K tokens"], title: "310K tokens" };
  for (const [providers, shown, said] of [
    [[saved({ kind: "chatgpt", service: null })], line(), "About $1.40 · 310K tokens"],
    [[saved({ kind: "openai-compatible", service: null })], line(), "About $1.40 · 310K tokens"],
    [[], line(), "About $1.40 · 310K tokens"],
    [[saved({})], tokensOnly, "310K tokens"],
  ] as const) {
    shared.providers = [...providers];
    await show(shown);
    expect(price()).toBeNull();
    expect(link()).toBeNull();
    expect(text()).toBe(said);
    expect(tooltip()).toBeNull();
  }
});
