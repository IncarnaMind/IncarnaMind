/**
 * A verified document's text as paragraphs, and the claims the model names
 * (#97, src/core/answers/checks/claims.ts).
 */
import { describe, expect, test } from "vitest";
import {
  findClaimsPrompt,
  paragraphsOf,
  readSortWords,
  sortedWhole,
  sortWordsOf,
  sortWordsReader,
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

describe("The prompt a sort is sent", () => {
  test.each(["North opened.\nSouth followed.", "北店开业。\n南店随后开业。"])(
    "keeps global ids and original line breaks: %s",
    (text) => {
      const sentences = [{ number: 37, text }];
      expect(JSON.parse(findClaimsPrompt(sentences))).toEqual({ sentences });
    },
  );
});

describe("The words a sort gives its sentences", () => {
  test("each asked number gets its word, in any case and with spaces", () => {
    expect(sortWordsOf({ "1": "claim", "2": "note", "3": "no" }, [1, 2, 3])).toEqual(
      new Map([
        [1, "claim"],
        [2, "note"],
        [3, "no"],
      ]),
    );
    expect(sortWordsOf({ "2": "Claim", "5": " no ", "6": "NOTE" }, [2, 5, 6])).toEqual(
      new Map([
        [2, "claim"],
        [5, "no"],
        [6, "note"],
      ]),
    );
  });

  test("a number that wasn't asked and a word the sort doesn't know are left out", () => {
    expect(sortWordsOf({ "1": "claim", "2": "maybe", "3": true, "9": "claim" }, [1, 2, 3])).toEqual(
      new Map([[1, "claim"]]),
    );
  });

  test("a sentence the reply leaves out has no word", () => {
    expect(sortWordsOf({ "1": "claim" }, [1, 2])?.has(2)).toBe(false);
  });

  test.each([{ "7": "claim" }, { "1": "maybe" }, { claims: [1, 2] }, [1, 2], "claim", null])(
    "a reply that decides none of them reads as none: %j",
    (value) => {
      expect(sortWordsOf(value, [1, 2])).toBeNull();
    },
  );
});

describe("A sorting reply read from its text", () => {
  test.each([
    '{"1": "claim", "2": "no", "3": "note"}',
    'Here they are:\n```json\n{"1": "claim", "2": "no", "3": "note"}\n```',
    'Sorted, one word each: {"1": "claim", "2": "no", "3": "note"}',
  ])("reads the JSON of %j", (reply) => {
    expect(readSortWords(reply, [1, 2, 3])).toEqual(
      new Map([
        [1, "claim"],
        [2, "no"],
        [3, "note"],
      ]),
    );
  });

  // protects=a reply that gives a sentence two different words decides none, as every reply read through the judge module does (#2895); fails_when=the last of the two is read; no_claim=how the evaluation scores a call.
  test.each([
    "No claims.",
    '{"claims": [1, 2]}',
    '{"7": "claim"}',
    "[1, 2]",
    "{not json}",
    '{"1": "claim", "1": "no"}',
  ])("reads nothing from %j", (reply) => {
    expect(readSortWords(reply, [1, 2])).toBeNull();
  });

  test("a sentence given the same word twice is read", () => {
    expect(readSortWords('{"1": "claim", "1": "claim", "2": "no"}', [1, 2])).toEqual(
      new Map([
        [1, "claim"],
        [2, "no"],
      ]),
    );
  });
});

describe("A sorting reply read as it streams", () => {
  const reply = '{"7":"claim","8":"no","12":"claim","9":"note","7":"no"}';
  const written = (pair: string) => reply.indexOf(pair) + pair.length;

  // protects=each sentence's word is heard as soon as the reply has written it, whatever the chunks, so its check can start while the sort still streams (#2532); fails_when=a word is heard before its closing quote, a number the batch didn't ask is heard, or a number is heard twice; no_claim=which word of a sentence given two decides it, which the whole reply settles.
  test.each([1, 5, 64])("gives each number once, as it is written, in chunks of %i", (size) => {
    const read = sortWordsReader([7, 8, 9]);
    const heard: { at: number; number: number; word: string }[] = [];
    for (let at = 0; at < reply.length; at += size) {
      const end = Math.min(reply.length, at + size);
      for (const each of read(reply.slice(at, end))) heard.push({ at: end, ...each });
    }

    expect(heard.map(({ number, word }) => [number, word])).toEqual([
      [7, "claim"],
      [8, "no"],
      [9, "note"],
    ]);
    for (const [number, pair] of [
      [7, '"7":"claim"'],
      [8, '"8":"no"'],
      [9, '"9":"note"'],
    ] as const) {
      const at = heard.find((each) => each.number === number)?.at ?? 0;
      expect(at).toBeGreaterThanOrEqual(written(pair));
      expect(at).toBeLessThan(written(pair) + size);
    }
    expect(readSortWords(reply, [7, 8, 9])).toBeNull();
  });

  test("a pair split across two deltas is given when it is whole", () => {
    const read = sortWordsReader([3, 4]);
    expect(read('{"3":"cl')).toEqual([]);
    expect(read('aim", "4"')).toEqual([{ number: 3, word: "claim" }]);
    expect(read(': "n')).toEqual([]);
    expect(read('ote"}')).toEqual([{ number: 4, word: "note" }]);
    expect(read("")).toEqual([]);
  });
});

describe("A sentence sorted whole", () => {
  const text = "Revenue rose 12% in 2025.";
  const span = { start: 0, end: text.length };

  test("a claim is one whole fact, a note one whole opinion about the note itself, and a no nothing", () => {
    expect(sortedWhole(text, "claim")).toEqual([{ kind: "fact", span }]);
    expect(sortedWhole(text, "note")).toEqual([{ kind: "opinion", itself: true, span }]);
    expect(sortedWhole(text, "no")).toEqual([]);
  });
});
