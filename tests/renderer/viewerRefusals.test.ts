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
    this.status = servedStatus;
    if (servedStatus === 200) {
      const bytes = served;
      this.response = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    }
    queueMicrotask(() => this.onload?.());
  }
  abort() {}
}

/** A BMP a canvas draws, whatever the file is named. */
function bmpClaiming(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set([0x42, 0x4d], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 8, true);
  return bytes;
}

/** A HEIC with no ispe box: its size can only be known after it is decoded. */
function heifWithoutIspe(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x68, 0x65, 0x69, 0x63], 8);
  return bytes;
}

let served: Uint8Array = new Uint8Array();
let servedStatus = 200;
let decoded: Uint8Array | null = null;
let root: Root | null = null;
let container: HTMLElement;
const recheckCitation = vi.fn();
const logError = vi.fn();

beforeEach(async () => {
  recheckCitation.mockReset();
  logError.mockReset();
  servedStatus = 200;
  const dom = new DOMParser().parseFromString(
    "<!doctype html><html><body></body></html>",
    "text/html",
  );
  const window = dom.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined, readScannedText: async () => ({ pages: [] }), recheckCitation },
    {
      get: (each, name) => {
        if (name === "on" || name === "readScannedText" || name === "recheckCitation") {
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
    incarnamindFiles: { decodePicture: async () => decoded, logError },
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
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
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

async function show(
  component: "image" | "text",
  document: Document,
  bytes: Uint8Array,
  language: "en" | "zh-CN" = "en",
  status = 200,
) {
  served = bytes;
  servedStatus = status;
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language } as never });
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
  test("a changed Transcript's header forwards the stored cue Location to recheck", async () => {
    const location = { kind: "time", from: 7000, to: 10_000, speaker: "Dana" } as const;
    const document = documentOf({ id: "review", kind: "transcript", contentHash: "v2", tags: [] });
    const quote = "We agreed to review the plan.";
    recheckCitation.mockResolvedValue({
      check: "found",
      checkReason: null,
      contentHash: "v2",
      passageId: "p1",
      pageFrom: 1,
      pageTo: 1,
      location,
    });
    const { useAppStore } = await import("../../src/renderer/src/store");
    useAppStore.setState({ status: { kind: "ready" }, documents: [document] });
    const headerPath = "../../src/renderer/src/viewer/ViewerHeader.tsx";
    const { ViewerHeader, ViewerFrameContext } = await import(headerPath);
    const citedTarget: ViewerTarget = {
      documentId: document.id,
      request: 1,
      quote,
      citation: { check: "found", contentHash: "v1", pageFrom: 1, pageTo: 1, location },
    };
    await act(() =>
      root?.render(
        createElement(
          ViewerFrameContext.Provider,
          {
            value: {
              document,
              target: citedTarget,
              tabId: "review",
              preview: false,
              keep: () => undefined,
            },
          },
          createElement(ViewerHeader),
        ),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(recheckCitation).toHaveBeenCalledWith({
      documentId: document.id,
      contentHash: "v1",
      pageFrom: 1,
      pageTo: 1,
      quote,
      mindId: null,
      location,
    });
  });

  test("an oversized picture is refused, never drawn, and the line is not wrapped twice", async () => {
    await show(
      "image",
      documentOf({ kind: "image", name: "Bomb.png", path: "/tmp/Bomb.png" }),
      pngClaiming(30_000, 30_000),
    );
    expect(container.textContent).toContain("This picture is too large to open.");
    expect(container.textContent).not.toContain("This Document couldn’t be shown");
    expect(container.querySelector("img")).toBeNull();
  });

  test("the refusal reads in Chinese too", async () => {
    await show(
      "image",
      documentOf({ kind: "image", name: "Bomb.png", path: "/tmp/Bomb.png" }),
      pngClaiming(30_000, 30_000),
      "zh-CN",
    );
    expect(container.textContent).toContain("这张图片太大，无法打开。");
    expect(container.textContent).not.toContain("This Document couldn’t be shown");
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

  test("a file that isn't a picture it reads says it can't be shown, never drawn", async () => {
    await show(
      "image",
      documentOf({ kind: "image", name: "Bomb.png", path: "/tmp/Bomb.png" }),
      bmpClaiming(8_192, 8_192),
    );
    expect(container.textContent).toContain("This picture can’t be shown here.");
    expect(container.querySelector("img")).toBeNull();
  });

  test("a HEIC bomb is caught on the PNG decoded from it, before it is drawn", async () => {
    decoded = pngClaiming(30_000, 30_000);
    try {
      await show(
        "image",
        documentOf({ kind: "image", name: "Phone.heic", path: "/tmp/Phone.heic" }),
        heifWithoutIspe(),
      );
      expect(container.textContent).toContain("This picture is too large to open.");
      expect(container.querySelector("img")).toBeNull();
    } finally {
      decoded = null;
    }
  });

  test("a text file the reader refuses says why in English, not the reader's sentence", async () => {
    await show(
      "text",
      documentOf({ kind: "rtf", name: "Broken.rtf", path: "/tmp/Broken.rtf" }),
      new TextEncoder().encode("This is not an RTF file."),
    );
    expect(container.textContent).toContain("This file can’t be read as text.");
    expect(container.textContent).not.toContain("This isn't an RTF file.");
    expect(container.textContent).not.toContain("Opening the Document…");
  });

  test("a text file the reader refuses says why in Chinese", async () => {
    await show(
      "text",
      documentOf({ kind: "rtf", name: "Broken.rtf", path: "/tmp/Broken.rtf" }),
      new TextEncoder().encode("This is not an RTF file."),
      "zh-CN",
    );
    expect(container.textContent).toContain("无法将此文件作为文本读取。");
    expect(container.textContent).not.toContain("This isn't an RTF file.");
  });

  test("a text file over the size cap says it is too large, in English and Chinese", async () => {
    const huge = new Uint8Array(64 * 1024 * 1024 + 1);
    await show(
      "text",
      documentOf({ kind: "html", name: "Huge.html", path: "/tmp/Huge.html" }),
      huge,
    );
    expect(container.textContent).toContain("This file is too large to open here.");
    await show(
      "text",
      documentOf({ kind: "html", name: "Huge.html", path: "/tmp/Huge.html" }),
      huge,
      "zh-CN",
    );
    expect(container.textContent).toContain("这个文件太大，无法在此打开。");
  });

  const click = async (id: string) => {
    await act(async () => {
      container
        .querySelector(`[data-testid="${id}"]`)
        ?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  test("a picture whose file can't be read says so, logs it, and Retry reads it again", async () => {
    await show(
      "image",
      documentOf({ kind: "image", name: "Map.png", path: "/tmp/Map.png" }),
      pngClaiming(640, 360),
      "en",
      500,
    );
    expect(container.textContent).toContain("This picture couldn’t be opened.");
    expect(container.textContent).not.toContain("This picture can’t be shown here.");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("status 500") }),
    );
    expect(container.querySelector('[data-testid="viewer-retry"]')?.textContent).toBe("Retry");

    servedStatus = 200;
    await click("viewer-retry");
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.textContent).not.toContain("This picture couldn’t be opened.");
  });

  test("a picture whose file can't be read says so in Chinese too", async () => {
    await show(
      "image",
      documentOf({ kind: "image", name: "Map.png", path: "/tmp/Map.png" }),
      pngClaiming(640, 360),
      "zh-CN",
      500,
    );
    expect(container.textContent).toContain("无法打开这张图片。");
    expect(container.querySelector('[data-testid="viewer-retry"]')?.textContent).toBe("重试");
  });

  test("a text file that can't be read says so, logs it, and Retry reads it again", async () => {
    await show(
      "text",
      documentOf({ kind: "text", name: "Notes.txt", path: "/tmp/Notes.txt" }),
      new TextEncoder().encode("The harbour rules."),
      "en",
      500,
    );
    expect(container.textContent).toContain("This file couldn’t be opened.");
    expect(container.textContent).not.toContain("This file can’t be read as text.");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("status 500") }),
    );
    expect(container.querySelector('[data-testid="viewer-retry"]')?.textContent).toBe("Retry");

    servedStatus = 200;
    await click("viewer-retry");
    expect(container.textContent).toContain("The harbour rules.");
  });

  test("a text file that can't be read says so in Chinese too", async () => {
    await show(
      "text",
      documentOf({ kind: "text", name: "Notes.txt", path: "/tmp/Notes.txt" }),
      new TextEncoder().encode("The harbour rules."),
      "zh-CN",
      500,
    );
    expect(container.textContent).toContain("无法打开此文件。");
    expect(container.querySelector('[data-testid="viewer-retry"]')?.textContent).toBe("重试");
  });
});
