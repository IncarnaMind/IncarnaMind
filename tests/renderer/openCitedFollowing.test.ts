import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationRecheck, Document } from "../../src/core/api";

type OpenCited = typeof import("../../src/renderer/src/openCited");
type Store = typeof import("../../src/renderer/src/store");

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
const openDocument = vi.fn();

beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  };
  opened = await import("../../src/renderer/src/openCited");
  store = await import("../../src/renderer/src/store");
});

const CITED = {
  documentId: "terms",
  check: "found",
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

const HOW = { check: "found", withQuote: true, label: "§ Notice" } as const;

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
  test("opens where the quote is now when its Document changed and the quote moved inside the same Units", async () => {
    recheckCitation.mockResolvedValue(
      recheckOf({
        location: { kind: "section", heading: "Notice", paragraphs: { from: 4, to: 4 } },
      }),
    );
    await opened.openCitedFollowing(CITED, HOW, null);
    expect(recheckCitation).toHaveBeenCalledOnce();
    expect(openDocument).toHaveBeenCalledOnce();
    const [location] = openDocument.mock.calls[0] ?? [];
    expect(location).toMatchObject({ documentId: "terms", pageFrom: 2, pageTo: 2 });
    expect(location.citation.label.replace(/\s/g, " ")).toBe("§ Notice, ¶ 4");
  });

  test("opens where it was cited when the quote is still there, and asks nothing of an unchanged Document", async () => {
    recheckCitation.mockResolvedValue(recheckOf({}));
    await opened.openCitedFollowing(CITED, HOW, null);
    expect(openDocument.mock.calls[0]?.[0]).toMatchObject({ pageFrom: 2, pageTo: 2 });
    expect(openDocument.mock.calls[0]?.[0].citation.label).toBe("§ Notice");

    openDocument.mockReset();
    recheckCitation.mockReset();
    store.useAppStore.setState({ documents: [documentAt("v1")] });
    await opened.openCitedFollowing(CITED, HOW, null);
    expect(recheckCitation).not.toHaveBeenCalled();
    expect(openDocument).toHaveBeenCalledOnce();
  });

  test("still opens when the new version can't be looked at", async () => {
    recheckCitation.mockRejectedValue(new Error("no text"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await opened.openCitedFollowing(CITED, HOW, null);
    expect(openDocument).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
