import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MarkedCitation } from "../../src/core/api";

/*
 * A Citation in a reply at a Note's foot is the Note's own chip (#3765), and pressed it opens its
 * Citation as a reply's does (#3762): a meeting's Transcript in the sheet over the meeting's Note,
 * with the Citation's own place; any other Document beside the Note at the words cited, as a Note's
 * own Citation opens it. In the Note itself nothing goes to the sheet first.
 */

const opened = vi.hoisted(() => ({
  inSheet: vi.fn((target: { documentId: string }) => target.documentId === "transcript"),
  beside: vi.fn(),
}));

vi.mock("../../src/renderer/src/openCited", () => ({ openCited: opened.beside }));

let root: Root | null = null;
let Shown: ComponentType<{ citation: MarkedCitation; inReply: boolean }>;

beforeEach(async () => {
  vi.clearAllMocks();
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
        name === "on"
          ? each.on
          : () => Promise.resolve(String(name).startsWith("list") ? [] : undefined),
    },
  );
  Object.assign(window, {
    incarnamind: bridge,
    incarnamindFiles: bridge,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    reportError: () => undefined,
  });
  const globals: Record<string, unknown> = {
    document,
    window,
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
    CSS: { escape: (text: string) => text },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  const prototype = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  prototype.showPopover = () => undefined;
  prototype.hidePopover = () => undefined;
  const element = window.Element.prototype as unknown as { matches(selector: string): boolean };
  const matches = element.matches;
  element.matches = function (this: Element, selector: string) {
    return selector === ":popover-open" ? false : matches.call(this, selector);
  };
  const container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);

  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    status: { kind: "ready" },
    documents: [
      {
        id: "transcript",
        name: "Harbour call",
        kind: "transcript",
        contentHash: "transcript-v1",
        meetingMindId: "note-call",
        path: "/data/Transcripts/harbour.vtt",
      },
      {
        id: "tender",
        name: "Tender.pdf",
        kind: "pdf",
        contentHash: "tender-v2",
        path: "/data/Tender.pdf",
      },
    ],
    linkedFolders: [],
    library: null,
    minds: [],
    keptCitationTexts: [],
    settings: { language: "en", user: {}, device: {} },
  } as never);
  const { ReplyCitationOpensContext } = await import("../../src/renderer/src/editor/mindContext");
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const viewPath = "../../src/renderer/src/editor/CitationView";
  const { CitationView }: { CitationView: ComponentType<Record<string, unknown>> } = await import(
    viewPath
  );
  // As a reply draws it (`Reply`, which gives the sheet's opener), or as a Note does.
  Shown = ({ citation, inReply }) =>
    createElement(
      ReplyCitationOpensContext.Provider,
      { value: inReply ? opened.inSheet : null },
      createElement(CitationView, {
        node: { attrs: citation },
        editor: { isEditable: false },
        getPos: () => 0,
        deleteNode: () => undefined,
        updateAttributes: () => undefined,
        decorations: [],
      }),
    );
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const SAID: MarkedCitation = {
  marker: 1,
  passageId: "passage-said",
  documentId: "transcript",
  documentName: "Harbour call",
  contentHash: "transcript-v1",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "time", from: 12_000, to: 15_000 },
  quote: "The ramp works start on the third of March",
  check: "found",
  checkReason: null,
};

const TENDER: MarkedCitation = {
  marker: 2,
  passageId: "passage-tender",
  documentId: "tender",
  documentName: "Tender.pdf",
  contentHash: "tender-v2",
  pageFrom: 4,
  pageTo: 4,
  location: null,
  quote: "about two hundred thousand pounds",
  check: "found",
  checkReason: null,
};

async function press(citation: MarkedCitation, inReply: boolean) {
  await act(() => root?.render(createElement(Shown, { citation, inReply })));
  const chip = document.querySelector('[data-testid="citation-chip"]');
  if (!chip) throw new Error("No Citation is drawn.");
  await act(() => {
    chip.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

describe("a reply's Citation, drawn as a Note's chip", () => {
  test("of a meeting's Transcript: pressed, it opens in the sheet at its own place, and nowhere else", async () => {
    await press(SAID, true);
    expect(opened.inSheet).toHaveBeenCalledTimes(1);
    expect(opened.inSheet).toHaveBeenCalledWith({
      documentId: "transcript",
      quote: "The ramp works start on the third of March",
      pageFrom: 1,
      pageTo: 1,
      citation: {
        check: "found",
        origin: "note",
        contentHash: "transcript-v1",
        location: { kind: "time", from: 12_000, to: 15_000 },
        pageFrom: 1,
        pageTo: 1,
      },
      request: 0,
    });
    expect(opened.beside).not.toHaveBeenCalled();
  });

  test("of any other Document: pressed, it opens beside the Note at the words cited", async () => {
    await press(TENDER, true);
    expect(opened.inSheet).toHaveBeenCalledTimes(1);
    expect(opened.beside).toHaveBeenCalledTimes(1);
    expect(opened.beside).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "tender",
        quote: "about two hundred thousand pounds",
        pageFrom: 4,
        pageTo: 4,
        contentHash: "tender-v2",
      }),
      expect.objectContaining({ origin: "note", check: "found", withQuote: true }),
    );
  });

  test("in a Note, a Transcript's Citation opens as a Note's does, never in a reply's sheet first", async () => {
    await press(SAID, false);
    expect(opened.inSheet).not.toHaveBeenCalled();
    expect(opened.beside).toHaveBeenCalledTimes(1);
    expect(opened.beside).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "transcript" }),
      expect.objectContaining({ origin: "note", check: "found" }),
    );
  });
});
