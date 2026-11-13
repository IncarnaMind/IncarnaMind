/**
 * What a Citation says of its quote once its Document changed after it was cited (#3041): the same
 * line on its card in the Note and in the viewer, worded from the same answer. Still at its place,
 * now at one other place, in another place (several, or one no Location names), or no longer in the
 * new version. A Note's Citations ask only the re-check they always asked; a card that is open, or
 * the viewer, asks where the quote stands when it isn't at its place, and says nothing of the quote
 * until it knows. The answers are the core's, for a Markdown file whose quote moved from the cited
 * section to another (tests/core/citationKindsChanged.test.ts).
 */
import { act, type ComponentType, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, Document } from "../../src/core/api";
import type { ViewerTarget } from "../../src/renderer/src/store";
import { mountViewerDom } from "../helpers/viewerDom";

// The top layer the card opens in isn't in this DOM: its contents are drawn in place.
vi.mock("../../src/renderer/src/editor/Popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  registerNativePopover: () => undefined,
  unregisterNativePopover: () => undefined,
}));

const INSIDE = "The stored place has no quoted decision.";
const QUOTE = "The final decision is to retain the harbour.";
const FILE = `# Stored\n\n${INSIDE}\n\n# Elsewhere\n\n${QUOTE}\n`;

type Language = "en" | "zh-CN";

const STORED = { kind: "section", heading: "Stored" } as const;

const NOT_HERE = {
  check: "not-found",
  checkReason: "quote-not-on-pages",
  contentHash: "hash-1",
  passageId: "passage-1",
  pageFrom: 1,
  pageTo: 1,
  location: STORED,
};

/** The table of the ruling: the answer a Note's Citation gets, and the one a shown line gets. */
const ROWS: {
  name: string;
  first: object;
  looked: object | null;
  line: Record<Language, string>;
}[] = [
  {
    name: "at its cited place",
    first: { ...NOT_HERE, check: "found", checkReason: null },
    looked: null,
    line: { en: "The quote is still here.", "zh-CN": "引文仍在原处。" },
  },
  {
    name: "in one other place",
    first: NOT_HERE,
    looked: { ...NOT_HERE, elsewhere: { location: { kind: "section", heading: "Elsewhere" } } },
    line: { en: "Its quote is now at § Elsewhere.", "zh-CN": "引文已移到§ Elsewhere。" },
  },
  {
    name: "in several other places, or one no Location names",
    first: NOT_HERE,
    looked: { ...NOT_HERE, elsewhere: { location: null } },
    line: {
      en: "Its quote is in another place in the new version.",
      "zh-CN": "引文在新版本中换了位置。",
    },
  },
  {
    name: "nowhere",
    first: NOT_HERE,
    looked: { ...NOT_HERE, elsewhere: null },
    line: {
      en: "Its quote is no longer in the new version.",
      "zh-CN": "新版本中已找不到这条引文。",
    },
  },
];

const CHANGED = {
  en: "The Document changed after this was cited.",
  "zh-CN": "此文档在被引用后有改动。",
};

const PLACE_LINE = { en: "The cited place", "zh-CN": "引用的位置" };

const DOCUMENT = {
  id: "doc-markdown",
  name: "Scope",
  title: "Scope",
  path: "/tmp/Scope.md",
  kind: "markdown",
  status: "ready",
  contentHash: "hash-1",
  failure: null,
  speakers: null,
  tags: [],
  web: null,
} as unknown as Document;

const calls: Record<string, unknown>[] = [];
let row = ROWS[0] as (typeof ROWS)[number];
/** The look's answer, held back until the test lets it go. */
let held: Promise<void> | null = null;
let mounted: ReturnType<typeof mountViewerDom>;

