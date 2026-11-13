import { describe, expect, test } from "vitest";
import { readFigures } from "../../src/shared/figures";

const read = (text: string) => readFigures(text).map((figure) => figure.chars);

describe("tonnes written against the number (#3022)", () => {
  // protects=a figure written as an amount reads with a "t" against it ("54,000t", "1.2t", "5万t", "60,000t左右"), and a bare number with a letter after it stays unread, as a section or a name ("15 U.S.C. 78t", "500t" in running text); fails_when="54,000t" reads as nothing, or "78t" reads as 78 tonnes; no_claim=other units written against the number, which the reader already lists.
  test.each([
    ["Output was 54,000t.", ["54,000t"]],
    ["The haul was 1.2t.", ["1.2t"]],
    ["Capacity 5万t", ["5万t"]],
    ["运量达60,000t左右", ["60,000t左右"]],
  ])("%s reads %j", (text, chars) => {
    expect(read(text)).toEqual(chars);
  });

  test.each([["See 15 U.S.C. 78t."], ["Section 78t applies."]])("%s reads no 78t", (text) => {
    expect(read(text)).not.toContain("78t");
  });
});
