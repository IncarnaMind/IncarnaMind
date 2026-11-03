/**
 * A search that couldn't run says so, and never that nothing matched (#281): Cite…'s panel shows
 * the failure where the Passages would be, beside the error's notice.
 */
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

let cleanup: (() => Promise<void>) | null = null;
let failing = false;

beforeEach(() => {
  failing = false;
});

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

/** The panel over a Note, whose search fails while `failing` is set. */
async function panel(language: "en" | "zh-CN") {
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
                notCited: false,
                relevance: null,
                matches: ["spring", "tides"],
              },
            ]),
      wallOfTurn: () => Promise.resolve(null),
      countScopeDocuments: () => Promise.resolve(1),
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

  const editor = new Editor({
    element: document.createElement("div", {}),
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Spring tides flood." }] }],
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
  await act(async () => {
    root.render(
      createElement(CiteSearch, {
        place: { editor, from: 1, to: 2 },
        mindId: "mind",
        doc,
        onDone: () => undefined,
      }),
    );
  });
  // The panel lets typing settle before it searches.
  await act(() => new Promise((done) => setTimeout(done, 400)));
  return container;
}

describe("Cite…'s panel when its search fails", () => {
  test("says the search failed, and never that nothing matched", async () => {
    failing = true;
    const container = await panel("en");
    expect(container.querySelector('[data-testid="cite-failed"]')?.textContent).toBe(
      "Searching your Documents failed",
    );
    expect(container.querySelector('[data-testid="cite-nothing"]')).toBeNull();
  });

  test("still lists the Passages when the search runs, in Chinese too", async () => {
    const container = await panel("zh-CN");
    const rows = container.querySelectorAll('[data-testid="cite-result"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Tides");
    const line = rows[0]?.querySelector('[data-testid="cite-result-text"]');
    expect(line?.querySelector("b")?.textContent).toBe("Spring");
    expect(container.querySelector('[data-testid="cite-failed"]')).toBeNull();
    expect(container.querySelector('[data-testid="cite-nothing"]')).toBeNull();
  });
});
