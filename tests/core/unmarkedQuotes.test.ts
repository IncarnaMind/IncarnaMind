import { describe, expect, test } from "vitest";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { wordsOf } from "../../src/core/answers/markerPlacement";
import {
  matchUnmarked,
  mayDrawOn,
  parseAsked,
  settleOrphans,
} from "../../src/core/answers/unmarkedQuotes";
import { askAndFinish, citationsIn, setUpWithDocuments } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/*
 * #760: an Answer that quotes the Passages it read without Citation markers
 * gets its Citations, each found on its page; when nothing matches it, the
 * model is asked for them once, and never "no sources".
 */

const FIRST =
  "Tea drinking began in southwest China, where it was first used as a medicinal drink.";
const SECOND = "Traders carried tea along the Tea Horse Road to Tibet.";
/** Shares enough of SECOND's words to draw on it, too few to be a near-duplicate of it. */
const LOOSE =
  "Long ago, merchants and traders carried bricks of tea along the old Horse Road through mountains and rivers, trading them for horses and silver.";
const TEA = {
  name: "Tea history.md",
  contents: `# Tea history\n\n${FIRST}\n\n${SECOND}\n`,
};

/** A model that searches once, then answers `answer` with no Citations; `asked` replies to the one request for them. */
function quotingModel(
  answer: string,
  asked: (call: ModelCall) => ScriptedReply = () => ({ text: "{}" }),
) {
  return scriptedModel((call) => {
    if (call.json) return asked(call);
    if (!call.results.some((result) => result.tool === "search_documents")) {
      return {
        calls: [{ tool: "search_documents", input: { query: "where tea was first drunk" } }],
      };
    }
    return { text: answer };
  });
}

/** The ids of the Passages a search result lists ("P1", …). */
const passageIds = (text: string) => [...text.matchAll(/<passage id=\\?"(P\d+)/g)].map((m) => m[1]);

describe("An Answer that quotes without markers (#760)", { timeout: 30_000 }, () => {
  // protects=a quotation the Answer copied from a Passage gets its Citation, found on its page, with no request more; fails_when=it stays uncited, is cited not found, or the model is asked again; no_claim=the line under the Answer (tests/renderer/answerSteps.test.ts).
  test("a quotation copied from a Passage gets its Citation, found, and the model isn't asked again", async () => {
    const model = quotingModel(`As one article puts it, "${FIRST}" So it began in China.`);
    const { core, client, mind } = await setUpWithDocuments(model, [TEA]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "Where was tea first drunk?",
    );

    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({ check: "found", quote: FIRST }),
    ]);
    expect(finished.citedAfterChecking).toEqual({ count: 1, asked: false });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  // protects=a marker the model wrote but gave no record for takes the Citation found for its sentence, instead of being removed; fails_when=the marker is removed, or a second marker is added; no_claim=none beyond protects.
  test("a marker written with no record behind it takes the Citation its quotation matches", async () => {
    const model = quotingModel(`It is described as "${SECOND}" [^1] That is all.`);
    const { core, client, mind } = await setUpWithDocuments(model, [TEA]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "How did tea reach Tibet?",
    );

    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({ check: "found", quote: SECOND }),
    ]);
    expect(finished.citedAfterChecking).toEqual({ count: 1, asked: false });
    expect(finished.citations).toHaveLength(1);
  });

  // protects=two sentences holding one marker the model gave no record for each get their own Citation, the first keeping the marker; fails_when=the second's record overwrites the first's, so the first cites the second's Passage; no_claim=none beyond protects.
  test("two sentences sharing a marker with no record each get their own Citation", async () => {
    const model = quotingModel(`It says "${FIRST}" [^1] It also says "${SECOND}" [^1]`);
    const { core, client, mind } = await setUpWithDocuments(model, [TEA]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "What do the notes say?",
    );

    expect(citationsIn(client, answerId).map((each) => [each.quote, each.check])).toEqual([
      [FIRST, "found"],
      [SECOND, "found"],
    ]);
    expect(finished.citedAfterChecking).toEqual({ count: 2, asked: false });
  });

  // protects=a sentence worded closely like a Passage's is cited with that sentence as its quote; fails_when=it stays uncited or cites another Passage sentence; no_claim=how close is close enough beyond this pair.
  test("a sentence worded closely like a Passage's is cited with the Passage's sentence", async () => {
    const model = quotingModel(
      "Tea drinking began in southwest China, where people first used it as a medicinal drink.",
    );
    const { core, client, mind } = await setUpWithDocuments(model, [TEA]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "Where was tea first drunk?",
    );

    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({ check: "found", quote: FIRST }),
    ]);
    expect(finished.citedAfterChecking).toEqual({ count: 1, asked: false });
  });

  // protects=when nothing matches the model is asked once for its Citations, with the Passages it read, and only a quote the check finds is taken; fails_when=no request is made, more than one is, or an unfound quote is cited; no_claim=what a real model replies.
  test("when nothing matches, the model is asked once, with the Passages it read", async () => {
    const asked: ModelCall[] = [];
    const model = quotingModel(LOOSE, (call) => {
      asked.push(call);
      const [id] = passageIds(
        call.options.prompt.map((message) => JSON.stringify(message)).join(""),
      );
      return {
        text: JSON.stringify({
          citations: [
            {
              sentence: LOOSE,
              passage: id,
              quote: SECOND,
            },
            {
              sentence: LOOSE,
              passage: id,
              quote: "Not in it.",
            },
          ],
        }),
      };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [TEA]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "How did tea reach Tibet?",
    );

    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0]?.options.prompt)).toContain(SECOND);
    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({ check: "found", quote: SECOND }),
    ]);
    expect(finished.citedAfterChecking).toEqual({ count: 1, asked: true });
  });

  // protects=the one request for Citations is one of the end-of-turn checks' asks (#946): with no step of the budget left it isn't made; fails_when=the model is asked past the step budget; no_claim=none beyond protects.
  test("with no step left in the budget, the model isn't asked for Citations", async () => {
    let requests = 0;
    const model = quotingModel(LOOSE, () => {
      requests++;
      return { text: JSON.stringify({ citations: [] }) };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [TEA], {
      answerEngine: createAiSdkAnswerEngine({ maxSteps: 2 }),
    });

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "How did tea reach Tibet?",
    );

    expect(requests).toBe(0);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(citationsIn(client, answerId)).toEqual([]);
    expect(finished.citedAfterChecking?.asked ?? false).toBe(false);
  });

  // protects=the one request is made at most once, and an Answer it can't help stays uncited; an Answer that shares nothing with the Passages isn't asked about; fails_when=it asks twice, asks for a decline, or invents a Citation; no_claim=none beyond protects.
  test("asked and given nothing, the Answer stays uncited after one request; a decline isn't asked about", async () => {
    let requests = 0;
    const replyNothing = () => {
      requests++;
      return { text: JSON.stringify({ citations: [] }) };
    };
    const drawing = quotingModel(LOOSE, replyNothing);
    const first = await setUpWithDocuments(drawing, [TEA]);

    const asked = await askAndFinish(first.core, first.client, first.mind.id, "Who carried it?");

    expect(requests).toBe(1);
    expect(citationsIn(first.client, asked.answerId)).toEqual([]);
    expect(asked.finished.citedAfterChecking).toEqual({ count: 0, asked: true });

    const declining = quotingModel("Your Documents don't say who grew it.", replyNothing);
    const second = await setUpWithDocuments(declining, [TEA]);
    const declined = await askAndFinish(second.core, second.client, second.mind.id, "Who grew it?");
    expect(requests).toBe(1);
    expect(declined.finished.citedAfterChecking).toEqual({ count: 0, asked: false });
  });

  // protects=an Answer that cites with its own markers is left as it is, and nothing is asked; fails_when=its markers move or a request is made; no_claim=none beyond protects.
  test("an Answer with its own Citations isn't asked again", async () => {
    let requests = 0;
    const model = scriptedModel((call) => {
      if (call.json) {
        requests++;
        return { text: "{}" };
      }
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
      }
      if (call.results.some((result) => result.tool === "cite")) return { text: "" };
      const [id] = passageIds(searches[0]?.text ?? "");
      return {
        text: "It began in southwest China [^1]. I can't say more.",
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: id, quote: FIRST }] } }],
      };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [TEA]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "Where was tea first drunk?",
    );

    expect(requests).toBe(0);
    expect(citationsIn(client, answerId)).toHaveLength(1);
    expect(finished.citedAfterChecking).toEqual({ count: 0, asked: false });
  });
});

