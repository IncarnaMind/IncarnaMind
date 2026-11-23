/**
 * A Markdown file with no headings is cited by paragraph (#3657). A Citation made before, whose
 * place is the whole file, opens at its quote with it marked, as one that names its paragraph does:
 * the viewer finds a quote by its words.
 */
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationLocation, Document } from "../../src/core/api";
import type { ViewerTarget } from "../../src/renderer/src/store";
import { mountViewerDom } from "../helpers/viewerDom";

const FILE = [
  "Interviewer: How did the harbour change after the war?",
  "",
  "Alex Moran: The east quay grew first.",
  "",
  "Alex Moran: The fishing fleet doubled within ten years, and the east quay held 31 boats by 1956.",
  "",
  "李明：渡轮整个冬天都在运行。",
].join("\n");

const DOCUMENT = {
  id: "doc-interview",
  name: "Harbour interview",
  title: "Harbour interview",
  path: "/tmp/Harbour interview.md",
  kind: "markdown",
  status: "ready",
  contentHash: "hash-1",
  failure: null,
  speakers: null,
  tags: [],
  web: null,
} as unknown as Document;

let mounted: ReturnType<typeof mountViewerDom>;

beforeEach(() => {
  mounted = mountViewerDom(() => ({ status: 200, bytes: new TextEncoder().encode(FILE) }));
  const dom = mounted.container.ownerDocument;
  Object.defineProperty(dom, "styleSheets", { value: [] });
  Object.assign(Element.prototype, { scrollIntoView: () => undefined });
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  vi.stubGlobal("getComputedStyle", () => ({
    fontStyle: "",
    fontWeight: "",
    fontSize: "",
    fontFamily: "",
  }));
});

afterEach(async () => {
  await mounted.unmount();
});

const settled = () =>
  act(async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  });

/** The viewer opened at a Citation of `quote` whose place is `location`. */
async function openAt(quote: string, location: CitationLocation) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useMeetings } = await import("../../src/renderer/src/meetings");
  const { useConversations } = await import("../../src/renderer/src/conversations");
  await act(() => {
    useConversations.setState({ list: [], openId: null } as never);
    useAppStore.setState({
      status: { kind: "ready" },
      documents: [DOCUMENT],
      library: null,
      minds: [],
      keptCitationTexts: [],
      settings: { language: "en", device: {}, user: { personId: null } } as never,
    } as never);
    useMeetings.setState({ meetings: [] });
  });
  await import("../../src/renderer/src/commands/app");
  const textPath = "../../src/renderer/src/viewer/TextView.tsx";
  const headerPath = "../../src/renderer/src/viewer/ViewerHeader.tsx";
  const { TextView } = await import(textPath);
  const { ViewerFrameContext } = await import(headerPath);
  const target: ViewerTarget = {
    documentId: DOCUMENT.id,
    request: 1,
    quote,
    pageFrom: 1,
    pageTo: 1,
    citation: {
      check: "found",
      number: 1,
      pageFrom: 1,
      pageTo: 1,
      location,
      contentHash: "hash-1",
    },
  };
  const frame = {
    document: DOCUMENT,
    target,
    tabId: "tab-1",
    preview: false,
    keep: () => undefined,
  };
  await act(() => mounted.root.render(null));
  await act(() =>
    mounted.root.render(
      createElement(
        ViewerFrameContext.Provider,
        { value: frame },
        createElement(TextView, { document: DOCUMENT, target }),
      ),
    ),
  );
  await settled();
}

const marked = () =>
  [...mounted.container.querySelectorAll("[data-quote-highlight]")]
    .map((mark) => mark.textContent)
    .join("");

describe("a heading-less Markdown file's Citations in the viewer (#3657)", () => {
  test("one made before, its place the whole file, opens at its quote with it marked", async () => {
    await openAt("The fishing fleet doubled within ten years", { kind: "section", heading: null });
    expect(marked()).toBe("The fishing fleet doubled within ten years");
  });

  test("one that names its paragraph opens at its quote with it marked, in Chinese text too", async () => {
    await openAt("The fishing fleet doubled within ten years", {
      kind: "section",
      heading: null,
      paragraphs: { from: 3, to: 3 },
    });
    expect(marked()).toBe("The fishing fleet doubled within ten years");
    await openAt("渡轮整个冬天", {
      kind: "section",
      heading: null,
      paragraphs: { from: 4, to: 4 },
    });
    expect(marked()).toBe("渡轮整个冬天");
  });
});
