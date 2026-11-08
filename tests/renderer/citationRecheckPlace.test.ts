/**
 * A Citation's card in an Answer asks its conversation's wall when it is checked again (#2782):
 * the Answer's text hands the card its conversation (`ConversationIdContext`), and the card names
 * it to the core, so the core can refuse a Document that conversation may not read. The card at
 * its count of a document whose version moved on is the one the User would see.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
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
      on: () => () => undefined,
    },
    {
      get: (each, name) =>
        name in each
          ? each[name as keyof typeof each]
          : () => Promise.resolve(String(name).startsWith("list") ? [] : undefined),
    },
  );

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
  calls.length = 0;
  vi.unstubAllGlobals();
});

test("a Citation's card in an Answer asks the core with the Answer's conversation", async () => {
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
    CSS: { escape: (text: string) => text },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  const container = parsed.createElement("div", {});
  parsed.body.append(container);
  const root = createRoot(container);
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    status: { kind: "ready" },
    documents: [{ id: "document", name: "Lease", contentHash: "version 2" }],
    library: null,
    minds: [],
    keptCitationTexts: [],
  } as never);
  const { ConversationIdContext } = await import("../../src/renderer/src/editor/mindContext");
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const viewPath = "../../src/renderer/src/editor/CitationView";
  const { CitationView }: { CitationView: ComponentType<Record<string, unknown>> } = await import(
    viewPath
  );

  await act(() =>
    root.render(
      createElement(
        ConversationIdContext.Provider,
        { value: "the conversation" },
        createElement(CitationView, {
          node: {
            attrs: {
              passageId: null,
              documentId: "document",
              documentName: "Lease",
              contentHash: "version 1",
              pageFrom: 1,
              pageTo: 1,
              location: { kind: "page", from: 1, to: 1 },
              quote: "The term is 60 days from the start.",
              check: "found",
              checkReason: null,
            },
          },
          editor: { isEditable: false },
          getPos: () => 0,
          deleteNode: () => undefined,
          updateAttributes: () => undefined,
          decorations: [],
        } as never),
      ),
    ),
  );

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
