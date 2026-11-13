import { DOMParser } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

/** What the main process answers to a Document's file: its status and bytes. */
export interface ServedFile {
  status: number;
  bytes: Uint8Array;
}

/**
 * A small DOM for a viewer to render into, with the bridge's calls answered by nothing unless
 * `answers` has one, and its Document's file served by `served` through the XMLHttpRequest the
 * viewer reads it with. `unmount` takes the globals it stubbed away again.
 */
export function mountViewerDom(
  served: () => ServedFile,
  answers: Record<string, unknown> = {},
): {
  root: Root;
  container: HTMLElement;
  unmount(): Promise<void>;
} {
  class FileRequest {
    status = 200;
    responseType = "";
    response: ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    send() {
      const { status, bytes } = served();
      this.status = status;
      if (status === 200) {
        this.response = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      }
      queueMicrotask(() => this.onload?.());
    }
    abort() {}
  }
  const dom = new DOMParser().parseFromString(
    "<!doctype html><html><body></body></html>",
    "text/html",
  );
  const window = dom.defaultView;
  const bridge = new Proxy<Record<string, unknown>>(
    { on: () => () => undefined, ...answers },
    {
      get: (each, name: string) => {
        if (name in each) return each[name];
        if (name === "listApprovalRequests" || name === "listUserQuestions") {
          return () => Promise.resolve([]);
        }
        return () => Promise.resolve(undefined);
      },
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document: dom,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    navigator: { platform: "Linux", languages: ["en"] },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    XMLHttpRequest: FileRequest,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  const container = dom.createElement("div", {}) as HTMLElement;
  dom.body.append(container);
  const root = createRoot(container);
  return {
    root,
    container,
    async unmount() {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}
