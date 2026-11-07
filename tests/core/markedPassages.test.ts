import { describe, expect, test } from "vitest";
import { markedRecords } from "../../src/core/answers/markedPassages";

const PRICES = {
  id: "P2",
  text: "# Price sheet 2026\n\n- Team plan: $29 per driver a month.\n- Enterprise plan: $52 per driver a month, with route optimisation.\n- Volume: 10% off Enterprise from 50 drivers.",
};
const HEARD = {
  id: "P1",
  text: "[0:04 Them] Could you do Enterprise at forty dollars a driver?",
};
const ZH = {
  id: "P3",
  text: "- 团队版：每名司机每月 190 元。\n- 企业版：每名司机每月 340 元，含路线优化。",
};
const everywhere = () => true;
const none = () => false;

describe("Records for a reply that names its Passages in its markers", () => {
  // protects=each marker naming a Passage the model was given is recorded with that Passage's sentence most like its claim, without list marks or a transcript line's time and speaker, in English and Chinese; fails_when=another sentence or Passage is quoted, or a mark is left in the quote; no_claim=whether the Citation check finds it (the core's test) (#2526).
  test("quotes the sentence of the named Passage most like the marked claim, as a quote is written", () => {
    const text =
      "★ Enterprise stays at $52 a driver, with route optimisation [^2]\n→ holds the price\n\nThey asked for forty dollars [^1]\n\n企业版每名司机每月 340 元 [^3]";
    expect(markedRecords(text, [HEARD, PRICES, ZH], everywhere, none)).toEqual([
      {
        marker: 2,
        passage: "P2",
        quote: "Enterprise plan: $52 per driver a month, with route optimisation.",
      },
      {
        marker: 1,
        passage: "P1",
        quote: "Could you do Enterprise at forty dollars a driver?",
      },
      { marker: 3, passage: "P3", quote: "企业版：每名司机每月 340 元，含路线优化。" },
    ]);
  });

  // protects=a quote the Citation check wouldn't find is passed over for the next most alike that it finds; a marker naming no Passage given, or one already recorded, gets no record; fails_when=an unfound quote is recorded, or a record is made for a Passage not given or a marker already backed; no_claim=what becomes of the unbacked marker (the core's test) (#2526).
  test("takes the most alike sentence the check finds, and nothing for a marker naming no Passage or already recorded", () => {
    const text = "Enterprise is $52 a driver [^2], with 10% off from 50 drivers [^7]";
    const found = (_: string, quote: string) => !quote.startsWith("Enterprise plan");
    expect(markedRecords(text, [PRICES], found, none)).toEqual([
      { marker: 2, passage: "P2", quote: "Volume: 10% off Enterprise from 50 drivers." },
    ]);
    expect(markedRecords(text, [PRICES], everywhere, (marker) => marker === 2)).toEqual([]);
  });
});
