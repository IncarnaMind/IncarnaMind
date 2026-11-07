/**
 * The export card's changed list (#2514): when files changed since the User looked, the card says
 * so, marks what is new, and holds Allow for a moment so a double-click can't approve unseen files.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
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

test("a changed list says so, marks what is new, and holds Allow for a moment", async () => {
  vi.useFakeTimers();
  const card = await render(request(true, 3));
  expect(card.querySelector(".approval-title")?.textContent).toContain(
    "The files changed since you looked. Allow these instead?",
  );
  const files = card.querySelectorAll('[data-testid="approval-file"]');
  expect(files).toHaveLength(3);
  expect(files[2]?.textContent).toContain("New");
  expect(card.querySelectorAll('[data-testid="approval-file-new"]')).toHaveLength(1);
  expect(card.querySelector(".approval-explanation")?.textContent).toBe(
    "This writes 3 new files outside your Output location.",
  );
  const allow = card.querySelector('[data-testid="approval-allow-once"]') as HTMLButtonElement;
  expect(allow.disabled).toBe(true);
  await act(() => vi.advanceTimersByTime(1_000));
  expect(allow.disabled).toBe(false);
});

test("a list that did not change keeps today's title, and Allow works at once", async () => {
  const card = await render(request(false, 3));
  expect(card.querySelector(".approval-title")?.textContent).toContain(
    "Save “Tides” as Markdown (.md) in “Exports”?",
  );
  expect(card.querySelectorAll('[data-testid="approval-file-new"]')).toHaveLength(0);
  const allow = card.querySelector('[data-testid="approval-allow-once"]') as HTMLButtonElement;
  expect(allow.disabled).toBe(false);
});

test("a long list lists every name, in its own scrolling list, and the count follows it", async () => {
  const card = await render(request(false, 25));
  expect(card.querySelectorAll('[data-testid="approval-file"]')).toHaveLength(25);
  expect(card.querySelector(".approval-explanation")?.textContent).toBe(
    "This writes 25 new files outside your Output location.",
  );
  expect(card.querySelector('[data-testid="approval-files"]')).not.toBeNull();
});
