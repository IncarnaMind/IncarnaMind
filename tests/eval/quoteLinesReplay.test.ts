/**
 * The quote lines' replay (#2847) on presses made up here, in the shape the saved records are
 * converted into: what it draws, what it counts, and the readers' file. Nothing is sent anywhere.
 */
import { describe, expect, test } from "vitest";
import {
  pressesIn,
  readersFile,
  replay,
  type SavedCitation,
  type SavedPress,
} from "../../eval/speed/quoteLinesReplay";

const SHEET = [
  "# Pricing 2026",
  "- Team plan: $25 per seat a month.",
  "- Enterprise plan: $45 per seat a month, with single sign-on and audit logs.",
  "- Enterprise contracts are billed annually.",
  "- Volume discount: 10% off from 50 seats.",
].join("\n");

const sheet = (
  marker: number,
  quote: string,
  more: Partial<SavedCitation> = {},
): SavedCitation => ({
  marker,
  quote,
  check: "found",
  document: "Pricing 2026",
  from: "model",
  passage: "P1",
  location: "line 2",
  passageText: SHEET,
  ...more,
});

const CALL = [
  "[0:02 Them] Honestly, our budget is about thirty-five a seat, maybe less.",
  "[0:04 Them] We need single sign-on. And audit logs for compliance.",
  "[0:09 Them] That's too high for us. Can you do thirty?",
].join("\n");

const heard = (marker: number, quote: string, location: string): SavedCitation => ({
  marker,
  quote,
  check: "found",
  document: "Transcript · Pricing call",
  from: "model",
  passage: "T1",
  location,
  passageText: CALL,
});

const press = (given: Partial<SavedPress> & Pick<SavedPress, "id" | "button" | "text">) => ({
  set: "gate-main",
  language: "en" as const,
  citations: [],
  order: null,
  ...given,
});

const OPTIONS = press({
  id: "en-answer",
  button: "answer",
  order: "cite-first",
  text: "★ Yes, Enterprise includes single sign-on, at $45 per seat a month [^1]\n→ answers both at once\n\nIt's billed annually, and from 50 seats you get 10% off [^2] [^3]\n→ opens the volume talk",
  citations: [
    sheet(1, "Enterprise plan: $45 per seat a month, with single sign-on and audit logs."),
    sheet(2, "Enterprise contracts are billed annually."),
    sheet(3, "Volume discount: 10% off from 50 seats."),
  ],
});

const CHINESE = press({
  id: "zh-say",
  button: "say",
  language: "zh-CN",
  text: "★ 企业版每个席位每月 40 美元 [^1]\n→ 直接回答\n\n合同按年付费 [^2]\n→ 谈期限",
  citations: [
    {
      marker: 1,
      quote: "企业版每个席位每月 40 美元。",
      check: "not-found",
      checkReason: "quote-not-on-pages",
      document: "2026 价格表",
      from: "model",
      passage: "P9",
    },
    {
      marker: 2,
      quote: "企业版合同按年付费。",
      check: "cant-check",
      checkReason: "document-removed",
      document: "2026 价格表",
      from: "model",
      passage: "P9",
    },
  ],
});

/** A number written before its cite, whose quote lies inside the first's: its room closes. */
const JOINED = press({
  id: "en-joined",
  button: "answer",
  order: "number-first",
  text: "★ Enterprise has single sign-on and audit logs [^1] [^2]\n→ answers at once",
  citations: [
    sheet(1, "Enterprise plan: $45 per seat a month, with single sign-on and audit logs."),
    sheet(2, "with single sign-on and audit logs"),
  ],
});

/** The same, with a third quote of other words, which takes the room. */
const TAKEN = press({
  id: "en-taken",
  button: "answer",
  order: "number-first",
  text: "★ Enterprise has single sign-on, billed annually [^1] [^2] [^3]\n→ answers at once",
  citations: [
    sheet(1, "Enterprise plan: $45 per seat a month, with single sign-on and audit logs."),
    sheet(2, "with single sign-on and audit logs"),
    sheet(3, "Enterprise contracts are billed annually."),
  ],
});

const LONG = press({
  id: "en-long",
  button: "check",
  text: "- Not quite: it is billed annually at 42,000 dollars [^1]\n- And they asked about the term",
  citations: [
    sheet(
      1,
      "Enterprise contracts are billed annually, at 42,000 dollars for the first 50 seats, and every seat after that is billed at 3.5 percent less than the list price.",
      { passageText: undefined },
    ),
  ],
  unrecorded: [7],
});

const READINGS = press({
  id: "en-want",
  set: "readings-recent",
  button: "want",
  text: [
    "★ They want to stay near $35 a seat",
    "0:02 “our budget is about thirty-five a seat” [^1]",
    "→ show the Team plan first",
    "",
    "They want a better price",
    "0:02 “our budget is thirty-five a seat, tops” [^2]",
    "→ hold the price",
  ].join("\n"),
  citations: [
    {
      marker: 1,
      quote: "Honestly, our budget is about thirty-five a seat, maybe less.",
      check: "found",
      found: true,
      place: "Transcript · Pricing call",
    },
    {
      marker: 2,
      quote: "Honestly, our budget is about thirty-five a seat, maybe less.",
      check: "found",
      found: true,
      place: "Transcript · Pricing call",
    },
  ],
});

