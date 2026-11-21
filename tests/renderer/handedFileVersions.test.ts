/**
 * The card of a file an agent handed over (#3412) offers each other version's check to open
 * (#3493). A Note open while the agent hands over the next version reads the file as that version's
 * check is being made, before it has a Note: the card offers it once its Note comes.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { type HandedFileOfMind, MIND_SETTINGS_FIELD } from "../../src/core/api";
import { writeVerification } from "../../src/shared/verification";

const AT = "2026-11-21T09:00:00.000Z";
const FIRST = "mind-version-1";
const SECOND = "mind-version-2";

const bridge = {
  /** What the core says of the file the Note checks, as it is now. */
  handed: null as HandedFileOfMind | null,
  on: () => () => undefined,
  handedFileOf: async () => bridge.handed,
};
const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
const view = page.defaultView;
const methods = new Proxy(bridge, {
  get: (each, name) =>
    name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
});
Object.assign(view, { incarnamind: methods, incarnamindFiles: methods });
const globals: Record<string, unknown> = {
  document: page,
  window: view,
  HTMLElement: view.HTMLElement,
  Element: view.Element,
  Event: view.Event,
  Node: view.Node,
  MutationObserver: view.MutationObserver,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const linePath = "../../src/renderer/src/editor/HandedFileLine.tsx";
const {
  HandedFileLine,
}: {
  HandedFileLine: ComponentType<{ mindId: string; doc: Y.Doc; kept: number; running: boolean }>;
} = await import(linePath);

/** The deck's two versions; the second's check Note is `second`, null while it is made. */
const handedOf = (second: string | null): HandedFileOfMind => ({
  file: {
    id: "deck",
    title: "Harbour review",
    kind: "pptx",
    folderId: null,
    agent: "Claude Code",
    documentId: "deck-document",
    version: 2,
    createdAt: AT,
    updatedAt: AT,
  },
  version: 1,
  versions: [
    { number: 1, contentHash: "v1", size: 1, mindId: FIRST, agent: "Claude Code", createdAt: AT },
    { number: 2, contentHash: "v2", size: 1, mindId: second, agent: "Claude Code", createdAt: AT },
  ],
});

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("the card of a handed-over file's earlier version", () => {
  // protects=a Note open while the next version is handed over offers that version once its check Note is made, though the file's Document took the version before the Note came (#3493); fails_when=the card keeps the read from before the Note and offers no way to the newer version
  test("offers the version handed over while it was open, once that version's check is made", async () => {
    const doc = new Y.Doc();
    writeVerification(doc.getMap(MIND_SETTINGS_FIELD), {
      documentId: "deck-document",
      documentName: "Harbour review.pptx",
      pages: {},
      claims: null,
      comments: false,
    });
    bridge.handed = handedOf(null);
    useAppStore.setState({
      settings: { language: "en", user: {}, device: { gettingStarted: {} } },
      documents: [{ id: "deck-document", contentHash: "v2" }],
      minds: [{ id: FIRST, folderId: null }],
    } as never);
    const container = page.createElement("div", {});
    page.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(HandedFileLine, { mindId: FIRST, doc, kept: 0, running: false })),
    );
    const versions = () =>
      [...container.querySelectorAll('[data-testid="verify-handed-version"]')].map(
        (button) => button.textContent,
      );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("From Claude Code · version 1 of 2"),
    );
    expect(versions()).toEqual([]);
    unmount = async () => {
      await act(() => root.unmount());
      container.remove();
    };

    bridge.handed = handedOf(SECOND);
    await act(async () =>
      useAppStore.setState({
        minds: [
          { id: FIRST, folderId: null },
          { id: SECOND, folderId: null },
        ],
      } as never),
    );
    await vi.waitFor(() => expect(versions()).toEqual(["Version 2"]));
  });
});