describe("Matching sentences to Passages", () => {
  const found = (text: string) => (_passage: string, quote: string) => text.includes(quote);

  // protects=quotations in curly quotes and Chinese corner brackets match, short ones don't, and each sentence gets one Citation; fails_when=a two-word quotation is cited or a sentence gets two; no_claim=the Citation check itself (tests/core/citations.test.ts).
  test("quotations in any quotation marks, long enough to say something", () => {
    const passages = [{ id: "P1", text: `${FIRST}\n茶最早在中国西南地区作为药用饮品。` }];
    const text = `${FIRST}\n茶最早在中国西南地区作为药用饮品。`;
    expect(
      matchUnmarked(
        `It says “${FIRST}” Also “began in”. 文中说「茶最早在中国西南地区作为药用饮品。」`,
        passages,
        found(text),
      ).map(({ passage, quote, sentence }) => ({ passage, quote, sentence })),
    ).toEqual([
      { passage: "P1", quote: FIRST, sentence: `It says “${FIRST}` },
      {
        passage: "P1",
        quote: "茶最早在中国西南地区作为药用饮品。",
        sentence: "文中说「茶最早在中国西南地区作为药用饮品。",
      },
    ]);
  });

  // protects=a near-duplicate with another number, or a negation the Passage doesn't have, isn't cited, in English and Chinese; one saying the same is; fails_when=£739,800 is cited by £793,800, "is not" by "is", or 不是 by 是; no_claim=quotations, which the check reads word for word.
  test("a near-duplicate must give the same numbers and negations", () => {
    const rent = "The rent for the flat in Camden is £793,800 a year, paid monthly.";
    const monthly = "The rent for the flat in Camden is £1,200 a month, paid in advance.";
    const zh = "这套公寓的月租金是一千二百元，按月支付。";
    const passages = [{ id: "P1", text: `${rent}\n${monthly}\n${zh}` }];
    const found = (_passage: string, quote: string) => passages[0]?.text.includes(quote) ?? false;
    const cited = (sentence: string) =>
      matchUnmarked(sentence, passages, found).map((each) => each.quote);

    expect(cited("The rent for the flat in Camden is £739,800 a year, paid monthly.")).toEqual([]);
    expect(
      cited("The rent for the flat in Camden is not £1,200 a month, paid in advance."),
    ).toEqual([]);
    expect(cited("这套公寓的月租金不是一千二百元，按月支付。")).toEqual([]);
    expect(cited("这套公寓的月租金是一千二百元，每月支付。")).toEqual([zh]);
    expect(cited("The rent for the flat in Camden is £793,800 a year, paid each month.")).toEqual([
      rent,
    ]);
  });

  // protects=a sentence that shares only a few words with a Passage isn't cited; fails_when=a loose paraphrase is cited; no_claim=none beyond protects.
  test("a loosely related sentence isn't cited", () => {
    expect(
      matchUnmarked("China is where tea is from.", [{ id: "P1", text: FIRST }], found(FIRST)),
    ).toEqual([]);
  });

  // protects=a marker without a record stays only in the sentence that took it; elsewhere it becomes that sentence's own Citation's marker, or goes; fails_when=a sentence keeps another's Citation; no_claim=none beyond protects.
  test("a shared marker without a record stays only where it was taken", () => {
    const answer = "A one [^1]. B two [^1]. C three [^1].";
    const span = (sentence: string) => {
      const start = answer.indexOf(sentence);
      return { start, end: start + sentence.length };
    };
    expect(
      settleOrphans(answer, [
        { marker: 1, took: true, ...span("A one [^1].") },
        { marker: 4, took: false, ...span("B two [^1].") },
      ]),
    ).toBe("A one [^1]. B two [^4]. C three .");
  });

  // protects=a footnote definition ("[^1]: Source, p. 1") keeps its marker when a sentence takes that number, so the line is dropped whole afterwards and no ": Source, p. 1" stays in the Answer; fails_when=the definition loses its marker and the rest of the line shows; no_claim=none beyond protects.
  test("a footnote definition keeps its marker", () => {
    const answer = "A one [^1]. B two [^1].\n\n[^1]: Tea history, p. 1";
    const start = answer.indexOf("A one");
    expect(
      settleOrphans(answer, [{ marker: 1, took: true, start, end: start + "A one [^1].".length }]),
    ).toBe("A one [^1]. B two .\n\n[^1]: Tea history, p. 1");
  });

  // protects=#1415: across languages a reply is worth asking about when it shares a number of 2+ digits or a Latin term of 4+ letters with the Passages, as summaries of English Documents in Chinese do, and not otherwise; fails_when=a Chinese summary naming a figure or a term isn't asked, or a greeting, a "didn't find", a question back or a count of Documents is; no_claim=the replay of real Answers in the pull request.
  test("across languages, a number or a Latin term shared with the Passages", () => {
    const passages = [
      {
        id: "P1",
        text: "The Transformer achieves 28.4 BLEU on the WMT 2014 English-to-German translation task.",
      },
      { id: "P2", text: "Table 2 lists the 7 models we trained on 12 GPUs." },
    ];
    expect(mayDrawOn("该论文提出了 Transformer 架构。", passages)).toBe(true);
    expect(mayDrawOn("在英德翻译任务上达到了 28.4 的成绩。", passages)).toBe(true);
    expect(mayDrawOn("训练在 8 块 GPU 上进行了 12 小时。", passages)).toBe(true);
    for (const reply of [
      "你好！有什么可以帮你？",
      "我在你的文档中没有找到关于停车位的内容。",
      "你是想问哪一处房产的停车位？",
      "以下内容不是来自你的文档：注意力机制让模型关注输入中最相关的部分。",
      "我查看了 7 个文档，都没有提到停车位。",
      "你是指第 2 份报告吗？",
    ]) {
      expect(mayDrawOn(reply, passages)).toBe(false);
    }
    expect(mayDrawOn("I didn't find anything about parking in your documents.", passages)).toBe(
      false,
    );
  });

  // protects=the reply to the one request is read leniently and only well-formed items are kept; fails_when=a malformed item throws or is kept; no_claim=none beyond protects.
  test("the one request's reply: only whole items", () => {
    expect(
      parseAsked({
        citations: [
          { sentence: " A. ", passage: "P1", quote: " q " },
          { sentence: "B.", passage: 2, quote: "q" },
          "nonsense",
        ],
      }),
    ).toEqual([{ sentence: "A.", passage: "P1", quote: "q" }]);
    expect(parseAsked(undefined)).toEqual([]);
  });
});

