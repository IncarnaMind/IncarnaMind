/**
 * A Citation whose cited place is no longer in its Document (#2984): the viewer highlights
 * nothing, even where the quote stands elsewhere in the file, and says so on its top line with the
 * place worded as the Citation's chip words it, whether or not the Citation kept its version. A
 * place found by its number but worded by its name (a section, a sheet's rows, lines, a time) may
 * still be in the Document under that name, so its line says it is no longer where it was; and no
 * line follows "Its quote is now at …" or "The quote is still here". A Citation whose place is
 * there is washed as before and the line stays away. The text, Markdown and Transcript views run
 * against a small DOM; the other formats open in the built app (see `e2e/quoteScope.spec.ts`).
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

/**
 * Where a Citation to the quote points and how its chip words that in each language; `gone`, a Unit
 * the file doesn't have (for Markdown the one after its last, as when a section before it was
 * deleted); `here`, one it has; and where the quote now stands when it moved.
 */
const PLACES: Record<
  Format,
  {
    location: CitationLocation;
    words: Record<Language, string>;
    gone: number;
    here: number;
    moved: { pageFrom: number; location: CitationLocation; words: Record<Language, string> };
  }
> = {
  text: {
    location: { kind: "lines", from: 9, to: 9 },
    words: { en: "line 9", "zh-CN": "第 9 行" },
    gone: 9,
    here: 1,
    moved: {
      pageFrom: 1,
      location: { kind: "lines", from: 2, to: 2 },
      words: { en: "line 2", "zh-CN": "第 2 行" },
    },
  },
  markdown: {
    location: { kind: "section", heading: "Elsewhere" },
    words: { en: "§ Elsewhere", "zh-CN": "§ Elsewhere" },
    gone: 3,
    here: 2,
    moved: {
      pageFrom: 2,
      location: { kind: "section", heading: "Elsewhere" },
      words: { en: "§ Elsewhere", "zh-CN": "§ Elsewhere" },
    },
  },
  transcript: {
    location: { kind: "time", from: 5000, to: 8000 },
    words: { en: "0:05", "zh-CN": "0:05" },
    gone: 9,
    here: 1,
    moved: {
      pageFrom: 1,
      location: { kind: "time", from: 5000, to: 8000 },
      words: { en: "0:05", "zh-CN": "0:05" },
    },
  },
};

/** A section, rows, lines or a time are worded by their name, which the Document may still have. */
const GONE = {
  en: (place: string) => `The cited place (${place}) is no longer where it was in this Document.`,
  "zh-CN": (place: string) => `引用的位置（${place}）已不在原处。`,
};

const PLACE_LINE = { en: "The cited place", "zh-CN": "引用的位置" };

const CHANGED = {
  en: "The Document changed after this was cited.",
  "zh-CN": "此文档在被引用后有改动。",
};

const STILL = { en: "The quote is still here.", "zh-CN": "引文仍在原处。" };

let file = "";
let mounted: ReturnType<typeof mountViewerDom>;
let rechecked: object = {};

/** What the Document's new version holds of the quote, looked through: nothing (#3041). */
const NOWHERE = {
  check: "not-found",
  checkReason: "quote-not-on-pages",
  contentHash: "hash-1",
  passageId: null,
  pageFrom: null,
  pageTo: null,
  location: null,
  elsewhere: null,
};

beforeEach(() => {
  rechecked = NOWHERE;
  mounted = mountViewerDom(() => ({ status: 200, bytes: new TextEncoder().encode(file) }), {
    recheckCitation: async () => rechecked,
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
  // Each opening starts afresh: the new version isn't looked at again for the same Citation.
  await act(() => mounted.root.render(null));
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
      const place = PLACES[format];
      const line = GONE[language](place.words[language]);

      // protects=a place the Document has no Unit for is said at the viewer's top, in the chip's words, as "no longer where it was" for a place worded by its name, and the quote standing elsewhere in the file is not washed, as in a Citation that kept its version and one that didn't; a place the Document has is washed by its quote and the line stays away; fails_when=the line is missing, says the place is gone from the Document, the quote is washed anyway, or the line shows over a place that is there; no_claim=the other formats, which open in the built app, and a page or slide, worded by its number (see the unit test).
      test(`${format}, ${language}: says the named place is no longer where it was and washes nothing; a place that is there is washed and says nothing`, async () => {
        for (const version of ["none", "kept"] as const) {
          await openAt(format, language, place.gone, version);
          expect(washed()).toEqual([]);
          expect(said()).toBe(line);
        }
        // The section is still in the file under its name, at a lower number.
        if (format === "markdown") expect(mounted.container.textContent).toContain("Elsewhere");

        // The changed-Document line stands first, and the place's follows "no longer in the new version".
        await openAt(format, language, place.gone, "changed");
        expect(washed()).toEqual([]);
        expect(said()?.startsWith(CHANGED[language])).toBe(true);
        expect(said()?.endsWith(line)).toBe(true);

        // This DOM has no Range to wrap a Transcript's quote in: its wash is held by the spec.
        if (format === "transcript") return;
        await openAt(format, language, place.here, "none");
        expect(washed()).toEqual([QUOTE]);
        expect(said()).toBeNull();
      });

      // protects=the place's line is left out after the line that says where the quote now is, and after the one that says it is still at its place, so the viewer never says a place is gone in the same breath as it names it; fails_when=the line follows either; no_claim=the wording of the changed-Document line, which its own tests hold.
      test(`${format}, ${language}: no line follows "Its quote is now at …" or "The quote is still here."`, async () => {
        rechecked = {
          check: "found",
          checkReason: null,
          contentHash: "hash-1",
          passageId: "passage-1",
          pageFrom: place.moved.pageFrom,
          pageTo: place.moved.pageFrom,
          location: place.moved.location,
        };
        await openAt(format, language, place.gone, "changed");
        const movedTo = place.moved.words[language];
        expect(said()?.startsWith(CHANGED[language])).toBe(true);
        expect(said()?.endsWith(language === "en" ? `${movedTo}.` : `（${movedTo}）。`)).toBe(true);
        expect(said()).not.toContain(PLACE_LINE[language]);

        rechecked = {
          check: "found",
          checkReason: null,
          contentHash: "hash-1",
          passageId: "passage-1",
          pageFrom: place.gone,
          pageTo: place.gone,
          location: place.location,
        };
        await openAt(format, language, place.gone, "changed");
        expect(said()?.endsWith(STILL[language])).toBe(true);
        expect(said()).not.toContain(PLACE_LINE[language]);
      });
    }
  }
});
