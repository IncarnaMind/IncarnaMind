/**
 * A Document's highlights drawn in its page (#327): where each quote is, in a
 * React view's text and in a view that draws its file as DOM, with its note's
 * mark after it.
 */
import { DOMParser } from "linkedom";
import { describe, expect, test } from "vitest";
import type { Annotation } from "../../src/core/api";
import {
  annotationRangesIn,
  noteMarkElement,
  unmarkAnnotationsInDom,
} from "../../src/renderer/src/viewer/annotationMarks";

const AT = "2026-11-03T09:00:00.000Z";

const annotation = (over: Partial<Annotation>): Annotation => ({
  id: "a1",
  documentId: "d1",
  documentName: "Costs",
  contentHash: "v1",
  passageId: null,
  source: "user",
  colour: "yellow",
  quote: "Neap tides come a week later.",
  note: null,
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "page", from: 1, to: 1 },
  check: "found",
  checkReason: null,
  anchor: null,
  author: null,
  missing: false,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const TEXT = "Spring tides come with the new moon.\nNeap tides come a week later.\n";

describe("a highlight in a page", () => {
  test("its words are found in the text, with the highlight's colour and id", () => {
    const green = annotation({
      id: "g1",
      colour: "green",
      quote: "Spring tides come with the new moon.",
    });
    const ranges = annotationRangesIn(TEXT, [green, annotation({})]);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({ id: "g1", colour: "green", start: 0 });
    expect(TEXT.slice(ranges[0]?.start, ranges[0]?.end)).toBe(
      "Spring tides come with the new moon.",
    );
    expect(TEXT.slice(ranges[1]?.start, ranges[1]?.end)).toBe("Neap tides come a week later.");
  });

  test("a missing highlight is not drawn on the words that survive", () => {
    const missing = annotation({ id: "m1", missing: true, note: "Still in the list" });
    expect(annotationRangesIn(TEXT, [missing])).toEqual([]);
    // The same words, still in the version, are drawn.
    expect(annotationRangesIn(TEXT, [annotation({ id: "live" })])).toHaveLength(1);
  });

  test("repeated words are drawn at the place the selection's surroundings fit", () => {
    const twice =
      "Rent.\nThe deposit is held by the landlord.\nReturn.\nThe deposit is held by the landlord.\n";
    const second = annotation({
      id: "second",
      quote: "The deposit is held by the landlord.",
      anchor: {
        parts: [
          {
            unit: null,
            text: "The deposit is held by the landlord.",
            before: "Return.\n",
            after: "\n",
          },
        ],
      },
    });
    const [range] = annotationRangesIn(twice, [second]);
    expect(range?.start).toBe(twice.indexOf("The deposit is held", twice.indexOf("Return.")));
    expect(range?.start).not.toBe(twice.indexOf("The deposit is held"));
  });

  test("one whose words aren't in this version has no range, and so is not drawn", () => {
    expect(annotationRangesIn(TEXT, [annotation({ quote: "This sentence isn't here." })])).toEqual(
      [],
    );
  });

  test("a note's mark is a button with its note's id, and unmarking takes the marks out", () => {
    const page = new DOMParser().parseFromString(
      `<html><body><article><p>Spring tides come with the new moon. <mark data-annotation-id="a1" class="annotation-highlight annotation-highlight--yellow">Neap tides</mark><button data-annotation-note="a1"></button></p></article></body></html>`,
      "text/html",
    );
    const body = page.querySelector("article") as HTMLElement;
    const button = noteMarkElement(
      annotation({ note: "Check the almanac." }),
      page as unknown as globalThis.Document,
      "Edit note",
    );
    expect(button.tagName).toBe("BUTTON");
    expect(button.dataset.annotationNote).toBe("a1");
    expect(button.getAttribute("aria-label")).toBe("Edit note");
    expect(button.className).toBe("annotation-note-mark");

    unmarkAnnotationsInDom(body);
    expect(body.querySelector("mark[data-annotation-id]")).toBeNull();
    expect(body.querySelector("[data-annotation-note]")).toBeNull();
    expect(body.textContent).toBe("Spring tides come with the new moon. Neap tides");
  });
});
