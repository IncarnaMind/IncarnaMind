/**
 * Cite…'s panel (#281): a search that couldn't run says so and never that nothing matched, the
 * rows show the sentence that will be quoted with its words bold, and a number written at another
 * scale isn't shown as a match.
 */
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { CITATION_NODE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

let cleanup: (() => Promise<void>) | null = null;
let failing = false;

beforeEach(() => {
  failing = false;
});

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The panel over a Note, whose search fails while `failing` is set. */
async function panel(language: "en" | "zh-CN", { slash = false } = {}) {
  // The search's pause is the test's to run: nothing waits on the wall clock.
  vi.useFakeTimers();
  const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  const bridge = new Proxy(
    {
      on: () => () => undefined,
      findPassages: () =>
        failing
          ? Promise.reject(new Error("The search could not run."))
          : Promise.resolve([
              {
                passageId: "p1",
                documentId: "d1",
                documentName: "Tides",
                documentKind: "markdown",
                pageFrom: null,
                pageTo: null,
                location: null,
                text: "Spring tides flood the marsh.",
                quote: "Spring tides flood the marsh.",
                notCited: false,
                relevance: null,
                matches: ["spring", "tides"],
              },
            ]),
      wallOfTurn: () => Promise.resolve(null),
      countScopeDocuments: () => Promise.resolve(1),
      citePassage: () =>
        Promise.resolve({
          passageId: "p1",
          documentId: "d1",
          documentName: "Tides",
          contentHash: "hash",
          pageFrom: null,
          pageTo: null,
          location: null,
          quote: "Spring tides flood the marsh.",
          check: "found",
          checkReason: null,
        }),
    },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, {
    incarnamind: bridge,
    incarnamindFiles: bridge,
    // Reduce motion: the panel shows where it goes at once, and reports nothing.
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    reportError: () => undefined,
  });
  class Rect {
    constructor(
      readonly x = 0,
      readonly y = 0,
      readonly width = 0,
      readonly height = 0,
    ) {}
    get left() {
      return this.x;
    }
    get top() {
      return this.y;
    }
    get right() {
      return this.x + this.width;
    }
    get bottom() {
      return this.y + this.height;
    }
  }
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    DOMRect: Rect,
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
  // The native popover the panel opens in, and a field's selection, which linkedom doesn't have.
  const prototype = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  prototype.showPopover = () => undefined;
  prototype.hidePopover = () => undefined;
  const input = window.HTMLInputElement.prototype as unknown as Record<string, unknown>;
  input.select = () => undefined;
  const element = window.Element.prototype as unknown as { matches(selector: string): boolean };
  const matches = element.matches;
  element.matches = function (this: Element, selector: string) {
    return selector === ":popover-open" ? false : matches.call(this, selector);
  };

  const container = document.createElement("div", {});
  document.body.append(container);
  const root = createRoot(container);
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useConversations } = await import("../../src/renderer/src/conversations");
  useConversations.setState({ list: [] } as never);
  useAppStore.setState({
    settings: { language },
    minds: [{ id: "mind", folderId: null }],
    folders: [],
    tags: [],
    documents: [],
    library: { groups: [], assignments: [] },
  } as never);

  const text = slash ? "Spring tides flood. /" : "Spring tides flood.";
  const editor = new Editor({
    element: document.createElement("div", {}),
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
  // Where the caret is on screen: linkedom lays nothing out.
  editor.view.coordsAtPos = () => new Rect(0, 0, 0, 0) as never;
  const doc = new Y.Doc();
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const panelPath = "../../src/renderer/src/editor/CiteSearch.tsx";
  const { CiteSearch }: { CiteSearch: ComponentType<Record<string, unknown>> } = await import(
    panelPath
  );
  cleanup = async () => {
    await act(() => root.unmount());
    editor.destroy();
    container.remove();
  };
  // A paragraph's text starts at 1: the "/" and its query are the range the Citation replaces.
  const at = slash ? 1 + text.indexOf("/") : editor.state.selection.from;
  await act(async () => {
    root.render(
      createElement(CiteSearch, {
        place: { editor, from: at, to: slash ? at + 1 : at },
        mindId: "mind",
        doc,
        onDone: () => undefined,
      }),
    );
  });
  await act(() => vi.advanceTimersByTimeAsync(300));
  return { container, editor };
}

describe("Cite…'s panel when its search fails", () => {
  test("says the search failed, and never that nothing matched", async () => {
    failing = true;
    const { container } = await panel("en");
    expect(container.querySelector('[data-testid="cite-failed"]')?.textContent).toBe(
      "Searching your Documents failed",
    );
    expect(container.querySelector('[data-testid="cite-nothing"]')).toBeNull();
  });

  test("still lists the Passages when the search runs, in Chinese too", async () => {
    const { container } = await panel("zh-CN");
    const rows = container.querySelectorAll('[data-testid="cite-result"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Tides");
    const line = rows[0]?.querySelector('[data-testid="cite-result-text"]');
    expect(line?.querySelector("b")?.textContent).toBe("Spring");
    expect(container.querySelector('[data-testid="cite-failed"]')).toBeNull();
    expect(container.querySelector('[data-testid="cite-nothing"]')).toBeNull();
  });

  test("shows the sentence it would quote, and not a number written at another scale", async () => {
    const panelPath = "../../src/renderer/src/editor/CiteSearch.tsx";
    const { matchesToShow }: { matchesToShow: (q: string, m: string[], s: string) => string[] } =
      await import(panelPath);
    expect(
      matchesToShow(
        "Revenue reached $12.3 thousand in 2024.",
        ["revenue", "12.3"],
        "Revenue reached $12.3 million in 2024.",
      ),
    ).toEqual(["revenue"]);
    expect(
      matchesToShow(
        "Revenue reached $12.3 million in 2024.",
        ["revenue", "12.3"],
        "Revenue reached $12.3 million in 2024.",
      ),
    ).toEqual(["revenue", "12.3"]);
  });
});

describe("Cite…'s place in a Note that changes while it is open", () => {
  const citations = (editor: Editor) => {
    let count = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === CITATION_NODE) count++;
    });
    return count;
  };
  const written = (editor: Editor) =>
    editor.state.doc.firstChild?.textBetween(0, editor.state.doc.firstChild.content.size) ?? "";

  test("a Citation goes where the “/” moved to, not where it was", async () => {
    const { container, editor } = await panel("en", { slash: true });
    // Another change above the caret: the same as an Answer or another window writing there.
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText("Note: ", 1));
    });

    await act(async () => {
      (container.querySelector('[data-testid="cite-result"]') as HTMLElement | null)?.click();
    });
    await act(() => vi.advanceTimersByTimeAsync(10));

    expect(written(editor)).toBe("Note: Spring tides flood. ");
    expect(citations(editor)).toBe(1);
  });

  test("once the “/” is gone it says so, and puts no Citation in", async () => {
    const { container, editor } = await panel("en", { slash: true });
    const from = 1 + "Spring tides flood. ".length;
    await act(async () => {
      editor.view.dispatch(editor.state.tr.delete(from, from + 1));
    });

    await act(async () => {
      (container.querySelector('[data-testid="cite-result"]') as HTMLElement | null)?.click();
    });
    await act(() => vi.advanceTimersByTimeAsync(10));

    expect(container.querySelector('[data-testid="cite-problem"]')?.textContent).toBe(
      "That passage is gone. Search again.",
    );
    expect(citations(editor)).toBe(0);
  });
});
