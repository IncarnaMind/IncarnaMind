import { describe, expect, test, vi } from "vitest";
import { CITATION_NODE, type Core, type MarkedCitation } from "../../src/core";
import { SENTENCE_BATCH_INSTRUCTIONS } from "../../src/core/answers/checks/sentenceBatch";
import { pageBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { citedSentences } from "../../src/shared/citedSentences";
import { checkGenerate, checkingModel, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { answerJudged, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { nextTurn, startCore } from "../helpers/core";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";
import { docxOf } from "../helpers/office";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

/**
 * An Answer in the assistant shows a found Citation's green check only on a sentence its quote
 * supports (#2311): each sentence with a Citation is checked as Check this Note checks it once
 * the Answer ends, and its Citations wait as checking until then. The two cases are the walk's: a Chinese sentence that read "installed" as
 * already installed, and "dated 2026" under a quote of the Document's title.
 */

const slide = (...lines: string[]) => ({
  shapes: sp({
    id: 2,
    name: "Body",
    txBox: true,
    body: txBody(lines.map((line) => para(line)).join("")),
  }),
});

const KILN_DECK = {
  name: "Kiln upgrade plan.pptx",
  contents: pptxOf({
    slides: [
      slide("Kiln upgrade plan", "Northwind Ceramics Ltd", "Board pack, October 2026"),
      slide("Why upgrade now", "Our two kilns are 14 years old."),
      slide(
        "The plan",
        "Supplier: Hartwell Kilns",
        "Cost: £185,000 for two K9 kilns, installed",
        "Installation in February 2027",
      ),
    ],
  }),
};

/** The year the Library takes as the contract's own (the latest in its first page), though it dates deliveries. */
const DELIVERY = "交货安排：自 2026 年 11 月起，每季度交货一次，每次 12 吨高岭土。";

const CONTRACT = {
  name: "供应商合同.docx",
  contents: docxOf([
    { text: "供应商合同摘要", heading: 1 },
    { text: "供应商：景德镇青山陶土有限公司。" },
    { text: "合同总金额为人民币 860,000 元，分四期支付。" },
    { text: DELIVERY },
    { text: "合同有效期至 2027 年 12 月 31 日。" },
  ]),
};

const COST = "Cost: £185,000 for two K9 kilns, installed";
const INSTALLATION = "Installation in February 2027";
const TITLE = "供应商合同摘要";
const TERM = "合同有效期至 2027 年 12 月 31 日";

/**
 * A batch of an Answer's sentences judged as `plans` say (#2311): each its plan's verdict and what
 * it says, unsupported with no plan; those in `opinions` sorted all opinion.
 */
function batchReply(
  call: GenerateCall,
  plans: Record<string, Plan>,
  opinions: readonly string[] = [],
): GeneratedReply {
  const sentences = [
    ...call.prompt.matchAll(/<sentence number="(\d+)">\n([\s\S]*?)\n<\/sentence>/g),
  ];
  return {
    text: JSON.stringify({
      sentences: sentences.map(([, number, sentence = ""]) => ({
        number: Number(number),
        kind: opinions.includes(sentence) ? "opinion" : "fact",
        verdict: plans[sentence]?.verdict ?? "unsupported",
        roles: "same",
        time: "same",
        says: plans[sentence]?.says ?? null,
      })),
    }),
  };
}

const isBatch = (call: GenerateCall) => call.system === SENTENCE_BATCH_INSTRUCTIONS;

/**
 * A model that searches for `query`, answers with `answer`, citing `quotes` as markers 1, 2…, and
 * judges its sentences as `plans` say, or as `judge` replies to each batch; every streamed request
 * it is sent is kept in `calls`.
 */
function answeringModel(
  query: string,
  answer: string,
  quotes: readonly string[],
  plans: Record<string, Plan>,
  {
    calls = [],
    opinions = [],
    judge,
  }: {
    calls?: ModelCall[];
    opinions?: readonly string[];
    judge?: (call: GenerateCall) => GeneratedReply;
  } = {},
) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call)) return checkReply(call, plans);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = shownPassages(searches.at(-1)?.text ?? "");
        const citations = quotes.map((quote, index) => ({
          marker: index + 1,
          passage: passages.find((each) => each.text.includes(quote))?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: answer };
    },
    {
      generate: (call) =>
        isBatch(call)
          ? (judge?.(call) ?? batchReply(call, plans, opinions))
          : checkGenerate(plans)(call),
    },
  );
}

/**
 * Asks in the assistant: the Answer as it ends, its sentences not judged yet, and as it is once
 * they are.
 */
