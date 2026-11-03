import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, Document, LibrarySnapshot, Mind } from "../../src/core/api";

/*
 * A Citation kept inside a walled Folder, shown in a Note outside it after its Document got a new
 * version (#1934): nothing of the new version was read, so the check card and the chart point's
 * card say where it is kept, beside the result it was made with, and never that its quote is gone.
 */

const LEASE: CitationAttributes = {
  passageId: "p1",
  documentId: "lease-a",
  documentName: "Client A lease",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: "Client A notice: 90 days.",
  check: "found",
  checkReason: null,
};

let root: Root | null = null;
let container: HTMLElement;
let recheck: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  recheck = vi.fn(async () => ({ keptInside: "Client A" }));
  const bridge = new Proxy(
    { on: () => () => undefined, recheckCitation: recheck },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
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
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useConversations } = await import("../../src/renderer/src/conversations");
  useConversations.setState({ list: [], openId: null } as never);
  const library = {
    groups: [{ id: "a", name: "Client A", keepInside: true }],
    assignments: [{ documentId: "lease-a", groupId: "a" }],
  } as Pick<LibrarySnapshot, "groups" | "assignments"> as LibrarySnapshot;
  useAppStore.setState({
    status: { kind: "ready", documents: [{ id: "lease-a", contentHash: "v2" } as Document] },
    documents: [{ id: "lease-a", contentHash: "v2" } as Document],
    minds: [{ id: "outside", title: "Outside note", autoTitle: "", folderId: null } as Mind],
    library,
  } as never);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function showInOutsideNote(card: ReactNode) {
  const { MindIdContext } = await import("../../src/renderer/src/editor/mindContext");
  await act(() => root?.render(createElement(MindIdContext.Provider, { value: "outside" }, card)));
}

const NOT_SAID = ["no longer in the new version", "changed after"];

describe("a Citation kept inside a wall, its Document changed since", () => {
  test("the check card says Kept inside and nothing about the new version", async () => {
    // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
    const noticePath = "../../src/renderer/src/editor/ChangedSourceNotice.tsx";
    const { ChangedCitations }: { ChangedCitations: ComponentType<Record<string, unknown>> } =
      await import(noticePath);
    await showInOutsideNote(
      createElement(ChangedCitations, {
        cited: [{ pos: 0, number: 1, key: "b1:0", attributes: LEASE, footnote: true }],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Kept inside Client A");
    for (const said of NOT_SAID) expect(text).not.toContain(said);
    expect(recheck).not.toHaveBeenCalled();
  });

  test("the chart point's card says Kept inside and nothing about the new version", async () => {
    const cardPath = "../../src/renderer/src/editor/ChartPointCard.tsx";
    const { ChartPointCard }: { ChartPointCard: ComponentType<Record<string, unknown>> } =
      await import(cardPath);
    const { citationState } = await import("../../src/shared/citations");
    await showInOutsideNote(
      createElement(ChartPointCard, {
        title: "Notice",
        position: null,
        value: "90",
        detail: null,
        notDrawn: null,
        cut: null,
        citation: LEASE,
        state: citationState(LEASE, [{ id: "lease-a", contentHash: "v2" }], [], "Client A"),
        onOpen: () => undefined,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Kept inside Client A");
    for (const said of NOT_SAID) expect(text).not.toContain(said);
    expect(recheck).not.toHaveBeenCalled();
  });
});