beforeEach(async () => {
  calls.length = 0;
  held = null;
  mounted = mountViewerDom(() => ({ status: 200, bytes: new TextEncoder().encode(FILE) }), {
    recheckCitation: async (input: Record<string, unknown>) => {
      calls.push(input);
      if (input.lookElsewhere !== true) return row.first;
      await held;
      return row.looked;
    },
  });
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

async function ready(language: Language) {
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
}

/** The viewer opened at the Citation, which cites unit `unit` of the version before. */
async function openViewer(language: Language, unit = 1) {
  await ready(language);
  const textPath = "../../src/renderer/src/viewer/TextView.tsx";
  const headerPath = "../../src/renderer/src/viewer/ViewerHeader.tsx";
  const { TextView } = await import(textPath);
  const { ViewerFrameContext } = await import(headerPath);
  const target: ViewerTarget = {
    documentId: DOCUMENT.id,
    request: 1,
    quote: QUOTE,
    pageFrom: unit,
    pageTo: unit,
    citation: {
      check: "found",
      number: 1,
      pageFrom: unit,
      pageTo: unit,
      location: STORED,
      contentHash: "hash-0",
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

const CITATION: CitationAttributes = {
  passageId: "passage-0",
  documentId: DOCUMENT.id,
  documentName: "Scope",
  contentHash: "hash-0",
  pageFrom: 1,
  pageTo: 1,
  location: STORED,
  quote: QUOTE,
  check: "found",
  checkReason: null,
};

/** The Citation in a Note, its card open when `open`, as a click leaves it. */
async function showInNote(language: Language, open: boolean) {
  await ready(language);
  const { MindIdContext } = await import("../../src/renderer/src/editor/mindContext");
  const { pinCitation } = await import("../../src/renderer/src/pinnedCitation");
  const viewPath = "../../src/renderer/src/editor/CitationView";
  const { CitationView }: { CitationView: ComponentType<Record<string, unknown>> } = await import(
    viewPath
  );
  if (open) pinCitation("note", "text:0");
  await act(() => mounted.root.render(null));
  await act(() =>
    mounted.root.render(
      createElement(
        MindIdContext.Provider,
        { value: "note" },
        createElement(CitationView, {
          node: { attrs: CITATION },
          // Read only, at the Note's top level, with no Note's copy to fix the wording from.
          editor: { isEditable: false, state: { doc: { resolve: () => ({ depth: 0 }) } } },
          getPos: () => 0,
          deleteNode: () => undefined,
          updateAttributes: () => undefined,
          decorations: [],
        } as never),
      ),
    ),
  );
  await settled();
}

/** A sentence's open card, which lists its Citations whose Documents changed. */
async function showSentenceCard(language: Language) {
  await ready(language);
  const { MindIdContext } = await import("../../src/renderer/src/editor/mindContext");
  const noticePath = "../../src/renderer/src/editor/ChangedSourceNotice.tsx";
  const { ChangedCitations }: { ChangedCitations: ComponentType<Record<string, unknown>> } =
    await import(noticePath);
  await act(() => mounted.root.render(null));
  await act(() =>
    mounted.root.render(
      createElement(
        MindIdContext.Provider,
        { value: "note" },
        createElement(ChangedCitations, {
          cited: [{ pos: 0, number: 1, key: "b1:0", attributes: CITATION, footnote: true }],
        }),
      ),
    ),
  );
  await settled();
}

const body = () => mounted.container.ownerDocument.body;
const sentenceNotice = () =>
  [...body().querySelectorAll('[data-testid="citation-changed-notice"] p')].map(
    (each) => each.textContent,
  );
const viewerLine = () =>
  body().querySelector('[data-testid="viewer-citation-changed"]')?.textContent ?? null;
const cardChanged = () =>
  body().querySelector('[data-testid="citation-changed"]')?.textContent ?? null;
const cardLine = () =>
  body().querySelector('[data-testid="citation-changed-quote"]')?.textContent ?? null;
const washed = () =>
  [...body().querySelectorAll("[data-quote-highlight]")].map((each) => each.textContent);
const looks = () => calls.filter((each) => each.lookElsewhere === true).length;

describe("what a Citation says of its quote in its Document's new version (#3041)", () => {
  for (const each of ROWS) {
    for (const language of ["en", "zh-CN"] as const) {
      // protects=for each row of the table (the quote at its cited place, in one other place, in several or in one no Location names, nowhere), the Citation's open card in the Note and the viewer say the same line in English and Chinese, the viewer washes nothing at the new place, and only a quote not at its place is looked for; fails_when=the card and the viewer word it apart, a quote the new version holds reads as no longer in it, the new place is washed, or a quote at its place is looked for; no_claim=how the core finds where it stands (tests/core/quoteElsewhere.test.ts).
      test(`${each.name}, ${language}: the card and the viewer say the same`, async () => {
        row = each;
        await openViewer(language);
        expect(viewerLine()).toBe(
          `${CHANGED[language]}${language === "en" ? " " : ""}${each.line[language]}`,
        );
        expect(washed()).toEqual([]);
        const viewerLooks = looks();
        expect(viewerLooks).toBe(each.looked ? 1 : 0);

        await showInNote(language, true);
        expect(cardChanged()).toContain(CHANGED[language]);
        expect(cardLine()).toBe(each.line[language]);
        expect(looks() - viewerLooks).toBe(each.looked ? 1 : 0);

        // A sentence's card lists the same Citation with the same line.
        await showSentenceCard(language);
        expect(sentenceNotice()).toEqual([CHANGED[language], each.line[language]]);
      });
    }
  }

  // protects=a Note's Citations ask only the re-check they always asked when the Note opens, and none asks where its quote stands until its card is open; fails_when=opening a Note looks through a changed Document for any Citation; no_claim=the time a look takes (the pull request's timing).
  test("opening a Note asks for nothing new; an open card asks", async () => {
    row = ROWS[1] as (typeof ROWS)[number];
    await showInNote("en", false);
    expect(calls).toHaveLength(1);
    expect(looks()).toBe(0);
    await showInNote("en", true);
    expect(looks()).toBe(1);
  });

  // protects=while the look runs, the card says only that the Document changed and nothing about the quote, and the line follows once the look answers; fails_when=the card says the quote is no longer in the new version before the look has answered; no_claim=the wording of the line, held above.
  test("while the look runs, the card says only that the Document changed", async () => {
    row = ROWS[1] as (typeof ROWS)[number];
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await showInNote("en", true);
    expect(looks()).toBe(1);
    expect(cardChanged()).toBe(CHANGED.en);
    expect(cardLine()).toBeNull();
    release();
    await settled();
    expect(cardLine()).toBe("Its quote is now at § Elsewhere.");
  });

  // protects=with the cited place gone from the file, the place's line is left out after either line that says the quote is in another place, and stays after the one that says it is no longer in the new version; fails_when=a place is said gone in the same breath as the quote is said to be elsewhere, or the place's line is lost after "no longer"; no_claim=the place's own wording (tests/renderer/citedPlaceGone.test.ts).
  test("the cited place's line is left out after either moved line, and stays after no longer", async () => {
    for (const each of ROWS.slice(1)) {
      row = each;
      await openViewer("en", 3);
      expect(viewerLine()?.startsWith(CHANGED.en)).toBe(true);
      expect(viewerLine()).toContain(each.line.en);
      expect(viewerLine()?.includes(PLACE_LINE.en)).toBe(each === ROWS[3]);
    }
  });
});