async function askedAnswer(core: Core, question: string) {
  const asked = await core.askInConversation({ text: question });
  if (!asked.asked) throw new Error("Not asked.");
  // The Answer as its end is announced, before the judgement of its sentences.
  const ended = await new Promise<string>((resolve) => {
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === asked.answerId && end("finished")),
      core.on("answer.failed", ({ answerId }) => answerId === asked.answerId && end("failed")),
    ];
    function end(event: string) {
      for (const stop of stops) stop();
      resolve(event);
    }
  });
  const { messages } = await core.getConversation(asked.conversation.id);
  const atEnd = messages.find((each) => each.id === asked.answerId);
  if (atEnd?.kind !== "answer") throw new Error("No Answer.");
  return {
    ended,
    atEnd,
    judged: () => answerJudged(core, asked.conversation.id, asked.answerId),
  };
}

async function citationsOfAnswer(core: Core, question: string): Promise<MarkedCitation[]> {
  return (await (await askedAnswer(core, question)).judged()).citations;
}

const checkOf = (citations: readonly MarkedCitation[], marker: number) =>
  citations.find((each) => each.marker === marker);

describe("a sentence its quote doesn't support loses its green check", () => {
  test.each([
    {
      language: "Chinese",
      question: "窑炉升级要花多少钱？什么时候安装？",
      wrong: "窑炉升级计划的费用是 £185,000，包括两台 K9 窑炉并已安装好。",
      right: "安装计划在 2027 年 2 月。",
      says: "幻灯片说两台 K9 窑炉将于 2027 年 2 月安装，尚未安装。",
    },
    {
      language: "English",
      question: "How much does the kiln upgrade cost, and when is it installed?",
      wrong: "The upgrade costs £185,000 for two K9 kilns, which are already installed.",
      right: "Installation is planned for February 2027.",
      says: "The slide says the two K9 kilns are to be installed in February 2027.",
    },
  ])("a mistranslated fact, in $language, is marked contradicted", async (each) => {
    const answer = `${each.wrong.slice(0, -1)}[^1]${each.wrong.slice(-1)} ${each.right.slice(0, -1)}[^2]${each.right.slice(-1)}`;
    const plans: Record<string, Plan> = {
      [each.wrong]: { verdict: "contradicted", quote: INSTALLATION, says: each.says },
      [each.right]: { verdict: "supported", quote: INSTALLATION, says: each.right },
    };
    const { core } = await setUpWithDocuments(
      answeringModel("kilns installed cost", answer, [COST, INSTALLATION], plans),
      [KILN_DECK],
    );

    const citations = await citationsOfAnswer(core, each.question);

    expect(checkOf(citations, 1)).toMatchObject({
      quote: COST,
      check: "contradicted",
      verdict: each.says,
    });
    expect(checkOf(citations, 2)).toMatchObject({ quote: INSTALLATION, check: "found" });
    expect(checkOf(citations, 2)?.verdict).toBeUndefined();
  });

  test.each([
    {
      language: "English",
      question: "What does '供应商合同' say?",
      wrong: "The document is a supplier contract summary, “供应商合同摘要”, dated 2026.",
      right: "The contract runs until 31 December 2027.",
      reason: "The Document doesn't say when it is dated.",
    },
    {
      language: "Chinese",
      question: "《供应商合同》写了什么？",
      wrong: "这份文件是供应商合同摘要，日期为 2026 年。",
      right: "合同有效期至 2027 年 12 月 31 日。",
      reason: "文档没有写明它的日期。",
    },
  ])("a date taken from a title, in $language, is marked unsupported", async (each) => {
    const answer = `${each.wrong.slice(0, -1)}[^1]${each.wrong.slice(-1)} ${each.right.slice(0, -1)}[^2]${each.right.slice(-1)}`;
    const plans: Record<string, Plan> = {
      [each.wrong]: { verdict: "unsupported", says: each.reason },
      [each.right]: { verdict: "supported", quote: TERM, says: each.right },
    };
    const { core } = await setUpWithDocuments(
      answeringModel("供应商合同", answer, [TITLE, TERM], plans),
      [CONTRACT],
    );

    const citations = await citationsOfAnswer(core, each.question);

    expect(checkOf(citations, 1)).toMatchObject({
      quote: TITLE,
      check: "unsupported",
      verdict: each.reason,
    });
    expect(checkOf(citations, 2)).toMatchObject({ quote: TERM, check: "found" });
  });
});