const MOMENTS = press({
  id: "en-moments",
  button: "want",
  text: [
    "★ They need sign-on and audit logs",
    "0:04 “We need single sign-on[^1]. And audit logs for compliance.” [^2]",
    "→ lead with security",
    "",
    "They push back on price",
    "0:09 “That's too high for us” [^3] / 0:11 “Can you do thirty?” [^4]",
    "0:09 Dana, their CFO: “That's too high for us” [^3]",
    "0:20 “the other quote we have”",
    "→ hold the price",
  ].join("\n"),
  citations: [
    heard(1, "We need single sign-on.", "0:04"),
    heard(2, "And audit logs for compliance.", "0:06"),
    heard(3, "That's too high for us.", "0:09"),
    heard(4, "Can you do thirty?", "0:11"),
  ],
});

const OLDER = press({
  id: "older-want",
  set: "readings-older",
  button: "want",
  citations: null,
  text: "★ They want a firm date\n0:03 “we need a date this week” [^1]\n→ give the date",
});

const ALL = [OPTIONS, CHINESE, JOINED, TAKEN, LONG, READINGS, MOMENTS, OLDER];

describe("The quote lines' replay", () => {
  // protects=the free replay counts what the panel draws, by shape and by kind, from presses in the saved records' shape: quotes word for word or cut at a clause, card words for a quote not found or that can't be checked, reading moments by kind, the join that closes a room by order, words shown twice, and the bars that must hold at zero (#2847); fails_when=a count disagrees with what the panel draws for these presses; no_claim=the saved presses' own counts.
  test("counts what the panel draws, by shape and kind, and the bars hold", () => {
    const { counts } = replay(pressesIn(JSON.parse(JSON.stringify(ALL))));
    expect(counts.presses).toEqual({ "gate-main": 6, "readings-recent": 1, "readings-older": 1 });
    expect(counts.lines).toEqual({ options: 6, lines: 1, readings: 7 });
    expect(counts.rows).toEqual({
      "word-for-word": 12,
      "cut-at-a-clause": 1,
      "cells-named": 0,
      "cells-as-quoted": 0,
      "not-found": 1,
      "cant-check": 1,
    });
    expect(counts.moments).toEqual({
      "plain-found": 1,
      "plain-replaced": 1,
      plain: 1,
      several: 1,
      "two-moments": 1,
      general: 1,
    });
    expect(counts.unplaced).toEqual([{ id: "en-moments", line: 6 }]);
    expect(counts.joinClosesRoom).toEqual({ "number-first": 1 });
    expect(counts.sameWordsTwice).toEqual({ "two-moments": 1, general: 1 });
    expect(counts.momentsWithNoTime).toBe(1);
    expect(counts.unrecordedNumbers).toBe(1);
    expect(counts.linesWithNoCitation).toBe(0);
    expect(counts.plainFoundOutsideQuote).toBe(0);
    expect(counts.quoteCheckDiffers).toBe(0);
    expect(counts.checkBesideUnfoundWords).toBe(0);
    expect(counts.quoteNotAsGiven).toBe(0);
    expect(counts.plainWordsChangedWithCheck).toBe(0);
  });

  test("draws each line as the panel shows it, in the interface's language", () => {
    const { drawn } = replay([OPTIONS, CHINESE, JOINED, LONG, READINGS, MOMENTS]);
    const rowsOf = (id: string) =>
      drawn.filter((line) => line.press.id === id).map((line) => line.rows);
    expect(rowsOf("en-answer")).toEqual([
      ["“Enterprise plan: $45 per seat a month, with single sign-on and audit logs.” 1 ✓"],
      [
        "“Enterprise contracts are billed annually.” 2 ✓",
        "“Volume discount: 10% off from 50 seats.” 3 ✓",
      ],
    ]);
    expect(rowsOf("zh-say")).toEqual([["未在“2026 价格表”中找到引文 1"], ["无法核对 2"]]);
    expect(rowsOf("en-joined")).toEqual([
      ["“Enterprise plan: $45 per seat a month, with single sign-on and audit logs.” 1 2 ✓"],
    ]);
    expect(rowsOf("en-long")).toEqual([
      ["“Enterprise contracts are billed annually, at 42,000 dollars for the first 50 seats…” 1 ✓"],
    ]);
    expect(rowsOf("en-want")).toEqual([
      ["0:02 “our budget is about thirty-five a seat” 1 ✓"],
      ["“Honestly, our budget is about thirty-five a seat, maybe less.” 2 ✓"],
    ]);
    expect(rowsOf("en-moments")).toEqual([
      ["0:04 “We need single sign-on.” 1 ✓", "0:06 “And audit logs for compliance.” 2 ✓"],
      ["“That's too high for us.” 3 ✓", "“Can you do thirty?” 4 ✓"],
      ["“That's too high for us.” 3 ✓"],
    ]);
  });

  test("the readers' file holds the drawn lines and nothing of their kind; its key says which", () => {
    const { drawn } = replay(ALL);
    const { text, key } = readersFile(drawn);
    const shown = drawn.filter((line) => line.rows.length > 0).length;
    expect(key).toHaveLength(shown);
    expect(text).not.toMatch(/plain|several|moments|general|options|readings|gate-main|en-answer/u);
    expect(text).toContain("“Enterprise contracts are billed annually.” 2 ✓");
    expect(key[0]).toEqual(expect.objectContaining({ line: 1, id: expect.any(String) }));
    expect(readersFile(drawn, 3).key).toHaveLength(3);
  });

  test("a file not in the saved records' shape is refused with where it fails", () => {
    expect(() => pressesIn({})).toThrow("expected a list of presses");
    expect(() =>
      pressesIn([{ id: "x", set: "s", text: "", language: "fr", button: "say" }]),
    ).toThrow("press 1: unknown language");
    expect(() =>
      pressesIn([
        { id: "x", set: "s", text: "", language: "en", button: "say", citations: [{ marker: 1 }] },
      ]),
    ).toThrow("a Citation needs its marker and quote");
  });
});
