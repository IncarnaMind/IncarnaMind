/**
 * A deck's viewer takes up a change that waits from the core (#149): when it can't, the User is
 * told, as a Problem, and a gesture the core then refuses for that change takes it up again.
 */
import { DOMParser } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DeckUnwritable, Document } from "../../src/core/api";
import type { DeckEditing } from "../../src/renderer/src/viewer/slides/deckEditing";

const asked = vi.hoisted(() => ({ waiting: [] as (() => Promise<DeckUnwritable | null>)[] }));

let root: Root | null = null;

beforeEach(() => {
  const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  const window = document.defaultView;
  const bridge = new Proxy(
    {
      on: () => () => undefined,
      deckChangeWaiting: () => (asked.waiting.shift() ?? (() => Promise.resolve(null)))(),
      keptDeckStates: () => Promise.resolve({ sitting: null, first: null }),
    },
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
    Node: window.Node,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  const container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

const DECK = {
  id: "deck",
  name: "Harbour plan.pptx",
  kind: "pptx",
  contentHash: "v1",
  fileStatus: "available",
} as unknown as Document;

const WAITING: DeckUnwritable = {
  kind: "unwritable",
  sittingId: "sitting",
  documentId: "deck",
  why: "locked",
  name: "Harbour plan.pptx",
  bytes: new Uint8Array(),
  contentHash: "v2",
};

// protects=a change that waits which the viewer couldn't take up is said, and taken up again when a gesture is refused for it (#149 review); fails_when=only a log line says so, and every gesture is refused with no button to save the change; no_claim=the line's look.
test("a change that waits the viewer can't take up is said, and taken up when a gesture is refused for it", async () => {
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useDeckEditing } = await import("../../src/renderer/src/viewer/slides/deckEditing");
  const reportError = vi.fn();
  useAppStore.setState({
    settings: { language: "en", user: { personId: "person" } },
    reportError,
  } as never);
  asked.waiting.push(() => Promise.reject(new Error("The core didn't answer.")));
  const held: { editing: DeckEditing | null } = { editing: null };
  const Probe = () => {
    held.editing = useDeckEditing(DECK, null);
    return null;
  };
  await act(() => root?.render(createElement(Probe)));
  await act(async () => undefined);
  expect(reportError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "The core didn't answer." }),
  );
  expect(held.editing?.waiting ?? null).toBeNull();
  // A gesture the core refuses because a change waits takes the change up: its line shows.
  asked.waiting.push(() => Promise.resolve(WAITING));
  const bridge = (window as unknown as { incarnamind: Record<string, unknown> }).incarnamind;
  const { TranslatableError } = await import("../../src/core/errors");
  bridge.editDeck = () => Promise.reject(new TranslatableError({ key: "error.deck.waiting" }));
  await act(async () => {
    await held.editing?.edit(
      [{ kind: "box", slide: 1, shape: "2", box: { x: 1, y: 1, w: 9, h: 9 } }],
      "moved",
    );
  });
  await act(async () => undefined);
  expect(held.editing?.waiting?.sittingId).toBe("sitting");
});
