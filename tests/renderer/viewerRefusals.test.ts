/**
 * What a viewer refuses, and how it says so (#762): a picture the reader won't
 * take is never drawn, and a text file the reader refuses says its reason
 * instead of staying on "Opening the Document…". The components run against a
 * small DOM with the file bridge's bytes under their own control.
 */
import { DOMParser } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document } from "../../src/core/api";
import type { ViewerTarget } from "../../src/renderer/src/store";

/** A PNG whose header claims 30,000 × 30,000 pixels. */
function pngClaiming(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

class BytesRequest {
  status = 200;
  responseType = "";
  response: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  send() {
    const bytes = served;
    this.response = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    queueMicrotask(() => this.onload?.());
  }
  abort() {}
}

let served: Uint8Array = new Uint8Array();
let root: Root | null = null;
let container: HTMLElement;

beforeEach(async () => {
  const dom = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  const window = dom.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined, readScannedText: async () => ({ pages: [] }) },
    {
      get: (each, name) => {
        if (name === "on" || name === "readScannedText") {
          return (each as Record<string, unknown>)[name as string];
        }
        // The two lists the approvals and questions stores ask for as they load.
        if (name === "listApprovalRequests" || name === "listUserQuestions") {
          return () => Promise.resolve([]);
        }
        return () => Promise.resolve(undefined);
      },
    },
  );
  Object.assign(window, {
    incarnamind: bridge,
    incarnamindFiles: { decodePicture: async () => null },
  });
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
    XMLHttpRequest: BytesRequest,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  class TestURL extends URL {
    static override createObjectURL() {
      return "blob:test";
    }
    static override revokeObjectURL() {}
  }
  vi.stubGlobal("URL", TestURL);
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language: "en" } as never });
  container = dom.createElement("div", {}) as HTMLElement;
  dom.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const documentOf = (overrides: Partial<Document>): Document =>
  ({
    id: "doc-1",
    name: "File",
    title: "File",
    path: "/tmp/File",
    kind: "image",
    status: "ready",
    contentHash: "hash-1",
    failure: null,
    ...overrides,
  }) as unknown as Document;

const target = { request: 1 } as ViewerTarget;

async function show(component: "image" | "text", document: Document, bytes: Uint8Array) {
  served = bytes;
  // A variable path, so the test's tsconfig (no jsx) leaves the component to the runtime.
  const viewPath =
    component === "image"
      ? "../../src/renderer/src/viewer/ImageView.tsx"
      : "../../src/renderer/src/viewer/TextView.tsx";
  const module = await import(viewPath);
  const view = module.ImageView ?? module.TextView;
  await act(() => root?.render(createElement(view, { document, target })));
  await act(async () => {
    await Promise.resolve();
  });
}

describe("A viewer refuses what its reader refuses (#762)", () => {
  test("an oversized picture is refused, never drawn", async () => {
    await show(
      "image",
      documentOf({ kind: "image", name: "Bomb.png", path: "/tmp/Bomb.png" }),
      pngClaiming(30_000, 30_000),
    );
    expect(container.textContent).toContain("This picture is too large to open.");
    expect(container.querySelector("img")).toBeNull();
  });

  test("a picture whose size can't be read says that, not that it is too large", async () => {
    await show(
      "image",
      documentOf({ kind: "image", name: "Cut.png", path: "/tmp/Cut.png" }),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(container.textContent).toContain("This picture’s size can’t be read.");
    expect(container.textContent).not.toContain("too large");
    expect(container.querySelector("img")).toBeNull();
  });

  test("a text file the reader refuses says why instead of staying on opening", async () => {
    await show(
      "text",
      documentOf({ kind: "rtf", name: "Broken.rtf", path: "/tmp/Broken.rtf" }),
      new TextEncoder().encode("This is not an RTF file."),
    );
    expect(container.textContent).toContain("This isn't an RTF file.");
    expect(container.textContent).not.toContain("Opening the Document…");
  });
});
