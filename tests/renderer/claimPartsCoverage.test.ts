/**
 * The coverage line of a sentence's parts card (#2002): "Covers 3 of the 4 quarters" (覆盖 4 项中的
 * 3 项) sits above the rows only when the sentence has two or more parts; a single part's rows
 * already say what it covers.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckPart } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const source = (quote: string): CitationAttributes => ({
  passageId: `passage-${quote}`,
  documentId: "results",
  documentName: "Results",
  contentHash: "v1",
  quote,
  pageFrom: 1,
  pageTo: 1,
  location: null,
  check: "found",
  checkReason: null,
});

const fact = (start: number, end: number, evidence: CitationAttributes[]): ClaimCheckPart => ({
  span: { start, end },
  kind: "fact",
  verdict: "supported",
  evidence,
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

const CASES = [
  {
    language: "en",
    quantified: "Revenue rose in every quarter",
    other: "costs fell in June",
    joined: "Revenue rose in every quarter, and costs fell in June.",
    unit: "quarters",
    line: "Covers 3 of the 4 quarters",
  },
  {
    language: "zh-CN",
    quantified: "每个季度的收入都增长了",
    other: "六月成本下降了",
    joined: "每个季度的收入都增长了，六月成本下降了。",
    unit: "季度",
    line: "覆盖 4 项中的 3 项",
  },
] as const;

/** A quantified part over four quarters, three of them found. */
const covering = (end: number, unit: string): ClaimCheckPart => ({
  ...fact(0, end, []),
  verdict: "unsupported",
  coverage: {
    quantifier: "all",
    complete: true,
    unit,
    domainEvidence: [source("Q1, Q2, Q3, Q4: the quarters of 2026.")],
    members: [1, 2, 3, 4].map((quarter) => ({
      label: `Q${quarter}`,
      verdict: quarter === 4 ? "unsupported" : "supported",
      evidence: quarter === 4 ? [] : [source(`Q${quarter}: revenue rose.`)],
    })),
  },
});

let root: Root | null = null;
let container: HTMLElement;
let editor: Editor | null = null;

beforeEach(() => {
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
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function card(language: string, text: string, parts: ClaimCheckPart[]) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  const content: JSONContent[] = [{ type: "paragraph", content: [{ type: "text", text }] }];
  editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const rowsPath = "../../src/renderer/src/editor/ClaimPartRows.tsx";
  const { ClaimPartRows }: { ClaimPartRows: ComponentType<Record<string, unknown>> } = await import(
    rowsPath
  );
  await act(() =>
    root?.render(
      createElement(ClaimPartRows, {
        editor,
        id: "check",
        text,
        parts,
        onCheck: () => undefined,
        onOpen: () => undefined,
      }),
    ),
  );
  return {
    line: container.querySelector('[data-testid="claim-parts-coverage"]')?.textContent ?? null,
    rows: container.querySelectorAll('[data-testid="claim-part"]').length,
  };
}

describe.each(CASES)("the coverage line ($language)", (example) => {
  // protects=a sentence of one quantified part shows its member rows and no coverage line (DESIGN.md, D282 as amended for #2002); fails_when=the line shows for one part; no_claim=the rows' own wording.
  test("a single part shows its rows and no coverage line", async () => {
    const sentence = `${example.quantified}${example.language === "en" ? "." : "。"}`;
    const shown = await card(example.language, sentence, [
      covering(example.quantified.length, example.unit),
    ]);
    expect(shown.line).toBeNull();
    expect(shown.rows).toBe(4);
  });

  // protects=a sentence of two parts, one of them quantified, shows the coverage line in the interface language above its rows (#2002); fails_when=the line is missing or worded otherwise; no_claim=its place on screen.
  test("two parts show the coverage line", async () => {
    const at = example.joined.indexOf(example.other);
    const shown = await card(example.language, example.joined, [
      covering(example.quantified.length, example.unit),
      fact(at, at + example.other.length, [source(example.other)]),
    ]);
    expect(shown.line).toBe(example.line);
  });
});
