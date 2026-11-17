/**
 * A mark made before a check judged each sentence whole keeps its parts, and its card still shows
 * them: a part an absence's whole read decided (#1443) shows only what decided it, never another
 * part's quote.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckPart } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const CASES = [
  {
    language: "en",
    claim: "The lease has no break clause and is governed by English law.",
    absence: "The lease has no break clause",
    rest: "is governed by English law",
    deciding: "This lease is governed by English law",
  },
  {
    language: "zh-CN",
    claim: "租约没有提前解约条款，并且适用英国法律。",
    absence: "租约没有提前解约条款",
    rest: "适用英国法律",
    deciding: "本租约适用英国法律",
  },
] as const;

const quoted = (quote: string): CitationAttributes => ({
  passageId: "lease-p1",
  documentId: "lease",
  documentName: "Lease.md",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

/** The parts as an older mark keeps them: the absence read whole, the rest with its quote. */
function olderParts(example: (typeof CASES)[number]): ClaimCheckPart[] {
  const part = (words: string, more: Partial<ClaimCheckPart>): ClaimCheckPart => {
    const start = example.claim.indexOf(words);
    return {
      span: { start, end: start + words.length },
      kind: "fact",
      verdict: "supported",
      evidence: [],
      says: null,
      unsupported: null,
      calculation: null,
      reason: null,
      detail: null,
      versions: [{ documentId: "lease", contentHash: "v1" }],
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
      ...more,
    };
  };
  return [
    part(example.absence, {
      readDocuments: [
        {
          documentId: "lease",
          documentName: "Lease.md",
          contentHash: "v1",
          locations: [{ kind: "page", from: 1, to: 1 }],
        },
      ],
    }),
    part(example.rest, { evidence: [quoted(example.deciding)] }),
  ];
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

/** The parts' rows as the card renders them. */
async function rows(language: string, text: string, parts: readonly ClaimCheckPart[]) {
  const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
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
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  const container = document.createElement("div", {});
  document.body.append(container);
  const root = createRoot(container);
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  const content: JSONContent[] = [{ type: "paragraph", content: [{ type: "text", text }] }];
  const editor = new Editor({
    element: document.createElement("div", {}),
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  cleanup = async () => {
    await act(() => root.unmount());
    editor.destroy();
    container.remove();
  };
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const rowsPath = "../../src/renderer/src/editor/ClaimPartRows.tsx";
  const {
    cardParts,
    PartBlock,
  }: {
    cardParts(input: Record<string, unknown>): { key: string; words: string }[];
    PartBlock: ComponentType<Record<string, unknown>>;
  } = await import(rowsPath);
  // Every row opened, as Show opens the folded ones, with each of its quotes.
  const shown = cardParts({
    state: editor.state,
    text,
    sentence: text,
    parts,
    stale: false,
    checking: false,
  });
  await act(() =>
    root.render(
      createElement(
        "ol",
        {},
        shown.map((row) =>
          createElement(PartBlock, {
            key: row.key,
            editor,
            row,
            stale: false,
            checking: false,
            lookedIn: "",
            allQuotes: true,
            more: null,
            checkId: "check",
            fix: null,
            drawsFix: false,
            onOpen: () => undefined,
          }),
        ),
      ),
    ),
  );
  return [...container.querySelectorAll('[data-testid="claim-part"]')].map((row, index) => ({
    words: shown[index]?.words ?? "",
    text: row.textContent ?? "",
  }));
}

describe.each(CASES)("an older mark's part decided by its whole read ($language)", (example) => {
  // protects=an older mark's parts still show as rows, each with only its own quotes: the part an absence's whole read decided shows none, and the other part keeps its deciding quote; fails_when=a row is dropped, the parts collapse into one row, the whole-read row shows another part's quote, or the other part loses its own; no_claim=how a check decides a sentence now, which no longer makes parts
  test("shows no other part's quote, and the other part keeps its own", async () => {
    const shown = await rows(example.language, example.claim, olderParts(example));

    expect(shown.map((row) => row.words)).toEqual([example.absence, example.rest]);
    expect(shown[0]?.text).not.toContain(example.deciding);
    expect(shown[1]?.text).toContain(example.deciding);
  });
});
