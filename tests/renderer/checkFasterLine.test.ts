import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CheckDecisionStatus } from "../../src/core/api";

/*
 * The check card's line about the decision model (#3118). It is for a User who never touched the
 * switch in Settings, holds a key that reaches the model, and has no model reading by default:
 * anyone else has either said, can't turn it on, or already has it. It only points at the switch.
 */

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
  navigator: { languages: ["en-US"], userAgent: "node" },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");
const linePath = "../../src/renderer/src/editor/CheckFasterLine.tsx";
const { CheckFasterLine } = (await import(linePath)) as {
  CheckFasterLine: ComponentType<{ status: CheckDecisionStatus | null | undefined }>;
};

const READY: CheckDecisionStatus = {
  model: { host: "openrouter", modelId: "perplexity/pplx-decider-v1.2", name: "Decider v1.2" },
  hostName: { en: "OpenRouter", zh: "OpenRouter" },
  maker: "Perplexity",
  reads: null,
  blocked: null,
};

type Said = { host: "openrouter"; modelId: string } | "off" | null;

const updates: unknown[] = [];
const opened: unknown[][] = [];

/** The window's settings as the core would send them after `patch`. */
function settle(language: "en" | "zh-CN", said: Said, tips: Record<string, number>) {
  useAppStore.setState({
    settings: { language, device: { checkDecisionModel: said, tips } },
    updateSettings: async (patch: { device?: { tips?: Record<string, number> } }) => {
      updates.push(patch);
      settle(language, said, patch.device?.tips ?? tips);
    },
    openSettings: (...where: unknown[]) => {
      opened.push(where);
    },
  } as never);
}

async function line(status: CheckDecisionStatus | null | undefined) {
  const container: HTMLElement = document.createElement("div", {});
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(CheckFasterLine, { status })));
  const one = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const press = (testId: string) =>
    act(async () => one(testId)?.dispatchEvent(new window.Event("click", { bubbles: true })));
  return { one, press, text: () => container.textContent ?? "" };
}

beforeEach(() => {
  updates.length = 0;
  opened.length = 0;
});

describe.each([
  ["en", "Check faster with Decider v1.2", "Turn on in Settings ›"],
  ["zh-CN", "用 Decider v1.2 更快核对", "去设置开启 ›"],
] as const)("the check card's line about the decision model (%s)", (language, words, action) => {
  // protects=a User who holds the key and never said is told once, in the card, that a decision model can read first, and is sent to the switch whose line says what goes: the line itself turns nothing on (#3118); fails_when=the line is missing for that User, names the model by its id, or changes the setting itself.
  test("names the model and opens its switch in Settings, changing nothing itself", async () => {
    settle(language, null, {});
    const shown = await line(READY);
    expect(shown.text()).toContain(words);
    expect(shown.one("check-faster-settings")?.textContent).toBe(action);
    await shown.press("check-faster-settings");
    expect(opened).toEqual([["ai", "check-decision"]]);
    expect(updates).toEqual([]);
  });

  // protects=✕ ends the line for good on this device (#3118); fails_when=it comes back after ✕, on the same card or the next one opened.
  test("✕ ends it for good", async () => {
    settle(language, null, {});
    const shown = await line(READY);
    await shown.press("tip-close");
    expect(shown.one("check-faster")).toBeNull();
    expect(updates).toEqual([{ device: { tips: { "check-faster": 2 } } }]);
    expect((await line(READY)).one("check-faster")).toBeNull();
  });

  // protects=nobody is nagged who has said, can't turn it on, or already has it reading (#3118); fails_when=the line shows after the switch was turned off or on, without a key, in Local mode, where a model reads by default, or before the core has answered.
  test.each([
    ["turned the switch off", "off", READY],
    ["turned the switch on", { host: "openrouter", modelId: READY.model.modelId }, READY],
    ["has no key for its host", null, { ...READY, blocked: "no-key" }],
    ["keeps everything on this computer", null, { ...READY, blocked: "local-mode" }],
    ["already has a model reading by default", null, { ...READY, reads: "default" }],
    ["hasn't heard from the core yet", null, undefined],
    ["can't be told by the core", null, null],
  ] as const)("shows nothing to a User who %s", async (_who, said, status) => {
    settle(language, said, {});
    expect((await line(status)).one("check-faster")).toBeNull();
  });
});
