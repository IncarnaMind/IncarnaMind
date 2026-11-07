/**
 * What every printed page carries (#1258): its number, and a watermark across it. Chromium lays
 * the pages out in the hidden print window; these read what it is given to draw.
 */
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { markPage } from "../../src/renderer/print/marks";

const page = (): HTMLElement => {
  const { document } = parseHTML("<html><body><section class='page'></section></body></html>");
  return document.querySelector("section") as unknown as HTMLElement;
};

describe("A printed page's marks", () => {
  test("a page is numbered from one, at its foot, unless the Note says not", () => {
    const first = page();
    markPage(first, 0, {});
    expect(first.querySelector(".page-number")?.textContent).toBe("1");
    markPage(first, 2, { pageNumbers: true });
    expect([...first.querySelectorAll(".page-number")].map((each) => each.textContent)).toEqual([
      "1",
      "3",
    ]);
    const unnumbered = page();
    markPage(unnumbered, 0, { pageNumbers: false });
    expect(unnumbered.querySelector(".page-number")).toBeNull();
  });

  test("a watermark is drawn on every page, in its words, and reads to no screen reader", () => {
    const described = page();
    markPage(described, 0, { watermark: "DRAFT" });
    const watermark = described.querySelector(".page-watermark");
    expect(watermark?.textContent).toBe("DRAFT");
    expect(watermark?.getAttribute("aria-hidden")).toBe("true");
  });

  test("with no watermark, no watermark is drawn", () => {
    const plain = page();
    markPage(plain, 0, { pageNumbers: true });
    expect(plain.querySelector(".page-watermark")).toBeNull();
  });
});
