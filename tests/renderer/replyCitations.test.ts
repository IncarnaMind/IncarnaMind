import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NoteCitation } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";

/*
 * A Citation chip in a reply at a Note's foot (#3762): every chip that is a button opens its
 * Citation, pressed or given Enter or Space. A meeting's Transcript opens in the sheet over the
 * meeting's Note; any other Document opens beside the Note at the words cited, as a Note's own
 * Citation opens it.
 */

const opened = vi.hoisted(() => ({
  inSheet: vi.fn((target: { documentId: string }) => target.documentId === "transcript"),
  beside: vi.fn(),
}));

vi.mock("../../src/renderer/src/components/meetings/MeetingFoot", () => ({
  showCitedInTranscript: opened.inSheet,
}));
vi.mock("../../src/renderer/src/openCited", () => ({ openCited: opened.beside }));
vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {},
    { get: (_target, name) => (name === "on" ? () => () => undefined : async () => []) },
  ),
  files: new Proxy({}, { get: () => () => () => undefined }),
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => translate.bind(null, "en"),
  useLanguage: () => "en",
  useGap: () => () => " · ",
  translateNow: (key: Parameters<typeof translate>[1]) => translate("en", key),
}));

const CITATIONS: NoteCitation[] = [
  {
    token: "said",
    documentId: "transcript",
    documentName: "Harbour call",
    quote: "The ramp works start on the third of March",
    passageId: "passage-said",
    contentHash: "transcript-v1",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "time", from: 12_000, to: 15_000 },
  },
  {
    token: "tender",
    documentId: "tender",
    documentName: "Tender.pdf",
    quote: "about two hundred thousand pounds",
    passageId: "passage-tender",
    contentHash: "tender-v2",
    pageFrom: 4,
    pageTo: 4,
    location: null,
  },
];
const REPLY = "The works start on 3 March [cite:said] and cost about £200,000 [cite:tender].";

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    navigator: { languages: ["en"], platform: "Linux" },
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function showReply() {
  // A variable path, so the test's tsconfig (no jsx) leaves the component to the runtime.
  const path = "../../src/renderer/src/components/noteAsk/NoteAskPill.tsx";
  let Reply: ComponentType<{ text: string; citations: readonly NoteCitation[] }>;
  ({ Reply } = await import(path));
  await act(async () => root?.render(createElement(Reply, { text: REPLY, citations: CITATIONS })));
}

function chip(token: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`.citation-marker[data-token="${token}"]`);
  if (!found) throw new Error(`No chip for ${token}.`);
  return found;
}

async function press(target: HTMLElement) {
  await act(async () => target.dispatchEvent(new window.Event("click", { bubbles: true })));
}

async function key(target: HTMLElement, name: string) {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: name });
  await act(async () => target.dispatchEvent(event));
  return event;
}

describe("a reply's Citation chips", () => {
  test("each chip is a button that opens its Citation: the Transcript's in the sheet, a PDF's beside the Note at its quote", async () => {
    await showReply();
    expect(chip("said").getAttribute("role")).toBe("button");
    expect(chip("tender").getAttribute("role")).toBe("button");

    await press(chip("said"));
    // With the Citation's own place, so the sheet can say when that place is gone.
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

    await press(chip("tender"));
    expect(opened.beside).toHaveBeenCalledTimes(1);
    expect(opened.beside).toHaveBeenCalledWith(
      {
        documentId: "tender",
        quote: "about two hundred thousand pounds",
        pageFrom: 4,
        pageTo: 4,
        contentHash: "tender-v2",
      },
      { origin: "note", check: "found", withQuote: true },
    );
  });

  test.each(["Enter", " "])("%j on a chip opens its Citation, as a press does", async (name) => {
    await showReply();
    const event = await key(chip("tender"), name);
    expect(opened.beside).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    await key(chip("said"), name);
    expect(opened.inSheet).toHaveBeenCalledTimes(2);
    expect(opened.beside).toHaveBeenCalledTimes(1);
  });

  test("another key, or a press beside the chips, opens nothing", async () => {
    await showReply();
    const event = await key(chip("tender"), "a");
    expect(event.defaultPrevented).toBe(false);
    await press(
      container.querySelector<HTMLElement>('[data-testid="note-ask-reply"] p') ?? container,
    );
    expect(opened.inSheet).not.toHaveBeenCalled();
    expect(opened.beside).not.toHaveBeenCalled();
  });
});
