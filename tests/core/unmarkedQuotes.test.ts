import { describe, expect, test } from "vitest";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { wordsOf } from "../../src/core/answers/markerPlacement";
import { mayDrawOn, parseAsked, settleOrphans } from "../../src/core/answers/unmarkedQuotes";
import { askAndFinish, citationsIn, setUpWithDocuments } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/*
 * #760, #3410: a sentence an Answer's model didn't cite has no Citation, however closely it
 * repeats a Passage; the model is asked once for the Citations it left out, and only a quote the
 * check finds is taken from its reply.
 */

const FIRST =
  "Tea drinking began in southwest China, where it was first used as a medicinal drink.";
const SECOND = "Traders carried tea along the Tea Horse Road to Tibet.";
/** Shares enough of SECOND's words to draw on it. */
const LOOSE =
  "Long ago, merchants and traders carried bricks of tea along the old Horse Road through mountains and rivers, trading them for horses and silver.";
const TEA = {
  name: "Tea history.md",
  contents: `# Tea history\n\n${FIRST}\n\n${SECOND}\n`,
};
const FIRST_ZH = "饮茶最早始于中国西南地区，当时茶被当作药用饮品。";
const TEA_ZH = { name: "茶史.md", contents: `# 茶史\n\n${FIRST_ZH}\n` };

/** A model that searches once, then answers `answer` with no Citations; `asked` replies to the one request for them. */
function quotingModel(
  answer: string,
  asked: (call: ModelCall) => ScriptedReply = () => ({ text: "{}" }),
  query = "where tea was first drunk",
) {
  return scriptedModel((call) => {
    if (call.json) return asked(call);
    if (!call.results.some((result) => result.tool === "search_documents")) {
      return { calls: [{ tool: "search_documents", input: { query } }] };
    }
    return { text: answer };
  });
}

/** The ids of the Passages a search result lists ("P1", …). */
const passageIds = (text: string) => [...text.matchAll(/<passage id=\\?"(P\d+)/g)].map((m) => m[1]);

describe("An Answer's Citations its model left out (#760, #3410)", { timeout: 30_000 }, () => {
  // protects=a sentence that quotes a Passage word for word, or repeats one nearly, gets no Citation the model didn't give, in English and Chinese: the model is asked once, and a reply with nothing leaves it uncited; fails_when=code gives it the Passage's Citation by its words, or no request goes out; no_claim=how the Answer's own judgement reads it in the assistant (tests/core/answerUncited.test.ts).
  test.each([
    ["a quotation", `As one article puts it, "${FIRST}" So it began in China.`, TEA, undefined],
    [
      "a near copy",
      "Tea drinking began in southwest China, where people first used it as a medicinal drink.",
      TEA,
      undefined,
    ],
    ["a Chinese quotation", `文中写道：“${FIRST_ZH}”所以茶起源于中国。`, TEA_ZH, "饮茶 西南"],
  ] as const)(
    "%s the model didn't cite has no Citation",
    async (_kind, answer, document, query) => {
      let requests = 0;
      const model = quotingModel(
        answer,
        () => {
          requests++;
          return { text: JSON.stringify({ citations: [] }) };
        },
        query,
      );
      const { core, client, mind } = await setUpWithDocuments(model, [document]);

      const { answerId, finished } = await askAndFinish(
        core,
        client,
        mind.id,
        "Where was tea first drunk?",
      );

      expect(citationsIn(client, answerId)).toEqual([]);
      expect(requests).toBe(1);
      expect(finished.citedAfterChecking).toEqual({ count: 0, asked: true });
    },
  );

  // protects=a marker the model wrote with no record gets the Citation the one request gives for its sentence, taking that marker; fails_when=code cites it by its words before asking, or the marker is lost; no_claim=none beyond protects.
  test("a marker written with no record takes the Citation the model gives when asked", async () => {
    const answer = `It is described as "${SECOND}" [^1] That is all.`;
    const model = quotingModel(answer, (call) => {
      const [id] = passageIds(
        call.options.prompt.map((message) => JSON.stringify(message)).join(""),
      );
      return {
        text: JSON.stringify({
          citations: [
            { sentence: `It is described as "${SECOND}" [^1]`, passage: id, quote: SECOND },
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

    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({ check: "found", quote: SECOND }),
    ]);
    expect(finished.citedAfterChecking).toEqual({ count: 1, asked: true });
  });

  // protects=an uncited Answer that draws on its Passages has the model asked once for its Citations, with the Passages it read, and only a quote the check finds is taken; fails_when=no request is made, more than one is, or an unfound quote is cited; no_claim=what a real model replies.
  test("an uncited Answer that draws on its Passages: the model is asked once, with the Passages it read", async () => {
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

describe("What the one request for Citations reads", () => {
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

  // protects=the words a sentence is compared by hold none for a figure's marker, as none for a Citation's, in English and Chinese; fails_when=a figure marker's digits come back as a word; no_claim=none beyond protects.
  test("a figure's marker gives no word", () => {
    const year = "The full cost of the survey is covered by the supplier in the first year.";
    const years = "合同前几年去各个现场的差旅费由客户支付。";
    expect(wordsOf(year.replace(/\.$/, " [=12]."))).toEqual(wordsOf(year));
    expect(wordsOf(years.replace(/。$/, "[=2]。"))).toEqual(wordsOf(years));
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
