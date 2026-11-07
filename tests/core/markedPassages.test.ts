import { describe, expect, test } from "vitest";
import { markedPassages, namedInputs } from "../../src/core/answers/markedPassages";

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

  // protects=a calculation input naming a Passage by its number as a marker, with no record of that number, quotes that Passage's first sentence holding its number (not a longer number that starts the same), and other inputs are left as given; fails_when=the input keeps an unrecorded citation the calculation refuses, quotes a sentence without its number, or an input with a record or a passage is changed; no_claim=the calculation itself (#2526).
  test("a calculation input naming a Passage by its marker number quotes the Passage's sentence holding its number", () => {
    const sheet = {
      id: "P2",
      text: "- Team plan: $450 per driver a year.\n- Enterprise plan: $45 per driver a month.\n- Volume: 10% off Enterprise from 50 drivers.",
    };
    const figures = [
      {
        marker: 1,
        inputs: [
          { name: "price", citation: 2, number: "$45" },
          { name: "drivers", citation: 2, number: "50" },
          { name: "kept", citation: 1, number: "60" },
          { name: "given", passage: "P2", quote: "10% off", number: "10%" },
        ],
        formula: "price * drivers",
      },
    ];
    expect(namedInputs(figures, [sheet], (marker) => marker === 1)).toEqual([
      {
        marker: 1,
        inputs: [
          {
            name: "price",
            passage: "P2",
            quote: "Enterprise plan: $45 per driver a month.",
            number: "$45",
          },
          {
            name: "drivers",
            passage: "P2",
            quote: "Volume: 10% off Enterprise from 50 drivers.",
            number: "50",
          },
          { name: "kept", citation: 1, number: "60" },
          { name: "given", passage: "P2", quote: "10% off", number: "10%" },
        ],
        formula: "price * drivers",
      },
    ]);
  });

  // protects=a marker written after its sentence's full stop is matched on that sentence, never on nothing, a heading is never quoted, and a claim sharing no word with the named Passage loses its marker rather than show another sentence's Citation; fails_when=the Document's heading or its first line is quoted for a marker after a full stop, or a claim sharing no word keeps a marker backed by another sentence's quote; no_claim=what becomes of the unbacked marker (the core's test) (#2526).
  test("a marker after the full stop is matched on the sentence before it, no heading is quoted, and a claim sharing no word loses its marker", () => {
    const terms = {
      id: "P4",
      text: "# Contract terms\n\n- Minimum term: 12 months.\n- Invoices are due within 30 days.\n- After the contract ends, we provide a CSV export of your data within 30 days.",
    };
    const text =
      "★ Invoices are due in thirty days, so the 30-day payment term holds. [^4]\n→ confirms it\n\nThe pilot starts in March [^4]";
    expect(markedPassages(text, [terms], everywhere, none)).toEqual({
      text: text.replace("March [^4]", "March"),
      records: [{ marker: 4, passage: "P4", quote: "Invoices are due within 30 days." }],
    });
  });
});
