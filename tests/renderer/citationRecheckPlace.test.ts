/**
 * A Citation's card in an Answer asks its conversation's wall when it is checked again (#2782):
 * the recheck names the conversation, so the core can refuse a Document that conversation may not
 * read. The Answer's text hands the card its conversation (`ConversationIdContext`).
 */
import { DOMParser } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const calls: Record<string, unknown>[] = [];

const bridge = () =>
  new Proxy(
    {
      recheckCitation: async (input: Record<string, unknown>) => {
        calls.push(input);
        return null;
      },
    },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
    },
  );

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
  calls.length = 0;
  vi.unstubAllGlobals();
});

test("a Citation in an Answer is rechecked with the conversation it is shown in", async () => {
  const parsed = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  Object.defineProperty(parsed, "styleSheets", { value: [] });
  const window = parsed.defaultView;
  Object.assign(window, { incarnamind: bridge(), incarnamindFiles: bridge() });
  const globals: Record<string, unknown> = {
    document: parsed,
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
  const container = parsed.createElement("div", {});
  parsed.body.append(container);
  const root = createRoot(container);
  const { useCitationRecheck } = await import("../../src/renderer/src/citationVersion");

  function Probe() {
    useCitationRecheck(
      {
        documentId: "document",
        contentHash: "version 1",
        pageFrom: 1,
        pageTo: 1,
        quote: "The term is 60 days from the start.",
      },
      true,
      "version 2",
      null,
      "the conversation",
    );
    return null;
  }
  await act(() => root.render(createElement(Probe)));
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({
    documentId: "document",
    mindId: null,
    conversationId: "the conversation",
  });
  cleanups.push(async () => {
    await act(() => root.unmount());
    container.remove();
  });
});
