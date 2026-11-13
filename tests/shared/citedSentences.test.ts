import { describe, expect, test } from "vitest";
import { citedSentences } from "../../src/shared/citedSentences";
import { random } from "../helpers/random";

const MARKER = /\[\^\d+\]/g;
const FOOTNOTE_LINE = /^\s*\[\^\d+\]:/;

const split = (text: string) =>
  citedSentences(text).map(({ sentence, markers }) => [sentence, markers]);

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

/** The words of an Answer's sentences, as a reader reads them: without its markers and footnotes. */
const wordsOf = (answer: string) =>
  words(
    answer
      .split("\n")
      .filter((line) => !FOOTNOTE_LINE.test(line))
      .join("\n")
      .replace(MARKER, ""),
  );

const wordsReturned = (answer: string) =>
  words(
    citedSentences(answer)
      .map(({ sentence }) => sentence)
      .join(" "),
  );

/** From a Chinese research Answer (#3009). */
const QUOTING =
  "另外，该文档的摘要页写明“Prepared for software testing[^5]. The text is fictional.”（为软件测试准备，文本是虚构的）[^4]。";

describe("A cited sentence ends where its own sentence ends (#3009)", () => {
  test("a Chinese sentence that quotes an English one is one sentence, with every word and both Citations", () => {
    expect(split(QUOTING)).toEqual([
      [
        "另外，该文档的摘要页写明“Prepared for software testing. The text is fictional.”（为软件测试准备，文本是虚构的）。",
        [5, 4],
      ],
    ]);
  });

  test("a Chinese sentence still ends at its 。 after a closed quotation", () => {
    expect(
      split(
        "摘要页写明“The text is fictional.”[^1]。下一页说明它是为软件测试准备的[^2]。另一份报告也写明“Revenue grew.”[^3]",
      ),
    ).toEqual([
      ["摘要页写明“The text is fictional.”。", [1]],
      ["下一页说明它是为软件测试准备的。", [2]],
      ["另一份报告也写明“Revenue grew.”", [3]],
    ]);
  });

  test.each([
    ["「", "」"],
    ['"', '"'],
    ["『", "』"],
  ])("an English full stop inside %s…%s in Chinese text ends no sentence", (open, close) => {
    expect(
      split(
        `摘要页写明${open}Prepared for software testing[^1]. The text is fictional.${close}（为软件测试准备）[^2]。下一句是另一回事[^3]。`,
      ),
    ).toEqual([
      [
        `摘要页写明${open}Prepared for software testing. The text is fictional.${close}（为软件测试准备）。`,
        [1, 2],
      ],
      ["下一句是另一回事。", [3]],
    ]);
  });

  test("a quoted English sentence that ends a Chinese sentence ends it, when a space comes before the next word", () => {
    expect(split("合同写明“Delivery in six weeks.”[^1] 我们同意这个日期[^2]。")).toEqual([
      ["合同写明“Delivery in six weeks.”", [1]],
      ["我们同意这个日期。", [2]],
    ]);
    expect(split("他说“Stop here. Go back.”[^1] Then he left the room [^2].")).toEqual([
      ["他说“Stop here. Go back.”", [1]],
      ["Then he left the room.", [2]],
    ]);
  });

  test.each([
    "合同写明“Delivery in six weeks.”[^1]，我们同意这个日期[^2]。",
    "合同写明“Delivery in six weeks.”[^1]（六周内交货）我们同意这个日期[^2]。",
    "所谓“Delivery in six weeks.”[^1]的说法我们同意[^2]。",
  ])("a quoted English sentence that the Chinese sentence goes on past is in it: %s", (answer) => {
    expect(split(answer)).toEqual([[answer.replaceAll(/\[\^\d\]/g, ""), [1, 2]]]);
  });

  test.each([
    "合同第三条（原文：We ship in six weeks. No later than May.）[^1]规定了交货期[^2]。",
    "合同第三条 (We ship in six weeks. No later than May.)[^1] 规定了交货期[^2]。",
    "他说‘Stop here. Go back now.’[^1]然后就离开了会议室[^2]。",
    "《Terms of Service. Second edition.》[^1]规定了退款的期限[^2]。",
    "合同（原文（英文）：We ship in six weeks. No later than May.）[^1]规定了交货期[^2]。",
  ])(
    "English sentences in brackets, single quotation marks or a title within a Chinese sentence are in it: %s",
    (answer) => {
      expect(split(answer)).toEqual([[answer.replaceAll(/\[\^\d\]/g, ""), [1, 2]]]);
    },
  );

  test("a quotation that starts a Chinese sentence is read with the words after it", () => {
    expect(
      split("“Prepared for software testing. The text is fictional.”是摘要页的原话[^1]。"),
    ).toEqual([["“Prepared for software testing. The text is fictional.”是摘要页的原话。", [1]]]);
  });

  // In English the full stop inside the closing mark ends the sentence that quotes it too.
  test("English text still ends a sentence at the full stop of the sentence it quotes", () => {
    expect(split('He said "Stop."[^1] Then he left[^2].')).toEqual([
      ['He said "Stop."', [1]],
      ["Then he left.", [2]],
    ]);
    expect(split('合同已经签署了[^1]。He said "Stop."[^2] Then he left[^3].')).toEqual([
      ["合同已经签署了。", [1]],
      ['He said "Stop."', [2]],
      ["Then he left.", [3]],
    ]);
  });

  test.each([
    QUOTING.replace("”", ""),
    QUOTING.replace("“", "「"),
    QUOTING.replaceAll(/[“”]/g, '"').replace('."', "."),
    `${QUOTING.replace("”", "")}他又写道“Stop here. Go on[^6].`,
  ])("a quotation never closed loses no word: %s", (answer) => {
    expect(wordsReturned(answer)).toEqual(wordsOf(answer));
  });
});

