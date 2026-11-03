/**
 * The print page cuts a block at a page break inside it (#746): a list item, a
 * quote. Each ordered list goes on counting after the break from the items
 * before it, and an item cut in two shows its number once.
 */
import { DOMParser } from "linkedom";
import { describe, expect, test } from "vitest";
import { apartAtBreaks } from "../../src/renderer/print/pageBreaks";

const BREAK = '<div class="page-break"></div>';

function blockOf(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    "text/html",
  );
  const block = doc.body.firstElementChild;
  if (!block) throw new Error("No block.");
  return block as unknown as HTMLElement;
}

/** What a part shows: each list item with the number it is drawn with, or none for a continued one. */
function shown(part: HTMLElement): string[] {
  if (part.classList.contains("page-break")) return ["(page break)"];
  if (part.localName !== "ol" && part.localName !== "ul") return [part.textContent ?? ""];
  let number = Number(part.getAttribute("start") ?? "1");
  return [...part.children].map((item) => {
    const own = [...item.childNodes]
      .filter((each) => each.nodeName.toLowerCase() !== "ol")
      .map((each) => each.textContent ?? "")
      .join("");
    const nested = [...item.children].filter((each) => each.localName === "ol");
    const label = item.classList.contains("continued")
      ? ""
      : `${part.localName === "ol" ? number : "•"}. `;
    number += 1;
    return [
      label + own,
      ...nested.flatMap((each) => shown(each as HTMLElement).map((line) => `  ${line}`)),
    ].join("\n");
  });
}

const apart = (html: string) => apartAtBreaks(blockOf(html)).map(shown);

describe("a page break inside a block, in the PDF", () => {
  test.each([
    ["English", ["Clause one.", "Clause two begins.", "Clause two ends.", "Clause three."]],
    ["Chinese", ["第一条。", "第二条前半。", "第二条后半。", "第三条。"]],
  ])(
    "in a list's second item: the list goes on counting from it, the item numbered once (%s)",
    (_, [one, begins, ends, three]) => {
      expect(
        apart(
          `<ol><li><p>${one}</p></li><li><p>${begins}</p>${BREAK}<p>${ends}</p></li><li><p>${three}</p></li></ol>`,
        ),
      ).toEqual([[`1. ${one}`, `2. ${begins}`], ["(page break)"], [ends, `3. ${three}`]]);
    },
  );

  test("at the start of an item: the item and its number go to the next page", () => {
    expect(
      apart(
        `<ol start="4"><li><p>Four.</p></li><li>${BREAK}<p>Five.</p></li><li><p>Six.</p></li></ol>`,
      ),
    ).toEqual([["4. Four."], ["(page break)"], ["5. Five.", "6. Six."]]);
  });

  test("in a list inside a list: each goes on counting", () => {
    expect(
      apart(
        `<ol><li>One.<ol><li>a</li><li>b${BREAK}b too</li><li>c</li></ol></li><li>Two.</li></ol>`,
      ),
    ).toEqual([["1. One.\n  1. a\n  2. b"], ["(page break)"], ["\n  b too\n  3. c", "2. Two."]]);
  });

  test("twice in a quote: three parts with a break between each", () => {
    expect(
      apart(`<blockquote><p>One.</p>${BREAK}<p>Two.</p>${BREAK}<p>Three.</p></blockquote>`),
    ).toEqual([["One."], ["(page break)"], ["Two."], ["(page break)"], ["Three."]]);
  });
});
