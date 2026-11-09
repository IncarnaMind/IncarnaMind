import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document, DocumentStatus, Settings } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";

/*
 * A Document's status at the end of its sidebar row (#2870): only one that isn't ready says
 * so, to the eye and to a screen reader alike; one being read or one that failed still does.
 */

let root: Root | null = null;
let container: HTMLElement;
let DocumentStatusLabel: ComponentType<{ item: Document }>;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each
          ? (each as Record<string, unknown>)[name as string]
          : () => Promise.resolve([]),
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
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const sectionPath = "../../src/renderer/src/components/DocumentsSection.tsx";
  const section: { DocumentStatusLabel: ComponentType<{ item: Document }> } = await import(
    sectionPath
  );
  DocumentStatusLabel = section.DocumentStatusLabel;
  ({ useAppStore } = await import("../../src/renderer/src/store"));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function show(language: "en" | "zh-CN", item: Partial<Document>) {
  useAppStore.setState({
    settings: { language, device: {} } as unknown as Settings,
  } as never);
  const document = {
    kind: "pdf",
    fileStatus: "ok",
    progress: 0,
    failure: null,
    scan: null,
    ...item,
  } as unknown as Document;
  await act(() => root?.render(createElement(DocumentStatusLabel, { item: document })));
}

describe.each(["en", "zh-CN"] as const)("a Document's status label (%s)", (language) => {
  test("a ready Document says nothing, not even to a screen reader", async () => {
    await show(language, { status: "ready" });
    expect(container.querySelector('[data-testid="document-status"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  test.each([
    ["queued", "documents.statusShort.queued"],
    ["extracting", "documents.statusShort.extracting"],
    ["waiting-for-model", "documents.statusShort.waiting"],
    ["no-text", "documents.statusShort.noText"],
    ["failed", "documents.statusShort.failed"],
  ] as const)("a Document that is %s still says so", async (status: DocumentStatus, key) => {
    await show(language, {
      status,
      ...(status === "failed" && { failure: { reason: "unreadable", message: "" } }),
    });
    const label = container.querySelector('[data-testid="document-status"]');
    expect(label?.textContent).toContain(translate(language, key));
  });

  test("a Document being embedded shows how far it is", async () => {
    await show(language, { status: "embedding", progress: 0.38 });
    const label = container.querySelector('[data-testid="document-status"]');
    expect(label?.textContent).toContain("38%");
  });

  test("a Document whose file is missing says so, whatever its status", async () => {
    await show(language, { status: "ready", fileStatus: "missing" });
    const label = container.querySelector('[data-testid="document-status"]');
    expect(label?.textContent).toContain(translate(language, "documents.fileShort.missing"));
  });
});
