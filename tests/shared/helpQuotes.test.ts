/**
 * What call help's panel draws under a line of a reply (#2847): each Citation's quote word for
 * word, cut at a clause past the fact-line limit, two lines at most, a quote inside another found
 * quote of the same place on that quote's line, and a reading's moment by its kind.
 */
import { describe, expect, test } from "vitest";
import type { AnswerStatus, CitationCheck, CitationCheckReason } from "../../src/core/api";
import {
  fittedQuote,
  momentBegun,
  momentFound,
  momentOf,
  momentWords,
  type QuotedCitation,
  quoteLines,
  quoteState,
} from "../../src/shared/helpQuotes";
import { readHelpReply } from "../../src/shared/helpReplyRead";

const cited = (
  marker: number,
  quote: string,
  more: Partial<QuotedCitation> = {},
): QuotedCitation => ({
  marker,
  documentId: "pricing",
  passageId: "pricing-1",
  location: null,
  quote,
  check: "found",
  checkReason: null,
  ...more,
});

const said = (marker: number, quote: string, fromMs: number, toMs = fromMs + 4000) =>
  cited(marker, quote, {
    documentId: "transcript",
    passageId: "transcript-1",
    location: { kind: "time", from: fromMs, to: toMs, speaker: "Them" },
  });

function linesOf(
  citations: readonly QuotedCitation[],
  status: AnswerStatus = "done",
  markers: readonly number[] = citations.map((each) => each.marker),
) {
  return quoteLines(
    markers,
    (marker) => citations.find((each) => each.marker === marker),
    status,
  ).map(({ markers: numbers, more, state, quote, drawn }) => ({
    markers: numbers,
    more,
    state,
    quote,
    drawn,
  }));
}

const ENTERPRISE = "Enterprise plan: $45 per seat a month, with single sign-on and audit logs.";

describe("A quote line's quote", () => {
  test.each([
    ["English", ENTERPRISE],
    ["Chinese", "企业版：每个席位每月 45 美元，含单点登录和审计日志。"],
  ])("in %s, within the limit, is the Document's words whole", (_, quote) => {
    expect(fittedQuote(quote)).toEqual({ text: quote, cut: false });
  });

  // protects=a quote past the trial's fact-line limit is cut at the last clause within it with "…", and a mark inside a number ends no clause, in English and Chinese (#2847); fails_when=a cut lands inside "42,000" or "3.5", or mid-clause where a clause ends within the limit; no_claim=how a cut quote reads aloud.
  test.each([
    [
      "English",
      "Enterprise contracts are billed annually, at 42,000 dollars for the first 50 seats, and every seat after that is billed at 3.5 percent less than the list price.",
      "Enterprise contracts are billed annually, at 42,000 dollars for the first 50 seats…",
    ],
    [
      "Chinese",
      "企业版合同按年付费，首批五十个席位的价格为 42,000 美元，之后每增加一个席位，价格比标价低 3.5%，并且包含单点登录、审计日志以及专属客户经理的支持服务。",
      "企业版合同按年付费，首批五十个席位的价格为 42,000 美元，之后每增加一个席位…",
    ],
  ])("in %s, past the limit, is cut at a clause, never inside a number", (_, quote, shown) => {
    expect(fittedQuote(quote)).toEqual({ text: shown, cut: true });
  });

  test.each([
    [
      "English",
      "Revenue grew 3.5 percent in the first quarter and 4.2 percent in the second quarter of the year while costs fell sharply across all regions",
      "Revenue grew 3.5 percent in the first quarter and 4.2 percent in the second quarter of the year while costs…",
    ],
    [
      "Chinese",
      "我们今年第一季度的营业收入比去年同期增长了百分之三点五而第二季度又增长了百分之四点二同时各个地区的成本都在大幅下降",
      "我们今年第一季度的营业收入比去年同期增长了百分之三点五而第二季度又增长了百分之四…",
    ],
  ])(
    "in %s, with no clause to end at, is cut at the last word within the limit",
    (_, quote, shown) => {
      expect(fittedQuote(quote)).toEqual({ text: shown, cut: true });
    },
  );

  test("a Chinese cut with no clause never splits a number", () => {
    const quote = `${"营".repeat(38)}12345678 元`;
    const { text } = fittedQuote(quote);
    expect(text).toBe(`${"营".repeat(38)}…`);
  });

  test("leaves out the Markdown marks its line begins with", () => {
    expect(fittedQuote("- Team plan: $25 per seat a month.").text).toBe(
      "Team plan: $25 per seat a month.",
    );
    expect(fittedQuote("## 批量折扣").text).toBe("批量折扣");
  });
});

