/**
 * A footnote's mark set as a small raised digit right after an amount is a
 * mark, not one more digit of the amount (#2474): in a PDF's page text and in
 * a Word file's text, as the reader of a table row already reads it (#448).
 */
import { describe, expect, test } from "vitest";
import { extractText } from "../../src/core/documents/extract";
import { extractDocx } from "../../src/core/documents/formats/docx";
import { readFigures } from "../../src/shared/figures";
import { buildPdf, type PdfPage } from "../helpers/pdf";
import { paragraph, STYLES, wordFile } from "../helpers/word";

describe("A PDF page's footnote mark (#2474)", () => {
  const pageText = async (placed: PdfPage["placed"]) => {
    const pdf = buildPdf([{ lines: ["Grants paid 2025"], placed }]);
    const { units } = await extractText("pdf", pdf);
    return units[0]?.text;
  };

  test("a digit set clearly smaller than its line and raised after an amount is kept apart", async () => {
    expect(
      await pageText([
        { text: "Hollin Pumps 1,240.50", x: 72, y: 700 },
        { text: "1", x: 173, y: 703, size: 7 },
      ]),
    ).toBe("Grants paid 2025\nHollin Pumps 1,240.50¹");
  });

  test("digits at the line's own size are part of the amount", async () => {
    expect(
      await pageText([
        { text: "Hollin Pumps 1,240.50", x: 72, y: 700 },
        { text: "1", x: 173, y: 700 },
      ]),
    ).toBe("Grants paid 2025\nHollin Pumps 1,240.501");
    expect(await pageText([{ text: "Hollin Pumps 1,240.51", x: 72, y: 700 }])).toBe(
      "Grants paid 2025\nHollin Pumps 1,240.51",
    );
  });

  test("a raised digit after a word, not an amount, is unchanged", async () => {
    expect(
      await pageText([
        { text: "See the note", x: 72, y: 700 },
        { text: "1", x: 112, y: 703, size: 7 },
      ]),
    ).toBe("Grants paid 2025\nSee the note1");
  });

  test("a raised digit after a bare number is a footnote's mark, never the joined 106", async () => {
    // A power ("10⁶") is set the same way as a footnote's mark; the page can't tell them apart, so the
    // mark is kept apart and the figure is read as 10 with a mark, rather than as the joined 106.
    expect(
      await pageText([
        { text: "Total 10", x: 72, y: 700 },
        { text: "6", x: 108, y: 703, size: 7 },
      ]),
    ).toBe("Grants paid 2025\nTotal 10⁶");
    expect(readFigures("Total 10⁶").map((each) => [each.value, each.footnote])).toEqual([
      [10, "⁶"],
    ]);
  });
});

describe("A Word file's footnote mark (#2474)", () => {
  const mark = (rPr: string) => `<w:r><w:rPr>${rPr}</w:rPr><w:t>1</w:t></w:r>`;
  const style = (id: string, rPr: string) =>
    `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr>${rPr}</w:rPr></w:style>`;
  const amount = "<w:r><w:t>1,240.50</w:t></w:r>";

  test("a superscript set directly, by a character style or by a raised position is a mark", async () => {
    const body = [
      paragraph(amount + mark('<w:vertAlign w:val="superscript"/>')),
      paragraph(amount + mark('<w:rStyle w:val="Raised"/>')),
      paragraph(amount + mark('<w:rStyle w:val="Lifted"/>')),
      paragraph(amount + mark('<w:position w:val="6"/>')),
    ].join("");
    const file = wordFile({
      styles:
        STYLES +
        style("Raised", '<w:vertAlign w:val="superscript"/>') +
        style("Lifted", '<w:position w:val="6"/>'),
      body,
    });

    const { units } = await extractDocx(new Uint8Array(file));

    expect(units.map((unit) => unit.text)).toEqual(["1,240.50¹\n1,240.50¹\n1,240.50¹\n1,240.50¹"]);
  });
});
