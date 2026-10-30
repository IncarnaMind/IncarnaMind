/**
 * A verified document's text as paragraphs, and the claims the model names
 * (#97, src/core/answers/checks/claims.ts).
 */
import { describe, expect, test } from "vitest";
import {
  findClaimsPrompt,
  paragraphsOf,
  readClaimDecisions,
  readClaimParts,
  readFacetPartsLine,
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

describe("flat Parts wire", () => {
  test.each([
    {
      sentence: "According to Atlas, Nora said rates are currently 5%.",
      words: ["According to Atlas", "Nora said", "currently", "5%"],
      ordinary: "5%",
    },
    {
      sentence: "据图谱，诺拉说利率目前为5%。",
      words: ["据图谱", "诺拉说", "目前", "5%"],
      ordinary: "为5%",
    },
  ])(
    "flat and nested forms have identical literal plans: $sentence",
    ({ sentence, words, ordinary }) => {
      const kinds = ["source", "speaker", "time", "fact"];
      const flat = words.map((text, index) => ({ kind: kinds[index], text }));
      const nested = flat.map(({ kind, text }) =>
        kind === "fact" ? { kind, text } : { kind: "fact", text, facet: { kind } },
      );
      const expected = flat.map(({ kind, text }) => ({
        kind: "fact",
        span: {
          start: sentence.indexOf(kind === "fact" ? ordinary : text),
          end: sentence.indexOf(text) + text.length,
        },
        ...(kind !== "fact" && { facet: { kind } }),
      }));
      for (const parts of [flat, nested]) {
        expect(readPartsLine(`Parts: ${JSON.stringify(parts)}`, sentence)).toEqual(expected);
        expect(
          readClaimParts(JSON.stringify({ sentences: [{ number: 37, parts }] }), [
            { number: 37, text: sentence },
          ]),
        ).toEqual(new Map([[37, expected]]));
      }
    },
  );

  test.each(["source", "speaker", "time"])(
    "a matching redundant nested %s facet has the same canonical shape",
    (kind) => {
      const sentence = "Atlas";
      expect(
        readPartsLine(
          `Parts: ${JSON.stringify([{ kind, text: sentence, facet: { kind } }])}`,
          sentence,
        ),
      ).toEqual([{ kind: "fact", span: { start: 0, end: sentence.length }, facet: { kind } }]);
    },
  );

  test.each([
    { kind: "source", facet: { kind: "time" } },
    { kind: "speaker", facet: { kind: "source" } },
    { kind: "time", facet: { kind: "speaker" } },
    { kind: "opinion", facet: { kind: "source" } },
    { kind: "fact", facet: { kind: "opinion" } },
    { kind: "source", facet: null },
    {
      kind: "source",
      facet: { kind: "source", selectedDocumentId: "11111111-1111-4111-8111-111111111111" },
    },
    {
      kind: "time",
      facet: { kind: "time", period: { start: "2026-10-30", end: "2026-10-30", precision: "day" } },
    },
  ])("conflicting or untrusted planning metadata stays unreadable: %j", (part) => {
    const sentence = "Atlas";
    const parts = [{ ...part, text: sentence }];
    expect(readPartsLine(`Parts: ${JSON.stringify(parts)}`, sentence)).toBeNull();
    expect(
      readClaimParts(JSON.stringify({ sentences: [{ number: 37, parts }] }), [
        { number: 37, text: sentence },
      ]),
    ).toBeNull();
  });
});

describe("independent facets in an unreadable Parts inventory", () => {
  test.each([
    {
      sentence: "According to Atlas, Nora said rates are currently 5%.",
      words: ["According to Atlas", "Nora said", "currently"],
    },
    { sentence: "据图谱，诺拉说利率目前为5%。", words: ["据图谱", "诺拉说", "目前"] },
  ])(
    "retains only exact facets without extending their spans: $sentence",
    ({ sentence, words }) => {
      const kinds = ["source", "speaker", "time"];
      const flat = words.map((text, index) => ({ kind: kinds[index], text }));
      const expected = flat.map(({ kind, text }) => ({
        kind: "fact",
        facet: { kind },
        span: { start: sentence.indexOf(text), end: sentence.indexOf(text) + text.length },
      }));
      for (const facets of [
        flat,
        flat.map(({ kind, text }) => ({ kind: "fact", text, facet: { kind } })),
      ]) {
        const reply = `Parts: ${JSON.stringify([
          facets[0],
          { kind: "fact", text: sentence },
          ...facets.slice(1),
        ])}`;
        expect(readPartsLine(reply, sentence)).toBeNull();
        expect(readFacetPartsLine(reply, sentence)).toEqual(expected);
      }
    },
  );

  test.each([
    { sentence: "Nora said Nora said rates rose.", words: "Nora said", fact: "rates rose." },
    { sentence: "诺拉说诺拉说利率上涨。", words: "诺拉说", fact: "利率上涨。" },
  ])("a repeated facet cannot be located independently: $sentence", ({ sentence, words, fact }) => {
    const reply = `Parts: ${JSON.stringify([
      { kind: "fact", text: words },
      { kind: "speaker", text: words },
      { kind: "fact", text: fact },
    ])}`;
    expect(readPartsLine(reply, sentence)?.[1]?.span).toEqual({
      start: sentence.lastIndexOf(words),
      end: sentence.lastIndexOf(words) + words.length,
    });
    expect(readFacetPartsLine(reply, sentence)).toBeNull();
  });

  test.each([
    [{ kind: "source", text: "Atlas", facet: { kind: "time" } }],
    [
      { kind: "source", text: "Atlas" },
      { kind: "time", text: "Atlas" },
    ],
    [
      { kind: "time", text: "currently" },
      { kind: "source", text: "Atlas" },
    ],
    [{ kind: "source", text: "a rewritten title" }],
    [{ kind: "source", text: 42 }],
    [{ kind: "fact", text: "Atlas", facet: { kind: "source", extra: true } }],
    [
      { kind: "source", text: "Atlas" },
      { kind: "fact", text: "currently", facet: null },
    ],
  ])("one malformed or overlapping facet refuses the whole subset: %j", (...parts) => {
    expect(
      readFacetPartsLine(`Parts: ${JSON.stringify(parts)}`, "Atlas rates are currently 5%."),
    ).toBeNull();
  });

  test("the latest unreadable facet line cannot borrow an earlier valid one", () => {
    expect(
      readFacetPartsLine(
        'Parts: [{"kind":"source","text":"Atlas"}]\nParts: [{"kind":"time","text":42}]',
        "Atlas is currently open.",
      ),
    ).toBeNull();
  });

  test.each(["Nora lives in Oslo.", "诺拉住在奥斯陆。"])(
    "no facet never invents a checked part: %s",
    (sentence) => {
      expect(
        readFacetPartsLine(
          `Parts: ${JSON.stringify([{ kind: "fact", text: sentence }])}`,
          sentence,
        ),
      ).toEqual([]);
      expect(readFacetPartsLine("Parts: []", sentence)).toEqual([]);
      expect(readFacetPartsLine("No readable Parts line.", sentence)).toBeNull();
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