describe("A quote line's state", () => {
  const stored = (check: CitationCheck, checkReason: CitationCheckReason | null = null) =>
    quoteState({ check, checkReason }, "done");

  // protects=a reply stored before quote lines draws each Citation from what is stored: found, unsupported, contradicted, not checked and an ended "checking" were only ever said of a found quote, and quoted words the cited place doesn't hold leave the quote found (#2847); fails_when=a stored state shows no ✓ on a found quote, or a quote not found shows ✓; no_claim=what the sentence check said of the sentence.
  test("a stored reply's six states: a found quote takes ✓, a quote not found doesn't", () => {
    expect(
      (["found", "unsupported", "contradicted", "not-checked", "checking"] as const).map((check) =>
        stored(check),
      ),
    ).toEqual(["found", "found", "found", "found", "found"]);
    expect(stored("not-found", "quote-not-on-pages")).toBe("not-found");
    expect(stored("not-found", "quoted-words-not-on-pages")).toBe("found");
    expect(stored("cant-check", "document-removed")).toBe("cant-check");
  });

  test("while written, a number with no Citation yet keeps its room; Stop and failure close it", () => {
    expect(quoteState(undefined, "streaming")).toBe("waiting");
    expect(quoteState({ check: "checking", checkReason: null }, "streaming")).toBe("waiting");
    for (const status of ["done", "stopped", "failed"] as const) {
      expect(quoteState(undefined, status)).toBeNull();
    }
  });
});

describe("The quote lines under a line", () => {
  test("the first two Citations get a line each, in cited order; a third keeps its number on the second", () => {
    expect(
      linesOf([
        cited(2, "Enterprise contracts are billed annually."),
        cited(1, "Volume discount: 10% off from 50 seats.", { passageId: "pricing-2" }),
        cited(3, "Team plan: $25 per seat a month.", { passageId: "pricing-3" }),
      ]),
    ).toEqual([
      {
        markers: [2],
        more: [],
        state: "found",
        quote: "Enterprise contracts are billed annually.",
        drawn: 2,
      },
      {
        markers: [1],
        more: [3],
        state: "found",
        quote: "Volume discount: 10% off from 50 seats.",
        drawn: 1,
      },
    ]);
  });

  // protects=a found quote wholly inside another found quote of the same place joins that quote's line, its number in cited order, compared as the quote check compares, before the two lines are counted (#2847); fails_when=a quote inside another takes a line of its own, a line it frees isn't given to a quote with other words, or the joined line draws the inner quote; no_claim=how a joined line looks.
  test("a quote inside another found quote of the same place joins its line, which then goes to another quote", () => {
    expect(
      linesOf([
        cited(1, "With Single Sign‑On  and audit logs"),
        cited(2, ENTERPRISE),
        cited(3, "Enterprise contracts are billed annually.", { passageId: "pricing-2" }),
      ]),
    ).toEqual([
      { markers: [1, 2], more: [], state: "found", quote: ENTERPRISE, drawn: 2 },
      {
        markers: [3],
        more: [],
        state: "found",
        quote: "Enterprise contracts are billed annually.",
        drawn: 3,
      },
    ]);
    expect(linesOf([cited(1, ENTERPRISE), cited(2, `“${ENTERPRISE}”`)])).toEqual([
      { markers: [1, 2], more: [], state: "found", quote: ENTERPRISE, drawn: 1 },
    ]);
  });

  test("on a call, a quote joins only one said within the other's time", () => {
    const whole = said(1, "We need single sign-on. And audit logs for compliance.", 2000, 9000);
    expect(linesOf([whole, said(2, "And audit logs for compliance.", 5000, 9000)])).toEqual([
      { markers: [1, 2], more: [], state: "found", quote: whole.quote, drawn: 1 },
    ]);
    // Said again later in the call: another moment, a line of its own.
    expect(
      linesOf([whole, said(2, "And audit logs for compliance.", 60_000)]).map(
        (line) => line.markers,
      ),
    ).toEqual([[1], [2]]);
  });

  test("the same words elsewhere, an overlap, or a quote not found keep a line each", () => {
    const keepApart = (second: QuotedCitation) =>
      linesOf([cited(1, ENTERPRISE), second]).map((line) => [line.markers, line.state]);
    expect(
      keepApart(cited(2, "single sign-on and audit logs", { documentId: "contract" })),
    ).toEqual([
      [[1], "found"],
      [[2], "found"],
    ]);
    expect(
      keepApart(cited(2, "single sign-on and audit logs", { passageId: "pricing-9" })),
    ).toEqual([
      [[1], "found"],
      [[2], "found"],
    ]);
    // The same Passage, but another page of it: not the cited place itself.
    expect(
      linesOf([
        cited(1, ENTERPRISE, { location: { kind: "page", from: 3, to: 3 } }),
        cited(2, "single sign-on and audit logs", { location: { kind: "page", from: 4, to: 4 } }),
      ]).map((line) => line.markers),
    ).toEqual([[1], [2]]);
    expect(
      linesOf([
        cited(1, ENTERPRISE, { location: { kind: "page", from: 3, to: 4 } }),
        cited(2, "single sign-on and audit logs", { location: { kind: "page", from: 4, to: 4 } }),
      ]).map((line) => line.markers),
    ).toEqual([[1, 2]]);
    expect(keepApart(cited(2, "audit logs. Enterprise contracts are billed annually."))).toEqual([
      [[1], "found"],
      [[2], "found"],
    ]);
    expect(
      keepApart(
        cited(2, "single sign-on and audit logs", {
          check: "not-found",
          checkReason: "quote-not-on-pages",
        }),
      ),
    ).toEqual([
      [[1], "found"],
      [[2], "not-found"],
    ]);
  });

  test("while written, a number whose Citation hasn't come keeps its own room", () => {
    expect(
      linesOf([cited(1, ENTERPRISE)], "streaming", [1, 2]).map((line) => [
        line.markers,
        line.state,
      ]),
    ).toEqual([
      [[1], "found"],
      [[2], "waiting"],
    ]);
  });

  // protects=a joined line can only form while the reply is written, so nothing moves once it ends: the one case a line under a line to say goes up while written is a room or a quote line that a later cite joins to another's (#2847); fails_when=the joined lines read differently once the reply ends than as stored; no_claim=how often a model writes its number before its cite.
  test("a number that joins once its quote lands frees its room while written, never after", () => {
    const whole = cited(1, ENTERPRISE);
    const inner = cited(2, "single sign-on and audit logs");
    expect(linesOf([whole], "streaming", [1, 2]).map((line) => line.markers)).toEqual([[1], [2]]);
    expect(linesOf([whole, inner], "streaming").map((line) => line.markers)).toEqual([[1, 2]]);
    expect(linesOf([whole, inner], "done").map((line) => line.markers)).toEqual([[1, 2]]);
  });
});

