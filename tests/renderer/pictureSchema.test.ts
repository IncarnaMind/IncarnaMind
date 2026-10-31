import { getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { PICTURE_NODE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A pasted HTML fragment, parsed as the editor parses a paste. */
function parsed(html: string) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return ProseMirrorDOMParser.fromSchema(getSchema(noteExtensions())).parse(
    document.body as unknown as Node,
  );
}

const picturesIn = (html: string): { src: string; alt: string }[] => {
  const found: { src: string; alt: string }[] = [];
  parsed(html).descendants((node) => {
    if (node.type.name !== PICTURE_NODE) return true;
    found.push({
      src: String(node.attrs.src ?? ""),
      alt: String(node.attrs.alt ?? ""),
    });
    return false;
  });
  return found;
};

describe("a picture Block is only the Note's own data (#1937)", () => {
  test("a picture from a page or from a file is no picture Block, and the words beside it stay", () => {
    // The same markup the editor writes for its own picture, with an address instead of its data.
    expect(
      picturesIn('<img data-type="picture" src="https://images.example/chart.png" alt="A chart">'),
    ).toEqual([]);
    expect(
      picturesIn('<img data-type="picture" src="file:///Users/someone/chart.png" alt="A chart">'),
    ).toEqual([]);
    // The words of the paste are kept: the absence above is not a paste that parsed nothing.
    const doc = parsed(
      '<p>Spring tides rise twice a day.</p><img data-type="picture" src="https://images.example/chart.png">',
    );
    expect(doc.textContent).toContain("Spring tides rise twice a day.");
    expect(doc.childCount).toBe(1);
  });

  test("a picture of the Note's own data is one picture Block, with its description", () => {
    expect(picturesIn(`<img data-type="picture" src="${PIXEL}" alt="A chart">`)).toEqual([
      { src: PIXEL, alt: "A chart" },
    ]);
    // Beside words, as copying part of a Note makes it.
    const doc = parsed(
      `<p>Spring tides.</p><img data-type="picture" src="${PIXEL}" alt="A chart">`,
    );
    expect(doc.childCount).toBe(2);
    expect(doc.textContent).toContain("Spring tides.");
    expect(
      picturesIn(`<p>Spring tides.</p><img data-type="picture" src="${PIXEL}" alt="A chart">`),
    ).toHaveLength(1);
  });
});
