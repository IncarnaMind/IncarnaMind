import { describe, expect, test } from "vitest";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
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

  // protects=the reply to the one request is read leniently and only well-formed items are kept; fails_when=a malformed item throws or is kept; no_claim=none beyond protects.
  // protects=#1415: across languages a reply is worth asking about when it shares a number in Latin digits or a Latin term of 4+ letters with the Passages, as summaries of English Documents in Chinese do, and not otherwise; fails_when=a Chinese summary naming a figure or a term isn't asked, or a greeting, a "didn't find" or a question back is; no_claim=the replay of real Answers in the pull request.
  test("across languages, a number or a Latin term shared with the Passages", () => {
    const passages = [
      {
        id: "P1",
        text: "The Transformer achieves 28.4 BLEU on the WMT 2014 English-to-German translation task.",
      },
    ];
    expect(mayDrawOn("该论文提出了 Transformer 架构。", passages)).toBe(true);
    expect(mayDrawOn("在英德翻译任务上达到了 28.4 的成绩。", passages)).toBe(true);
    for (const reply of [
      "你好！有什么可以帮你？",
      "我在你的文档中没有找到关于停车位的内容。",
      "你是想问哪一处房产的停车位？",
      "以下内容不是来自你的文档：注意力机制让模型关注输入中最相关的部分。",
    ]) {
      expect(mayDrawOn(reply, passages)).toBe(false);
    }
    expect(mayDrawOn("I didn't find anything about parking in your documents.", passages)).toBe(
      false,
    );
  });

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
