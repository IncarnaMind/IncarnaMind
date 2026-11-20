import { describe, expect, test, vi } from "vitest";
import { CITATION_NODE, CLAIM_CHECK_MARK, type Core, type MarkedCitation } from "../../src/core";
import { checkableSentences } from "../../src/core/answers/checks/written";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { citedSentences } from "../../src/shared/citedSentences";
import { answeringModel, batchReply } from "../helpers/answerJudging";
import { isCheckRun, type Plan } from "../helpers/checks";
import { answerJudged, setUpWithDocuments } from "../helpers/citations";
import { nextTurn, startCore } from "../helpers/core";
import { readMind, writeMind } from "../helpers/minds";
import type { GenerateCall, GeneratedReply, ModelCall } from "../helpers/models";
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

  // protects=a sentence the model wrapped over a line break is judged as the one sentence it is, so the verdict lands on its Citation; fails_when=each line is read alone, the sentence is never judged and its Citation reads found beside a sentence nobody judged (#3213); no_claim=how the Note's paragraphs split
  test.each([
    {
      language: "English",
      question: "How much does the kiln upgrade cost, and when is it installed?",
      lines: [
        "The upgrade costs £185,000 for two K9 kilns, which are",
        "already installed [^1]. Installation is planned for",
        "February 2027 [^2].",
      ],
      wrong: "The upgrade costs £185,000 for two K9 kilns, which are already installed.",
      right: "Installation is planned for February 2027.",
      says: "The slide says the two K9 kilns are to be installed in February 2027.",
    },
    {
      language: "English, wrapped at 80 columns",
      question: "How much does the kiln upgrade cost, and when is it installed?",
      lines: [
        "The upgrade costs £185,000 for two K9 kilns, which are already installed in",
        "the main hall at the Stoke site, with the cost split across two years [^1].",
        "Installation is planned for February 2027, after the supplier confirms the",
        "order and the board signs off the budget [^2].",
      ],
      wrong:
        "The upgrade costs £185,000 for two K9 kilns, which are already installed in the main hall at the Stoke site, with the cost split across two years.",
      right:
        "Installation is planned for February 2027, after the supplier confirms the order and the board signs off the budget.",
      says: "The slide says the two K9 kilns are to be installed in February 2027.",
    },
    {
      language: "Chinese",
      question: "窑炉升级要花多少钱？什么时候安装？",
      lines: [
        "窑炉升级计划的费用是 £185,000，包括两台 K9 窑炉，并",
        "装好[^1]。安装计划在 2027 年",
        "2月[^2]。",
      ],
      wrong: "窑炉升级计划的费用是 £185,000，包括两台 K9 窑炉，并装好。",
      right: "安装计划在 2027 年 2月。",
      says: "幻灯片说两台 K9 窑炉将于 2027 年 2 月安装，尚未安装。",
    },
  ])("a sentence wrapped over a line break, in $language, is judged whole", async (each) => {
    const plans: Record<string, Plan> = {
      [each.wrong]: { verdict: "contradicted", quote: INSTALLATION, says: each.says },
      [each.right]: { verdict: "supported", quote: INSTALLATION, says: each.right },
    };
    const { core } = await setUpWithDocuments(
      answeringModel("kilns installed cost", each.lines.join("\n"), [COST, INSTALLATION], plans),
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

  // protects=an Answer's batch is told the Citation check's own verdicts (#3410), and reads each: a cited sentence it finds overstated, partly supported or not found shows Unsupported with what the Documents say, beside a supported one; fails_when=a verdict word of the check's rules is dropped, leaving the sentence Not checked, or is read as supported; no_claim=how a real model chooses among them (eval/answerSupport).
  test.each(["overstated", "partly supported", "not found"] as const)(
    "a cited sentence the batch finds %s shows Unsupported",
    async (verdict) => {
      const wrong = "The document is a supplier contract summary, “供应商合同摘要”, dated 2026.";
      const right = "The contract runs until 31 December 2027.";
      const reason = "The Document doesn't say when it is dated.";
      const answer = `${wrong.slice(0, -1)}[^1]. ${right.slice(0, -1)}[^2].`;
      const plans: Record<string, Plan> = {
        [wrong]: { verdict, says: reason },
        [right]: { verdict: "supported", quote: TERM, says: right },
      };
      const { core } = await setUpWithDocuments(
        answeringModel("供应商合同", answer, [TITLE, TERM], plans),
        [CONTRACT],
      );

      const citations = await citationsOfAnswer(core, "What does '供应商合同' say?");

      expect(checkOf(citations, 1)).toMatchObject({
        quote: TITLE,
        check: "unsupported",
        verdict: reason,
      });
      expect(checkOf(citations, 2)).toMatchObject({ quote: TERM, check: "found" });
    },
  );
});

describe("a check reply that corrects itself is read by its corrected answer (#3029)", () => {
  // protects=an Answer's check reads a batch reply that holds a first answer, words, then a corrected one, by the corrected one: its verdicts reach the Citations, and a pass the first answer judged otherwise leaves its sentence Not checked; fails_when=such a reply leaves every sentence Not checked, or a pass rests on a reply that said otherwise; no_claim=how often a model corrects itself.
  test.each([
    {
      language: "English",
      question: "How much does the kiln upgrade cost, and when is it installed?",
      cost: "The upgrade costs £185,000 for two K9 kilns.",
      date: "Installation is planned for February 2027.",
      words: "Wait, I need to include both sentences.",
    },
    {
      language: "Chinese",
      question: "窑炉升级要花多少钱？什么时候安装？",
      cost: "升级两台 K9 窑炉的费用是 £185,000。",
      date: "安装计划在 2027 年 2 月。",
      words: "等等，两句都要给出结论。更正如下：",
    },
  ])("in $language, the corrected answer's verdicts are the Citations'", async (each) => {
    const answer = `${each.cost.slice(0, -1)}[^1]${each.cost.slice(-1)} ${each.date.slice(0, -1)}[^2]${each.date.slice(-1)}`;
    const entry = (number: number, verdict: string) =>
      `{"number":${number},"kind":"fact","verdict":"${verdict}","roles":"same","time":"same","quoted":"states","says":"The slide says so."}`;
    const replies = [
      // Sentence 2 skipped, then both: each gets the corrected answer's verdict.
      `{"sentences":[${entry(1, "supported")}]}\n\n${each.words}\n\n{"sentences":[${entry(1, "supported")},${entry(2, "contradicted")}]}`,
      // Sentence 1 judged unsupported, then passed: it stays Not checked.
      `{"sentences":[${entry(1, "unsupported")},${entry(2, "supported")}]}\n\n${each.words}\n\n{"sentences":[${entry(1, "supported")},${entry(2, "supported")}]}`,
    ];
    const checks = [];
    for (const reply of replies) {
      const { core } = await setUpWithDocuments(
        answeringModel(
          "kilns installed cost",
          answer,
          [COST, INSTALLATION],
          {},
          {
            judge: () => ({ text: reply }),
          },
        ),
        [KILN_DECK],
      );
      const citations = await citationsOfAnswer(core, each.question);
      checks.push([checkOf(citations, 1)?.check, checkOf(citations, 2)?.check]);
    }

    expect(checks).toEqual([
      ["found", "contradicted"],
      ["not-checked", "found"],
    ]);
  });
});

describe("an Answer's ✓ rests only on its Citations' own quotes (#3050)", () => {
  const AGE = "Our two kilns are fourteen years old.";
  const SUPPLIER = "Supplier: Hartwell Kilns";
  const AGE_ZH = "我们的两台窑炉已经用了很多年。";
  const SUPPLIER_ZH = "供应商：哈特韦尔窑炉公司";
  const DOCUMENTS = [
    { name: "Kilns.pptx", contents: pptxOf({ slides: [slide(AGE, AGE_ZH)] }) },
    { name: "Supply.md", contents: `${SUPPLIER}\n\n${SUPPLIER_ZH}\n` },
  ];

  // protects=an Answer's judgement is shown only the Passage its sentence's Citation quotes, and takes no record its reply writes of another Passage: the Citation stays as the model gave it, with the ✓ its reply gives, which Add to note carries with that Citation for the Note to read alike, in English and Chinese; fails_when=the judgement is shown another Passage or takes a record from its reply, which would need the Note's reading (`asCitedNow`) in the Answer too; no_claim=what a real model's judgement says.
  test.each([
    {
      language: "English",
      question: "Who supplies the kilns?",
      answer: "The kilns are supplied by Hartwell Kilns[^1].",
      cites: AGE,
      elsewhere: SUPPLIER,
    },
    {
      language: "Chinese",
      question: "窑炉的供应商是谁？",
      answer: "窑炉由哈特韦尔窑炉公司供应[^1]。",
      cites: AGE_ZH,
      elsewhere: SUPPLIER_ZH,
    },
  ])("in $language, a record its reply writes of another Passage changes nothing", async (each) => {
    const shown: string[] = [];
    const judge = (call: GenerateCall): GeneratedReply => {
      shown.push(call.prompt);
      const entry = {
        number: 1,
        kind: "fact",
        verdict: "supported",
        roles: "same",
        time: "same",
        quoted: "states",
        says: null,
      };
      return {
        text: `${JSON.stringify({ sentences: [entry] })}\n\nCite 1: Supply, “${each.elsewhere}”`,
      };
    };
    const { core, client } = await setUpWithDocuments(
      answeringModel("kilns supplier 窑炉 供应商", each.answer, [each.cites], {}, { judge }),
      DOCUMENTS,
    );
    const answer = await (await askedAnswer(core, each.question)).judged();
    writeMind(client, withAnswerChecks(pageBlocks(answer), answer, null));
    await client.settled();
    const inNote = claimsOf(readMind(client), {
      footing: "not-yet-known",
      versions: null,
      folderId: null,
      scope: null,
    });

    expect(answer.citations).toEqual([
      expect.objectContaining({ marker: 1, quote: each.cites, check: "found", passedAt: [0] }),
    ]);
    expect(inNote.claims.map((claim) => claim.shown.state)).toEqual(["supported"]);
    expect(shown).toHaveLength(1);
    for (const prompt of shown) {
      expect(prompt).toContain(each.cites);
      expect(prompt).not.toContain(each.elsewhere);
    }
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
      const judgedAnswer = await asked.judged();
      expect(judgedAnswer.citations).toMatchObject([{ marker: 1, check: "found" }]);
      // A Note made from it carries the judgement's check, at the judgement's time (#2313).
      const carried = withAnswerChecks(pageBlocks(judgedAnswer), judgedAnswer, null);
      const marks: unknown[] = [];
      const collect = (nodes: readonly NodeJSON[]) =>
        nodes.forEach((node) => {
          for (const mark of node.marks ?? []) {
            if (mark.type === CLAIM_CHECK_MARK) marks.push(mark.attrs);
          }
          collect(node.content ?? []);
        });
      collect(carried);
      // A sentence split around its Citation carries its one mark on each piece of its text.
      const distinct = [
        ...new Map(marks.map((mark) => [(mark as { id: string }).id, mark])).values(),
      ];
      // Its judgement read only its Citation: the carried check says so (#2809).
      expect(distinct).toMatchObject([
        { state: "supported", checkedAt: expect.any(String), citedOnly: true },
      ]);
      // The write's own check leaves the carried sentence to the judgement that settled it.
      expect(checkableSentences(carried)).toHaveLength(0);
    },
  );

  test.each([
    { language: "English", question: "When is the kiln installed?", answer: ANSWER },
    { language: "Chinese", question: "窑炉什么时候安装？", answer: ANSWER_ZH },
  ])(
    "in $language, a judgement with its roles or time missing or misspelt leaves it not checked, never found (#2816)",
    async (each) => {
      const sentence = each.answer.replace("[^1]", "");
      const judged = async (reply: string) => {
        const { core } = await setUpWithDocuments(
          answeringModel(
            "kilns installed cost",
            each.answer,
            [INSTALLATION],
            { [sentence]: { verdict: "supported", quote: INSTALLATION, says: sentence } },
            { judge: () => ({ text: reply }) },
          ),
          [KILN_DECK],
        );
        return (await (await askedAnswer(core, each.question)).judged()).citations;
      };

      expect(await judged('{"sentences":[{"number":1,"verdict":"supported"}]}')).toMatchObject([
        { marker: 1, check: "not-checked" },
      ]);
      expect(
        await judged(
          '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"different","time":"same","says":"The slide says so."}]}',
        ),
      ).toMatchObject([{ marker: 1, check: "not-checked" }]);
      expect(
        await judged(
          '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","says":"The slide says so."}]}',
        ),
      ).toMatchObject([{ marker: 1, check: "not-checked" }]);
      expect(
        await judged(
          '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","quoted":"states","says":"The slide says so."}]}',
        ),
      ).toMatchObject([{ marker: 1, check: "found" }]);
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
    const waiting = pageBlocks(asked.atEnd);
    await core.stopConversationAnswer({
      conversationId: asked.atEnd.conversationId,
      answerId: asked.atEnd.id,
    });
    const notChecked = await asked.judged();
    release();

    expect(asked.atEnd.citations).toMatchObject([{ marker: 1, check: "checking" }]);
    expect(checksIn(waiting)).toEqual(["found"]);
    expect(notChecked.citations).toMatchObject([{ marker: 1, check: "not-checked" }]);
    expect(checksIn(pageBlocks(notChecked))).toEqual(["found"]);
    // A stopped Answer's Citation still checking never had its quote checked.
    expect(checksIn(pageBlocks({ ...asked.atEnd, status: "stopped" }))).toEqual(["checking"]);
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

/** Every cited sentence of `answer`, judged supported, as a model that keeps to its quotes is. */
function supportedPlans(answer: string): Record<string, Plan> {
  return Object.fromEntries(
    citedSentences(answer).map(({ sentence }) => [
      sentence,
      { verdict: "supported" as const, says: sentence },
    ]),
  );
}

/** Asks one Question about `document`, citing `quote`, with the plan that judges the Answer supported. */
async function askedCited(
  question: string,
  query: string,
  answer: string,
  quote: string,
  document: { name: string; contents: string },
) {
  const { core } = await setUpWithDocuments(
    answeringModel(query, answer, [quote], supportedPlans(answer)),
    [document],
  );
  return citationsOfAnswer(core, question);
}

describe("a figure in the words a sentence quotes is stated by its Citation", () => {
  // protects=the quoted-words check splits sentences with the shared splitter, so "Mr. Smith" ends no sentence and the words before it are checked with the sentence's Citation (#2712); fails_when=the check ends the sentence at "Mr." and leaves the 5% the page doesn't say unchecked; no_claim=how the claim judge reads the sentence.
  test("a figure the page doesn't state, quoted before an abbreviation, makes its Citation not found", async () => {
    const answer = "The schedule says “The fee is 5% per week,” said Mr. Smith[^1].";
    const citations = await askedCited(
      "What does the schedule say?",
      "fee per week grace period",
      answer,
      "The fee is 3% per week",
      {
        name: "Fee schedule.md",
        contents: "# Fee schedule\n\nThe fee is 3% per week after the grace period.\n",
      },
    );

    expect(checkOf(citations, 1)).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
    });
  });
});

describe("a table's row, judged as one line, carries onto its cells in a Note (#3214)", () => {
  const AMOUNT = "合同总金额为人民币 860,000 元，分四期支付。";
  const CASES = [
    {
      language: "English",
      question: "How much does the kiln upgrade cost, and when is it installed?",
      keywords: "kilns installed cost",
      text: [
        "| Item | Detail |",
        "| --- | --- |",
        "| Cost | £185,000 for two K9 kilns [^1] |",
        "| Installation | February 2027 [^2] |",
      ].join("\n"),
      documents: [KILN_DECK],
      passages: [COST, INSTALLATION],
      cells: ["£185,000 for two K9 kilns", "February 2027"],
    },
    {
      language: "Chinese",
      question: "《供应商合同》的金额和期限是什么？",
      keywords: "供应商合同",
      text: [
        "| 项目 | 内容 |",
        "| --- | --- |",
        "| 金额 | 合同总金额为人民币 860,000 元，分四期支付 [^1] |",
        "| 期限 | 合同有效期至 2027 年 12 月 31 日 [^2] |",
      ].join("\n"),
      documents: [CONTRACT],
      passages: [AMOUNT, TERM],
      cells: ["合同总金额为人民币 860,000 元，分四期支付", "合同有效期至 2027 年 12 月 31 日"],
    },
  ];

  /** The Note an Answer's Add to note makes, read as the Note's own check reads it. */
  async function noteOf(
    each: (typeof CASES)[number],
    verdicts: ("supported" | "unsupported" | "contradicted")[],
  ) {
    const rows = citedSentences(each.text).map((cited) => cited.sentence);
    const plans: Record<string, Plan> = {};
    rows.forEach((row, index) => {
      const verdict = verdicts[index] ?? "supported";
      plans[row] =
        verdict === "supported"
          ? { verdict, quote: each.passages[index] ?? "", says: row }
          : verdict === "contradicted"
            ? {
                verdict,
                quote: each.passages.at(-1) ?? "",
                says: "The Document gives another date.",
              }
            : { verdict, says: "The Document says otherwise." };
    });
    const { core, client } = await setUpWithDocuments(
      answeringModel(each.keywords, each.text, each.passages, plans),
      each.documents,
    );
    const answer = await (await askedAnswer(core, each.question)).judged();
    const carried = withAnswerChecks(pageBlocks(answer), answer, null);
    writeMind(client, carried);
    await client.settled();
    const claims = claimsOf(readMind(client), {
      footing: "not-yet-known",
      versions: null,
      folderId: null,
      scope: null,
    }).claims;
    return { rows, claims, answer };
  }

  // protects=a table row the Answer's judgement settled Supported is Supported on the cell holding its Citation in the Note, so the Note's own check doesn't judge it again; fails_when=the row's verdict is keyed to the row's words, which no cell has (0 of 2 carried)
  test.each(CASES)("each row's verdict reaches its cell, in $language", async (each) => {
    const { rows, claims, answer } = await noteOf(each, []);

    expect(rows).toHaveLength(2);
    expect(answer.citations).toMatchObject([{ check: "found" }, { check: "found" }]);
    expect(claims.map((claim) => [claim.sentence.text, claim.shown.state])).toEqual([
      [each.cells[0], "supported"],
      [each.cells[1], "supported"],
    ]);
  });

  // protects=a row of two cited cells that is not Supported marks neither: the judgement read the row as one line, so it can't say which cell is wrong, and a right price cell must not read Contradicted for a wrong date (#3214); fails_when=the row's verdict is copied to every cited cell
  const TWO_CITED_CELLS = [
    [
      "| Item | Price | Date |",
      "| --- | --- | --- |",
      "| Kilns | £185,000 for two K9 kilns [^1] | Installed in February 2027 [^2] |",
    ],
    [
      "| 项目 | 金额 | 期限 |",
      "| --- | --- | --- |",
      "| 合同 | 合同总金额为人民币 860,000 元，分四期支付 [^1] | 合同有效期至 2027 年 12 月 31 日 [^2] |",
    ],
  ];
  test.each(
    CASES.map((each, index) => ({ ...each, text: (TWO_CITED_CELLS[index] ?? []).join("\n") })),
  )(
    "a row of two cited cells judged Contradicted marks neither cell, in $language",
    async (each) => {
      const { claims, answer } = await noteOf(each, ["contradicted"]);

      expect(answer.citations.map((citation) => citation.check)).toContain("contradicted");
      expect(claims.map((claim) => [claim.sentence.text, claim.shown.state])).toEqual([]);
    },
  );

  // protects=a row the judgement settled Unsupported is Unsupported on its cell, never Supported (#3214); fails_when=an unsupported row's cell reads Supported or unchecked
  test.each(CASES)("a row judged Unsupported carries that, in $language", async (each) => {
    const { claims } = await noteOf(each, ["unsupported", "supported"]);

    expect(claims.map((claim) => claim.shown.state)).toEqual(["unsupported", "supported"]);
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

  test("a Chinese sentence that quotes an English one is judged whole, and its Citations take that judgement (#3009)", async () => {
    const answer =
      "另外，该文档的摘要页写明“Prepared for software testing[^1]. The text is fictional.”（为软件测试准备，文本是虚构的）[^2]。";
    const whole =
      "另外，该文档的摘要页写明“Prepared for software testing. The text is fictional.”（为软件测试准备，文本是虚构的）。";
    const plans: Record<string, Plan> = { [whole]: { verdict: "supported", says: whole } };
    const judged: string[] = [];
    const { core } = await setUpWithDocuments(
      answeringModel(
        "software testing fictional",
        answer,
        ["Prepared for software testing", "The text is fictional"],
        plans,
        {
          judge: (call) => {
            for (const [, sentence = ""] of call.prompt.matchAll(
              /<sentence number="\d+">\n([\s\S]*?)\n<\/sentence>/g,
            ))
              judged.push(sentence);
            return batchReply(call, plans);
          },
        },
      ),
      [
        {
          name: "Test summary.md",
          contents: "# Summary\n\nPrepared for software testing. The text is fictional.\n",
        },
      ],
    );

    const citations = await citationsOfAnswer(core, "这份文档的摘要页写了什么？");

    expect(judged).toEqual([whole]);
    expect(checkOf(citations, 1)).toMatchObject({ check: "found" });
    expect(checkOf(citations, 2)).toMatchObject({ check: "found" });
  });
});