describe("An English sentence that quotes two sentences is one sentence (#3019)", () => {
  // The split before this rule is the second column: each quotation was cut at its first full stop.
  test.each([
    [
      'The report\'s first page says "Prepared for software testing[^4]. The text is fictional."[^3] So it may not describe a real model[^5].',
      [
        'The report\'s first page says "Prepared for software testing. The text is fictional."',
        "So it may not describe a real model.",
      ],
      [
        "The report's first page says \"Prepared for software testing.",
        'The text is fictional."',
        "So it may not describe a real model.",
      ],
    ],
    [
      "The appendix reads “Loss falls more smoothly. Fewer steps are needed.”[^1] That is its whole account[^2].",
      [
        "The appendix reads “Loss falls more smoothly. Fewer steps are needed.”",
        "That is its whole account.",
      ],
      [
        "The appendix reads “Loss falls more smoothly.",
        "Fewer steps are needed.”",
        "That is its whole account.",
      ],
    ],
    [
      "The memo calls it ‘a draft. Not final.’[^1] in its last line.",
      ["The memo calls it ‘a draft. Not final.’ in its last line."],
      ["The memo calls it ‘a draft.", "Not final.’ in its last line."],
    ],
    [
      "Table 1 (Work per layer. Three ways compared.)[^1] lists recurrent layers first.",
      ["Table 1 (Work per layer. Three ways compared.) lists recurrent layers first."],
      ["Table 1 (Work per layer.", "Three ways compared.) lists recurrent layers first."],
    ],
    [
      'It says "may carry over to sequences longer than those in training"[^1], and nothing else.',
      ['It says "may carry over to sequences longer than those in training", and nothing else.'],
      ['It says "may carry over to sequences longer than those in training", and nothing else.'],
    ],
  ])("%s", (answer, now) => {
    expect(split(answer).map(([sentence]) => sentence)).toEqual(now);
  });

  test("the quotation's markers stay with the sentence that holds it", () => {
    expect(
      split(
        'The report\'s first page says "Prepared for software testing[^4]. The text is fictional."[^3] So it may not describe a real model[^5].',
      ),
    ).toEqual([
      [
        'The report\'s first page says "Prepared for software testing. The text is fictional."',
        [4, 3],
      ],
      ["So it may not describe a real model.", [5]],
    ]);
  });

  // From a second read of #3019's English rule: each reads as on main, two sentences, and its twin
  // that quotes two sentences still joins.
  test.each<[string, string[]]>([
    [
      'The lease says "Rent is due monthly."[^1] "Late rent bears interest," it adds[^2].',
      ['The lease says "Rent is due monthly."', '"Late rent bears interest," it adds.'],
    ],
    [
      'The lease says "Rent is due monthly."[^1] (Clause 4 says when.)[^2] The tenant agreed to it[^3].',
      [
        'The lease says "Rent is due monthly."',
        "(Clause 4 says when.)",
        "The tenant agreed to it.",
      ],
    ],
    [
      "The lease says “Rent is due monthly.”[^1] ‘Later’ payments bear interest[^2].",
      ["The lease says “Rent is due monthly.”", "‘Later’ payments bear interest."],
    ],
    [
      "The memo says (Rent is due monthly.)[^1] “Late rent bears interest,” it adds[^2].",
      ["The memo says (Rent is due monthly.)", "“Late rent bears interest,” it adds."],
    ],
    ...["£500", "$500", "¥500", "— 500 pounds", "…500 pounds"].map(
      (opening): [string, string[]] => [
        `He asked "Why is it late?"[^1] ${opening} is due now[^2].`,
        ['He asked "Why is it late?"', `${opening} is due now.`],
      ],
    ),
    [
      'She cried "Stop the sale!"[^1] $500 was paid anyway[^2].',
      ['She cried "Stop the sale!"', "$500 was paid anyway."],
    ],
    [
      "Did he say it (twice. Loudly.)?[^1] Yes, he said it twice[^2].",
      ["Did he say it (twice. Loudly.)?", "Yes, he said it twice."],
    ],
    [
      "In the ‘90s sales rose[^1]. In the 2000s they didn’t[^2].",
      ["In the ‘90s sales rose.", "In the 2000s they didn’t."],
    ],
    [
      'The lease says "Rent is due monthly. Late rent bears interest."[^1] The tenant agreed to it[^2].',
      [
        'The lease says "Rent is due monthly. Late rent bears interest."',
        "The tenant agreed to it.",
      ],
    ],
  ])("a quotation that ends its sentence leaves the next one apart: %s", (answer, sentences) => {
    expect(split(answer).map(([sentence]) => sentence)).toEqual(sentences);
  });

  // protects=a straight mark that closes nothing (an inch mark) leaves the next quotation to be read, and a Chinese closing mark between Han characters closes its quotation; fails_when=the real quotation is skipped, or a Chinese closing mark is taken for an apostrophe and joins the next English sentence; no_claim=none beyond protects.
  test.each<[string, string[]]>([
    [
      'The display is 15 inches wide (15")[^1]. The report says "Costs fell. Revenue rose."[^2]',
      ['The display is 15 inches wide (15").', 'The report says "Costs fell. Revenue rose."'],
    ],
    [
      "报告称‘收入增长’但没有给出数据[^1]. Costs fell sharply in May[^2]. Revenue held up in June[^3].",
      ["报告称‘收入增长’但没有给出数据.", "Costs fell sharply in May.", "Revenue held up in June."],
    ],
  ])("a mark that closes nothing, or a Chinese one, is read as it is: %s", (answer, sentences) => {
    expect(split(answer).map(([sentence]) => sentence)).toEqual(sentences);
  });

  test.each([
    [
      'He wrote "Stop here[^1]. Go on with the next step[^2].',
      ['He wrote "Stop here.', "Go on with the next step."],
    ],
    [
      'He wrote "Stop here[^1]. Then she said "go" twice[^2].',
      ['He wrote "Stop here.', 'Then she said "go" twice.'],
    ],
    [
      "Prices rose in the first quarter[^1]. Wages fell in the second[^2].",
      ["Prices rose in the first quarter.", "Wages fell in the second."],
    ],
  ])("a quotation never closed, or none at all, keeps the plain split: %s", (answer, sentences) => {
    expect(split(answer).map(([sentence]) => sentence)).toEqual(sentences);
  });
});

