import { describe, expect, test } from "vitest";
import { markedPassages } from "../../src/core/answers/markedPassages";

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
    expect(markedPassages(text, [HEARD, PRICES, ZH], everywhere, none)).toEqual({
      text,
      records: [
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
      ],
    });
  });

  // protects=a quote the Citation check wouldn't find is passed over for the next most alike that it finds; a marker naming no Passage given, or one already recorded, gets no record; fails_when=an unfound quote is recorded, or a record is made for a Passage not given or a marker already backed; no_claim=what becomes of the unbacked marker (the core's test) (#2526).
  test("takes the most alike sentence the check finds, and nothing for a marker naming no Passage or already recorded", () => {
    const text = "Enterprise is $52 a driver [^2], with 10% off from 50 drivers [^7]";
    const found = (_: string, quote: string) => !quote.startsWith("Enterprise plan");
    expect(markedPassages(text, [PRICES], found, none)).toEqual({
      text,
      records: [{ marker: 2, passage: "P2", quote: "Volume: 10% off Enterprise from 50 drivers." }],
    });
    expect(markedPassages(text, [PRICES], everywhere, (marker) => marker === 2)).toEqual({
      text,
      records: [],
    });
  });

  // protects=a Passage named in two sentences that rest on different sentences of it gets a record for each, the second under a marker of its own that the text then holds, and two sentences resting on the same sentence share one; fails_when=both claims get one quote, or a new marker collides with one the reply wrote; no_claim=how the panel numbers them (#2526).
  test("a Passage named by two claims resting on different sentences of it gets a marker for each", () => {
    const text =
      "★ Enterprise is $52 a driver [^2]\n→ holds the price\n\nFrom 50 drivers it is 10% off [^2]\n→ a real lever\n\nThey asked about forty dollars [^1], and Enterprise is still $52 a driver [^2]";
    expect(markedPassages(text, [HEARD, PRICES], everywhere, none)).toEqual({
      text: text.replace("10% off [^2]", "10% off [^3]"),
      records: [
        {
          marker: 2,
          passage: "P2",
          quote: "Enterprise plan: $52 per driver a month, with route optimisation.",
        },
        { marker: 3, passage: "P2", quote: "Volume: 10% off Enterprise from 50 drivers." },
        { marker: 1, passage: "P1", quote: "Could you do Enterprise at forty dollars a driver?" },
      ],
    });
  });

  // protects=a claim resting on several lines of one Passage gets a quote for each line that adds its own words, each under a marker of its own written where the model put its one, and a marker written as the id itself ("[^P3]") is read as the number; fails_when=only one of the lines is quoted, a line adding nothing of the claim is quoted, or "[^P3]" is left in the text; no_claim=whether the judge finds the claim stated (the gate) (#2526).
  test("a claim resting on several lines of one Passage gets a quote for each, and [^P3] is read as [^3]", () => {
    const text =
      "★ 企业版每名司机每月 340 元，50 名司机起打九折，开通费一次性 15,000 元 [^P3]\n→ 报价清楚";
    const prices = {
      id: "P3",
      text: "- 团队版：每名司机每月 190 元。\n- 企业版：每名司机每月 340 元，含路线优化。\n- 批量优惠：企业版 50 名司机起打九折。\n- 开通费：一次性 15,000 元。",
    };
    expect(markedPassages(text, [prices], everywhere, none)).toEqual({
      text: text.replace("[^P3]", "[^3][^4][^5]"),
      records: [
        { marker: 3, passage: "P3", quote: "批量优惠：企业版 50 名司机起打九折。" },
        { marker: 4, passage: "P3", quote: "开通费：一次性 15,000 元。" },
        { marker: 5, passage: "P3", quote: "企业版：每名司机每月 340 元，含路线优化。" },
      ],
    });
  });
});
