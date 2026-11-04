/**
 * Words an Answer quotes from its Document are found when they are on the page (#2504): a quote
 * nested in the quote written in the other kind of mark, words that run on from the cited page to
 * the next, and a bracketed gloss of a term left out. A quote that changes a word or a number,
 * adds a "not" or takes a word from another line still shows Quote not found.
 */
import { describe, expect, test } from "vitest";
import {
  askAndFinish,
  citingModel,
  onlyCitation,
  type ShownPassage,
  type SourceFile,
  setUpWithDocuments,
} from "../helpers/citations";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

interface Case {
  file: SourceFile;
  query: string;
  question: string;
  /** The record's quote, which is on the page. */
  quote: string;
}

/** The check of the one Citation of an Answer whose sentence is `sentence`, citing `quote`. */
async function checkOf({ file, query, question, quote }: Case, sentence: string) {
  const model = citingModel({
    query,
    records: (passages: ShownPassage[]) => [{ marker: 1, passage: passages[0]?.id, quote }],
    answer: sentence,
  });
  const { core, client, mind } = await setUpWithDocuments(model, [file]);
  const { answerId } = await askAndFinish(core, client, mind.id, question);
  const { check, checkReason } = onlyCitation(client, answerId);
  return { check, checkReason };
}

const FOUND = { check: "found", checkReason: null };
const NOT_FOUND = { check: "not-found", checkReason: "quoted-words-not-on-pages" };

const NESTED = {
  en: {
    file: {
      name: "Returns policy.md",
      contents:
        "# Returns policy\n\nThe “cooling-off period” lasts 14 days from delivery for every order.\n",
    },
    query: "cooling-off period",
    question: "How long is the cooling-off period?",
    quote: "The “cooling-off period” lasts 14 days from delivery",
    found: "It says “the ‘cooling-off period’ lasts 14 days from delivery for every order” [^1].",
    number: "It says “the ‘cooling-off period’ lasts 15 days from delivery for every order” [^1].",
    not: "It says “the ‘cooling-off period’ does not last 14 days from delivery” [^1].",
  },
  zh: {
    file: {
      name: "注意力机制.md",
      contents:
        "# 注意力机制\n\n注意力机制的灵活性来自于它的“软权重”特性，即这种权重是可以在运行时改变的，模型共有12层。\n",
    },
    query: "软权重",
    question: "注意力机制为什么更灵活？",
    quote: "注意力机制的灵活性来自于它的“软权重”特性",
    found:
      "文中写道“注意力机制的灵活性来自于它的‘软权重’特性，即这种权重是可以在运行时改变的，模型共有12层”[^1]。",
    number:
      "文中写道“注意力机制的灵活性来自于它的‘软权重’特性，即这种权重是可以在运行时改变的，模型共有13层”[^1]。",
    not: "文中写道“注意力机制的灵活性来自于它的‘软权重’特性，即这种权重是不可以在运行时改变的”[^1]。",
  },
} as const;

describe.each(["en", "zh"] as const)("A quote nested in the quote (%s)", (language) => {
  const nested = NESTED[language];

  test("written in the other kind of quotation mark, the words are the page's: found", async () => {
    expect(await checkOf(nested, nested.found)).toEqual(FOUND);
  });

  test.each([
    ["a changed number", "number"],
    ["an added not", "not"],
  ] as const)("with %s, not found", async (_, key) => {
    expect(await checkOf(nested, nested[key])).toEqual(NOT_FOUND);
  });
});

const RUN_ON = {
  en: {
    file: {
      name: "Code of Practice.pdf",
      contents: buildPdf([
        {
          lines: [
            "Clause 26 Delivery of items",
            "When a representative offers to drop items off, the reply card must say that there is no",
            "obligation to grant an interview when items are",
          ],
        },
        {
          lines: [
            "delivered. Items can be returned without explanation.",
            "The reply card must give the health professional a way to say no.",
          ],
        },
      ]),
    },
    query: "reply card interview",
    question: "What must the reply card say?",
    quote: "the reply card must say that there is no",
    found:
      "The card must say there is “no obligation to grant an interview when items are delivered” [^1].",
    otherLine:
      "The card must say there is “no obligation to grant an interview when items are returned” [^1].",
    number:
      "The card must say there is “no obligation to grant an interview when 3 items are delivered” [^1].",
    nextPageOnly: "The card says “Items can be returned without explanation” [^1].",
    ellipsis:
      "The card must say there is “no obligation to grant an interview … give the health professional a way to say no” [^1].",
  },
  zh: {
    file: {
      name: "行为准则.pdf",
      contents: buildPdf([
        {
          chineseLines: [
            "第二十六条 物品递送",
            "代表提出送来物品时，回执卡必须写明医务人员没有义务在物品送达",
          ],
        },
        {
          chineseLines: [
            "时接受面谈。物品可以退回，无须向代表说明任何理由。",
            "回执卡必须让医务人员可以拒绝。",
          ],
        },
      ]),
    },
    query: "回执卡 面谈",
    question: "回执卡必须写明什么？",
    quote: "回执卡必须写明医务人员没有义务",
    found: "回执卡必须写明“医务人员没有义务在物品送达时接受面谈”[^1]。",
    otherLine: "回执卡必须写明“医务人员没有义务在物品退回时接受面谈”[^1]。",
    number: "回执卡必须写明“医务人员没有义务在3件物品送达时接受面谈”[^1]。",
    nextPageOnly: "回执卡写明“物品可以退回，无须向代表说明任何理由”[^1]。",
    ellipsis:
      "回执卡写明“回执卡必须写明医务人员没有义务在物品送达……物品可以退回，无须向代表说明任何理由”[^1]。",
  },
} as const;