/*
 * #3059: a sentence's numbers are read without its Citation markers, so a sentence whose marker
 * has no record matches its own Document line, and a marker's digits never stand in for a number
 * the sentence left out.
 */
const SUPPLIER = {
  en: {
    name: "Survey terms.md",
    lines: {
      year: "The full cost of the survey is covered by the supplier in the first year.",
      years: "Travel to each site is paid by the client for the first 2 years of the contract.",
      figure: "The survey costs $4,500 for each site in the region.",
    },
    question: "What does the supplier cover?",
  },
  zh: {
    name: "调研条款.md",
    lines: {
      year: "第一年调研的全部费用由供应商承担。",
      years: "合同前 2 年去各个现场的差旅费由客户支付。",
      figure: "本地区每个地点的调研费用为 4,500 美元。",
    },
    question: "供应商承担哪些费用？",
  },
};
const supplierDocument = (
  language: "en" | "zh",
  lines: readonly string[] = Object.values(SUPPLIER[language].lines),
) => {
  const { name } = SUPPLIER[language];
  return { name, contents: `# ${name.replace(/\.md$/, "")}\n\n${lines.join("\n\n")}\n` };
};
/** A sentence of the Answer as the model writes it: a Document's line with `marker` before its full stop. */
const marked = (line: string, marker: string) => line.replace(/([.。])$/, `${marker}$1`);
/** The other years' line with its number left out: "for the first years", "前几年". */
const yearsLeftOut = {
  en: SUPPLIER.en.lines.years.replace("first 2 years", "first years"),
  zh: SUPPLIER.zh.lines.years.replace("前 2 年", "前几年"),
};
/** A model that searches for `query` once and answers `answer`, giving no record of its own; the one request gets nothing. */
const writingModel = (query: string, answer: string) =>
  scriptedModel((call) => {
    if (call.json) return { text: "{}" };
    if (!call.results.some((result) => result.tool === "search_documents")) {
      return { calls: [{ tool: "search_documents", input: { query } }] };
    }
    return { text: answer };
  });

/** `answer` written over the supplier's Document, of its own lines or of `lines`. */
async function answered(language: "en" | "zh", answer: string, lines?: readonly string[]) {
  const model = writingModel(SUPPLIER[language].question, answer);
  const { core, client, mind } = await setUpWithDocuments(model, [
    supplierDocument(language, lines),
  ]);
  const { answerId, finished } = await askAndFinish(
    core,
    client,
    mind.id,
    SUPPLIER[language].question,
  );
  return {
    quotes: citationsIn(client, answerId).map((each) => [each.quote, each.check]),
    finished,
    model,
  };
}