describe("an Answer works at once, and its Citations wait for their sentences' judgement", () => {
  const ANSWER = "Installation is planned for February 2027[^1].";
  const ANSWER_ZH = "窑炉计划在 2027 年 2 月安装[^1]。";

  test.each([
    { language: "English", question: "When is the kiln installed?", answer: ANSWER },
    { language: "Chinese", question: "窑炉什么时候安装？", answer: ANSWER_ZH },
  ])(
    "in $language, it ends with its Citation checking, never found, then takes its sentence's result",
    async (each) => {
      const sentence = each.answer.replace("[^1]", "");
      const { core } = await setUpWithDocuments(
        answeringModel("kilns installed cost", each.answer, [INSTALLATION], {
          [sentence]: { verdict: "supported", quote: INSTALLATION, says: sentence },
        }),
        [KILN_DECK],
      );

      const asked = await askedAnswer(core, each.question);

      expect(asked.ended).toBe("finished");
      expect(asked.atEnd).toMatchObject({ status: "done", text: each.answer });
      expect(asked.atEnd.citations).toMatchObject([{ marker: 1, check: "checking" }]);
      expect((await asked.judged()).citations).toMatchObject([{ marker: 1, check: "found" }]);
    },
  );

  test.each([
    { language: "English", question: "When is the kiln installed?", answer: ANSWER },
    { language: "Chinese", question: "窑炉什么时候安装？", answer: ANSWER_ZH },
  ])(
    "in $language, a judgement that fails leaves it not checked, never found, and Check again judges it",
    async (each) => {
      const sentence = each.answer.replace("[^1]", "");
      let fails = true;
      const { core } = await setUpWithDocuments(
        answeringModel(
          "kilns installed cost",
          each.answer,
          [INSTALLATION],
          { [sentence]: { verdict: "supported", says: sentence } },
          {
            judge: (call) =>
              fails
                ? { error: { status: 500, message: "The provider failed." } }
                : batchReply(call, { [sentence]: { verdict: "supported", says: sentence } }),
          },
        ),
        [KILN_DECK],
      );

      const asked = await askedAnswer(core, each.question);
      const judged = await asked.judged();

      expect(judged.citations).toMatchObject([{ marker: 1, check: "not-checked" }]);
      expect(judged.citations.some((citation) => citation.check === "found")).toBe(false);

      fails = false;
      await core.checkAnswerAgain({ conversationId: judged.conversationId, answerId: judged.id });
      const again = await answerJudged(core, judged.conversationId, judged.id);
      expect(again.citations).toMatchObject([{ marker: 1, check: "found" }]);
    },
  );

  test.each([
    { language: "English", question: "When is the kiln installed?", answer: ANSWER },
    { language: "Chinese", question: "窑炉什么时候安装？", answer: ANSWER_ZH },
  ])(
    "in $language, a sentence its check sorts as all opinion is not checked, never found, though its quote is there",
    async (each) => {
      const sentence = each.answer.replace("[^1]", "");
      const { core } = await setUpWithDocuments(
        answeringModel(
          "kilns installed cost",
          each.answer,
          [INSTALLATION],
          { [sentence]: { verdict: "contradicted", quote: INSTALLATION, says: sentence } },
          { opinions: [sentence] },
        ),
        [KILN_DECK],
      );

      const judged = await (await askedAnswer(core, each.question)).judged();

      expect(judged.citations).toMatchObject([{ marker: 1, check: "not-checked" }]);
      expect(judged.citations.some((citation) => citation.check === "found")).toBe(false);
    },
  );

  test("closed while its sentence is judged, it writes nothing more, and the next start finds its Citation not checked", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, dataDir, models } = await setUpWithDocuments(
      answeringModel(
        "kilns installed cost",
        ANSWER,
        [INSTALLATION],
        {},
        { judge: (call) => ({ ...batchReply(call, {}), until: held }) },
      ),
      [KILN_DECK],
    );
    const asked = await askedAnswer(core, "When is the kiln installed?");

    core.close();
    release();
    await nextTurn();
    const later = startCore(dataDir, { createChatModel: models.createChatModel });
    const { messages } = await later.getConversation(asked.atEnd.conversationId);
    const reopened = messages.find((message) => message.id === asked.atEnd.id);

    expect(asked.atEnd.citations).toMatchObject([{ marker: 1, check: "checking" }]);
    expect(reopened).toMatchObject({
      status: "done",
      citations: [{ marker: 1, check: "not-checked" }],
    });
  });

  test("added to a Note while its sentence is judged, or once it couldn't be, its Citation goes in as its quote check left it: found", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const question = "When is the kiln installed?";
    const { core } = await setUpWithDocuments(
      answeringModel(
        "kilns installed cost",
        ANSWER,
        [INSTALLATION],
        {},
        { judge: (call) => ({ ...batchReply(call, {}), until: held }) },
      ),
      [KILN_DECK],
    );
    const checksIn = (blocks: readonly NodeJSON[]): unknown[] =>
      blocks.flatMap((block) => [
        ...(block.type === CITATION_NODE ? [block.attrs?.check] : []),
        ...checksIn(block.content ?? []),
      ]);

    const asked = await askedAnswer(core, question);
    const waiting = pageBlocks(asked.atEnd, question);
    await core.stopConversationAnswer({
      conversationId: asked.atEnd.conversationId,
      answerId: asked.atEnd.id,
    });
    const notChecked = await asked.judged();
    release();

    expect(asked.atEnd.citations).toMatchObject([{ marker: 1, check: "checking" }]);
    expect(checksIn(waiting)).toEqual(["found"]);
    expect(notChecked.citations).toMatchObject([{ marker: 1, check: "not-checked" }]);
    expect(checksIn(pageBlocks(notChecked, question))).toEqual(["found"]);
    // A stopped Answer's Citation still checking never had its quote checked.
    expect(checksIn(pageBlocks({ ...asked.atEnd, status: "stopped" }, question))).toEqual([
      "checking",
    ]);
  });

  test.each([
    { language: "English", sentence: (n: number) => `Kiln ${n} is installed in February 2027.` },
    { language: "Chinese", sentence: (n: number) => `第 ${n} 台窑炉在 2027 年 2 月安装。` },
  ])(
    "in $language, stopping it while a batch is judged leaves that batch's Citations not checked and keeps the batch judged",
    async (each) => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Nine sentences: the first batch holds eight, the second the ninth.
      const sentences = Array.from({ length: 9 }, (_, index) => each.sentence(index + 1));
      const answer = sentences
        .map((sentence, index) => `${sentence.slice(0, -1)}[^${index + 1}]${sentence.slice(-1)}`)
        .join(" ");
      const plans = Object.fromEntries(
        sentences.map((sentence): [string, Plan] => [sentence, { verdict: "supported" }]),
      );
      const schedule = {
        name: "Kiln schedule.md",
        contents: `# Kiln schedule\n\n${sentences.join("\n\n")}\n`,
      };
      const { core } = await setUpWithDocuments(
        answeringModel(
          "kiln installed February 2027",
          answer,
          sentences.map((sentence) => sentence.slice(0, -1)),
          plans,
          {
            judge: (call) =>
              // The ninth sentence's own batch: every batch shows the Passage that has its line.
              call.prompt.includes(`">\n${sentences[8]}\n</sentence>`)
                ? { ...batchReply(call, plans), until: held }
                : batchReply(call, plans),
          },
        ),
        [schedule],
      );

      const asked = await askedAnswer(core, "When are the kilns installed?");
      const { conversationId, id: answerId } = asked.atEnd;
      await vi.waitFor(
        async () => {
          const { messages } = await core.getConversation(conversationId);
          const answer = messages.find((message) => message.id === answerId);
          if (answer?.kind !== "answer" || checkOf(answer.citations, 8)?.check !== "found") {
            throw new Error("Its first batch isn't judged yet.");
          }
        },
        { timeout: 20_000, interval: 20 },
      );
      await core.stopConversationAnswer({ conversationId, answerId });
      const judged = await asked.judged();
      release();

      expect(asked.atEnd.citations.every((citation) => citation.check === "checking")).toBe(true);
      expect(judged.status).toBe("done");
      expect(judged.citations.slice(0, 8).map((citation) => citation.check)).toEqual(
        Array(8).fill("found"),
      );
      expect(checkOf(judged.citations, 9)).toMatchObject({
        check: "not-checked",
        checkReason: null,
      });
    },
  );
});