const ENGLISH = [
  "Prepared for software testing",
  "The text is fictional",
  "Revenue grew in the quarter",
  "Costs fell by a third",
  "The board approved the plan",
];
const LEADS = [
  "另外，该文档的摘要页写明",
  "合同第三条规定",
  "报告在结论部分说：",
  "供应商在信中提到 ",
];
const AFTER = [
  "（为软件测试准备，文本是虚构的）",
  "（收入在本季度增长）",
  "，这说明文件是测试用的",
  "",
];
const CHINESE = ["今天的潮水很高", "窑炉计划在明年二月安装", "合同有效期至年底"];
const MARKS = [
  ["“", "”"],
  ['"', '"'],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["（", "）"],
  ["(", ")"],
  ["《", "》"],
] as const;

/**
 * An Answer whose every sentence, as its own language punctuates it, carries a Citation: Chinese
 * sentences quoting English ones in quotation marks, brackets or a title (some never closed, some
 * ending at the quoted sentence), Chinese and English ones without them, English ones ending in
 * the sentence they quote, list items and footnotes.
 */
function generatedAnswer(seed: number): string {
  const { next, pick } = random(seed);
  let marker = 1;
  const cite = () => `[^${marker++}]`;
  const chance = (odds: number) => next() < odds;
  const sentence = () => {
    const kind = next();
    if (kind < 0.5) {
      const [open, close] = pick(MARKS);
      const quoted = Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
        const stop = pick([".", ".", "!", "?"]);
        return `${pick(ENGLISH)}${chance(0.4) ? cite() : ""}${stop}`;
      }).join(" ");
      const end = chance(0.5) ? `${cite()}。` : `。${cite()}`;
      return `${pick(LEADS)}${open}${quoted}${chance(0.8) ? close : ""}${pick(AFTER)}${end}`;
    }
    if (kind < 0.6) {
      const [open, close] = pick(MARKS);
      return `${pick(LEADS)}${open}${pick(ENGLISH)}.${close}${cite()} `;
    }
    if (kind < 0.7) return `${pick(CHINESE)}${cite()}。`;
    if (kind < 0.85) return `He said "${pick(ENGLISH)}."${cite()}`;
    return `${pick(ENGLISH)} in the memo${cite()}.`;
  };
  const lines = Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
    const prefix = pick(["", "", "- ", "> "]);
    const joiner = pick(["", " "]);
    return `${prefix}${Array.from({ length: 1 + Math.floor(next() * 4) }, sentence).join(joiner)}`;
  });
  if (chance(0.5)) lines.push("", "[^1]: Summary.pdf, page 2.");
  return lines.join("\n");
}

describe("The cited sentences of an Answer", () => {
  test("lose no word between them, when each sentence carries a Citation", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const answer = generatedAnswer(seed);
      expect(wordsReturned(answer), answer).toEqual(wordsOf(answer));
    }
  });
});
