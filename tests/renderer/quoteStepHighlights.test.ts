/**
 * A viewer opened at the quotes of one chip (#3654) marks them all. Two of them may share words:
 * the text still reads as the file does, the shared words show as the quote the viewer is on, and
 * each quote keeps a highlight its stepper goes to.
 */
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document } from "../../src/core/api";
import type { ViewerTarget } from "../../src/renderer/src/store";
import { mountViewerDom } from "../helpers/viewerDom";

const LINE = "alpha beta gamma delta";
const FIRST = "alpha beta gamma";
const SECOND = "beta gamma delta";

const DOCUMENT = {
  id: "doc-text",
  name: "Notes",
  title: "Notes",
  path: "/tmp/Notes.txt",
  kind: "text",
  status: "ready",
  contentHash: "hash-1",
  failure: null,
  speakers: null,
  tags: [],
  web: null,
} as unknown as Document;

let mounted: ReturnType<typeof mountViewerDom>;

beforeEach(() => {
  mounted = mountViewerDom(() => ({ status: 200, bytes: new TextEncoder().encode(`${LINE}\n`) }));
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

async function openAt(language: "en" | "zh-CN") {
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
      settings: { language, device: {}, user: { personId: null } } as never,
    } as never);
    useMeetings.setState({ meetings: [] });
  });
  // The stepper's buttons name their shortcuts, the app's commands.
  await import("../../src/renderer/src/commands/app");
  const textPath = "../../src/renderer/src/viewer/TextView.tsx";
  const headerPath = "../../src/renderer/src/viewer/ViewerHeader.tsx";
  const { TextView } = await import(textPath);
  const { ViewerFrameContext } = await import(headerPath);
  const target: ViewerTarget = {
    documentId: DOCUMENT.id,
    request: 1,
    quote: FIRST,
    quotes: [FIRST, SECOND],
    pageFrom: 1,
    pageTo: 1,
    citation: { check: "found", number: 4, pageFrom: 1, pageTo: 1, contentHash: "hash-1" },
  };
  const frame = {
    document: DOCUMENT,
    target,
    tabId: "tab-1",
    preview: false,
    keep: () => undefined,
  };
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

const marks = () =>
  [...mounted.container.querySelectorAll<HTMLElement>("[data-quote-index]")].map((mark) => ({
    quote: Number(mark.dataset.quoteIndex),
    other: mark.classList.contains("quote-highlight--other"),
    words: mark.textContent,
  }));

const step = async (name: string) => {
  const button = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.getAttribute("aria-label") === name,
  );
  expect(button, name).toBeDefined();
  await act(() => button?.click());
  await settled();
};

describe("quotes of one chip that share words", () => {
  test("write the file's text once, the shared words shown as the quote the viewer is on", async () => {
    await openAt("en");
    expect(mounted.container.textContent).toContain(LINE);
    expect(mounted.container.textContent).toContain("Quote 1 of 2");
    expect(marks()).toEqual([
      { quote: 0, other: false, words: "alpha " },
      { quote: 0, other: false, words: "beta gamma" },
      { quote: 1, other: true, words: " delta" },
    ]);

    await step("Next quote");
    expect(mounted.container.textContent).toContain(LINE);
    expect(mounted.container.textContent).toContain("Quote 2 of 2");
    expect(marks()).toEqual([
      { quote: 0, other: true, words: "alpha " },
      { quote: 1, other: false, words: "beta gamma" },
      { quote: 1, other: false, words: " delta" },
    ]);
  });

  test("in Chinese, the stepper counts both", async () => {
    await openAt("zh-CN");
    expect(mounted.container.textContent).toContain(LINE);
    expect(mounted.container.textContent).toContain("第 1 处引文，共 2 处");
  });
});