describe("a check reads what the Document's words say, and no date beside them", () => {
  /** What each request showed the model: its prompt and what its searches found. */
  const shown = (call: ModelCall) =>
    [call.prompt, ...call.results.map((each) => each.text)].join("\n");
  const DATE_ATTRIBUTE = /(?:date|file-created|file-modified)="/;

  test("a contract's delivery year isn't its date to a check, though an Answer is told it", async () => {
    const calls: ModelCall[] = [];
    const sentence = "The document is a supplier contract summary, “供应商合同摘要”, dated 2026.";
    const { core, documents } = await setUpWithDocuments(
      answeringModel(
        "供应商合同",
        "The contract runs until 31 December 2027[^1].",
        [TERM],
        { [sentence]: { verdict: "unsupported" } },
        { calls },
      ),
      [CONTRACT],
    );
    const [contract] = documents;
    const [passage] = await core.searchPassages(TITLE);
    if (!contract || !passage) throw new Error("The contract wasn't added.");

    await citationsOfAnswer(core, "What does '供应商合同' say?");
    const answerSearch = calls.find(
      (call) => !isCheckRun(call) && call.results.some((each) => each.tool === "search_documents"),
    );
    calls.length = 0;
    await core.checkClaim({
      claim: sentence,
      cited: [
        {
          documentName: contract.name,
          documentId: contract.id,
          contentHash: contract.contentHash,
          passageId: passage.passageId,
          quote: TITLE,
        },
      ],
    });
    const checked = calls.filter(isCheckRun).map(shown).join("\n");

    // The Answer is still told the year, to lead with the newer of two Documents (#548).
    expect(answerSearch && shown(answerSearch)).toContain('date="2026"');
    expect(checked).toContain(DELIVERY);
    expect(checked).not.toMatch(DATE_ATTRIBUTE);
  });
});

