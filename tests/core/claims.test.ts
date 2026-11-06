/**
 * A verified document's text as paragraphs, and the claims the model names
 * (#97, src/core/answers/checks/claims.ts).
 */
import { describe, expect, test } from "vitest";
import {
  claimPartsReader,
  findClaimsPrompt,
  paragraphsOf,
  readClaimDecisions,
  readClaimParts,
  readPartsLine,
} from "../../src/core/answers/checks/claims";

const page = (number: number, ...lines: string[]) => ({
  page: number,
  text: lines.join("\n"),
  kind: "page" as const,
  label: null,
});

describe("A PDF's lines become paragraphs", () => {
  test("a sentence runs on across lines, past a year or a date that starts one; a short line before a fresh one ends its paragraph; a word broken at a hyphen is mended", () => {
    const paragraphs = paragraphsOf([
      page(
        1,
        "Riverside Library roof and insulation works: progress",
        "report 3",
        "1 Summary",
        "This report covers the roof and insulation package from 1 to 31 March 2027. Roof works were programmed to",
        "start on 4 January 2027. Under our contract, the package is due to be completed in April",
        "2027. Our contract for the package is valued at £1,240,000. It is due to be com-",
        "pleted on",
        "12 March 2028.",
      ),
      page(2, "Forty-two operatives worked on site during March."),
    ]);
    expect(paragraphs).toEqual([
      {
        page: 1,
        text: "Riverside Library roof and insulation works: progress report 3",
        heading: false,
      },
      { page: 1, text: "1 Summary", heading: true },
      {
        page: 1,
        heading: false,
        text: "This report covers the roof and insulation package from 1 to 31 March 2027. Roof works were programmed to start on 4 January 2027. Under our contract, the package is due to be completed in April 2027. Our contract for the package is valued at £1,240,000. It is due to be completed on 12 March 2028.",
      },
      { page: 2, text: "Forty-two operatives worked on site during March.", heading: false },
    ]);
  });

  test("a numbered heading starts a paragraph of its own, after a line as long as the page's", () => {
    const paragraphs = paragraphsOf([
      page(
        1,
        "Meridian Health Staffing · for the clinic network's workforce team · 2 November 2026",
        "1 Your plan as we understand it",
        "Your 2027 staffing plan sets a total budget of £50,929,200 across the network and its clinics.",
      ),
    ]);
    expect(paragraphs.map((each) => each.text)).toEqual([
      "Meridian Health Staffing · for the clinic network's workforce team · 2 November 2026",
      "1 Your plan as we understand it",
      "Your 2027 staffing plan sets a total budget of £50,929,200 across the network and its clinics.",
    ]);
  });

  test("Chinese runs on across lines with no space, until a sentence ends or a heading starts", () => {
    const paragraphs = paragraphsOf([
      page(
        1,
        "老年人持卡乘车继续免费。第三季度共处理乘客投诉1,250",
        "件。",
        "二、库存情况",
        "萧山冷链仓有机鲜牛奶库存量为4200，高于3000的安全库存。",
        "三、供货说明我公司供应的有机鲜牛奶保质期为7天。双方约定的结算周期为月结30天。",
      ),
    ]);
    // A section a PDF ran into its heading's line is text, not a heading.
    expect(paragraphs.map((each) => [each.text, each.heading])).toEqual([
      ["老年人持卡乘车继续免费。第三季度共处理乘客投诉1,250件。", false],
      ["二、库存情况", true],
      ["萧山冷链仓有机鲜牛奶库存量为4200，高于3000的安全库存。", false],
      ["三、供货说明我公司供应的有机鲜牛奶保质期为7天。双方约定的结算周期为月结30天。", false],
    ]);
  });
});

describe("The claims the model names", () => {
  test.each([
    [
      '{"1": "claim", "2": "no", "3": "claim"}',
      [1, 2, 3],
      [
        [1, true],
        [2, false],
        [3, true],
      ],
    ],
    [
      'Here they are:\n```json\n{"2": "Claim", "5": " no "}\n```',
      [2, 5],
      [
        [2, true],
        [5, false],
      ],
    ],
    ['{"1": "claim", "2": "maybe", "9": "claim"}', [1, 2, 3], [[1, true]]],
    ['{"1": "claim", "2": true}', [1, 2], [[1, true]]],
  ])("reads %j", (reply, numbers, decisions) => {
    expect(readClaimDecisions(reply, numbers)).toEqual(new Map(decisions as [number, boolean][]));
  });

  test.each(["No claims.", '{"claims": [1, 2]}', '{"7": "claim"}', "[1, 2]", "{not json}"])(
    "reads nothing from %j",
    (reply) => {
      expect(readClaimDecisions(reply, [1, 2])).toBeNull();
    },
  );
});

