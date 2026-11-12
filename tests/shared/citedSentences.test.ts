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
  ["「", "」"],
  ["『", "』"],
] as const;

/**
 * An Answer whose every sentence, as its own language punctuates it, carries a Citation: Chinese
 * sentences quoting English ones (some never closed), Chinese and English ones without quotes,
 * English ones ending in the sentence they quote, list items and footnotes.
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
