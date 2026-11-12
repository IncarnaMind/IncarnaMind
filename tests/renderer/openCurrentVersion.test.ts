import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CitationRecheck,
  type CitedOrigin,
  DEFAULT_ASSISTANT,
  type Document,
  type LayoutGroup,
  type TabItem,
  type WindowLayout,
} from "../../src/core/api";

type OpenCited = typeof import("../../src/renderer/src/openCited");
type Store = typeof import("../../src/renderer/src/store");
type LayoutSlice = typeof import("../../src/renderer/src/layoutSlice");

const { recheckCitation } = vi.hoisted(() => ({ recheckCitation: vi.fn() }));
vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    { recheckCitation },
    {
      get: (target, name) =>
        name in target ? target[name as "recheckCitation"] : () => () => undefined,
    },
  ),
}));

let opened: OpenCited;
let store: Store;
let layoutSlice: LayoutSlice;
const openDocument = vi.fn();

beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    innerWidth: 1440,
  };
  opened = await import("../../src/renderer/src/openCited");
  store = await import("../../src/renderer/src/store");
  layoutSlice = await import("../../src/renderer/src/layoutSlice");
});

const CITED = {
  documentId: "terms",
  contentHash: "v1",
  pageFrom: 2,
  pageTo: 2,
  quote: "Notice is sixty days.",
  location: { kind: "section", heading: "Notice", paragraphs: { from: 1, to: 1 } },
} as const;

const documentAt = (contentHash: string) => ({ id: "terms", contentHash }) as Document;

const recheckOf = (patch: Partial<CitationRecheck>): CitationRecheck =>
  ({
    check: "found",
    checkReason: null,
    contentHash: "v2",
    passageId: "p",
    pageFrom: 2,
    pageTo: 2,
    location: { kind: "section", heading: "Notice", paragraphs: { from: 1, to: 1 } },
    ...patch,
  }) as CitationRecheck;

const HOW = { origin: "note", check: "found", withQuote: true, label: "§ Notice" } as const;

beforeEach(() => {
  recheckCitation.mockReset();
  openDocument.mockReset();
  store.useAppStore.setState({
    status: { kind: "ready" } as never,
    documents: [documentAt("v2")],
    keptCitationTexts: [],
    openDocument,
  });
});

describe("Opening a Citation from a step, a chart point or a check card", () => {
  test("opens the version it was made from, at the place it cites, and asks nothing of the new one", () => {
    opened.openCited(CITED, HOW);
    expect(recheckCitation).not.toHaveBeenCalled();
    expect(openDocument).toHaveBeenCalledOnce();
    const [location] = openDocument.mock.calls[0] ?? [];
    expect(location.citation).toMatchObject({
      contentHash: "v1",
      pageFrom: 2,
      pageTo: 2,
      label: "§ Notice",
    });
  });
});

