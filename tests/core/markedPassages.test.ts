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
const SEATS = {
  id: "P2",
  name: "Price sheet",
  text: "Price sheet\n\nTeam plan: $39 per seat a month.\nEnterprise plan: $45 per seat a month, single sign-on included.\nSingle sign-on is included in the Team plan.",
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

  // protects=a quote the Citation check wouldn't find is passed over for the next line holding the claim that it finds; a marker naming no Passage given, or one already recorded, gets no record; fails_when=an unfound quote is recorded, or a record is made for a Passage not given or a marker already backed; no_claim=what becomes of the unbacked marker (the core's test) (#2526).
  test("takes the line holding the claim that the check finds, and nothing for a marker naming no Passage or already recorded", () => {
    const sheet = {
      id: "P2",
      text: "- Enterprise plan: $52 per driver a month.\n- On Enterprise, each driver costs $52 a month.",
    };
    const text = "Enterprise is $52 a driver a month [^2], and route plans come weekly [^7]";
    const found = (_: string, quote: string) => !quote.startsWith("Enterprise plan");
    expect(markedPassages(text, [sheet], found, none)).toEqual({
      text,
      records: [
        { marker: 2, passage: "P2", quote: "On Enterprise, each driver costs $52 a month." },
      ],
    });
    expect(markedPassages(text, [sheet], everywhere, (marker) => marker === 2)).toEqual({
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

  // protects=a marker this path adds never takes a number an earlier reply of the same Answer recorded, so a later reply's marker shows its own Passage; fails_when=the added marker is one already recorded (#2526).
  test("a marker added for a second quote skips the numbers already recorded", () => {
    const text = "Enterprise is $52 a driver [^2]\n\nFrom 50 drivers it is 10% off [^2]";
    expect(markedPassages(text, [PRICES], everywhere, (marker) => marker === 3)).toEqual({
      text: text.replace("10% off [^2]", "10% off [^4]"),
      records: [
        {
          marker: 2,
          passage: "P2",
          quote: "Enterprise plan: $52 per driver a month, with route optimisation.",
        },
        { marker: 4, passage: "P2", quote: "Volume: 10% off Enterprise from 50 drivers." },
      ],
    });
  });

  // protects=a claim resting on several lines of one Passage gets a quote for each line that holds a part of it, a line adding only one word the others lack among them, each under a marker of its own written where the model put its one, and a marker written as the id itself ("[^P3]") is read as the number, in Chinese and in English; fails_when=one of the lines isn't quoted, or "[^P3]" is left in the text; no_claim=whether the judge finds the claim stated (the gate) (#2526).
  test("a claim resting on several lines of one Passage gets a quote for each, and [^P3] is read as [^3]", () => {
    const text =
      "★ 企业版每名司机每月 340 元，50 名司机起打九折，开通费一次性 15,000 元 [^P3]\n→ 报价清楚";
    const prices = {
      id: "P3",
      text: "- 团队版：每名司机每月 190 元。\n- 企业版：每名司机每月 340 元，含路线优化。\n- 批量优惠：企业版 50 名司机起打九折。\n- 开通费：一次性 15,000 元。",
    };
    const { records } = markedPassages(text, [prices], everywhere, none);
    expect(markedPassages(text, [prices], everywhere, none).text).toBe(
      text.replace("[^P3]", "[^3][^4][^5]"),
    );
    expect(records.map((record) => record.quote).sort()).toEqual(
      [
        "企业版：每名司机每月 340 元，含路线优化。",
        "开通费：一次性 15,000 元。",
        "批量优惠：企业版 50 名司机起打九折。",
      ].sort(),
    );
    const integrations = {
      id: "P2",
      text: "- Enterprise plan: $52 a seat a month.\n- Webhooks retry for 24 hours.\n- Connectors are included.",
    };
    const facts =
      "Enterprise is $52 a seat, with connectors and webhooks that retry for 24 hours [^2]";
    expect(
      markedPassages(facts, [integrations], everywhere, none).records.map((each) => each.quote),
    ).toEqual(
      expect.arrayContaining([
        "Enterprise plan: $52 a seat a month.",
        "Webhooks retry for 24 hours.",
        "Connectors are included.",
      ]),
    );
  });

  // protects=of two lines sharing words with a claim, the one holding more of it is quoted, not the shorter one sharing fewer; fails_when=the shorter line with fewer of the claim's words wins (#2526).
  test("the line holding more of the claim is quoted over a shorter one holding less", () => {
    const shop = {
      id: "P2",
      text: "- Every plan includes webhooks.\n- Connectors for the web shop: syncs orders, stock levels, prices, returns and customer records nightly.",
    };
    const [first] = markedPassages(
      "Your web shop connector comes with every plan [^2]",
      [shop],
      everywhere,
      none,
    ).records;
    expect(first?.quote).toBe(
      "Connectors for the web shop: syncs orders, stock levels, prices, returns and customer records nightly.",
    );
  });

  // protects=a figure of the claim that no quote holds leaves no record and the marker goes, so "$39" is never shown found on a line saying "$45", in English and Chinese; fails_when=the line most like the claim is quoted though it gives another figure (#2526).
  test("a figure the claim gives that no line holds leaves no record, and its marker goes", () => {
    const enterprise = {
      id: "P2",
      text: "Enterprise plan: $45 per seat a month, single sign-on included.",
    };
    expect(
      markedPassages("Yes, Enterprise is $39 a seat a month [^2]", [enterprise], everywhere, none),
    ).toEqual({ text: "Yes, Enterprise is $39 a seat a month", records: [] });
    const zh = { id: "P3", text: "企业版：每席位每月 45 元，含单点登录。" };
    expect(markedPassages("企业版每席位每月 39 元 [^3]", [zh], everywhere, none)).toEqual({
      text: "企业版每席位每月 39 元",
      records: [],
    });
    expect(markedPassages("企业版每席位每月 45 元 [^3]", [zh], everywhere, none).records).toEqual([
      { marker: 3, passage: "P3", quote: "企业版：每席位每月 45 元，含单点登录。" },
    ]);
  });

  // protects=in a table beside a line of other figures, the row holding the claim's figures is quoted first and the line of other figures never, and a row giving another of the claim's figures is added to the line giving the first; fails_when=the prose line sharing more CJK pairs wins over the row, the "55 元 from 200 sensors" line is quoted for "60 元", or "down from $14" leaves the claim uncited (#2526).
  test("a table row holding the claim's figures is quoted, never a line about other figures, and a second row adds its figure", () => {
    const plans = {
      id: "P2",
      text: "| 方案 | 每个传感器每月 | 读数保存 |\n|---|---|---|\n| 标准版 | 60 元 | 1 年 |\n| 高级版 | 95 元 | 3 年 |\n\n200 个传感器起，标准版降到每个每月 55 元，高级版降到 85 元。",
    };
    expect(
      markedPassages("标准版每个传感器每月 60 元，读数保存 1 年 [^2]", [plans], everywhere, none)
        .records,
    ).toEqual([{ marker: 2, passage: "P2", quote: "| 标准版 | 60 元 | 1 年 |" }]);
    const call = { id: "P1", text: "[0:03 Them] We'll put in about 250 sensors." };
    const prices = {
      id: "P3",
      text: "| Plan | Price per sensor a month |\n|---|---|\n| Standard | $9 |\n| Premium | $14 |\n\nFrom 200 sensors, Standard drops to $8 a sensor a month and Premium to $12.",
    };
    expect(
      markedPassages(
        "At 250 sensors, Premium drops to $12 a sensor a month, down from $14 [^3]",
        [call, prices],
        everywhere,
        none,
      ).records.map((record) => record.quote),
    ).toEqual([
      "From 200 sensors, Standard drops to $8 a sensor a month and Premium to $12.",
      "| Premium | $14 |",
    ]);
  });

  // protects=a figure said in the call may stand in the claim beside a figure its quote holds, but a figure only the call says, with none of the quote's, leaves no record; fails_when=an answer comparing the asked figure with the Document's loses its Citation, or the asked figure alone is shown found (#2526).
  test("a figure said in the call stands beside one the quote holds, never alone", () => {
    const call = {
      id: "P1",
      text: "[0:03 Them] Will it run on our Android 10 phones at $39 a seat?",
    };
    const app = { id: "P2", text: "The driver app runs on Android 11 and later." };
    expect(
      markedPassages(
        "No, the driver app needs Android 11 or later, so your Android 10 phones won't run it [^2]",
        [call, app],
        everywhere,
        none,
      ).records,
    ).toEqual([
      { marker: 2, passage: "P2", quote: "The driver app runs on Android 11 and later." },
    ]);
    const enterprise = { id: "P2", text: "Enterprise plan: $45 per seat a month." };
    expect(
      markedPassages(
        "Yes, Enterprise runs at $39 a seat [^2]",
        [call, enterprise],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
  });

  // protects=a claim sharing one word with a line, or only words of the Document's name, or only a heading with or without "#", gets no record, and a transcript line's speaker is no word of it; fails_when=a line is quoted on one shared word, the Document's name, a heading or the speaker's label (#2526).
  test("one shared word, the Document's name, a heading or a speaker's label is no ground for a quote", () => {
    const app = {
      id: "P2",
      name: "Driver app",
      text: "Driver app\n\nThe driver app runs on Android 11 and later.\nAdmins must sign in with two-factor authentication.",
    };
    for (const claim of [
      "The driver app has a panic button for emergencies [^2]",
      "Admins get phone support around the clock [^2]",
      "Our driver app is on every phone [^2]",
    ]) {
      expect(markedPassages(claim, [app], everywhere, none).records, claim).toEqual([]);
    }
    const handbook = {
      id: "P4",
      text: "# Connectors and webhooks\nStandard support answers by email within a day.\n\nSupport plans\n\n| Plan | Price per seat | Phone support |\n|---|---|---|\n| Premium | $600 | yes |",
    };
    for (const claim of [
      "Connectors and webhooks come with it [^4]",
      "Both support plans are open to you [^4]",
      "Phone support is priced per seat [^4]",
    ]) {
      expect(markedPassages(claim, [handbook], everywhere, none).records, claim).toEqual([]);
    }
    const call = {
      id: "P1",
      text: "[0:00 Me] Most teams your size start on Standard.\n[0:03 Them] What does it cost?",
    };
    expect(markedPassages("Let me check [^1]", [call], everywhere, none).records).toEqual([]);
  });

  // protects=a claim's plural matches a line's singular ("connectors", "connector"), so the line holding it is quoted; fails_when=words are matched only as written and the claim gets no quote (#2526).
  test("a plural in the claim matches the line's singular", () => {
    const shop = {
      id: "P2",
      text: "- The shop connector is included.\n- Webhooks are included.",
    };
    expect(
      markedPassages("Both connectors are included [^2]", [shop], everywhere, none).records,
    ).toEqual([{ marker: 2, passage: "P2", quote: "The shop connector is included." }]);
  });

  // protects=a claim that is a line said again with a "not" more or less gets no record from that Passage, while a reply's own "No," before a line it restates keeps its Citation; fails_when=the line is quoted for its opposite, or an answer starting "No" loses its quote (#2526).
  test("a line said again with a not more or less is no quote for it", () => {
    expect(
      markedPassages(
        "Single sign-on is not included in the Team plan [^2]",
        [SEATS],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
    const texts = { id: "P2", text: "On Basic, each text message costs $0.05." };
    expect(
      markedPassages("No, on Basic each text message costs $0.05 [^2]", [texts], everywhere, none)
        .records,
    ).toEqual([{ marker: 2, passage: "P2", quote: "On Basic, each text message costs $0.05." }]);
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

  // protects=a marker written after its sentence's full stop is matched on that sentence, never on nothing, and a claim sharing no word with the named Passage loses its marker rather than show another sentence's Citation; fails_when=the first line is quoted for a marker after a full stop, or a claim sharing no word keeps a marker backed by another sentence's quote; no_claim=what becomes of the unbacked marker (the core's test) (#2526).
  test("a marker after the full stop is matched on the sentence before it, and a claim sharing no word loses its marker", () => {
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
