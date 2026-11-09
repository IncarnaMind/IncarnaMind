import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Meeting, MeetingHelpKind, MeetingHelpTemplate } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { askBarKinds } from "../../src/renderer/src/meetingPanel/askBarKinds";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const state = vi.hoisted(() => ({ language: { current: "en" as Language } }));

vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) =>
    translate(state.language.current, key, params),
}));
vi.mock("../../src/renderer/src/meetingHelp", async () => {
  const { create } = await import("zustand");
  return { useMeetingHelp: create(() => ({ pending: {} as Record<string, MeetingHelpKind> })) };
});
vi.mock("../../src/renderer/src/motion", () => ({ exit: vi.fn() }));

type Keys = Partial<Record<MeetingHelpKind, string>>;
interface AskBarProps {
  meeting: Meeting;
  keys: Keys;
  onAsk(kind: MeetingHelpKind): void;
  onReach(reach: number): void;
}

describe("the ask bar's prompts, in order", () => {
  test("with no template, three prompts are in the bar and the other four under More…", () => {
    expect(askBarKinds(null)).toEqual({
      bar: ["say", "answer", "want"],
      more: ["sum", "no", "ask", "check"],
    });
  });

  test.each([
    ["interview", ["followUp", "leading", "notCovered", "sum", "no", "ask", "check"]],
    ["sales", ["objection", "nextStep", "facts", "sum", "no", "ask", "check"]],
    ["team", ["decisions", "disagree", "sum", "no", "ask", "check"]],
  ] as const)("the %s template's own prompts come first under More…", (template, more) => {
    expect(askBarKinds(template)).toEqual({ bar: ["say", "answer", "want"], more });
  });
});

let root: Root | null = null;
let container: HTMLElement;
let AskBar: ComponentType<AskBarProps>;
let usePending: {
  setState(next: { pending: Record<string, MeetingHelpKind> }): void;
};
const onAsk = vi.fn<(kind: MeetingHelpKind) => void>();
const onReach = vi.fn<(reach: number) => void>();

const meetingOf = (helpTemplate: MeetingHelpTemplate | null): Meeting =>
  ({ id: "meeting-1", helpTemplate }) as Meeting;

beforeEach(async () => {
  vi.clearAllMocks();
  state.language.current = "en";
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const barPath = "../../src/renderer/src/meetingPanel/AskBar.tsx";
  ({ AskBar } = await import(barPath));
  const helpPath = "../../src/renderer/src/meetingHelp";
  ({ useMeetingHelp: usePending } = await import(helpPath));
  usePending.setState({ pending: {} });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const KEYS: Keys = { say: "⌃⌥1", answer: "⌃⌥2", want: "⌃⌥3", sum: "⌃⌥4", no: "⌃⌥5" };

async function show(template: MeetingHelpTemplate | null = null, keys: Keys = KEYS) {
  await act(async () =>
    root?.render(createElement(AskBar, { meeting: meetingOf(template), keys, onAsk, onReach })),
  );
}

const all = (testId: string) => Array.from(container.querySelectorAll(`[data-testid="${testId}"]`));

function one(testId: string): Element {
  const [found] = all(testId);
  if (!found) throw new Error(`Missing: ${testId}`);
  return found;
}

/** Each prompt's name and its key, in reading order, inside `scope`. */
const promptsIn = (scope: Element) =>
  Array.from(scope.querySelectorAll('[data-testid="help-prompt"]')).map((each) => [
    each.getAttribute("data-kind"),
    each.querySelector('[data-testid="help-prompt-keys"]')?.textContent ?? null,
  ]);

const fire = (target: Element, type: string) =>
  act(async () => {
    target.dispatchEvent(new window.Event(type, { bubbles: true }));
  });

describe("the ask bar", () => {
  test("shows three prompts with their keys, then More…, and no list", async () => {
    await show();
    const bar = one("ask-bar");
    expect(promptsIn(bar)).toEqual([
      ["say", "⌃⌥1"],
      ["answer", "⌃⌥2"],
      ["want", "⌃⌥3"],
    ]);
    expect(bar.textContent).toBe(
      "What should I say?⌃⌥1Answer their question⌃⌥2What do they want?⌃⌥3More…",
    );
    expect(one("help-more").getAttribute("aria-expanded")).toBe("false");
    expect(all("help-more-list")).toHaveLength(0);
  });

  test('shows no key where none is held, and no "/" on More…', async () => {
    await show(null, {});
    expect(promptsIn(one("ask-bar"))).toEqual([
      ["say", null],
      ["answer", null],
      ["want", null],
    ]);
    expect(one("help-more").textContent).toBe("More…");
  });

  test("is in Chinese in a Chinese interface", async () => {
    state.language.current = "zh-CN";
    await show();
    expect(one("help-more").textContent).toBe("更多…");
  });

  test("More… opens the other four over the answers, with their keys", async () => {
    await show();
    await fire(one("help-more"), "click");
    const list = one("help-more-list");
    expect(one("help-more").getAttribute("aria-expanded")).toBe("true");
    expect(promptsIn(list)).toEqual([
      ["sum", "⌃⌥4"],
      ["no", "⌃⌥5"],
      ["ask", null],
      ["check", null],
    ]);
  });

  test("a meeting template's own prompts come first in the list", async () => {
    await show("interview");
    await fire(one("help-more"), "click");
    expect(promptsIn(one("help-more-list")).map(([kind]) => kind)).toEqual([
      "followUp",
      "leading",
      "notCovered",
      "sum",
      "no",
      "ask",
      "check",
    ]);
  });

  test("choosing a row asks that prompt and closes the list", async () => {
    await show();
    await fire(one("help-more"), "click");
    const sumUp = all("help-prompt").find((each) => each.getAttribute("data-kind") === "sum");
    if (!sumUp) throw new Error("The list has no Sum up so far.");
    await fire(sumUp, "click");
    expect(onAsk.mock.calls).toEqual([["sum"]]);
    expect(all("help-more-list")).toHaveLength(0);
    expect(one("help-more").getAttribute("aria-expanded")).toBe("false");
  });

  test("a prompt in the bar asks at once", async () => {
    await show();
    await fire(one("help-prompt"), "click");
    expect(onAsk.mock.calls).toEqual([["say"]]);
    expect(all("help-more-list")).toHaveLength(0);
  });

  test("a second click on More… closes the list", async () => {
    await show();
    await fire(one("help-more"), "click");
    await fire(one("help-more"), "click");
    expect(all("help-more-list")).toHaveLength(0);
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("a press outside the bar closes the list, a press inside it does not", async () => {
    await show();
    await fire(one("help-more"), "click");
    await fire(one("help-more-list"), "pointerdown");
    expect(all("help-more-list")).toHaveLength(1);
    await fire(document.body, "pointerdown");
    expect(all("help-more-list")).toHaveLength(0);
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("a prompt asked another way, by its shortcut, closes the list", async () => {
    await show();
    await fire(one("help-more"), "click");
    await act(async () => usePending.setState({ pending: { "meeting-1": "check" } }));
    expect(all("help-more-list")).toHaveLength(0);
  });

  test("tells the panel how far the list reaches only while it is open", async () => {
    await show();
    expect(onReach).toHaveBeenLastCalledWith(0);
    await fire(one("help-more"), "click");
    expect(onReach).toHaveBeenCalledTimes(2);
    expect(onReach).not.toHaveBeenLastCalledWith(0);
    await fire(one("help-more"), "click");
    expect(onReach).toHaveBeenLastCalledWith(0);
  });
});