describe("a sentence's numbers are read without its markers (#3059)", { timeout: 60_000 }, () => {
  // protects=a sentence that is its Document's line, with a marker the model gave no record for, takes that line's Citation, found, and the model isn't asked again, in English and Chinese, whatever the marker's digits: one, two of them, or two markers; fails_when=the marker's digits are read as one of the sentence's numbers, so it doesn't match and the model is asked again; no_claim=how often a model leaves a marker without its record.
  test.each([
    ["en", "[^1]"],
    ["zh", "[^1]"],
    ["en", "[^12]"],
    ["zh", "[^12]"],
    ["en", "[^1][^2]"],
    ["zh", "[^1][^2]"],
  ] as const)(
    "in %s, a sentence with %s and no record takes its line's Citation",
    async (language, marker) => {
      const { year } = SUPPLIER[language].lines;
      const { quotes, finished } = await answered(language, marked(year, ` ${marker}`));
      expect(quotes).toEqual([[year, "found"]]);
      expect(finished.citedAfterChecking).toMatchObject({ asked: false });
    },
  );

  // protects=a sentence with a figure and a marker with no record matches its Document line, the figure read once, in English and Chinese, the marker glued to the figure's sentence; fails_when=the marker's digits are added to the sentence's figures; no_claim=none beyond protects.
  test.each(["en", "zh"] as const)(
    "in %s, a sentence with a figure and a marker with no record takes its line's Citation",
    async (language) => {
      const { figure } = SUPPLIER[language].lines;
      const { quotes, finished } = await answered(language, marked(figure, "[^3]"));
      expect(quotes).toEqual([[figure, "found"]]);
      expect(finished.citedAfterChecking).toMatchObject({ asked: false });
    },
  );

  // protects=a marker's digits never stand in for a number the sentence left out: "for the first years [^2]" doesn't match "for the first 2 years", nor "前几年 [^2]" "前 2 年", so no Citation quotes a number the sentence doesn't state, and the model is asked once; fails_when=the marker's 2 is read as the sentence's number and the line matches; no_claim=what a real model replies when asked.
  test.each(["en", "zh"] as const)(
    "in %s, a marker's digits don't fill a number the sentence left out",
    async (language) => {
      const { quotes, finished } = await answered(
        language,
        marked(yearsLeftOut[language], " [^2]"),
      );
      expect(quotes).toEqual([]);
      expect(finished.citedAfterChecking).toMatchObject({ asked: true });
    },
  );

  // protects=without a marker the two sentences read as before: the line itself matches, and the one with its number left out doesn't, in English and Chinese; fails_when=either changes; no_claim=none beyond protects.
  test.each(["en", "zh"] as const)(
    "in %s, a sentence with no marker reads as before",
    async (language) => {
      const { year } = SUPPLIER[language].lines;
      const same = await answered(language, year);
      expect(same.quotes).toEqual([[year, "found"]]);
      const leftOut = await answered(language, yearsLeftOut[language]);
      expect(leftOut.quotes).toEqual([]);
    },
  );

  // protects=a marker with a record keeps its record's Citation and nothing is matched for its sentence, in English and Chinese; fails_when=the citing step adds or changes a Citation for a recorded marker; no_claim=none beyond protects.
  test.each(["en", "zh"] as const)(
    "in %s, a marker with a record keeps its record",
    async (language) => {
      const { year, figure } = SUPPLIER[language].lines;
      const query = SUPPLIER[language].question;
      const model = scriptedModel((call) => {
        if (call.json) return { text: "{}" };
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) return { calls: [{ tool: "search_documents", input: { query } }] };
        if (!call.results.some((result) => result.tool === "cite")) {
          const [passage] = passageIds(searched.text);
          const citations = [{ marker: 1, passage, quote: figure }];
          return { calls: [{ tool: "cite", input: { citations } }] };
        }
        return { text: marked(year, " [^1]") };
      });
      const { core, client, mind } = await setUpWithDocuments(model, [supplierDocument(language)]);
      const { answerId, finished } = await askAndFinish(core, client, mind.id, query);
      expect(citationsIn(client, answerId).map((each) => each.quote)).toEqual([figure]);
      expect(finished.citedAfterChecking ?? { count: 0 }).toMatchObject({ count: 0 });
    },
  );

  // protects=a quotation with a marker written inside its quotation marks, among enough of the Answer's own words that only the quotation can match, is looked for and recorded as the Document's words: the marker goes with no space the words didn't have, before the full stop (spaced or glued), after it, or mid-line, in English and Chinese; fails_when=the marker's text, or a space it leaves, is looked for or recorded with the quoted words; no_claim=how often a model writes a marker inside quotation marks.
  test.each([
    ["en", "before the full stop", (line: string) => marked(line, " [^1]")],
    ["en", "glued before the full stop", (line: string) => marked(line, "[^1]")],
    ["en", "after the full stop", (line: string) => `${line} [^1]`],
    ["en", "mid-line", (line: string) => line.replace("survey is", "survey [^1] is")],
    ["zh", "before the full stop", (line: string) => marked(line, " [^1]")],
    ["zh", "glued before the full stop", (line: string) => marked(line, "[^1]")],
    ["zh", "after the full stop", (line: string) => `${line}[^1]`],
    ["zh", "mid-line", (line: string) => line.replace("费用由", "费用[^1]由")],
  ] as const)(
    "in %s, a quotation with its marker %s is recorded as the Document's line",
    async (language, _where, withMarker) => {
      const { year } = SUPPLIER[language].lines;
      const quoted = withMarker(year);
      expect(quoted).toContain("[^1]");
      const answer =
        language === "en"
          ? `Before anyone signed, Dana read the clause aloud to the whole room and underlined it twice: "${quoted}" Everyone nodded, and the meeting moved on to the schedule.`
          : `签约之前，达娜在会上把这一条大声读给所有人听，还在下面划了两道线：“${quoted}”大家都点了头，会议接着讨论了进度安排。`;
      const { quotes } = await answered(language, answer);
      expect(quotes).toEqual([[year, "found"]]);
    },
  );

  // protects=a sentence that is its Document's line with a figure's marker and no Citation marker takes that line's Citation, and one that leaves its number out matches nothing though its figure's marker holds that number, in English and Chinese (#3059); fails_when=a figure marker's digits are read as the sentence's number; no_claim=how often a model writes a figure's marker on a Document's line.
  test.each(["en", "zh"] as const)(
    "in %s, a figure's marker is no number of the sentence",
    async (language) => {
      const { year } = SUPPLIER[language].lines;
      const same = await answered(language, marked(year, " [=1]"));
      expect(same.quotes).toEqual([[year, "found"]]);
      const leftOut = await answered(language, marked(yearsLeftOut[language], " [=2]"));
      expect(leftOut.quotes).toEqual([]);
    },
  );

  // protects=the words a sentence is compared by hold none for a figure's marker, as none for a Citation's, in English and Chinese; fails_when=a figure marker's digits come back as a word; no_claim=none beyond protects.
  test("a figure's marker gives no word", () => {
    const { year } = SUPPLIER.en.lines;
    expect(wordsOf(marked(year, " [=12]"))).toEqual(wordsOf(year));
    expect(wordsOf(marked(yearsLeftOut.zh, "[=2]"))).toEqual(wordsOf(yearsLeftOut.zh));
  });

  // protects=whether an uncited Answer in another language may draw on the Passages reads its figures without its markers' digits, so a marker [^12] doesn't share "12" with a Passage; fails_when=a marker's digits count as the Answer's figure; no_claim=none beyond protects.
  test("an Answer's figures for the one request are read without its markers' digits", () => {
    const passages = [
      {
        id: "P1",
        text: "The Transformer achieves 28.4 BLEU on the WMT 2014 English-to-German translation task.",
      },
      { id: "P2", text: "Table 2 lists the 7 models we trained on 12 GPUs." },
    ];
    expect(mayDrawOn("我在你的文档中没有找到相关内容 [^12]。", passages)).toBe(false);
    expect(mayDrawOn("训练在 8 块 GPU 上进行了 12 小时。", passages)).toBe(true);
  });

  // protects=the ask for Citations goes out only when a marker with no record matches nothing: with every such marker matched there is no request beyond the search and the Answer; with one left unmatched the one request goes out; fails_when=an ask goes out though every marker matched, or none goes out though one didn't; no_claim=none beyond protects.
  test("the ask goes out only when a marker with no record matches nothing", async () => {
    const { year, figure } = SUPPLIER.en.lines;
    const all = await answered("en", `${marked(year, " [^1]")} ${marked(figure, " [^2]")}`);
    expect(all.finished.citedAfterChecking).toMatchObject({ asked: false });
    expect(all.model.doStreamCalls).toHaveLength(2);
    const one = await answered(
      "en",
      `${marked(year, " [^1]")} ${marked(yearsLeftOut.en, " [^2]")}`,
    );
    expect(one.finished.citedAfterChecking).toMatchObject({ asked: true });
  });
});