describe("a check names whether a thing has happened or is still to happen", () => {
  const ALREADY = "窑炉升级计划的费用是 £185,000，包括两台 K9 窑炉并已安装好。";
  const PLANNED = "两台 K9 窑炉计划于 2027 年 2 月安装。";
  /** Cites `quote` from a Passage it was shown, then replies with `text`. */
  const citeThen =
    (quote: string, text: string) =>
    (call: ModelCall): ScriptedReply => {
      if (call.results.some((each) => each.tool === "cite")) return { text };
      const shown = [
        ...call.results.flatMap((each) => shownPassages(each.text)),
        ...shownPassages(call.prompt),
      ];
      const passage = shown.find((each) => each.text.includes(quote))?.id;
      return { calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote }] } }] };
    };
  const verdict = (time: string, says: string) =>
    [
      "Verdict: supported",
      "Absence: no",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      `Time: ${time}`,
      `${says} [^1]`,
      "Covered: the price of two K9 kilns",
      "Not covered: that they are already installed",
    ].join("\n");

  test("a supported verdict whose Time differs is no support, in Chinese against an English slide", async () => {
    const { core, documents } = await setUpWithDocuments(
      checkingModel({
        [ALREADY]: {
          reply: citeThen(
            COST,
            verdict(
              "已安装好 / installation in February 2027, differs",
              "The slide prices two K9 kilns, installed.",
            ),
          ),
        },
        [PLANNED]: {
          reply: citeThen(
            INSTALLATION,
            verdict(
              "计划于 2027 年 2 月 / in February 2027, same",
              "The slide plans installation in February 2027.",
            ),
          ),
        },
      }),
      [KILN_DECK],
    );
    const [deck] = documents;
    const [passage] = await core.searchPassages(COST);
    if (!deck || !passage) throw new Error("The deck wasn't added.");
    const cited = (quote: string) => ({
      documentName: deck.name,
      documentId: deck.id,
      contentHash: deck.contentHash,
      passageId: passage.passageId,
      quote,
    });

    const already = await core.checkClaim({ claim: ALREADY, cited: [cited(COST)] });
    const planned = await core.checkClaim({ claim: PLANNED, cited: [cited(INSTALLATION)] });

    expect(already.verdict).toBe("unsupported");
    expect(planned.verdict).toBe("supported");
  });
});

describe("the sentences of an Answer its check reads", () => {
  test("a table's row and a sentence with a Calculated figure are told apart from an ordinary cited sentence", () => {
    const text = [
      "The library opened in 1968[^1]. 图书馆于 1968 年开放[^2]。",
      "",
      "| Quarter | Revenue |",
      "|:--|--:|",
      "| Q1 | Revenue was 289.4 [^3] |",
      "",
      "Revenue grew [=1] in 2025[^4].",
    ].join("\n");

    const found = citedSentences(text, [{ marker: 1, shown: "20.4%" }]);

    expect(
      found.map(({ sentence, markers, calculated, inTable }) => [
        sentence,
        markers,
        calculated,
        inTable,
      ]),
    ).toEqual([
      ["The library opened in 1968.", [1], false, false],
      ["图书馆于 1968 年开放。", [2], false, false],
      ["Q1 Revenue was 289.4", [3], false, true],
      ["Revenue grew 20.4% in 2025.", [4], true, false],
    ]);
  });
});
