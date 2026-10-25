import { describe, expect, test } from "vitest";
import type { NodeJSON } from "../../src/shared/blockJson";
import { firstLineOfBlocks } from "../../src/shared/noteBlocks";

const text = (value: string): NodeJSON => ({ type: "text", text: value });
const paragraph = (value: string): NodeJSON => ({ type: "paragraph", content: [text(value)] });

describe("the first line of the Blocks an unnamed Mind is about to hold (#1174)", () => {
  test("is the text of the first Block that has any", () => {
    expect(firstLineOfBlocks([{ type: "paragraph" }, paragraph("  "), paragraph("Summary")])).toBe(
      "Summary",
    );
    expect(firstLineOfBlocks([])).toBe("");
  });

  test("is a heading's text, and not the later paragraphs run onto it", () => {
    expect(
      firstLineOfBlocks([
        { type: "heading", attrs: { level: 2 }, content: [text("Summary")] },
        paragraph("The parties agree."),
      ]),
    ).toBe("Summary");
  });

  test("is a list's first item and a table's first cell, not all of them run together", () => {
    const list: NodeJSON = {
      type: "bulletList",
      content: [
        { type: "listItem", content: [paragraph("First item")] },
        { type: "listItem", content: [paragraph("Second item")] },
      ],
    };
    const table: NodeJSON = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [paragraph("Metric")] },
            { type: "tableHeader", content: [paragraph("2024")] },
          ],
        },
      ],
    };
    expect(firstLineOfBlocks([list])).toBe("First item");
    expect(firstLineOfBlocks([table])).toBe("Metric");
  });
});