/*
 * #3059: a list's number at a sentence's start ("**1.** ", "1) ", "1、") is no number the sentence
 * states, so a sentence that is its Document's line after one still matches it. A number of the
 * sentence's own stays one, and so does an enumeration that starts it.
 */
const LISTED = {
  en: {
    survey: "The supplier pays for the site survey in the first year of the contract.",
    listed: "1) The client pays travel to each site for the whole contract term.",
    trucks: "3 trucks arrived at the north depot early on Monday morning.",
    year: "2024 was the first year the north depot ran at a profit.",
    million: "1.5 million euros of revenue came from the northern region last year.",
    clauses: "Rule 2 applies to every site in the northern region from this year.",
    done: "2 and 3 are done for every site in the northern region.",
    clause: "Clause 2) covers the survey costs for each site in the region.",
    numbered: "1. Revenue rose 12% in the northern region over the last year.",
    numberedClose: "1) Costs fell 8% in the southern region over the same year.",
    plain: "Wages rose 3% across every depot in the western region this spring.",
    units: "2 units were returned to the north depot on Monday morning.",
    parcels: "2) parcels were sent back to the south depot on Friday evening.",
  },
  zh: {
    survey: "供应商承担合同第一年现场调研的全部费用。",
    listed: "1）客户承担整个合同期内去各个现场的差旅费。",
    trucks: "3 辆卡车周二早上到了北边的仓库。",
    year: "2024 年是北边仓库第一次盈利的年份。",
    million: "1.5 万欧元的收入来自北部地区的新客户。",
    building: "2 号楼已于三月交付给客户。",
    floors: "二层均为临街商铺，目前已经全部租出。",
    clauses: "第二条适用于北部地区的所有现场。",
    rule: "规则 2 适用于北部地区自今年起的所有厂区和办事处。",
    numbered: "1. 去年北部地区的营收增长了 12%，主要来自新客户。",
    numberedClose: "1）同一年南部地区的成本下降了 8%，主要来自运费。",
    plain: "今年春天西部地区每个仓库的工资都上涨了 3%。",
    units: "2 台设备周一上午退回了北边的仓库。",
    parcels: "2、箱零件周五晚上寄回了南边的仓库。",
    ordinal: "第一，客户承担整个合同期内的保险费用和税费。",
  },
};

