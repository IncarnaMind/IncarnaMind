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

  // protects=a quote the Citation check wouldn't find is passed over for the next line holding the claim that it finds; a marker naming no Passage given gets no record, and one an earlier reply recorded is read as naming its Passage anew, under a marker of its own, so it never shows the record its number already holds; fails_when=an unfound quote is recorded, a record is made for a Passage not given, or a recorded marker keeps the earlier record; no_claim=what becomes of the unbacked marker (the core's test) (#2526).
  test("takes the line holding the claim that the check finds, nothing for a marker naming no Passage, and a marker of its own for a recorded one", () => {
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
    expect(markedPassages(text, [sheet], found, (marker) => marker === 2)).toEqual({
      text: text.replace("[^2]", "[^8]"),
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
});
