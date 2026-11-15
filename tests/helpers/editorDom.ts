import { DOMParser } from "linkedom";
import { vi } from "vitest";

/**
 * A page for a Tiptap editor in plain Node: linkedom's document, as the window's globals, with what
 * ProseMirror's view reads of a browser stubbed. Its MutationObserver sees nothing, so the editor
 * changes only by transactions. `vi.unstubAllGlobals()` takes it away.
 */
export function stubEditorDom(): void {
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  class TransactionOnlyMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const window = new Proxy(document.defaultView, {
    get: (target, name) =>
      name === "MutationObserver" ? TransactionOnlyMutationObserver : Reflect.get(target, name),
  });
  Object.assign(document, {
    getSelection: () => null,
    implementation: {
      createHTMLDocument: () =>
        new DOMParser().parseFromString("<html><head></head><body></body></html>", "text/html"),
    },
  });
  for (const [name, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
  })) {
    vi.stubGlobal(name, value);
  }
}