describe("The literal parts of numbered JSON input", () => {
  test.each([
    ["North opened.\nSouth followed.", "North opened.", "South followed."],
    ["北店开业。\n南店随后开业。", "北店开业。", "南店随后开业。"],
  ])("preserves global ids and original line breaks: %s", (text, first, second) => {
    const sentences = [{ number: 37, text }];
    expect(JSON.parse(findClaimsPrompt(sentences))).toEqual({ sentences });
    const parts = readClaimParts(
      JSON.stringify({
        sentences: [
          {
            number: 37,
            parts: [
              { kind: "fact", text: first },
              { kind: "fact", text: second },
            ],
          },
        ],
      }),
      sentences,
    );
    expect(parts?.get(37)).toEqual([
      { kind: "fact", span: { start: 0, end: first.length } },
      { kind: "fact", span: { start: first.length + 1, end: text.length } },
    ]);
    expect(parts?.has(1)).toBe(false);
  });

  test.each([
    "The input is JSON, not the numbered draft I expected.",
    '{"sentences":[{"number":1,"parts":[{"kind":"fact","text":"North opened."}]}]}',
    '{"sentences":[{"number":37,"parts":[{"kind":"fact","text":"The North store opened."}]}]}',
  ])("keeps an unreadable or rewritten response unresolved: %s", (reply) => {
    expect(readClaimParts(reply, [{ number: 37, text: "North opened." }])).toBeNull();
  });

  test.each([
    ["North opened.", "South followed."],
    ["北店开业。", "南店随后开业。"],
  ])("keeps decided parts when another sentence is missing: %s", (first, second) => {
    const sentences = [
      { number: 37, text: first },
      { number: 38, text: second },
    ];
    expect(
      readClaimParts(
        JSON.stringify({ sentences: [{ number: 37, parts: [{ kind: "fact", text: first }] }] }),
        sentences,
      ),
    ).toEqual(new Map([[37, [{ kind: "fact", span: { start: 0, end: first.length } }]]]));
    expect(readClaimParts('{"sentences":[]}', sentences)).toEqual(new Map());
    expect(
      readClaimParts(JSON.stringify({ sentences: [{ number: 37, parts: [] }] }), sentences),
    ).toEqual(new Map([[37, []]]));
  });

  test.each(["North opened.", "北店开业。"])(
    "a duplicate or rewritten owner cannot overwrite another sentence's inventory: %s",
    (text) => {
      const valid = { number: 37, parts: [{ kind: "fact", text }] };
      const duplicate = { number: 38, parts: [{ kind: "fact", text }] };
      for (const invalid of [
        [duplicate, duplicate],
        [{ number: 38, parts: [{ kind: "fact", text: "not the original words" }] }],
      ]) {
        expect(
          readClaimParts(JSON.stringify({ sentences: [valid, ...invalid] }), [
            { number: 37, text },
            { number: 38, text },
          ]),
        ).toEqual(new Map([[37, [{ kind: "fact", span: { start: 0, end: text.length } }]]]));
      }
    },
  );
});