/** Each row: an Answer's sentence, and the Document's line it matches, or null for none. */
const LIST_ROWS: { language: "en" | "zh"; sentence: string; matches: string | null }[] = [
  ...["**1.** ", "1) ", "(1) ", "1.", "12) "].map((mark) => ({
    language: "en" as const,
    sentence: `${mark}${LISTED.en.survey}`,
    matches: LISTED.en.survey,
  })),
  {
    language: "en",
    sentence: "2) The client pays travel to each site for the whole contract term.",
    matches: null,
  },
  { language: "en", sentence: `1) ${LISTED.en.trucks}`, matches: LISTED.en.trucks },
  {
    language: "en",
    sentence: "1) 4 trucks arrived at the north depot early on Monday morning.",
    matches: null,
  },
  { language: "en", sentence: LISTED.en.trucks, matches: LISTED.en.trucks },
  {
    language: "en",
    sentence: "4 trucks arrived at the north depot early on Monday morning.",
    matches: null,
  },
  { language: "en", sentence: LISTED.en.year, matches: LISTED.en.year },
  {
    language: "en",
    sentence: "2023 was the first year the north depot ran at a profit.",
    matches: null,
  },
  { language: "en", sentence: LISTED.en.million, matches: LISTED.en.million },
  {
    language: "en",
    sentence: "2.5 million euros of revenue came from the northern region last year.",
    matches: null,
  },
  {
    language: "en",
    sentence: "1) and 2) apply to every site in the northern region from this year.",
    matches: null,
  },
  ...[
    "1) through 2)",
    "1) to 2)",
    "(1) to (2)",
    "1)-2)",
    "1)–2)",
    "1) as well as 2)",
    "1) plus 2)",
    "1) versus 2)",
    "1)/2)",
  ].map((marks) => ({
    language: "en" as const,
    sentence: `${marks} apply to every site in the northern region from this year.`,
    matches: null,
  })),
  {
    language: "en",
    sentence: "1, 2 and 3 are done for every site in the northern region.",
    matches: null,
  },
  {
    language: "en",
    sentence: "Clause 1) covers the survey costs for each site in the region.",
    matches: null,
  },
  {
    language: "en",
    sentence: "Revenue rose 12% in the northern region over the last year.",
    matches: LISTED.en.numbered.replace(/^1\. /, ""),
  },
  {
    language: "en",
    sentence: "Costs fell 8% in the southern region over the same year.",
    matches: LISTED.en.numberedClose,
  },
  { language: "en", sentence: `1. ${LISTED.en.plain}`, matches: LISTED.en.plain },
  { language: "en", sentence: `1) ${LISTED.en.plain}`, matches: LISTED.en.plain },
  {
    language: "en",
    sentence: "2) units were returned to the north depot on Monday morning.",
    matches: null,
  },
  {
    language: "en",
    sentence: "2 parcels were sent back to the south depot on Friday evening.",
    matches: null,
  },
  ...["1、", "1）", "（1）", "（一）", "一、", "**1.** "].map((mark) => ({
    language: "zh" as const,
    sentence: `${mark}${LISTED.zh.survey}`,
    matches: LISTED.zh.survey,
  })),
  { language: "zh", sentence: "2）客户承担整个合同期内去各个现场的差旅费。", matches: null },
  { language: "zh", sentence: `1）${LISTED.zh.trucks}`, matches: LISTED.zh.trucks },
  { language: "zh", sentence: "1）4 辆卡车周二早上到了北边的仓库。", matches: null },
  { language: "zh", sentence: LISTED.zh.trucks, matches: LISTED.zh.trucks },
  { language: "zh", sentence: LISTED.zh.year, matches: LISTED.zh.year },
  { language: "zh", sentence: "2023 年是北边仓库第一次盈利的年份。", matches: null },
  { language: "zh", sentence: LISTED.zh.million, matches: LISTED.zh.million },
  { language: "zh", sentence: "2.5 万欧元的收入来自北部地区的新客户。", matches: null },
  { language: "zh", sentence: "1、2 号楼已于三月交付给客户。", matches: null },
  { language: "zh", sentence: "一、二层均为临街商铺，目前已经全部租出。", matches: null },
  { language: "zh", sentence: "（一）和（二）适用于北部地区的所有现场。", matches: null },
  ...[
    "1）至 2）",
    "1）到 2）",
    "1）～2）",
    "（1）至（2）",
    "1）以及 2）",
    "1）或者 2）",
    "1）还有 2）",
    "1）直到 2）",
  ].map((marks) => ({
    language: "zh" as const,
    sentence: `${marks}适用于北部地区自今年起的所有厂区和办事处。`,
    matches: null,
  })),
  {
    language: "zh",
    sentence: "去年北部地区的营收增长了 12%，主要来自新客户。",
    matches: LISTED.zh.numbered.replace(/^1\. /, ""),
  },
  {
    language: "zh",
    sentence: "同一年南部地区的成本下降了 8%，主要来自运费。",
    matches: LISTED.zh.numberedClose,
  },
  { language: "zh", sentence: `1. ${LISTED.zh.plain}`, matches: LISTED.zh.plain },
  { language: "zh", sentence: `1）${LISTED.zh.plain}`, matches: LISTED.zh.plain },
  { language: "zh", sentence: "2、台设备周一上午退回了北边的仓库。", matches: null },
  { language: "zh", sentence: "2 箱零件周五晚上寄回了南边的仓库。", matches: null },
  ...["一是", "第一，", "其一，"].map((ordinal) => ({
    language: "zh" as const,
    sentence: `${ordinal}${LISTED.zh.survey}`,
    matches: null,
  })),
  { language: "zh", sentence: LISTED.zh.ordinal, matches: LISTED.zh.ordinal },
];

const CLAUSE = {
  en: (number: string, days = "") =>
    `(${number}) The tenant shall give ${days}notice within the first month of the lease.`,
  zh: (number: string, days = "") => `（${number}）租户须在租约第一个月内${days}发出书面通知。`,
};
const PHONE = {
  en: (code: string) =>
    `(${code}) 10 5550 1234 is the number of the Beijing office for late deliveries.`,
  zh: (code: string) => `（${code}）10 5550 1234 是北京办公室处理延迟交货的电话号码。`,
};
const ZH_NUMBER: Record<string, string> = { "2": "二", "3": "三" };
const NOTICE = {
  en: "The tenant must give 30 days' notice before leaving the flat.",
  zh: "承租人须提前三十天书面通知出租人。",
};
const INSURE = {
  en: {
    landlord: "The landlord shall insure the building against fire and flood.",
    tenant: "The tenant shall insure the contents of the flat against fire and theft.",
  },
  zh: { landlord: "房东须为房屋投保火灾和水灾险。", tenant: "租户须为屋内物品投保火灾和盗窃险。" },
};