describe("A reading's moment line", () => {
  const notesOf = (reply: string) => readHelpReply(reply).flatMap((item) => item.notes);
  const momentIn = (reply: string) => notesOf(reply).map((note) => momentOf(note));

  test.each([
    [
      "English",
      "★ They want to stay near $35 a seat\n0:02 “Our budget is about thirty-five a seat” [^1]\n→ show the Team plan first",
      "Our budget is about thirty-five a seat",
    ],
    [
      "Chinese",
      "★ 对方希望每个席位控制在 35 美元左右\n0:02 “我们的预算大概每个席位三十五美元” [^1]\n→ 先报团队版的价格",
      "我们的预算大概每个席位三十五美元",
    ],
  ])("in %s, a time, one quotation and one number is plain, its words kept", (_, reply, words) => {
    expect(momentIn(reply)).toEqual([{ kind: "plain", marker: 1, words }]);
  });

  test.each([
    [
      "English",
      "They want sign-on and audit logs\n0:04 “We need single sign-on[^2]. And audit logs for compliance.” [^3]\n→ lead with security",
    ],
    [
      "Chinese",
      "对方要单点登录和审计日志\n0:04 “我们需要单点登录[^2]。合规上还要审计日志。” [^3]\n→ 先讲安全功能",
    ],
  ])("in %s, one quotation with several numbers is the app's to draw", (_, reply) => {
    expect(momentIn(reply)).toEqual([{ kind: "several", markers: [2, 3] }]);
  });

  test.each([
    [
      "two moments on a line",
      "★ They push on price\n0:02 “Too high” [^1] / 0:09 “Can you do 30?” [^2]\n→ hold",
    ],
    ["two moments in Chinese", "★ 对方在压价\n0:02 “太贵了” [^1]；0:09 “能不能 30？” [^2]\n→ 坚持"],
    [
      "words beside the quotation",
      "★ They push on price\n0:02 Dana, their CFO: “Too high” [^1]\n→ hold",
    ],
    ["no Citation", "★ They push on price\n0:02 “Too high”\n→ hold"],
  ])("%s takes the general rule", (_, reply) => {
    expect(momentIn(reply)).toEqual([null]);
  });

  test("its words count as found when the place holds them, as the quote check compares", () => {
    const citation = { quotedWordsFound: ["Our budget is about thirty-five a seat."] };
    expect(momentFound("our budget is about thirty‑five a seat", citation)).toBe(true);
    expect(momentFound("Our budget is about forty a seat", citation)).toBe(false);
    expect(momentFound("Our budget is about thirty-five a seat", {})).toBe(false);
  });

  test("its time is the cited place's own once its Citation has come, its words the model's", () => {
    expect(momentWords("0:02 “Our budget is about thirty-five a seat”", "0:03")).toBe(
      "0:03 “Our budget is about thirty-five a seat”",
    );
    expect(momentWords("0:02 “我们的预算大概每个席位三十五美元”", null)).toBe(
      "0:02 “我们的预算大概每个席位三十五美元”",
    );
    expect(momentWords("“Our budget is about thirty-five a seat”", "0:03")).toBe(
      "“Our budget is about thirty-five a seat”",
    );
  });

  test("while written, a line that may be a moment can't be told yet", () => {
    const [begun] = readHelpReply("★ They want X\n0:0");
    expect(momentBegun(begun?.notes[0] ?? [])).toBe(true);
    const [quoted] = readHelpReply("★ 对方想要 X\n“我们");
    expect(momentBegun(quoted?.notes[0] ?? [])).toBe(true);
    const [reading] = readHelpReply("★ They want");
    expect(momentBegun(reading?.lead ?? [])).toBe(false);
  });
});