describe("Words a sort leaves out of every part", () => {
  const sorted = (sentence: string, parts: readonly { kind: string; text: string }[]) =>
    (
      readClaimParts(JSON.stringify({ sentences: [{ number: 1, parts }] }), [
        { number: 1, text: sentence },
      ])?.get(1) ?? []
    ).map(({ kind, span }) => [kind, sentence.slice(span.start, span.end)]);
  const named = (sentence: string, parts: readonly { kind: string; text: string }[]) =>
    (readPartsLine(`Parts: ${JSON.stringify(parts)}`, sentence) ?? []).map(({ kind, span }) => [
      kind,
      sentence.slice(span.start, span.end),
    ]);

  // protects=a time, place, scope or condition a sort or a check's first turn leaves out beside a fact is checked with that fact (#2002); fails_when=the words drop out of every part; no_claim=how often a real model leaves them out.
  test.each([
    ["Revenue rose 12% in 2025.", "Revenue rose 12%", "Revenue rose 12% in 2025"],
    ["2025年收入增长了12%。", "收入增长了12%", "2025年收入增长了12%"],
    ["In Leeds, rent is paid monthly.", "rent is paid monthly", "In Leeds, rent is paid monthly"],
    ["在利兹，租金按月支付。", "租金按月支付", "在利兹，租金按月支付"],
  ])("joins the fact beside it: %s", (sentence, fact, kept) => {
    const parts = [{ kind: "fact", text: fact }];
    expect(sorted(sentence, parts)).toEqual([["fact", kept]]);
    expect(named(sentence, parts)).toEqual([["fact", kept]]);
  });

  // protects=joining words and punctuation between parts stay out of them, so a fact never takes "because" or "但" as a claim of its own (#2002); fails_when=a joining word is added to a part; no_claim=every joining word a model may leave.
  test.each([
    [
      "We think this is risky because costs rose 40%.",
      [
        { kind: "opinion", text: "We think this is risky" },
        { kind: "fact", text: "costs rose 40%" },
      ],
    ],
    [
      "我们认为这有风险，但成本上涨了40%。",
      [
        { kind: "opinion", text: "我们认为这有风险" },
        { kind: "fact", text: "成本上涨了40%" },
      ],
    ],
  ])("leaves joining words between parts: %s", (sentence, parts) => {
    expect(sorted(sentence, parts)).toEqual(parts.map(({ kind, text }) => [kind, text]));
  });

  // protects=words a sort leaves beside opinions only are left out with those opinions, so they are listed rather than lost (#2002); fails_when=they vanish from every part, or become a fact on their own; no_claim=whether they are an opinion.
  test.each([
    ["Frankly, we think it is lovely.", "we think it is lovely", "Frankly, we think it is lovely"],
    ["坦白说，我们认为它很美。", "我们认为它很美", "坦白说，我们认为它很美"],
  ])("joins the opinion beside it when no fact is: %s", (sentence, opinion, kept) => {
    expect(sorted(sentence, [{ kind: "opinion", text: opinion }])).toEqual([["opinion", kept]]);
  });
});

describe("A sorting reply read as it streams", () => {
  const sentences = [
    { number: 7, text: 'The sign says "Open {daily}".' },
    { number: 8, text: "北店开业。" },
    { number: 9, text: "Rain fell." },
  ];
  const reply = [
    'Here it is: {"sentences":[',
    '{"number":7,"parts":[{"kind":"fact","text":"The sign says \\"Open {daily}\\"."}]},',
    '{"number":8,"parts":[{"kind":"fact","text":"北店开业。"}]},',
    '{"number":12,"parts":[{"kind":"fact","text":"Rain fell."}]},',
    '{"number":9,"parts":[{"kind":"fact","text":"Snow fell."}]},',
    '{"number":8,"parts":[{"kind":"opinion","text":"北店开业。"}]}',
    "]}",
  ].join("");

  // protects=each sentence's parts are heard as soon as its record closes, whatever the chunks, as the whole reply reads them, so its check can start while the sort still streams (#2532); fails_when=a record is heard before it closes, a brace or an escaped quote inside a sentence ends one early, or a record the whole reply wouldn't read is heard; no_claim=which record of a sentence given twice decides it, which the whole reply settles.
  test.each([1, 5, 64])("hears each record as it closes, in chunks of %i", (size) => {
    const read = claimPartsReader(sentences);
    const heard: { at: number; number: number }[] = [];
    for (let at = 0; at < reply.length; at += size) {
      const end = Math.min(reply.length, at + size);
      for (const record of read(reply.slice(at, end)))
        heard.push({ at: end, number: record.number });
    }

    expect(heard.map((each) => each.number)).toEqual([7, 8, 8]);
    const closed = (number: number) => reply.indexOf(`{"number":${number}`);
    expect(heard[0]?.at).toBeLessThan(closed(8) + size + 1);
    expect(heard[1]?.at).toBeLessThan(closed(12) + size + 1);
    const whole = readClaimParts(reply, sentences);
    expect(whole?.get(7)).toEqual([
      { kind: "fact", span: { start: 0, end: sentences[0]?.text.length ?? 0 } },
    ]);
    // Given twice, the sentence is the whole reply's to settle: here it settles none.
    expect(whole?.has(8)).toBe(false);
  });

  test("hears nothing of prose before the reply's JSON, nor after it ends", () => {
    const read = claimPartsReader(sentences);
    expect(
      read('Records: [{"number":9,"parts":[{"kind":"fact","text":"Rain fell."}]}] then '),
    ).toEqual([]);
    expect(read('{"sentences":[]} {"sentences":[{"number":9,"parts":[]}]}')).toEqual([]);
  });
});