/** Each row: what it is, the Document's lines, an Answer's sentence and the line it matches, or null. */
const NUMBERED_PAIRS: {
  what: string;
  language: "en" | "zh";
  document: string[];
  sentence: string;
  matches: string | null;
}[] = (["en", "zh"] as const).flatMap((language) => {
  const clause = (number: string, days?: string) =>
    CLAUSE[language](language === "zh" ? (ZH_NUMBER[number] ?? number) : number, days);
  const notice = (days: number) => (language === "en" ? `${days} days' ` : `提前 ${days} 天`);
  return [
    {
      what: "a clause against the Document's clause (2)",
      language,
      document: [clause("2")],
      sentence: clause("3"),
      matches: null,
    },
    {
      what: "a clause against the Document's clause (3)",
      language,
      document: [clause("3")],
      sentence: clause("2"),
      matches: null,
    },
    {
      what: "a phone's code against the Document's (85)",
      language,
      document: [PHONE[language]("85")],
      sentence: PHONE[language]("86"),
      matches: null,
    },
    {
      what: "a phone's code against the Document's (86)",
      language,
      document: [PHONE[language]("86")],
      sentence: PHONE[language]("85"),
      matches: null,
    },
    {
      what: "the same phone's code",
      language,
      document: [PHONE[language]("85")],
      sentence: PHONE[language]("85"),
      matches: PHONE[language]("85"),
    },
    {
      what: "the same clause, another number of days",
      language,
      document: [clause("2", notice(30))],
      sentence: clause("2", notice(60)),
      matches: null,
    },
    {
      what: "the same clause, the same words",
      language,
      document: [clause("2", notice(30))],
      sentence: clause("2", notice(30)),
      matches: clause("2", notice(30)),
    },
    {
      what: "the same words under clauses (2) and (3), restated with no number",
      language,
      document: [clause("2"), clause("3")],
      sentence: clause("2").replace(/^(?:\(\d+\) |（.）)/u, ""),
      matches: clause("2"),
    },
    // Known, as the app has always read it: a plain "2. " is cut off as a place in a list before
    // the comparison, so a differing number in that form isn't caught. A count decides (#3059).
    {
      what: "known: a plain list number is a place in a list, so a Document's plain 2. matches (3)",
      language,
      document: [`1. ${INSURE[language].landlord}`, `2. ${INSURE[language].tenant}`],
      sentence: `${language === "en" ? "(3) " : "（三）"}${INSURE[language].tenant}`,
      matches: INSURE[language].tenant,
    },
    {
      what: "known: a plain list number is a place in a list, so the Answer's plain 3. matches (2)",
      language,
      document: [clause("2")],
      sentence: `3. ${clause("2").replace(/^(?:\(\d+\) |（.）)/u, "")}`,
      matches: clause("2"),
    },
    {
      what: "known: a plain list number is a place in a list, so plain 3. matches plain 2.",
      language,
      document: [`2. ${INSURE[language].tenant}`],
      sentence: `3. ${INSURE[language].tenant}`,
      matches: INSURE[language].tenant,
    },
    // Known: a Document's reader cuts a bold "**2.**" and an unspaced "2." off as a place in a
    // list too, so the number never reaches the comparison; the bold's marks stay in the quote.
    {
      what: "known: a Document's bold **2.** is a place in a list, so **3.** matches it",
      language,
      document: [`**2.** ${NOTICE[language]}`],
      sentence: `**3.** ${NOTICE[language]}`,
      matches: `** ${NOTICE[language]}`,
    },
    {
      what: "known: a Document's unspaced 2. is a place in a list, so an unspaced 3. matches it",
      language,
      document: [`2.${NOTICE[language]}`],
      sentence: `3.${NOTICE[language]}`,
      matches: NOTICE[language],
    },
    // Known: a code in a list's form on one side only comes off that side, as a list's number.
    {
      what: "known: a code on the Answer's side only is read as a list's number, so it matches",
      language,
      document: [PHONE[language]("86").replace(/^(?:\(86\) |（86）)/u, "")],
      sentence: PHONE[language]("86"),
      matches: PHONE[language]("86").replace(/^(?:\(86\) |（86）)/u, ""),
    },
    {
      what: "known: a code on the Document's side only is read as a list's number, so it matches",
      language,
      document: [PHONE[language]("86")],
      sentence: PHONE[language]("86").replace(/^(?:\(86\) |（86）)/u, ""),
      matches: PHONE[language]("86"),
    },
  ];
});

describe("a list's number at a sentence's start is no number it states (#3059)", () => {
  const passagesOf = (language: "en" | "zh") => [
    { id: "P1", text: Object.values(LISTED[language]).join("\n") },
  ];
  const matched = (language: "en" | "zh", sentence: string) => {
    const passages = passagesOf(language);
    const found = (_passage: string, quote: string) => passages[0]?.text.includes(quote) ?? false;
    return matchUnmarked(sentence, passages, found).map(({ passage, quote }) => ({
      passage,
      quote,
    }));
  };
  /** What `sentence` matches in a Document of `lines` alone. */
  const matchedIn = (lines: readonly string[], sentence: string) => {
    const text = lines.join("\n");
    const found = (_passage: string, quote: string) => text.includes(quote);
    return matchUnmarked(sentence, [{ id: "P1", text }], found).map(({ quote }) => quote);
  };
  /** The sentence with a marker the model gave no record for, before its full stop. */
  const withMarker = (sentence: string) => sentence.replace(/([.。])$/, " [^1]$1");

  // protects=two sentences that each start with a list's number match only under the same number, whichever is in the Document: a clause's ("(3)" against "(2)", "（三）" against "（二）") or a phone's code ("(86)" against "(85)"); under the same number the rest must still say the same ("30 days" is not "60 days"); a Document holding the same words under "(2)" and "(3)" gives an Answer's sentence with no number the first, in English and Chinese; fails_when=two clauses or codes are matched across their numbers, or the same number lets differing words match; no_claim=how often a Document numbers its clauses.
  test.each(NUMBERED_PAIRS)(
    "in $language, $what: “$sentence”",
    ({ document, sentence, matches }) => {
      expect(matchedIn(document, sentence)).toEqual(matches === null ? [] : [matches]);
    },
  );

  // protects=a list's number before a sentence ("**1.** ", "1) ", "(1) ", "1.", "12) ", "1、", "1）", "（1）", "（一）", "一、") comes off its numbers, so it matches its line; two sentences that each start with a list's number match only under the same one ("2)" is not "1)"), and one numbered on one side only matches nothing when that number is the other's own ("2) units" against "2 units"); a number of its own stays one, at the start ("3 trucks", "2024", "1.5 million") or after the list's number ("1) 3 trucks"), and an enumeration or a range that starts it, however its marks are joined ("1) and 2)", "1) through 2)", "(1) to (2)", "1)–2)", "1)/2)", "1) as well as 2)", "1, 2 and 3", "1、2 号楼", "一、二层", "（一）和（二）", "1）至 2）", "1）～2）", "1）以及 2）"), and a "1)" mid-sentence keep their numbers, so none matches a line stating fewer ("Rule 2", "规则 2"), in English and Chinese; fails_when=a list's number is read as the sentence's, or a number of its own, an enumeration's or a range's is taken off; no_claim=how often a model starts a sentence with a list's number.
  test.each(LIST_ROWS)("in $language, “$sentence”", ({ language, sentence, matches }) => {
    expect(matched(language, sentence)).toEqual(
      matches === null ? [] : [{ passage: "P1", quote: matches }],
    );
  });

  // protects=over the whole table, a sentence with a marker the model gave no record for matches exactly what the same sentence matches with the marker taken out, in English and Chinese; fails_when=a marker's digits change what a sentence matches; no_claim=none beyond protects.
  test("a marker with no record changes nothing a sentence matches", () => {
    for (const { language, sentence } of LIST_ROWS) {
      expect(withMarker(sentence)).toContain("[^1]");
      expect(matched(language, withMarker(sentence))).toEqual(matched(language, sentence));
    }
    for (const { document, sentence } of NUMBERED_PAIRS) {
      expect(withMarker(sentence)).toContain("[^1]");
      expect(matchedIn(document, withMarker(sentence))).toEqual(matchedIn(document, sentence));
    }
  });
});