describe("Open the current version, out of the cited one's view", () => {
  test("forwards a Transcript Citation's exact stored cue to the rechecker", async () => {
    const location = { kind: "time", from: 7000, to: 10_000, speaker: "Dana" } as const;
    recheckCitation.mockResolvedValue(recheckOf({ location }));
    const citation = { ...CITED, quote: "We agreed to review the plan.", location };
    await opened.openCurrentVersion(citation, { ...HOW, label: "Dana · 0:07" });
    expect(recheckCitation).toHaveBeenCalledWith({
      mindId: null,
      documentId: citation.documentId,
      contentHash: citation.contentHash,
      pageFrom: citation.pageFrom,
      pageTo: citation.pageTo,
      quote: citation.quote,
      location,
    });
    expect(openDocument.mock.calls[0]?.[0].citation.location).toEqual(location);
  });

  test("opens where the quote is now when its Document changed and the quote moved inside the same Units", async () => {
    recheckCitation.mockResolvedValue(
      recheckOf({
        location: { kind: "section", heading: "Notice", paragraphs: { from: 4, to: 4 } },
      }),
    );
    await opened.openCurrentVersion(CITED, HOW);
    expect(recheckCitation).toHaveBeenCalledOnce();
    expect(openDocument).toHaveBeenCalledOnce();
    const [location] = openDocument.mock.calls[0] ?? [];
    expect(location).toMatchObject({
      documentId: "terms",
      pageFrom: 2,
      pageTo: 2,
      currentVersion: true,
    });
    // The Citation keeps its version, so the viewer still says the Document changed after it was cited.
    expect(location.citation.contentHash).toBe("v1");
    expect(location.citation.label.replace(/\s/g, " ")).toBe("§ Notice, ¶ 4");
    expect(location.citation.location).toMatchObject({ paragraphs: { from: 4, to: 4 } });
  });

  test("opens at the place it was cited when the quote is still there", async () => {
    recheckCitation.mockResolvedValue(recheckOf({}));
    await opened.openCurrentVersion(CITED, HOW);
    expect(openDocument.mock.calls[0]?.[0]).toMatchObject({
      pageFrom: 2,
      pageTo: 2,
      currentVersion: true,
    });
    expect(openDocument.mock.calls[0]?.[0].citation).toMatchObject({
      label: "§ Notice",
      contentHash: "v1",
    });
  });

  test("asks nothing of an unchanged Document", async () => {
    store.useAppStore.setState({ documents: [documentAt("v1")] });
    await opened.openCurrentVersion(CITED, HOW);
    expect(recheckCitation).not.toHaveBeenCalled();
    expect(openDocument).toHaveBeenCalledOnce();
  });

  test("still opens when the new version can't be looked at", async () => {
    recheckCitation.mockRejectedValue(new Error("no text"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await opened.openCurrentVersion(CITED, HOW);
    expect(openDocument).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

const group = (id: string, item: TabItem): LayoutGroup => ({
  id,
  tabs: [{ id: `${id}-tab`, item, preview: false, pinned: false, place: null, opened: 0 }],
  activeTabId: `${id}-tab`,
  width: 0.5,
});

/** A Note and a page side by side: in an 860px card they have 430px each, under what a Note is written at (#2270). */
const NOTE_AND_PAGE: WindowLayout = {
  groups: [
    group("note", { kind: "mind", mindId: "m" }),
    group("page", { kind: "document", documentId: "terms" }),
  ],
  focusedGroupId: "note",
  reopenable: 0,
  conversationId: null,
  assistant: DEFAULT_ASSISTANT,
};

describe("Open the current version leaves the assistant as the page it opens from found it", () => {
  const placeAssistant = vi.fn();

  beforeEach(() => {
    placeAssistant.mockReset();
    layoutSlice.useCardWidth.setState({ width: 860 });
    store.useAppStore.setState({ layout: NOTE_AND_PAGE, placeAssistant });
    openDocument.mockResolvedValue(NOTE_AND_PAGE);
    recheckCitation.mockResolvedValue(recheckOf({}));
  });

  /** The page a Citation opens, as the viewer's tab then shows it, once its own opening has settled. */
  async function pageOpenedFrom(origin: CitedOrigin) {
    opened.openCited(CITED, { ...HOW, origin });
    await openDocument.mock.results[0]?.value;
    const [location] = openDocument.mock.calls[0] ?? [];
    placeAssistant.mockClear();
    openDocument.mockClear();
    return { ...location, request: 1 };
  }

  test("a page opened from the assistant opens its current version with the assistant still open", async () => {
    const page = await pageOpenedFrom("assistant");
    await opened.openCurrentVersionOf(page);
    await openDocument.mock.results[0]?.value;
    expect(openDocument.mock.calls[0]?.[0]).toMatchObject({ currentVersion: true });
    expect(placeAssistant).not.toHaveBeenCalled();
  });

  test("a page opened from a Note opens its current version as before, the assistant folding for the room", async () => {
    const page = await pageOpenedFrom("note");
    await opened.openCurrentVersionOf(page);
    await openDocument.mock.results[0]?.value;
    expect(openDocument.mock.calls[0]?.[0]).toMatchObject({ currentVersion: true });
    expect(placeAssistant).toHaveBeenCalledWith({ folded: true });
  });

  test("a page whose origin was not kept, as one saved before it was, is taken as opened from a Note", async () => {
    const { citation, ...rest } = await pageOpenedFrom("assistant");
    const { origin: _origin, ...kept } = citation;
    await opened.openCurrentVersionOf({ ...rest, citation: kept });
    await openDocument.mock.results[0]?.value;
    expect(placeAssistant).toHaveBeenCalledWith({ folded: true });
  });

  test("the current version it opens keeps the origin, so another round stays as the first", async () => {
    const page = await pageOpenedFrom("assistant");
    await opened.openCurrentVersionOf(page);
    expect(openDocument.mock.calls[0]?.[0].citation.origin).toBe("assistant");
  });
});
