import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatProvider } from "../../src/core/api";
import type { EstimateLine } from "../../src/renderer/src/cost";
import { translate } from "../../src/shared/i18n";

/*
 * An estimate says where it comes from (#1257): its price carries a tip naming the provider and
 * the day its prices were checked, the Tab key reaches it, and "Pricing ↗" opens the provider's
 * own page. A plan, a model on this computer, or a provider not known gives no estimate to say it.
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

// protects=an estimate's price carries "Estimate from {provider}'s price, checked {date}", reached by Tab, with "Pricing ↗" ending its line, in English and Chinese (#1257); fails_when=the tip or the link is missing, or names another provider; no_claim=that the link opens a browser, which e2e/research.spec.ts, e2e/comparisons.spec.ts and e2e/mindCheck.spec.ts check.
test.each([
  {
    language: "en" as const,
    parts: ["About $1.40", "310K tokens"],
    tip: /^Estimate from DeepSeek’s price, checked \d{1,2} \w+ \d{4}$/,
    shown: "About $1.40 · 310K tokens · Pricing ↗",
  },
  {
    language: "zh-CN" as const,
    parts: ["约 $1.40", "31万 token"],
    tip: /^按 DeepSeek 深度求索的价格估算，核对于 \d{4}年\d{1,2}月\d{1,2}日$/,
    shown: "约 $1.40 · 31万 token · 价格 ↗",
  },
])(
  "a priced line says where its price comes from, in $language",
  async ({ language, parts, tip, shown }) => {
    shared.language = language;
    await show(line({ parts }));

    expect(price()?.getAttribute("title")).toMatch(tip);
    expect(price()?.getAttribute("aria-description")).toBe(price()?.getAttribute("title"));
    expect(price()?.getAttribute("tabindex")).toBe("0");
    expect(link()?.getAttribute("href")).toBe(PRICES_URL);
    expect(link()?.getAttribute("target")).toBe("_blank");
    expect(text()).toBe(shown);
    expect(shared.load).toHaveBeenCalled();
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
  }
});
