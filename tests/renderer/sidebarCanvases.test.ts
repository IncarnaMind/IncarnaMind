/**
 * The sidebar's Canvases list (#3406): until the User has a Folder, it is a list of its own between
 * Notes and Documents, counting its rows, and only once there is a Canvas. On day one the sidebar
 * has no Canvases heading.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Canvas, Mind } from "../../src/core/api";

const TIDES: Canvas = {
  id: "canvas-1",
  title: "Tide report",
  folderId: null,
  agent: "Claude Code",
  version: 1,
  createdAt: "2026-11-19T00:00:00.000Z",
  updatedAt: "2026-11-19T00:00:00.000Z",
};

const NOTE: Mind = {
  id: "mind-1",
  title: "Harbour notes",
  autoTitle: "",
  kind: "mind",
  folderId: null,
  createdAt: "2026-11-19T00:00:00.000Z",
  updatedAt: "2026-11-19T00:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each
          ? each[name as keyof typeof each]
          : String(name).startsWith("list")
            ? () => Promise.resolve([])
            : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    localStorage: { getItem: () => null, setItem: () => undefined },
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

/** The sidebar's tree on day one, no Folder yet, with a Note and these Canvases. */
async function sidebar(canvases: Canvas[]) {
  await import("../../src/renderer/src/commands/app");
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useCanvases } = await import("../../src/renderer/src/canvases");
  useAppStore.setState({
    settings: { language: "en", user: { personId: "person" } },
    library: { groups: [], assignments: [] },
    minds: [NOTE],
  } as never);
  useCanvases.setState({ canvases });
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const path = "../../src/renderer/src/components/LibraryFolders.tsx";
  const { LibraryFolders }: { LibraryFolders: ComponentType<Record<string, unknown>> } =
    await import(path);
  await act(() =>
    root?.render(createElement(LibraryFolders, { documents: [], renderDocument: () => null })),
  );
  return container.querySelector('[data-testid="canvases-section"]');
}

describe("the sidebar's Canvases", () => {
  test("have no heading of their own while there is no Canvas", async () => {
    expect(await sidebar([])).toBeNull();
    expect(container.querySelector('[data-testid="notes-section"]')).not.toBeNull();
  });

  test("are a list of their own, counting its rows, once there is one", async () => {
    const section = await sidebar([TIDES]);
    expect(section?.querySelector('[data-testid="canvases-title"]')?.textContent).toContain(
      "Canvases",
    );
    expect(section?.querySelectorAll('[data-testid="canvas-row"]').length).toBe(1);
  });
});