describe.each(["en", "zh"] as const)(
  "Quoted words that run on to the next page (%s)",
  (language) => {
    const runOn = RUN_ON[language];

    test("starting on the cited page and running on to the next page of the Passage: found", async () => {
      expect(await checkOf(runOn, runOn.found)).toEqual(FOUND);
    });

    test.each([
      ["a word from another line", "otherLine"],
      ["a number added", "number"],
      ["words only on the next page", "nextPageOnly"],
      ["a part after an ellipsis only on the next page", "ellipsis"],
    ] as const)("with %s, not found", async (_, key) => {
      expect(await checkOf(runOn, runOn[key])).toEqual(NOT_FOUND);
    });
  },
);

describe("Quoted words that run on to the next slide", () => {
  test("a slide is a place of its own: words joined from two slides are not found", async () => {
    const slideOf = (text: string) => ({
      shapes: sp({ id: 2, name: "Body", txBox: true, body: txBody(para(text)) }),
    });
    const deck = {
      file: {
        name: "Results.pptx",
        contents: new Uint8Array(
          pptxOf({
            slides: [
              slideOf("Costs fell 4% this year and revenue grew"),
              slideOf("12% in Asia was the target for next year."),
            ],
          }),
        ),
      },
      query: "revenue grew",
      question: "How did revenue do?",
      quote: "Costs fell 4% this year and revenue grew",
    };

    expect(
      await checkOf(deck, "It says “costs fell 4% this year and revenue grew 12% in Asia” [^1]."),
    ).toEqual(NOT_FOUND);
  });
});

const GLOSS = {
  en: {
    file: {
      name: "Optimisers.md",
      contents:
        "# Optimisers\n\nStochastic gradient descent (Chinese: 随机梯度下降) is the most basic algorithm for training deep networks (since 2012) at scale.\n",
    },
    query: "stochastic gradient descent",
    question: "What is the most basic optimiser?",
    quote: "is the most basic algorithm for training deep networks",
    found:
      "It is “stochastic gradient descent is the most basic algorithm for training deep networks” [^1].",
    otherWord:
      "It is “stochastic gradient descent is the most widely used algorithm for training deep networks” [^1].",
    not: "It is “stochastic gradient descent is not the most basic algorithm for training deep networks” [^1].",
    otherBrackets:
      "It says it is “the most basic algorithm for training deep networks at scale” [^1].",
  },
  zh: {
    file: {
      name: "梯度下降法.md",
      contents:
        "# 梯度下降法\n\n随机梯度下降法作为梯度下降法的一个简单延展，是目前用于训练大多数深度学习结构（英語：deep networks）的最基本的算法（2012年起）之一。\n",
    },
    query: "随机梯度下降法",
    question: "最基础的优化算法是什么？",
    quote: "作为梯度下降法的一个简单延展",
    found: "条目写道，它“是目前用于训练大多数深度学习结构的最基本的算法”[^1]。",
    otherWord: "条目写道，它“是目前用于训练深度学习结构的最基本的算法”[^1]。",
    not: "条目写道，它“不是目前用于训练大多数深度学习结构的最基本的算法”[^1]。",
    otherBrackets: "条目写道，它“是目前用于训练大多数深度学习结构的最基本的算法之一”[^1]。",
  },
} as const;

describe.each(["en", "zh"] as const)("A bracketed gloss left out (%s)", (language) => {
  const gloss = GLOSS[language];

  test("the words around a gloss naming a language are the page's, in order: found", async () => {
    expect(await checkOf(gloss, gloss.found)).toEqual(FOUND);
  });

  test.each([
    ["a word changed or left out", "otherWord"],
    ["an added not", "not"],
    ["other words in brackets left out", "otherBrackets"],
  ] as const)("with %s, not found", async (_, key) => {
    expect(await checkOf(gloss, gloss[key])).toEqual(NOT_FOUND);
  });
});

describe("Changed words in Chinese stay not found", () => {
  const governance = {
    file: {
      name: "公司治理.md",
      contents:
        "# 公司治理\n\n其他該注意事項包括報告和透明度、商業道德、董事會監督、執行長/董事會主席由不同人擔任、股東提名董事會候選人的權利。\n",
    },
    query: "董事會主席",
    question: "公司治理要注意什么？",
    quote: "執行長/董事會主席由不同人擔任",
  };

  test("a word put in for the page's (CEO for 執行長): not found", async () => {
    expect(await checkOf(governance, "条目列出“CEO/董事会主席由不同人担任”[^1]。")).toEqual(
      NOT_FOUND,
    );
  });

  test("the page's words in simplified characters: found", async () => {
    expect(await checkOf(governance, "条目列出“执行长/董事会主席由不同人担任”[^1]。")).toEqual(
      FOUND,
    );
  });
});
