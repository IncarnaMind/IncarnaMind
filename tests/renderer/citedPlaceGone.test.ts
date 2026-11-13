/**
 * A Citation whose cited place is no longer in its Document (#2984): the viewer highlights
 * nothing, even where the quote stands elsewhere in the file, and says so on its top line with the
 * place worded as the Citation's chip words it, whether or not the Citation kept its version. A
 * Citation whose place is there is washed as before and the line stays away. The text, Markdown
 * and Transcript views run against a small DOM; the other formats open in the built app (see
 * `e2e/quoteScope.spec.ts`).
 */
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CitationLocation, Document } from "../../src/core/api";
import type { ViewerTarget } from "../../src/renderer/src/store";
import { mountViewerDom } from "../helpers/viewerDom";

const INSIDE = "The stored place has no quoted decision.";
const QUOTE = "The final decision is to retain the harbour.";

const FILES = {
  text: `${INSIDE}\n${QUOTE}\n`,
  markdown: `# Stored\n\n${INSIDE}\n\n# Elsewhere\n\n${QUOTE}\n`,
  transcript: `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${INSIDE}\n\n00:00:05.000 --> 00:00:08.000\n${QUOTE}\n`,
} as const;

type Format = keyof typeof FILES;
type Language = "en" | "zh-CN";

/** Where a Citation to the quote points, and how its chip words that in each language. */
const PLACES: Record<
  Format,
  { location: CitationLocation; words: Record<Language, string>; here: number }
> = {
  text: {
    location: { kind: "lines", from: 9, to: 9 },
    words: { en: "line 9", "zh-CN": "第 9 行" },
    here: 1,
  },
  markdown: {
    location: { kind: "section", heading: "Elsewhere" },
    words: { en: "§ Elsewhere", "zh-CN": "§ Elsewhere" },
    here: 2,
  },
  transcript: {
    location: { kind: "time", from: 5000, to: 8000 },
    words: { en: "0:05", "zh-CN": "0:05" },
    here: 1,
  },
};

const GONE = {
  en: (place: string) => `The cited place (${place}) is no longer in this Document.`,
  "zh-CN": (place: string) => `引用的位置（${place}）已不在此文档中。`,
};

const CHANGED = {
  en: "The Document changed after this was cited.",
  "zh-CN": "此文档在被引用后有改动。",
};

let file = "";
let mounted: ReturnType<typeof mountViewerDom>;

/** The Document's new version holds the quote nowhere. */
const recheckCitation = async () => ({
  check: "not-found",
  checkReason: null,
  contentHash: "hash-1",
  passageId: null,
  pageFrom: null,
  pageTo: null,
  location: null,
});

beforeEach(() => {
  mounted = mountViewerDom(() => ({ status: 200, bytes: new TextEncoder().encode(file) }), {
    recheckCitation,
  });
});

afterEach(async () => {
  await mounted.unmount();
});

const documentOf = (format: Format): Document =>
  ({
    id: `doc-${format}`,
    name: "Scope",
    title: "Scope",
    path: `/tmp/Scope.${format === "markdown" ? "md" : format === "text" ? "txt" : "vtt"}`,
    kind: format,
    status: "ready",
    contentHash: "hash-1",
    failure: null,
    speakers: null,
    tags: [],
  }) as unknown as Document;

/** The file is read, the page drawn and the new version looked at, each a turn of promises. */
const settled = () =>
  act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  });

/**
 * The Document opened by a Citation to a Unit. The Citation keeps no version (an older one), keeps
 * the Document's version, or keeps one the Document has changed since.
 */
type Version = "none" | "kept" | "changed";

async function openAt(format: Format, language: Language, unit: number, version: Version) {
  file = FILES[format];
  const document = documentOf(format);
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useMeetings } = await import("../../src/renderer/src/meetings");
  await act(() => {
    useAppStore.setState({
      status: { kind: "ready" },
      documents: [document],
      settings: { language, device: {} } as never,
    });
    useMeetings.setState({ meetings: [] });
  });
  // Variable paths, so the test's tsconfig (no jsx) leaves the components to the runtime.
  const textPath = "../../src/renderer/src/viewer/TextView.tsx";
  const transcriptPath = "../../src/renderer/src/viewer/TranscriptView.tsx";
  const headerPath = "../../src/renderer/src/viewer/ViewerHeader.tsx";
  const view =
    format === "transcript"
      ? (await import(transcriptPath)).TranscriptView
      : (await import(textPath)).TextView;
  const { ViewerFrameContext } = await import(headerPath);
  const target: ViewerTarget = {
    documentId: document.id,
    request: 1,
    quote: QUOTE,
    pageFrom: unit,
    pageTo: unit,
    citation: {
      check: "found",
      number: 1,
      pageFrom: unit,
      pageTo: unit,
      location: PLACES[format].location,
      ...(version !== "none" && { contentHash: version === "kept" ? "hash-1" : "hash-0" }),
    },
  };
  const frame = { document, target, tabId: "tab-1", preview: false, keep: () => undefined };
  await act(() =>
    mounted.root.render(
      createElement(
        ViewerFrameContext.Provider,
        { value: frame },
        createElement(view, { document, target }),
      ),
    ),
  );
  await settled();
}

const said = () =>
  mounted.container.querySelector('[data-testid="viewer-citation-changed"]')?.textContent ?? null;
const washed = () =>
  [...mounted.container.querySelectorAll("[data-quote-highlight]")].map((each) => each.textContent);

describe("a Citation whose cited place is gone (#2984)", () => {
  for (const format of ["text", "markdown", "transcript"] as const) {
    for (const language of ["en", "zh-CN"] as const) {
      // protects=a place the Document no longer has is said at the viewer's top, in the chip's words, and the quote standing elsewhere in the file is not washed, as in a Citation that kept its version and one that didn't; a place the Document has is washed by its quote and the line stays away; fails_when=the line is missing or worded another way, the quote is washed anyway, or the line shows over a place that is there; no_claim=the other formats, which open in the built app.
      test(`${format}, ${language}: says the place is gone and washes nothing; a place that is there is washed and says nothing`, async () => {
        const place = PLACES[format];
        const line = GONE[language](place.words[language]);
        for (const version of ["none", "kept"] as const) {
          await openAt(format, language, 9, version);
          expect(washed()).toEqual([]);
          expect(said()).toBe(line);
        }

        // The changed-Document line stands first, and the place's follows it.
        await openAt(format, language, 9, "changed");
        expect(washed()).toEqual([]);
        expect(said()?.startsWith(CHANGED[language])).toBe(true);
        expect(said()?.endsWith(line)).toBe(true);

        // This DOM has no Range to wrap a Transcript's quote in: its wash is held by the spec.
        if (format === "transcript") return;
        await openAt(format, language, place.here, "none");
        expect(washed()).toEqual([QUOTE]);
        expect(said()).toBeNull();
      });
    }
  }
});