describe("a list's number before a Document's line, through the core (#3059)", {
  timeout: 60_000,
}, () => {
  // protects=a sentence that is its Document's line after a list's number ("**1.** ", "1) ", "1、", "（一）"), with a marker it gave no record for, takes that line's Citation, found, and the model isn't asked again, in English and Chinese; fails_when=the list's number is read as the sentence's and the model is asked; no_claim=how often a model writes one.
  test.each([
    ["en", "**1.** "],
    ["en", "1) "],
    ["zh", "1、"],
    ["zh", "（一）"],
  ] as const)("in %s, after “%s”", async (language, mark) => {
    const { year } = SUPPLIER[language].lines;
    const { quotes, finished } = await answered(
      language,
      `${mark}${marked(year, language === "en" ? " [^1]" : "[^1]")}`,
    );
    expect(quotes).toEqual([[year, "found"]]);
    expect(finished.citedAfterChecking).toMatchObject({ asked: false });
  });

  // protects=a clause the Answer writes under the Document's own number, with a marker it gave no record for, takes that clause's Citation, found, without asking the model; the same clause under another number ("(3)" against "(2)", "（三）" against "（二）") takes no Citation and the model is asked, in English and Chinese; fails_when=a clause is cited to the Document's clause under another number, or the model isn't asked for it; no_claim=what a real model replies when asked.
  test.each(["en", "zh"] as const)(
    "in %s, a clause under another number is no Citation, and the model is asked",
    async (language) => {
      const clause = (number: string) =>
        CLAUSE[language](language === "zh" ? (ZH_NUMBER[number] ?? number) : number);
      const lines = [...Object.values(SUPPLIER[language].lines), clause("2")];
      const marker = language === "en" ? " [^1]" : "[^1]";
      const same = await answered(language, marked(clause("2"), marker), lines);
      expect(same.quotes).toEqual([[clause("2"), "found"]]);
      expect(same.finished.citedAfterChecking).toMatchObject({ asked: false });
      const other = await answered(language, marked(clause("3"), marker), lines);
      expect(other.quotes).toEqual([]);
      expect(other.finished.citedAfterChecking).toMatchObject({ asked: true });
    },
  );
});

describe("an Answer that says it found nothing, over Documents in another language (#3059)", {
  timeout: 60_000,
}, () => {
  const LATE = {
    en: {
      name: "Late fees.md",
      line: "Late reports are charged 45 dollars a day, and the fee is paid with the next invoice.",
      query: "late reports",
    },
    zh: {
      name: "迟交费用.md",
      line: "迟交的报告每天收 45 美元，这笔费用和下一张发票一起支付。",
      query: "迟交的报告",
    },
  };
  /** Requests for Citations after `answer`, over the Document in `documents`' language. */
  async function asks(documents: "en" | "zh", answer: string) {
    let requests = 0;
    const { name, line, query } = LATE[documents];
    const model = scriptedModel((call) => {
      if (call.json) {
        requests++;
        return { text: "{}" };
      }
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query } }] };
      }
      return { text: answer };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name, contents: `# ${name.replace(/\.md$/, "")}\n\n${line}\n` },
    ]);
    await askAndFinish(core, client, mind.id, "How much is a late report?");
    return requests;
  }

  // protects=across languages, an Answer that says it found nothing is asked for no Citations whether or not it carries a figure's marker, whose digits are no figure it shares with the Documents, and one stating the Documents' figure gets the one request, in Chinese over English Documents and English over Chinese; fails_when=a figure marker's "45" counts as a figure shared with the Documents, or the request stops going out for a sentence that states it; no_claim=what a real model writes when it finds nothing.
  test.each([
    { documents: "en", answer: "我在你的文档中没有找到相关内容 [=45]。", requests: 0 },
    { documents: "en", answer: "我在你的文档中没有找到相关内容。", requests: 0 },
    { documents: "en", answer: LATE.zh.line, requests: 1 },
    { documents: "zh", answer: "I found nothing about it in your Documents [=45].", requests: 0 },
    { documents: "zh", answer: "I found nothing about it in your Documents.", requests: 0 },
    { documents: "zh", answer: LATE.en.line, requests: 1 },
  ] as const)("over $documents Documents, “$answer”", async ({ documents, answer, requests }) => {
    expect(await asks(documents, answer)).toBe(requests);
  });
});
