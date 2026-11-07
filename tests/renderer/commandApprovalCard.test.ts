/**
 * The export card's changed list (#2514): when files changed since the User looked, the card says
 * so, marks what is new, and holds Allow for a moment so a double-click can't approve unseen files.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandApprovalRequest } from "../../src/core/api";

const request = (previous: boolean, count: number): CommandApprovalRequest => {
  const pictures = Array.from({ length: count - 1 }, (_, index) => `picture-${index + 1}.png`);
  return {
    requestId: previous ? "changed" : "first",
    answerId: "answer",
    toolCallId: "call",
    tool: "run_command",
    subject: { kind: "command", command: "mind.export" },
    ask: {
      kind: "export",
      mind: { id: "mind", name: "Tides" },
      format: "markdown",
      folder: "/tmp/Exports",
      fileName: "Tides.md",
      pictures,
      ...(previous && {
        previous: { fileName: "Tides.md", pictures: pictures.slice(0, -1) },
      }),
    },
    effects: [],
    tainted: false,
  } as unknown as CommandApprovalRequest;
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

beforeAll(async () => {
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    {
      on: () => () => undefined,
      listApprovalRequests: async () => [],
      getSettings: async () => ({ device: {} }),
    },
    {
      get: (target, name) =>
        name in target
          ? (target as Record<string, unknown>)[name as string]
          : () => Promise.resolve(undefined),
    },
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
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language: "en" } } as never);
});

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

async function render(approval: CommandApprovalRequest) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const path = "../../src/renderer/src/editor/CommandApprovalCard.tsx";
  const { CommandApprovalCard }: { CommandApprovalCard: ComponentType<Record<string, unknown>> } =
    await import(path);
  await act(() => root?.render(createElement(CommandApprovalCard, { request: approval })));
  return container;
}

/** Each row's name, without the New mark beside it. */
const namesOn = (card: HTMLElement) =>
  Array.from(
    card.querySelectorAll('[data-testid="approval-file"]'),
    (row) => row.firstChild?.textContent,
  );

/** The names marked New. */
const markedNew = (card: HTMLElement) =>
  Array.from(
    card.querySelectorAll('[data-testid="approval-file-new"]'),
    (mark) => mark.parentElement?.firstChild?.textContent,
  );

const WORDS = {
  en: {
    changed: "The files changed since you looked. Allow these instead?",
    first: "Save “Tides” as Markdown (.md) in “Exports”?",
    three: "This writes 3 new files outside your Output location.",
    many: "This writes 25 new files outside your Output location.",
    new: "New",
  },
  "zh-CN": {
    changed: "文件已有变化。改为允许这些吗？",
    first: "将“Tides”以 Markdown（.md） 格式保存到“Exports”？",
    three: "这会在保存位置之外写入 3 个新文件。",
    many: "这会在保存位置之外写入 25 个新文件。",
    new: "新增",
  },
} as const;

async function inLanguage(language: keyof typeof WORDS) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language } } as never);
}

describe.each(["en", "zh-CN"] as const)("in %s", (language) => {
  const words = WORDS[language];
  beforeEach(() => inLanguage(language));

  test("a changed list says so, names every file, marks what is new, and holds Allow a full second", async () => {
    vi.useFakeTimers();
    const card = await render(request(true, 3));
    expect(card.querySelector(".approval-title")?.textContent).toContain(words.changed);
    expect(namesOn(card)).toEqual(["Tides.md", "picture-1.png", "picture-2.png"]);
    expect(markedNew(card)).toEqual(["picture-2.png"]);
    expect(card.querySelector('[data-testid="approval-file-new"]')?.textContent).toBe(words.new);
    expect(card.querySelector(".approval-explanation")?.textContent).toBe(words.three);
    const allow = card.querySelector('[data-testid="approval-allow-once"]') as HTMLButtonElement;
    const deny = card.querySelector('[data-testid="approval-deny"]') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(false);
    await act(() => vi.advanceTimersByTime(999));
    expect(allow.disabled).toBe(true);
    await act(() => vi.advanceTimersByTime(1));
    expect(allow.disabled).toBe(false);
  });

  test("a list that did not change keeps today's title, names every file, and Allow works at once", async () => {
    const card = await render(request(false, 3));
    expect(card.querySelector(".approval-title")?.textContent).toContain(words.first);
    expect(namesOn(card)).toEqual(["Tides.md", "picture-1.png", "picture-2.png"]);
    expect(markedNew(card)).toEqual([]);
    expect(card.querySelector(".approval-explanation")?.textContent).toBe(words.three);
    const allow = card.querySelector('[data-testid="approval-allow-once"]') as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
  });

  test("a long list names every file in its own scrolling list, and the count follows it", async () => {
    const card = await render(request(false, 25));
    expect(namesOn(card)).toEqual([
      "Tides.md",
      ...Array.from({ length: 24 }, (_, index) => `picture-${index + 1}.png`),
    ]);
    expect(card.querySelector(".approval-explanation")?.textContent).toBe(words.many);
    expect(card.querySelector('[data-testid="approval-files"]')?.className).toContain(
      "overflow-y-auto",
    );
  });
});
