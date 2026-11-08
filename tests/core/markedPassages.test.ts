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

  // protects=a quote the Citation check wouldn't find is passed over for the next line holding the claim that it finds; a marker naming no Passage given gets no record and goes, so it never shows a record its number holds, and one an earlier reply recorded is read as naming its Passage anew, under a marker of its own, so it never shows the record its number already holds; fails_when=an unfound quote is recorded, a record is made for a Passage not given, or a recorded marker keeps the earlier record; no_claim=what becomes of the unbacked marker (the core's test) (#2526).
  test("takes the line holding the claim that the check finds, nothing for a marker naming no Passage, and a marker of its own for a recorded one", () => {
    const sheet = {
      id: "P2",
      text: "- Enterprise plan: $52 per driver a month.\n- On Enterprise, each driver costs $52 a month.",
    };
    const text = "Enterprise is $52 a driver a month [^2], and route plans come weekly [^7]";
    const found = (_: string, quote: string) => !quote.startsWith("Enterprise plan");
    expect(markedPassages(text, [sheet], found, none)).toEqual({
      text: "Enterprise is $52 a driver a month [^2], and route plans come weekly",
      records: [
        { marker: 2, passage: "P2", quote: "On Enterprise, each driver costs $52 a month." },
      ],
    });
    expect(markedPassages(text, [sheet], found, (marker) => marker === 2)).toEqual({
      text: "Enterprise is $52 a driver a month [^8], and route plans come weekly",
      records: [
        { marker: 8, passage: "P2", quote: "On Enterprise, each driver costs $52 a month." },
      ],
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
  // protects=a heading is never quoted and its words are no evidence: a "#" line inside a block, a line wholly in bold, and a short line with no closing punctuation that starts a block and runs straight into its text; fails_when=the "#" filter, the bold rule or the start-of-block rule is taken out and the heading is quoted (#2526).
  test("a heading inside a block, in bold or running straight into its text is never quoted", () => {
    const inBlock = {
      id: "P4",
      text: "Standard support answers by email within a day.\n# Connectors and webhooks\nWebhooks retry for 24 hours.",
    };
    expect(
      markedPassages("Connectors and webhooks come with it [^4]", [inBlock], everywhere, none),
    ).toEqual({ text: "Connectors and webhooks come with it", records: [] });
    for (const text of [
      "Premium support\nPremium answers critical alerts within 30 minutes.\nStandard support answers by email within a day.",
      "Standard support answers by email within a day.\n**Premium support**\nPremium answers critical alerts within 30 minutes.",
    ]) {
      const heading = text;
      const support = { id: "P4", text };
      expect(
        markedPassages("Premium support includes phone support [^4]", [support], everywhere, none)
          .records,
        heading,
      ).toEqual([]);
      expect(
        markedPassages(
          "Premium answers critical alerts within 30 minutes [^4]",
          [support],
          everywhere,
          none,
        ).records,
        heading,
      ).toEqual([
        { marker: 4, passage: "P4", quote: "Premium answers critical alerts within 30 minutes." },
      ]);
    }
  });

  // protects=words are matched with their endings folded, plural, -ies, -ed and -ly ("connectors" and "connector", "batteries" and "battery", "billing" and "billing", "yearly" and "year"); fails_when=a rule is taken out and the line holding the claim loses its quote (#2526).
  test("a word matches the line's word with another ending", () => {
    const sheet = {
      id: "P2",
      text: "- The shop connector is included.\n- Each battery is swappable.\n- Billing happens once a year.\n- Gateways cost $180 each.",
    };
    for (const [claim, quote] of [
      ["Both connectors are included [^2]", "The shop connector is included."],
      ["Batteries are swappable [^2]", "Each battery is swappable."],
      ["Billing is yearly [^2]", "Billing happens once a year."],
    ] as const) {
      expect(markedPassages(claim, [sheet], everywhere, none).records, claim).toEqual([
        { marker: 2, passage: "P2", quote },
      ]);
    }
  });

  // protects=a figure is held only by one of its kind: "9 years" not by "$9", "50 drivers" not by "50%", "30 seats" not by a call line's time "0:30", while "$1,200", "1200 dollars" and a time named in the claim are; fails_when=figures are matched as bare digits and the line is quoted for another quantity (#2526).
  test("a figure is held only by one of its kind: an amount, a percentage, a time", () => {
    const sensors = {
      id: "P3",
      text: "| Plan | Price per sensor a month | Readings kept |\n|---|---|---|\n| Standard | $9 | 1 year |",
    };
    expect(
      markedPassages("Standard keeps readings for 9 years [^3]", [sensors], everywhere, none)
        .records,
    ).toEqual([]);
    const volume = { id: "P2", text: "Volume: 50% off Enterprise for drivers on the yearly plan." };
    expect(
      markedPassages(
        "Enterprise needs 50 drivers on the yearly plan [^2]",
        [volume],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
    const call = {
      id: "P1",
      text: "[0:30 Them] We need about 20 seats.\n[5:56 Them] We need single sign-on for every seat.",
    };
    expect(markedPassages("They need 30 seats [^1]", [call], everywhere, none).records).toEqual([]);
    expect(
      markedPassages("At 5:56 they said they need single sign-on [^1]", [call], everywhere, none)
        .records,
    ).toEqual([{ marker: 1, passage: "P1", quote: "We need single sign-on for every seat." }]);
    const setup = { id: "P2", text: "Setup costs 1200 dollars, once." };
    expect(markedPassages("Setup is $1,200 once [^2]", [setup], everywhere, none).records).toEqual([
      { marker: 2, passage: "P2", quote: "Setup costs 1200 dollars, once." },
    ]);
  });

  // protects=a number in words or Chinese numerals is a figure on both sides: "twelve months" is not held by "24 months", 八折 not by 九折, while "2 weeks" is held by "two weeks" and "2 周" by 两周; a reply's "the one" or 每一 is no figure; fails_when=number words stay words, so a wrong number shows found or a right one loses its quote (#2526).
  test("a number in words or Chinese numerals is a figure", () => {
    const term = { id: "P4", text: "Minimum term: 24 months.\nOnboarding takes about two weeks." };
    expect(
      markedPassages("The minimum term is twelve months [^4]", [term], everywhere, none).records,
    ).toEqual([]);
    expect(
      markedPassages("Onboarding takes about 2 weeks [^4]", [term], everywhere, none).records,
    ).toEqual([{ marker: 4, passage: "P4", quote: "Onboarding takes about two weeks." }]);
    const zh = { id: "P3", text: "- 批量优惠：企业版 50 名司机起打九折。\n- 上线约两周完成。" };
    expect(markedPassages("企业版 50 名司机起打八折 [^3]", [zh], everywhere, none).records).toEqual(
      [],
    );
    expect(markedPassages("上线约 2 周完成 [^3]", [zh], everywhere, none).records).toEqual([
      { marker: 3, passage: "P3", quote: "上线约两周完成。" },
    ]);
    const plans = { id: "P2", text: "Enterprise is the plan with route optimisation." };
    expect(
      markedPassages(
        "Enterprise is the one with route optimisation [^2]",
        [plans],
        everywhere,
        none,
      ).records,
    ).toEqual([
      { marker: 2, passage: "P2", quote: "Enterprise is the plan with route optimisation." },
    ]);
  });

  // protects=a name the Passage gives a row or a thing (a table row's first cell, a line's lead before its colon, a word in capitals past a sentence's start) that the claim says is in a quote taken for it, so a figure moved to another row's name ("Team is $52" against "Enterprise plan: $52", 团队版 against 企业版, "on Basic" against "on Standard and Premium") is never shown found; a word that is no name, said beside the quoted fact, costs no Citation; fails_when=the line holding the figure is quoted though the claim names another row, or a promise beside a quoted fact loses its Citation (#2526).
  test("a name the claim gives that no quote holds leaves no record", () => {
    expect(markedPassages("Team is $52 a driver a month [^2]", [PRICES], everywhere, none)).toEqual(
      {
        text: "Team is $52 a driver a month",
        records: [],
      },
    );
    expect(
      markedPassages("团队版每名司机每月 340 元 [^3]", [ZH], everywhere, none).records,
    ).toEqual([]);
    const plans = {
      id: "P2",
      text: "| Plan | Price per sensor a month |\n|---|---|\n| Basic | $6 |\n| Standard | $9 |\n\nText-message alerts are included on Standard and Premium. On Basic, each text message costs $0.05.",
    };
    expect(
      markedPassages("Text-message alerts are included on Basic [^2]", [plans], everywhere, none)
        .records,
    ).toEqual([]);
    expect(
      markedPassages(
        "Yes, Team is $29 a driver, a fair start for you [^2]",
        [PRICES],
        everywhere,
        none,
      ).records,
    ).toEqual([{ marker: 2, passage: "P2", quote: "Team plan: $29 per driver a month." }]);
    const terms = {
      id: "P4",
      text: "Minimum term: 12 months.\nAfter the contract ends, we provide a CSV export of your data within 30 days.",
    };
    expect(
      markedPassages(
        "Our minimum term is 12 months; I can confirm the data export details in writing after the call [^4]",
        [terms],
        everywhere,
        none,
      ).records,
    ).toEqual([{ marker: 4, passage: "P4", quote: "Minimum term: 12 months." }]);
  });

  // protects=a figure of the Document's name or a heading may stand in the claim without a quote holding it ("our 2026 service levels"), while every other figure must; fails_when=the claim naming its Document's year loses its Citation (#2526).
  test("a figure of the Document's name or heading needs no quote", () => {
    const levels = {
      id: "P2",
      name: "Service levels 2026",
      text: "# Service levels 2026\n\nUrgent tickets: answered within 1 hour on Enterprise, 4 hours on Team.",
    };
    expect(
      markedPassages(
        "Under our 2026 service levels it's 1 hour on Enterprise [^2]",
        [levels],
        everywhere,
        none,
      ).records,
    ).toEqual([
      {
        marker: 2,
        passage: "P2",
        quote: "Urgent tickets: answered within 1 hour on Enterprise, 4 hours on Team.",
      },
    ]);
  });

  // protects=a Chinese claim whose words other lines hold too (版每 in 标准版每个, 一次 in 上报一次), and which names its row, keeps the row's quote; fails_when=a word that is no name blocks the Citation (#2526).
  test("a Chinese claim keeps its quote when other lines hold some of its words", () => {
    const plans = {
      id: "P2",
      name: "监控方案",
      text: "# 监控方案\n\n各方案的区别在于传感器多久上报一次。\n\n| 方案 | 每个传感器每月 | 上报间隔 | 读数保存 |\n|---|---|---|---|\n| 标准版 | 60 元 | 每 5 分钟 | 1 年 |\n\n基础版每条短信 0.3 元。",
    };
    expect(
      markedPassages(
        "标准版每 5 分钟上报一次，每个每月 60 元，读数存 1 年 [^2]",
        [plans],
        everywhere,
        none,
      ).records,
    ).toEqual([{ marker: 2, passage: "P2", quote: "| 标准版 | 60 元 | 每 5 分钟 | 1 年 |" }]);
  });

  // protects=a Passage with a line saying the claim's opposite gives it nothing: "doesn't include", "without", 不含, 没有, a line that negates what the claim says, and "Not quite, … is in" against "… is not included in"; while a negation of something the line doesn't say ("aren't included on Basic", "your Android 10 phones won't run it"), of another thing than the line names ("Team can't include live traffic" against "…on Enterprise only"), or a claim saying a word both ways keeps its quote; fails_when=the line is quoted for its opposite, or a claim with its own negation loses a quote that states it (#2526).
  test("a Passage with a line saying the claim's opposite gives it nothing", () => {
    const included = {
      id: "P2",
      text: "Team plan: $39 per seat a month.\nSingle sign-on is included in the Team plan.",
    };
    const notIncluded = {
      id: "P2",
      text: "Team plan: $39 per seat a month.\nSingle sign-on is not included in the Team plan.",
    };
    for (const [claim, passage] of [
      ["The Team plan doesn't include single sign-on [^2]", included],
      ["The Team plan comes without single sign-on [^2]", included],
      ["Sadly, single sign-on is not included in the Team plan for your drivers [^2]", included],
      ["The Team plan includes single sign-on [^2]", notIncluded],
      ["Not quite, single sign-on is in the Team plan [^2]", notIncluded],
      [
        "团队版不含单点登录 [^2]",
        { id: "P2", text: "团队版含单点登录。\n企业版每席位每月 45 元。" },
      ],
      ["团队版没有单点登录 [^2]", { id: "P2", text: "单点登录包含在团队版中。" }],
      ["团队版包含单点登录 [^2]", { id: "P2", text: "团队版不包含单点登录。" }],
    ] as const) {
      expect(markedPassages(claim, [passage], everywhere, none).records, claim).toEqual([]);
    }
    const texts = {
      id: "P2",
      text: "Text-message alerts are included on Standard and Premium. On Basic, each text message costs $0.05.\nEvery plan includes email alerts.",
    };
    expect(
      markedPassages(
        "Text alerts aren't included on Basic; each text message costs $0.05 [^2]",
        [texts],
        everywhere,
        none,
      ).records.map((record) => record.quote),
    ).toEqual([
      "On Basic, each text message costs $0.05.",
      "Text-message alerts are included on Standard and Premium.",
    ]);
    expect(
      markedPassages(
        "Text-message alerts are not included on Standard and Premium [^2]",
        [texts],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
    const traffic = {
      id: "P2",
      text: "- A route holds up to 200 stops.\n- Live traffic data is included on Enterprise only.",
    };
    expect(
      markedPassages(
        "Team can't include live traffic, but Enterprise has it [^2]",
        [traffic],
        everywhere,
        none,
      ).records,
    ).toEqual([
      { marker: 2, passage: "P2", quote: "Live traffic data is included on Enterprise only." },
    ]);
    const routes = {
      id: "P2",
      text: "- Routes are re-planned every 15 minutes during the day.\n- A route holds up to 200 stops.\n- Live traffic data is included on Enterprise only.",
    };
    expect(
      markedPassages(
        "I can't add live traffic to Team, but Team still gives you routes of up to 200 stops, re-planned every 15 minutes [^2]",
        [{ id: "P1", text: "Team plan: $29 per driver a month." }, routes],
        everywhere,
        none,
      ).records.length,
    ).toBeGreaterThan(0);
    const connectors = {
      id: "P2",
      text: "- SAP connector: Enterprise only, at $300 a month.\n- Shopify connector: free on every plan.",
    };
    expect(
      markedPassages(
        "Our SAP connector is Enterprise only, at $300 a month, so it isn't free on every plan; Shopify is free on every plan [^2]",
        [connectors],
        everywhere,
        none,
      ).records.map((record) => record.quote),
    ).toEqual([
      "SAP connector: Enterprise only, at $300 a month.",
      "Shopify connector: free on every plan.",
    ]);
    const lock = {
      id: "P2",
      text: "Prices are fixed for the first 24 months of a contract; after that, a yearly increase is capped at 4%.",
    };
    expect(
      markedPassages(
        "We can't fix prices for longer, but prices are fixed for 24 months and capped at 4% a year after that [^2]",
        [lock],
        everywhere,
        none,
      ).records.map((record) => record.quote),
    ).toEqual([lock.text]);
  });

  // protects=a figure the call said, standing in the claim, draws no further quote from a line that happens to hold it ("minus forty" against "40 probes"); fails_when=the line about gateways is quoted beside the line about temperatures (#2526).
  test("a figure the call said draws no further quote from a line that happens to hold it", () => {
    const call = { id: "P1", text: "[0:05 Them] Do the probes work down to minus forty?" };
    const hardware = {
      id: "P2",
      text: "Each probe works from -30 °C to +60 °C and is accurate to ±0.3 °C.\nOne gateway covers up to 40 probes within 100 metres.",
    };
    expect(
      markedPassages(
        "Down to minus forty: contradicted, the probes work from -30 °C to +60 °C [^2]",
        [call, hardware],
        everywhere,
        none,
      ).records,
    ).toEqual([
      {
        marker: 2,
        passage: "P2",
        quote: "Each probe works from -30 °C to +60 °C and is accurate to ±0.3 °C.",
      },
    ]);
  });
  // protects=a claim saying "they" and not "we" quotes no line the transcript marks "Me", and one saying "I" or "we" and not "they" none marked "Them", in English and Chinese, while a claim naming neither side quotes either; fails_when=the User's own line is quoted for what the other side said, or the reverse (#2526).
  test("a claim naming one side of the call quotes no line of the other's", () => {
    const call = {
      id: "P1",
      text: "[0:00 Me] Most teams start with 100 sensors.\n[0:30 Them] We need about 20 seats.\n[0:41 Them] 我们先上 100 个传感器。",
    };
    expect(
      markedPassages("They will start with 100 sensors [^1]", [call], everywhere, none).records,
    ).toEqual([]);
    expect(
      markedPassages("They need about 20 seats [^1]", [call], everywhere, none).records,
    ).toEqual([{ marker: 1, passage: "P1", quote: "We need about 20 seats." }]);
    expect(
      markedPassages("We usually start teams on 100 sensors [^1]", [call], everywhere, none)
        .records,
    ).toEqual([{ marker: 1, passage: "P1", quote: "Most teams start with 100 sensors." }]);
    expect(markedPassages("对方先上 100 个传感器 [^1]", [call], everywhere, none).records).toEqual([
      { marker: 1, passage: "P1", quote: "我们先上 100 个传感器。" },
    ]);
  });
  // protects=the trust pre-review's figure cases: "one week" is 1 against "two weeks", a unit of time is part of a figure ("12 weeks" is not "12 months", "30 days" not "30 minutes"), a multiplier ("$52k") and a minus sign ("-30 °C") too, a line's "every minute" holds a claim's "one-minute", and only a year of the Document's name is no figure to hold ("Q3" is); fails_when=the line is quoted for another quantity (#2526).
  test("a figure keeps its unit, scale and sign, and 'one week' is a figure", () => {
    const plan = {
      id: "P4",
      name: "Q3 price sheet",
      text: "Onboarding takes about two weeks.\nMinimum term: 12 months.\nPremium answers critical alerts within 30 minutes.\nEnterprise plan: $52 per driver a month.\nProbes work from -30 °C to +60 °C.",
    };
    for (const claim of [
      "Onboarding takes one week [^4]",
      "Onboarding takes 3 weeks [^4]",
      "The minimum term is 12 weeks [^4]",
      "Premium answers critical alerts within 30 days [^4]",
      "Enterprise plan is $52k per driver a month [^4]",
      "Probes work from 30 °C to 60 °C [^4]",
      "Onboarding takes 3 sessions over about two weeks [^4]",
    ]) {
      expect(markedPassages(claim, [plan], everywhere, none).records, claim).toEqual([]);
    }
    for (const [claim, quote] of [
      ["Onboarding takes about 2 weeks [^4]", "Onboarding takes about two weeks."],
      ["The minimum term is 12 months [^4]", "Minimum term: 12 months."],
      ["Probes work from -30 °C to +60 °C [^4]", "Probes work from -30 °C to +60 °C."],
    ] as const) {
      expect(markedPassages(claim, [plan], everywhere, none).records, claim).toEqual([
        { marker: 4, passage: "P4", quote },
      ]);
    }
    const zh = { id: "P3", text: "上线约两周完成。" };
    expect(markedPassages("上线约一周完成 [^3]", [zh], everywhere, none).records).toEqual([]);
    const battery = {
      id: "P2",
      text: "Battery life is about 5 years when a probe reports every 15 minutes, and 2 years at every minute.",
    };
    expect(
      markedPassages(
        "At one-minute reporting, the battery lasts about 2 years [^2]",
        [battery],
        everywhere,
        none,
      ).records,
    ).toEqual([{ marker: 2, passage: "P2", quote: battery.text }]);
  });

  // protects=a figure the call said stands in a claim only beside the quote's figures, never in place of the quote's own figure of its kind ("15% off" said for a line's "10% off", "from 40 drivers" for "from 50"), unless the line's figure is a bound the said one meets ("At 250 sensors" for "From 200 sensors") or the claim holds a quote's figure of its kind beside it ("Android 10" beside "Android 11", the line's "iOS 16" notwithstanding); fails_when=a figure the customer asked for is shown found as the Document's (#2526).
  test("a figure the call said never stands in place of the quote's own figure", () => {
    const volume = { id: "P2", text: "Volume: 10% off Enterprise from 50 seats." };
    const asked = {
      id: "P1",
      text: "[0:10 Them] We want a 15% discount, and we'll have 40 seats.",
    };
    for (const claim of [
      "Enterprise is 15% off from 50 seats [^2]",
      "From 40 seats, Enterprise is 10% off [^2]",
    ]) {
      expect(markedPassages(claim, [asked, volume], everywhere, none).records, claim).toEqual([]);
    }
    const phones = { id: "P1", text: "[0:03 Them] Our drivers have Android 10 phones." };
    const app = {
      id: "P2",
      text: "The driver app runs on Android 11 and later and iOS 16 and later.",
    };
    expect(
      markedPassages(
        "No, the driver app needs Android 11 or later, so your Android 10 phones won't run it [^2]",
        [phones, app],
        everywhere,
        none,
      ).records,
    ).toEqual([{ marker: 2, passage: "P2", quote: app.text }]);
    const larger = { id: "P1", text: "[0:10 Them] We'll have 60 seats." };
    expect(
      markedPassages("At 60 seats, Enterprise is 10% off [^2]", [larger, volume], everywhere, none)
        .records,
    ).toEqual([{ marker: 2, passage: "P2", quote: "Volume: 10% off Enterprise from 50 seats." }]);
  });

  // protects=the trust pre-review's negation cases: "cannot", a Chinese claim whose first clause holds its negation (不含…，需另付费), an English lead that is no answer word ("Not included:"), a line whose negation sits after its lead ("Team plan: …, single sign-on not included."), and a claim saying a word both ways whose negated clause restates the line; fails_when=the line saying the opposite is quoted (#2526).
  test("more ways of saying the opposite give nothing", () => {
    const included = { id: "P2", text: "Single sign-on is included in the Team plan." };
    for (const claim of [
      "The Team plan cannot include single sign-on [^2]",
      "Not included: single sign-on on the Team plan [^2]",
      "Single sign-on isn't included in the Team plan, but it is included in Enterprise [^2]",
    ]) {
      expect(markedPassages(claim, [included], everywhere, none).records, claim).toEqual([]);
    }
    expect(
      markedPassages(
        "团队版不含单点登录，需另付费 [^2]",
        [{ id: "P2", text: "团队版含单点登录。" }],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
    expect(
      markedPassages(
        "The Team plan includes single sign-on [^2]",
        [{ id: "P2", text: "Team plan: $39 per seat a month, single sign-on not included." }],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
  });

  // protects=a row's name is known from every Passage given, so a reply naming the wrong Passage ("Team is $52" on the Passage holding Enterprise's line, with Team's on another) gets nothing; fails_when=only the named Passage's names count and the Enterprise line is quoted for Team (#2526).
  test("a name from another Passage given counts against a quote naming another row", () => {
    const team = { id: "P2", text: "Team plan: $29 per driver a month." };
    const enterprise = { id: "P3", text: "Enterprise plan: $52 per driver a month." };
    expect(
      markedPassages("Team is $52 a driver a month [^3]", [team, enterprise], everywhere, none)
        .records,
    ).toEqual([]);
  });

  // protects=a claim's side is the first one it names ("They asked whether we…" is theirs), and "the customer" or 客户 is the other side; a speaker's mark is no word of the line ("Let me start you on it" shares "me" only with the mark); fails_when=the User's own line is quoted for what the other side asked, or a line is quoted on its speaker's mark (#2526).
  test("the side a claim names first decides, and a speaker's mark is no word", () => {
    const call = {
      id: "P1",
      text: "[0:00 Me] We can do Enterprise at forty dollars a driver.\n[0:05 Me] 大多数团队先上 100 个传感器。\n[0:09 Me] Most teams your size start on Standard.",
    };
    for (const claim of [
      "They asked whether we can do Enterprise at forty dollars [^1]",
      "客户要先上 100 个传感器 [^1]",
      "Let me start you on it [^1]",
    ]) {
      expect(markedPassages(claim, [call], everywhere, none).records, claim).toEqual([]);
    }
  });

  // protects=a marker no rule reads, in a table row of the reply, goes rather than show the record its number holds for another sentence; fails_when=the table's "[^2]" stays and shows Enterprise's line as found for "Team $45" (#2526).
  test("a marker in a table row of the reply goes", () => {
    expect(
      markedPassages(
        "| Team | $45 [^2] |\n\nEnterprise is $52 a driver a month [^2]",
        [PRICES],
        everywhere,
        none,
      ),
    ).toEqual({
      text: "| Team | $45 |\n\nEnterprise is $52 a driver a month [^2]",
      records: [
        {
          marker: 2,
          passage: "P2",
          quote: "Enterprise plan: $52 per driver a month, with route optimisation.",
        },
      ],
    });
  });
  // protects=a marker naming one Passage of a Document may rest on a line its sibling Passage (a transcript's next window) holds, and a name the claim says is absent ("I don't see NetSuite") needs no quote; fails_when=a transcript line in the next window, or a claim denying a name, loses its Citation (#2526).
  test("a sibling Passage of the same Document may hold the line, and a denied name needs no quote", () => {
    const first = {
      id: "P1",
      name: "Transcript · Meeting",
      text: "[0:00 Them] Let's run the pilot with twelve drivers.",
    };
    const second = {
      id: "P2",
      name: "Transcript · Meeting",
      text: "[6:01 Them] Our drivers need something they can learn in a single day.",
    };
    expect(
      markedPassages(
        "They need something drivers can learn in a single day [^1]",
        [first, second],
        everywhere,
        none,
      ).records,
    ).toEqual([
      {
        marker: 1,
        passage: "P2",
        quote: "Our drivers need something they can learn in a single day.",
      },
    ]);
    const integrations = {
      id: "P3",
      text: "- Connectors: Shopify on every plan, SAP on Enterprise only.",
    };
    const call = { id: "P1", text: "[0:04 Them] We run our books on NetSuite." };
    expect(
      markedPassages(
        "I don't see NetSuite among our connectors, only Shopify and SAP [^3]",
        [call, integrations],
        everywhere,
        none,
      ).records,
    ).toEqual([
      {
        marker: 3,
        passage: "P3",
        quote: "Connectors: Shopify on every plan, SAP on Enterprise only.",
      },
    ]);
  });
  // protects=a check that a Document supports what was said, its two markers right after what was said, records the call's line and the Document's; fails_when=either Passage goes uncited (#2526).
  test("what was said, marked with the call's line and the Document's, quotes both", () => {
    const call = { id: "P1", text: "[0:03 Me] Spare probes ship within 3 business days." };
    const terms = { id: "P2", text: "- Spare probes ship within 3 business days of the order." };
    expect(
      markedPassages(
        "You said spare probes ship within 3 business days [^1][^2]; the service terms support this.",
        [call, terms],
        everywhere,
        none,
      ).records,
    ).toEqual([
      { marker: 1, passage: "P1", quote: "Spare probes ship within 3 business days." },
      { marker: 2, passage: "P2", quote: "Spare probes ship within 3 business days of the order." },
    ]);
  });
});

describe("A check that says a Document agrees, and a sentence about two rows", () => {
  const call = {
    id: "P1",
    name: "Transcript · Meeting",
    text: "[0:02 Me] Overtime counts after 40 hours a week, unless you switch a location to daily overtime after 8 hours.\n[0:09 Them] Okay, that matches what our payroll lead expected.",
  };
  const payroll = {
    id: "P2",
    name: "Payroll export",
    text: "# Payroll export\n\nHours are exported every pay period.\n\nOvertime is worked out after 40 hours a week by default; a location can set it to daily overtime after 8 hours instead.",
  };
  const privacy = {
    id: "P3",
    name: "Data and privacy",
    text: "# Data and privacy\n\nAdmins sign in with single sign-on on Chain; on Starter and Growth they use two-factor authentication.",
  };
  const CALLED =
    "Overtime counts after 40 hours a week, unless you switch a location to daily overtime after 8 hours.";
  const OVERTIME =
    "Overtime is worked out after 40 hours a week by default; a location can set it to daily overtime after 8 hours instead.";
  const SAID = "You said overtime counts after 40 hours a week, or after 8 hours daily";

  // protects=a sentence whose marker names only the call's line, and whose words after it say a Document agrees, gets the Document's line holding the whole sentence, under a marker of its own before the sentence's closing punctuation (a bold one too), by the word for Documents or the Document's whole name, in English and Chinese, and a Document's lines on two sentences when each holds a figure; fails_when=only the call's line is recorded, so the sentence shows the call's line as the Document's word, or the Document's marker goes after the closing punctuation; no_claim=what a real model writes (the gate) (#2526).
  test("a check marking only the call's line while it says a Document agrees gets the Document's line", () => {
    expect(
      markedPassages(
        `${SAID} [^1]; the payroll export document agrees.`,
        [call, payroll, privacy],
        everywhere,
        none,
      ),
    ).toEqual({
      text: `${SAID} [^1]; the payroll export document agrees [^2].`,
      records: [
        { marker: 1, passage: "P1", quote: CALLED },
        { marker: 2, passage: "P2", quote: OVERTIME },
      ],
    });
    expect(
      markedPassages(
        `**${SAID} [^1]; the Payroll export supports this.**`,
        [call, payroll, privacy],
        everywhere,
        none,
      ).text,
    ).toBe(`**${SAID} [^1]; the Payroll export supports this [^2].**`);
    const sundays = {
      id: "P5",
      name: "Overtime rules",
      text: "Overtime is worked out after 40 hours a week. On Sundays, it starts after 8 hours.",
    };
    expect(
      markedPassages(
        "You said overtime starts after 40 hours a week, and after 8 hours on Sundays [^1]; the document agrees.",
        [call, sundays],
        everywhere,
        none,
      ).records.map((record) => record.quote),
    ).toEqual([
      CALLED,
      "On Sundays, it starts after 8 hours.",
      "Overtime is worked out after 40 hours a week.",
    ]);
    const zhCall = {
      id: "P1",
      text: "[0:02 Me] 加班默认按每周超过 40 小时算，门店也可以改成每天超过 8 小时算。",
    };
    const zhPayroll = {
      id: "P2",
      name: "工资导出",
      text: "# 工资导出\n\n加班默认按每周超过 40 小时计算；门店也可以改为每天超过 8 小时计加班。",
    };
    expect(
      markedPassages(
        "你说加班默认每周超过 40 小时、门店可改为每天超过 8 小时 [^1]；文档一致",
        [zhCall, zhPayroll],
        everywhere,
        none,
      ).text,
    ).toBe("你说加班默认每周超过 40 小时、门店可改为每天超过 8 小时 [^1]；文档一致 [^2]");
  });

  // protects=such a sentence shows uncited when no line of the Documents it names holds all of it: a figure only the call said, another row, a figure it adds after saying the Document agrees, or a line only another Document holds; fails_when=the call's line stays found under a sentence the Document doesn't support, or a line holding part of it is recorded at its end (#2526).
  test("such a sentence goes uncited when no line of the Document it names holds all of it", () => {
    const said = {
      id: "P1",
      text: "[0:02 Them] So admins on Growth get single sign-on, overtime counts after 45 hours, and it costs $10 an hour, right?",
    };
    const prices = { id: "P4", name: "Price sheet", text: "Growth is $89 a location a month." };
    for (const reply of [
      "They said admins on Growth get single sign-on [^1]; the document agrees.",
      "They said overtime counts after 45 hours [^1]; the Payroll export supports this.",
      "They said overtime counts after 40 hours a week and costs $10 an hour [^1]; the document agrees.",
      `${SAID} [^1]; the payroll export agrees, though drivers start at 45 hours.`,
      `${SAID} [^1]; the price sheet agrees.`,
    ]) {
      expect(
        markedPassages(reply, [said, call, payroll, privacy, prices], everywhere, none),
        reply,
      ).toEqual({ text: reply.replace(" [^1]", ""), records: [] });
    }
  });

  // protects=a Document line recorded for a check no model named it for says all of the sentence: each figure of its kind and unit exactly, each unit of time it names, no row it doesn't name, and no "only" or "but" it doesn't say; fails_when="a month" is recorded from "a year", "40 hours" from "40 shifts", "every hour" from "every night", "every plan" from "Chain only", or "on Starter" from "every plan but Starter" (#2526).
  test("a Document line recorded for such a check says all of it, its units, rows and limits too", () => {
    for (const [said, line] of [
      ["it's $45 a seat a month", "Enterprise: $45 a seat a year, single sign-on included."],
      ["overtime starts after 40 hours a week", "Overtime pay starts after 40 hours a year."],
      ["overtime starts after 40 hours", "Overtime starts after 40 shifts."],
      [
        "overtime starts after 40 hours a week",
        "Overtime starts after 40 each week, counted in hours.",
      ],
      ["exports run every hour", "Exports run every night at 2 a.m."],
      ["single sign-on is included on every plan", "Single sign-on is included on Chain."],
      ["forecasts are included on Starter", "Forecasts are included on every plan but Starter."],
    ]) {
      const heard = { id: "P1", text: `[0:02 Me] ${said}.` };
      const document = { id: "P2", name: "Terms", text: `${line}\n\n| Chain | $139 |` };
      const reply = `You said ${said} [^1]; the document agrees.`;
      expect(markedPassages(reply, [heard, document], everywhere, none), reply).toEqual({
        text: reply.replace(" [^1]", ""),
        records: [],
      });
    }
  });

  // protects=a sentence whose words after the call's line don't say a Document agrees is left as it is: one saying the Documents don't cover it, one saying a Document differs, and one already citing the Document, whose text gets no second marker; fails_when=the call's line is taken away, or a Document's line or a second marker is added (#2526).
  test("a verdict that doesn't say a Document agrees, or one already citing it, is left as it is", () => {
    for (const reply of [
      "They said that matches what their payroll lead expected [^1]; the Documents don't cover what the payroll lead expected.",
      `${SAID} [^1]; the payroll export differs for drivers.`,
      `${SAID} [^1]; the payroll export doesn't support this.`,
    ]) {
      expect(markedPassages(reply, [call, payroll, privacy], everywhere, none).text, reply).toBe(
        reply,
      );
    }
    const zh = "你说加班默认每周超过 40 小时 [^1]；工资导出文档不一致";
    expect(
      markedPassages(
        zh,
        [
          { id: "P1", text: "[0:02 Me] 加班默认按每周超过 40 小时算。" },
          { id: "P2", name: "工资导出", text: "加班默认按每周超过 40 小时计算。" },
        ],
        everywhere,
        none,
      ).text,
    ).toBe(zh);
    const both = `${SAID} [^1][^2]; the payroll export agrees.`;
    expect(markedPassages(both, [call, payroll, privacy], everywhere, none)).toEqual({
      text: both,
      records: [
        { marker: 1, passage: "P1", quote: CALLED },
        { marker: 2, passage: "P2", quote: OVERTIME },
      ],
    });
  });

  // protects=a Passage's sentence whose clauses each name rows of their own is read clause by clause, so another row's fact is never quoted ("Admins on Growth get single sign-on" from "…single sign-on on Chain; on Starter and Growth they use two-factor authentication") and one row's figure keeps no other row's fact out (成长版含人工成本预测 from its clause, not an overview line); a call's line and a sentence with a clause naming no row stay whole; fails_when=the whole sentence is quoted for another row's fact, the overview line is quoted, or a call's line or a clause about "the others" is quoted alone (#2526).
  test("a sentence whose clauses each name their own rows is quoted clause by clause", () => {
    expect(
      markedPassages("Admins on Growth get single sign-on [^3]", [call, privacy], everywhere, none),
    ).toEqual({ text: "Admins on Growth get single sign-on", records: [] });
    expect(
      markedPassages(
        "Growth admins use two-factor authentication [^3]",
        [call, privacy],
        everywhere,
        none,
      ).records,
    ).toEqual([
      {
        marker: 3,
        passage: "P3",
        quote: "on Starter and Growth they use two-factor authentication.",
      },
    ]);
    const plans = {
      id: "P2",
      name: "排班方案",
      text: "# 排班方案\n\n各方案的区别在于覆盖多少门店，以及是否含人工成本预测。\n\n| 方案 | 每家门店每月 |\n|---|---|\n| 入门版 | 299 元 |\n| 成长版 | 549 元 |\n| 连锁版 | 869 元 |\n\n成长版和连锁版含人工成本预测；入门版每家门店每月另收 99 元。\n\n20 家门店起，连锁版降到每家每月 749 元。",
    };
    expect(
      markedPassages(
        "成长版含人工成本预测，要是门店超过 20 家，连锁版每家每月降到 749 元 [^2]",
        [plans],
        everywhere,
        none,
      ).records.map((record) => record.quote),
    ).toEqual(["20 家门店起，连锁版降到每家每月 749 元。", "成长版和连锁版含人工成本预测"]);
    const heard = {
      id: "P1",
      text: "[0:02 Them] We want Team for 20 seats; Enterprise for 5 admins.",
    };
    const sheet = { id: "P2", text: "| Team | $29 |\n| Enterprise | $45 |" };
    expect(
      markedPassages("They want Enterprise for 5 admins [^1]", [heard, sheet], everywhere, none)
        .records,
    ).toEqual([
      { marker: 1, passage: "P1", quote: "We want Team for 20 seats; Enterprise for 5 admins." },
    ]);
    const others = {
      id: "P2",
      text: "| Starter | $49 |\n| Growth | $89 |\n\nForecasts are included on Growth; the others pay $99 a store a month.",
    };
    expect(
      markedPassages(
        "On Growth forecasts are included, and the others pay $99 a store a month [^2]",
        [others],
        everywhere,
        none,
      ).records,
    ).toEqual([
      {
        marker: 2,
        passage: "P2",
        quote: "Forecasts are included on Growth; the others pay $99 a store a month.",
      },
    ]);
  });

  // protects=a clause of a sentence saying the claim's opposite is never quoted for it, and a line naming only rows other than the claim's gives it nothing, as a first quote or a further one; fails_when=a clause is quoted where its whole sentence says the opposite, or another row's clause or line is quoted beside the claim's own (#2526).
  test("no clause of a sentence saying the opposite, and no line about other rows only", () => {
    const features = {
      id: "P2",
      text: "| Feature | Starter | Growth | Chain |\n|---|---|---|---|\n| Kiosks | yes | yes | yes |\n\nLabour forecasts and shift templates are included on Growth and Chain; Starter doesn't include forecasts.",
    };
    expect(
      markedPassages(
        "Labour forecasts and shift templates are included on Starter [^2]",
        [features],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
    const exports = {
      id: "P2",
      text: "Exports run nightly from Monday to Thursday; on Friday they run at noon.",
    };
    expect(
      markedPassages("Exports run at noon on Friday [^2]", [exports], everywhere, none).records,
    ).toEqual([{ marker: 2, passage: "P2", quote: "on Friday they run at noon." }]);
    const forecasts = {
      id: "P2",
      text: "| Starter | $49 |\n| Growth | $89 |\n| Chain | $139 |\n\nStarter pays $99 a store a month for forecasts; Growth and Chain include forecasts with shift templates.",
    };
    expect(
      markedPassages(
        "On Growth, forecasts with shift templates cost $99 a store a month [^2]",
        [forecasts],
        everywhere,
        none,
      ).records,
    ).toEqual([]);
  });

  // protects="I'll" gives no word "ll", so two lines sharing "I'll" and one word aren't a quote of each other; fails_when="I'll put the dates in writing" is quoted for "I'll send the prices in writing" (#2526).
  test("I'll gives no word", () => {
    const promise = { id: "P1", text: "[1:00 Me] I'll put the dates in writing." };
    expect(
      markedPassages("I'll send the prices in writing [^1]", [promise], everywhere, none),
    ).toEqual({ text: "I'll send the prices in writing", records: [] });
  });

  // protects="2-business-day" is read as two days, so a claim giving it and another figure gets the line holding each; fails_when=the line holding "2 business days" is left out as one about other figures (#2526).
  test("a hyphenated business day is read as days", () => {
    const kiosks = {
      id: "P2",
      text: "Each kiosk costs $240. A broken kiosk is swapped within 2 business days. One kiosk serves up to 60 staff.",
    };
    expect(
      markedPassages(
        "Finance may want the 2-business-day swap for broken kiosks and the 60-staff limit per kiosk [^2]",
        [kiosks],
        everywhere,
        none,
      ).records.map((record) => record.quote),
    ).toEqual([
      "A broken kiosk is swapped within 2 business days.",
      "One kiosk serves up to 60 staff.",
    ]);
  });
});
