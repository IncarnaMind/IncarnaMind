/**
 * An Answer's sentence keeps no ✓ for a unit its quotes don't back (#2997): six percentage points
 * is not six percent. Its check runs the unit gate Check against Documents runs, and ends
 * Unsupported with the same reason; a sentence its quote states keeps its ✓.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CLAIM_CHECK_MARK, type MarkedCitation } from "../../src/core";
import { writeVtt } from "../../src/core/documents/formats/vtt";
import type { Language } from "../../src/core/language";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { checkGenerate, checkingModel, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import {
  answerEnded,
  answerJudged,
  askAndFinish,
  type SourceFile,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const loose = (text: string) => text.replace(/\s+/gu, " ").trim();

/** A model that cites `quote` for `sentence`, and calls it supported, in an Answer's batch and in a check. */
function supportingModel(sentence: string, quote: string) {
  return citingModel(sentence, quote, { verdict: "supported", quote, says: quote });
}

/** A model that cites `quote` for `sentence` and calls it contradicted, in an Answer's batch and in a check. */
function contradictingModel(sentence: string, quote: string) {
  const plan: Plan = { verdict: "contradicted", quote, says: quote, judgement: "conflict" };
  return citingModel(sentence, quote, plan, (prompt) =>
    JSON.stringify({
      sentences: [...prompt.matchAll(/<sentence number="(\d+)">/g)].map(([, number]) => ({
        number: Number(number),
        kind: "fact",
        verdict: "contradicted",
        roles: "same",
        time: "same",
        quoted: "states",
        says: CONTRADICTS,
      })),
    }),
  );
}

const CONTRADICTS = "The Document gives another amount.";

/** A model that cites `quote` for `sentence`, replying `plan` in a check and `batch` (all supported when absent) when the Answer is judged. */
function citingModel(
  sentence: string,
  quote: string,
  plan: Plan,
  batch?: (prompt: string) => string,
) {
  const plans: Record<string, Plan> = { [sentence]: plan };
  const answer = sentence.replace(/([.。])$/u, "[^1]$1");
  const citing = (call: ModelCall): ScriptedReply => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: quote } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const shown = searches.flatMap((result) => shownPassages(result.text));
      const passage = shown.find((each) => loose(each.text).includes(loose(quote)));
      const citations = [{ marker: 1, passage: passage?.id, quote }];
      return { calls: [{ tool: "cite", input: { citations } }] };
    }
    return { text: answer };
  };
  // A Note's check of a sentence with a figure asks which Passage decides it: the one quoted.
  const evidence = JSON.stringify({ passage: "P1", location: null, quote });
  const generate = checkGenerate(plans, evidence);
  return scriptedModel(
    (call) => (isCheckRun(call) ? checkReply(call, plans) : citing(call)),
    batch
      ? {
          generate: (call) =>
            call.question === "sentence-batch" ? { text: batch(call.prompt) } : generate(call),
        }
      : { generate, judgesItsAnswers: true },
  );
}

/** `sentence` asked in the assistant, citing `quote` in `file`: the Answer once it is judged. */
async function answered(
  sentence: string,
  quote: string,
  file: SourceFile | readonly SourceFile[],
  language: Language,
  model = supportingModel(sentence, quote),
) {
  const files = "name" in file ? [file] : file;
  const setup = await setUpWithDocuments(model, files);
  const { core } = setup;
  if (language !== "en") await core.updateSettings({ user: { language } });
  const asked = await core.askInConversation({ text: "How much did it rise?" });
  if (!asked.asked) throw new Error("Not asked.");
  await answerEnded(core, asked.answerId);
  const ids = { conversationId: asked.conversation.id, answerId: asked.answerId };
  return { ...setup, ids, answer: await answerJudged(core, ids.conversationId, ids.answerId) };
}

const shownOf = (citation: MarkedCitation | undefined) => ({
  check: citation?.check,
  verdict: citation?.verdict ?? null,
});

/**
 * `sentence` citing `quote` in `file`, a model calling it supported both in an Answer's batch and
 * in Check against Documents: the Answer's Citation as the User sees it, and the check's result.
 */
async function judged(sentence: string, quote: string, file: SourceFile, language: Language) {
  const { core, answer } = await answered(sentence, quote, file, language);
  const checked = await core.checkClaim({ claim: sentence });
  return {
    answer: shownOf(answer.citations[0]),
    document: {
      verdict: checked.verdict,
      reason: checked.verdict === "unsupported" ? (checked.unsupported?.reason ?? null) : null,
    },
  };
}

const rates = (line: string): SourceFile => ({ name: "Rates.txt", contents: `Rates\n${line}\n` });

const meeting = (line: string): SourceFile => ({
  name: "Rates.vtt",
  contents: writeVtt({
    cues: [{ startMs: 0, endMs: 3000, text: line, speaker: "Alex" }],
    gaps: [],
  }),
});

describe("A percent is not backed by percentage points, nor points by a percent (#2997)", {
  timeout: 60_000,
}, () => {
  // protects=an Answer's sentence giving a percent where its quote gives percentage points or points, or points where it gives a percent, ends Unsupported with the reason Check against Documents gives, in English and Chinese, from a Document and from a Meeting's Transcript; fails_when="It rose 6%." citing "It rose 6 percentage points" keeps its ✓, or the Answer's reason differs from the check's; no_claim=what a real model calls the pair.
  test.each([
    {
      sentence: "It rose 6%.",
      file: rates("It rose 6 percentage points."),
      quote: "It rose 6 percentage points",
      en: "The Document gives 6 percentage points, not 6%.",
      zh: "文档写的是 6 percentage points，不是 6%。",
    },
    {
      sentence: "It rose 20%.",
      file: rates("The index rose 20 points."),
      quote: "The index rose 20 points",
      en: "The Document gives 20 points, not 20%.",
      zh: "文档写的是 20 points，不是 20%。",
    },
    {
      sentence: "It rose 6 percentage points.",
      file: rates("It rose 6%."),
      quote: "It rose 6%",
      en: "The Document gives 6%, not 6 percentage points.",
      zh: "文档写的是 6%，不是 6 percentage points。",
    },
    {
      sentence: "利润率上升了6%。",
      file: rates("利润率上升了6个百分点。"),
      quote: "利润率上升了6个百分点",
      en: "The Document gives 6个百分点, not 6%.",
      zh: "文档写的是 6个百分点，不是 6%。",
    },
    {
      sentence: "利润率上升了6个百分点。",
      file: rates("利润率上升了6%。"),
      quote: "利润率上升了6%",
      en: "The Document gives 6%, not 6个百分点.",
      zh: "文档写的是 6%，不是 6个百分点。",
    },
    {
      sentence: "It rose 6%.",
      file: meeting("it rose 6 percentage points"),
      quote: "it rose 6 percentage points",
      en: "The Document gives 6 percentage points, not 6%.",
      zh: "文档写的是 6 percentage points，不是 6%。",
    },
    {
      sentence: "It rose 6 percentage points.",
      file: meeting("it rose 6%"),
      quote: "it rose 6%",
      en: "The Document gives 6%, not 6 percentage points.",
      zh: "文档写的是 6%，不是 6 percentage points。",
    },
    {
      sentence: "利润率上升了6%。",
      file: meeting("利润率上升了6个百分点"),
      quote: "利润率上升了6个百分点",
      en: "The Document gives 6个百分点, not 6%.",
      zh: "文档写的是 6个百分点，不是 6%。",
    },
  ])("$sentence citing $quote in $file.name", async ({ sentence, file, quote, en, zh }) => {
    for (const [language, reason] of [
      ["en", en],
      ["zh-CN", zh],
    ] as const) {
      expect(await judged(sentence, quote, file, language), language).toEqual({
        answer: { check: "unsupported", verdict: reason },
        document: { verdict: "unsupported", reason },
      });
    }
  });

  // protects=a quote that states the sentence's own unit keeps its ✓ (6% for 6%, points for points, 230 bps for 2.3 percentage points, a currency the Document states), and a number no quote states stays Not checked, in English and Chinese, from a Document and a Transcript; fails_when=the gate takes a ✓ from a sentence its quote states, or a sentence not ✓ before ends ✓; no_claim=what a real model calls the pair.
  test.each([
    ["It rose 6%.", rates("It rose 6%."), "It rose 6%", "found"],
    [
      "It rose 6 percentage points.",
      rates("It rose 6 percentage points."),
      "It rose 6 percentage points",
      "found",
    ],
    [
      "It rose 230 bps.",
      rates("It rose 2.3 percentage points."),
      "It rose 2.3 percentage points",
      "found",
    ],
    ["The salary is £54,000.", rates("The salary is £54,000."), "The salary is £54,000", "found"],
    ["利润率上升了6个百分点。", rates("利润率上升了6个百分点。"), "利润率上升了6个百分点", "found"],
    [
      "利润率上升了230个基点。",
      rates("利润率上升了2.3个百分点。"),
      "利润率上升了2.3个百分点",
      "found",
    ],
    ["年薪为人民币54,000元。", rates("年薪为人民币54,000元。"), "年薪为人民币54,000元", "found"],
    ["It rose 6%.", meeting("it rose 6%"), "it rose 6%", "found"],
    [
      "It rose 6 percentage points.",
      meeting("it rose 6 percentage points"),
      "it rose 6 percentage points",
      "found",
    ],
    [
      "It rose 7%.",
      rates("It rose 6 percentage points."),
      "It rose 6 percentage points",
      "not-checked",
    ],
    [
      "It rose 7 percentage points.",
      rates("It rose 6 percentage points."),
      "It rose 6 percentage points",
      "not-checked",
    ],
    ["利润率上升了7%。", rates("利润率上升了6个百分点。"), "利润率上升了6个百分点", "not-checked"],
  ] as const)("%s citing %j keeps %s", async (sentence, file, quote, check) => {
    for (const language of ["en", "zh-CN"] as const) {
      const { answer } = await judged(sentence, quote, file, language);
      expect(answer, language).toEqual({ check, verdict: null });
    }
  });
});

describe("Every way an Answer's sentence reaches the User keeps the same result (#2997)", {
  timeout: 60_000,
}, () => {
  const SENTENCE = "It rose 6%.";
  const QUOTE = "It rose 6 percentage points";
  const FILE = rates("It rose 6 percentage points.");
  const LINE = "The Document gives 6 percentage points, not 6%.";
  const ZH_LINE = "文档写的是 6 percentage points，不是 6%。";

  // protects=Check again judges a sentence anew and shows what a first check with the same reply shows: Unsupported with the same line, never back to ✓; fails_when=a second judgement of "It rose 6%." citing "It rose 6 percentage points" ends ✓ or with another line; no_claim=what a real model replies.
  test.each([
    ["en", LINE],
    ["zh-CN", ZH_LINE],
  ] as const)("Check again shows what the first check showed (%s)", async (language, line) => {
    const { core, ids, answer } = await answered(SENTENCE, QUOTE, FILE, language);
    await core.checkAnswerAgain(ids);
    const again = await answerJudged(core, ids.conversationId, ids.answerId);

    expect(shownOf(answer.citations[0])).toEqual({ check: "unsupported", verdict: line });
    expect(shownOf(again.citations[0])).toEqual({ check: "unsupported", verdict: line });
  });

  // protects=the assistant's Answer added to a Note carries the sentence's Unsupported and its line into the Note's check mark, and the exported check record lists it so; fails_when=the Note marks it supported, loses the line, or the record says Supported; no_claim=the record's PDF, which needs a printer.
  test("added to a Note, the sentence is Unsupported with the line, in the Note and its check record", async () => {
    const { core, answer } = await answered(SENTENCE, QUOTE, FILE, "en");
    const question = "How much did it rise?";
    const carried = withAnswerChecks(pageBlocks(answer, question), answer, question, null);
    // A sentence split around its Citation carries its one mark on each piece of its text.
    const marks = new Map<string, { state: string; says: string | null }>();
    const collect = (nodes: readonly NodeJSON[]) =>
      nodes.forEach((node) => {
        for (const mark of node.marks ?? []) {
          if (mark.type !== CLAIM_CHECK_MARK) continue;
          const { id, state, says } = mark.attrs as {
            id: string;
            state: string;
            says: string | null;
          };
          marks.set(id, { state, says });
        }
        collect(node.content ?? []);
      });
    collect(carried);
    expect([...marks.values()]).toEqual([{ state: "unsupported", says: LINE }]);

    const mind = await core.createMind({ title: "Rates notes" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [...carried]);
    await client.settled();
    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    const saved = await core.saveCheckRecord(mind.id);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csv = readFileSync(
      join(out, `${saved.file.name.replace(/\.(pdf|csv)$/u, "")}.csv`),
      "utf8",
    );
    expect(
      recordRows(csv)
        .filter((row) => row.Sentence === SENTENCE)
        .map((row) => ({
          Kind: row.Kind,
          Result: row.Result,
          "What it says": row["What it says"],
        })),
    ).toEqual([
      { Kind: "Sentence", Result: "Unsupported", "What it says": LINE },
      { Kind: "Citation", Result: "Claim unsupported by the Document", "What it says": LINE },
    ]);
  });

  // protects=an Answer asked in a Note has no ✓ of its own (its Citation's "Quote found" isn't one): its sentence's result comes from Check this Note, which reads neither row Supported, a figure bound to a number in another unit or one its quote gives plain being left not checked there; fails_when=the Note's check calls either supported; no_claim=the line Check against Documents gives on its own path, which the measured table holds.
  test.each([
    {
      sentence: "It rose 6%.",
      quote: QUOTE,
      file: FILE,
      read: { state: "not-checked", reason: null },
    },
    {
      sentence: "The salary is £54,000.",
      quote: "The salary is 54,000",
      file: rates("The salary is 54,000."),
      read: { state: "not-checked", reason: null },
    },
  ])(
    "asked in a Note, Check this Note reads $sentence as measured",
    async ({ sentence, quote, file, read }) => {
      const { core, mind, client } = await setUpWithDocuments(supportingModel(sentence, quote), [
        file,
      ]);
      await askAndFinish(core, client, mind.id, "How much did it rise?");
      await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
      await client.settled();

      expect(
        claimSpans(readMind(client)).map((span) => ({
          sentence: span.sentence.text.replace(/\uFFFC/gu, "").trim(),
          state: span.check.state,
          reason: span.check.unsupported?.reason ?? null,
        })),
      ).toEqual([{ sentence, ...read }]);
    },
  );
});

describe("An Answer's Unsupported settles without looking further in its scope (#2997)", {
  timeout: 60_000,
}, () => {
  const SENTENCE = "The salary is £54,000.";
  const OFFER = { name: "Offer.txt", contents: "Offer letter\nThe salary is $54,000.\n" };
  const CONTRACT = {
    name: "Contract.txt",
    contents: "Employment contract\nThe salary is £54,000.\n",
  };
  const LINE = "The Document gives $54,000, not £54,000.";

  // protects=today an Answer's sentence citing a line that gives another currency reads Unsupported with the line, whether or not another Passage in its scope backs it, while Check against Documents, which searches the scope, finds the one that does; fails_when=either check reads otherwise; no_claim=what #3020 will make the Answer do, which changes the first test.
  test.each([
    ["with another Passage giving £54,000 in scope", [OFFER, CONTRACT]],
    ["with nothing else in scope", [OFFER]],
  ] as const)("in an Answer, %s", async (_, files) => {
    const { answer } = await answered(SENTENCE, "The salary is $54,000", files, "en");
    expect(shownOf(answer.citations[0])).toEqual({ check: "unsupported", verdict: LINE });
  });

  test.each([
    [
      "with another Passage giving £54,000 in scope",
      [OFFER, CONTRACT],
      "The salary is £54,000",
      { verdict: "supported", reason: null },
    ],
    [
      "with nothing else in scope",
      [OFFER],
      "The salary is $54,000",
      { verdict: "unsupported", reason: LINE },
    ],
  ] as const)("in Check against Documents, %s", async (_, files, found, read) => {
    const { core } = await setUpWithDocuments(
      checkingModel({ [SENTENCE]: { verdict: "supported", quote: found, says: found } }),
      files,
    );
    const checked = await core.checkClaim({ claim: SENTENCE });
    expect({
      verdict: checked.verdict,
      reason: checked.verdict === "unsupported" ? (checked.unsupported?.reason ?? null) : null,
    }).toEqual(read);
  });
});

describe("An Answer leaves a dollar or ¥ its Document doesn't say to Check against Documents for now (#2997)", {
  timeout: 60_000,
}, () => {
  const LEASE = { name: "Lease.txt", contents: "Lease\nThe rent is $54,000 a year.\n" };
  const QUOTE = "The rent is $54,000 a year";
  const CONTRADICTED = { check: "contradicted", verdict: CONTRADICTS };
  const FOUND = { check: "found", verdict: null };

  // protects=a contradicted reply stays Contradicted in an Answer, whether the sentence names a dollar the lease's bare $ doesn't say or gives another amount, in English and Chinese; fails_when="The rent is A$54,000." or "The rent is A$60,000." ends anything but Contradicted; no_claim=what a real model calls either.
  test.each(["The rent is A$54,000.", "The rent is A$60,000."])(
    "%s citing the lease's $54,000 stays Contradicted",
    async (sentence) => {
      for (const language of ["en", "zh-CN"] as const) {
        const model = contradictingModel(sentence, QUOTE);
        const { answer } = await answered(sentence, QUOTE, LEASE, language, model);
        expect(shownOf(answer.citations[0]), language).toEqual(CONTRADICTED);
      }
    },
  );

  // protects=a sentence naming the dollar a bare "$" leaves unsaid, or 日元 for a Chinese Document's ¥, keeps the ✓ in an Answer as before, while Check against Documents reads it Unsupported with its line, in English and Chinese; fails_when=the Answer takes the ✓ for either reading, or Check against Documents stops reading them; no_claim=what the assistant should write instead (#3030).
  test.each([
    {
      sentence: "Vantrell 的目标是超过 1.4 万亿美元。",
      quote: "The target is more than $1.4 trillion",
      file: { name: "Targets.txt", contents: "Targets\nThe target is more than $1.4 trillion.\n" },
      en: "“Targets” gives “$1.4 trillion” without saying which currency",
      zh: "“Targets”写的是“$1.4 trillion”，没有注明币种",
    },
    {
      sentence: "The fee is US$54,000.",
      quote: "The fee is $54,000",
      file: { name: "Invoice.txt", contents: "Invoice\nThe fee is $54,000.\n" },
      en: "“Invoice” gives “$54,000” without saying which currency",
      zh: "“Invoice”写的是“$54,000”，没有注明币种",
    },
    {
      sentence: "服务费用为54,000日元。",
      quote: "服务费用为¥54,000",
      file: { name: "费用.txt", contents: "费用\n服务费用为¥54,000。\n" },
      en: "“费用” gives “¥54,000”, and in Chinese text ¥ means 人民币",
      zh: "“费用”写的是“¥54,000”，中文里 ¥ 指人民币",
    },
  ])("$sentence citing $quote", async ({ sentence, quote, file, en, zh }) => {
    for (const [language, reason] of [
      ["en", en],
      ["zh-CN", zh],
    ] as const) {
      expect(await judged(sentence, quote, file, language), language).toEqual({
        answer: FOUND,
        document: { verdict: "unsupported", reason },
      });
    }
  });

  // protects=leaving the dollar out of an Answer's check leaves the other readings of the same sentence in: a named dollar beside a bare "$" and 6% beside "6 percentage points" in one sentence is Unsupported with the percent's line, in English and Chinese; fails_when=the sentence keeps its ✓ because the dollar is read first; no_claim=Check against Documents, which gives the dollar's line first.
  test("a sentence with a dollar left out and a percent beside points is Unsupported for the percent", async () => {
    const sentence = "The fee is US$54,000 and the margin rose 6%.";
    const quote = "The fee is $54,000 and the margin rose 6 percentage points";
    const file = {
      name: "Invoice.txt",
      contents: `Invoice\n${quote}.\n`,
    };
    for (const [language, reason] of [
      ["en", "The Document gives 6 percentage points, not 6%."],
      ["zh-CN", "文档写的是 6 percentage points，不是 6%。"],
    ] as const) {
      const { answer } = await judged(sentence, quote, file, language);
      expect(answer, language).toEqual({ check: "unsupported", verdict: reason });
    }
  });
});

describe("A label that reaches a number outranks another table's caption (#2997)", {
  timeout: 60_000,
}, () => {
  // protects=a number under a heading that states another measure's unit keeps no ✓ for the sentence's unit when another table's caption gives that unit, in an Answer and in Check against Documents, in English and Chinese; fails_when="8月用电为126万吨。" under 各月用电（万千瓦时）, with 表7 各厂产量（万吨） over another table, keeps its ✓ or reads Supported; no_claim=a caption that heads the number's own table, nor a unit line (单位：万吨) elsewhere, under which the sentence passes as on main.
  test("8月用电为126万吨。 under a kilowatt-hour heading stays Unsupported beside another table's （万吨）", async () => {
    const file = {
      name: "月报.txt",
      contents: "表7 各厂产量（万吨）\n一厂\t54\n\n各月用电（万千瓦时）\n8月: 126\n",
    };
    for (const [language, reason] of [
      ["en", "The Document gives 126, not 126万吨."],
      ["zh-CN", "文档写的是 126，不是 126万吨。"],
    ] as const) {
      expect(await judged("8月用电为126万吨。", "8月: 126", file, language), language).toEqual({
        answer: { check: "unsupported", verdict: reason },
        document: { verdict: "unsupported", reason },
      });
    }
  });
});

describe("A number said in words is read whole or not at all (#2997)", {
  timeout: 60_000,
}, () => {
  // protects=words that are part of a longer number said aloud are never read as a share of their own: the "point" of a spoken decimal is no unit ("two point five", "two point 5", "one point fifty"), and the last words of a number are not its figure ("a hundred and five percentage points", "two point fifty percentage points", "two point oh five percentage points"), so the sentence stays Not checked with no unit line, as on main, in an Answer and in Check against Documents, in English and Chinese; fails_when=any of them reads Unsupported with a line that names part of the number ("The Document gives two point, not 2%."); no_claim=a range ("five or six percentage points"), read at its last end as one in digits is.
  test.each([
    ["It rose 2%.", "It rose by two point five"],
    ["It rose 2%.", "It rose by two point 5"],
    ["It rose 1%.", "It rose by one point fifty"],
    ["It rose 5%.", "It rose a hundred and five percentage points"],
    ["It rose 5%.", "It rose one-hundred-and-five percentage points"],
    ["It rose 50%.", "It rose two point fifty percentage points"],
    ["It rose 5%.", "It rose two point oh five percentage points"],
    ["It rose 5%.", "It rose 2 point five percentage points"],
  ])("%s citing “%s” has no unit line", async (sentence, quote) => {
    for (const language of ["en", "zh-CN"] as const) {
      expect(await judged(sentence, quote, rates(`${quote}.`), language), language).toEqual({
        answer: { check: "not-checked", verdict: null },
        document: { verdict: "not-checked", reason: null },
      });
    }
  });

  // protects=a number said whole is still read beside those: a hundred and five with its "one", a decimal with its unit, one point after a rise, and a number after a "point" that is no decimal's ("at that point six percentage points"), each Unsupported with the whole number's line in both checks and both languages; fails_when=any of them loses its line or names fewer words than the number has; no_claim=which words a Transcript's engine writes as digits.
  test.each([
    [
      "It rose 105%.",
      "It rose one hundred and five percentage points",
      "one hundred and five percentage points",
      "105%",
    ],
    [
      "It rose 2.5%.",
      "It rose two point five percentage points",
      "two point five percentage points",
      "2.5%",
    ],
    ["The index rose 1%.", "The index rose one point", "one point", "1%"],
    [
      "At that point 6% separated them.",
      "At that point six percentage points separated them",
      "six percentage points",
      "6%",
    ],
  ])(
    "%s citing “%s” is Unsupported for the whole number",
    async (sentence, quote, said, figure) => {
      for (const [language, reason] of [
        ["en", `The Document gives ${said}, not ${figure}.`],
        ["zh-CN", `文档写的是 ${said}，不是 ${figure}。`],
      ] as const) {
        expect(await judged(sentence, quote, rates(`${quote}.`), language), language).toEqual({
          answer: { check: "unsupported", verdict: reason },
          document: { verdict: "unsupported", reason },
        });
      }
    },
  );
});

describe("A check reply that corrects itself, and the unit gate (#2997, #3029)", {
  timeout: 60_000,
}, () => {
  const SENTENCE = "It rose 6%.";
  const QUOTE = "It rose 6 percentage points";
  const FILE = rates("It rose 6 percentage points.");
  const entry = (verdict: string) =>
    `{"sentences":[{"number":1,"kind":"fact","verdict":"${verdict}","roles":"same","time":"same","quoted":"states","says":"${QUOTE}"}]}`;

  // protects=a pass that a reply gives only after an earlier answer judged the sentence otherwise leaves it Not checked, so the unit gate never runs on it, while a clean pass whose quote gives percentage points for a percent is Unsupported with the line, in English and Chinese; fails_when=the corrected pass reads Unsupported or found, or the clean pass keeps its ✓; no_claim=how often a model corrects itself.
  test.each([
    {
      name: "a pass after an earlier answer said unsupported",
      reply: `${entry("unsupported")}\n\nWait, let me correct that.\n\n${entry("supported")}`,
      en: { check: "not-checked", verdict: null },
      zh: { check: "not-checked", verdict: null },
    },
    {
      name: "a clean pass",
      reply: entry("supported"),
      en: { check: "unsupported", verdict: "The Document gives 6 percentage points, not 6%." },
      zh: { check: "unsupported", verdict: "文档写的是 6 percentage points，不是 6%。" },
    },
  ])("$name", async ({ reply, en, zh }) => {
    for (const [language, shown] of [
      ["en", en],
      ["zh-CN", zh],
    ] as const) {
      const plan: Plan = { verdict: "supported", quote: QUOTE, says: QUOTE };
      const model = citingModel(SENTENCE, QUOTE, plan, () => reply);
      const { answer } = await answered(SENTENCE, QUOTE, FILE, language, model);
      expect(shownOf(answer.citations[0]), language).toEqual(shown);
    }
  });
});

const report = (contents: string): SourceFile => ({ name: "Report.txt", contents });
const underOneHeading = (unit: string) => report(`项目\t数值（${unit}）\nA\t54\nB\t31\n`);
const KILOGRAMS = report("项目\t重量（千克）\nA\t54\nB\t31\n");
const KILOGRAM_ROWS = report("各项数值（千克）\nA: 54\nB: 31\n");
const PER_YEAR = report("项目\t产能（万吨/年）\n一期\t500\n二期\t300\n");
const THOUSAND_TONNES = report("Mill\tOutput (thousand tonnes)\nA\t54\nB\t31\n");
const KILOTONNES = report("Mill\tOutput (kt)\nA\t54\nB\t31\n");
const BESIDE_A_SHARE = report("厂区\t产量\t同比（%）\n一厂\t54\t12\n二厂\t31\t31\n");
const BESIDE_A_COUNT = report("厂区\t产量\t人数（人）\n一厂\t54\t12\n二厂\t31\t31\n");
const BESIDE_A_MARGIN = report("Segment\tRevenue\tMargin (%)\nRetail\t38\t9\nFreight\t12\t12\n");
const TWO_SCALES = report("厂区\t产量（万吨）\t库存（吨）\n一厂\t54\t12\n二厂\t31\t31\n");
const TWO_SCALES_APART = report("厂区\t产量（万吨）\t库存（吨）\n一厂\t54\t12\n二厂\t31\t30\n");

const linesOf = (given: string, figure: string) =>
  [
    ["en", `The Document gives ${given}, not ${figure}.`],
    ["zh-CN", `文档写的是 ${given}，不是 ${figure}。`],
  ] as const;

describe("A label's unit reads as a sentence writes it (#2997)", { timeout: 120_000 }, () => {
  // protects=the same characters are the same scale and unit in a label and in a sentence, so a right sentence under a label whose unit begins with 千 (千克, 千米, 千瓦, 千瓦时, 千伏, 千帕), under a rate label (万吨/年, 万桶/日), or in a unit that spells the label's scale (31 kt under "thousand tonnes") reads as on main in an Answer and in Check against Documents, in English and Chinese; fails_when="B重量为31千克。" under 重量（千克） or "一期产能为500万吨/年。" under 产能（万吨/年） reads Unsupported in either check; no_claim=a sentence in another unit of the measure that would need converting (31吨 under 千克, 31 miles under km), which passes as on main.
  test.each([
    ["重量（千克）", KILOGRAMS, "B重量为31千克。", "B\t31", "found"],
    ["重量（千克）", KILOGRAMS, "B重量为31公斤。", "B\t31", "not-checked"],
    ["重量（千克）", KILOGRAMS, "B重量为31kg。", "B\t31", "not-checked"],
    ["各项数值（千克）", KILOGRAM_ROWS, "B的数值为31千克。", "B: 31", "not-checked"],
    ["数值（千米）", underOneHeading("千米"), "B的数值为31千米。", "B\t31", "found"],
    ["数值（千米/小时）", underOneHeading("千米/小时"), "B的数值为31千米/小时。", "B\t31", "found"],
    ["数值（千瓦时）", underOneHeading("千瓦时"), "B的数值为31千瓦时。", "B\t31", "found"],
    ["数值（千瓦）", underOneHeading("千瓦"), "B的数值为31千瓦。", "B\t31", "found"],
    ["数值（千伏）", underOneHeading("千伏"), "B的数值为31千伏。", "B\t31", "found"],
    ["数值（千帕）", underOneHeading("千帕"), "B的数值为31千帕。", "B\t31", "found"],
    ["产能（万吨/年）", PER_YEAR, "一期产能为500万吨/年。", "一期\t500", "found"],
    ["产能（万吨/年）", PER_YEAR, "一期产能为每年500万吨。", "一期\t500", "found"],
    ["产能（万吨/年）", PER_YEAR, "一期年产能500万吨。", "一期\t500", "found"],
    ["产能（万吨/年）", PER_YEAR, "一期产能为500万吨。", "一期\t500", "found"],
    ["数值（万桶/日）", underOneHeading("万桶/日"), "B的数值为31万桶/日。", "B\t31", "found"],
    ["数值（万桶/日）", underOneHeading("万桶/日"), "B的数值为日均31万桶。", "B\t31", "found"],
    [
      "Output (thousand tonnes)",
      THOUSAND_TONNES,
      "Mill B's output was 31 kt.",
      "B\t31",
      "not-checked",
    ],
    [
      "Output (thousand tonnes)",
      THOUSAND_TONNES,
      "Mill B's output was 31 thousand tonnes.",
      "B\t31",
      "found",
    ],
  ] as const)("under %s, %s reads as on main", async (_, file, sentence, quote, check) => {
    for (const language of ["en", "zh-CN"] as const) {
      expect(await judged(sentence, quote, file, language), language).toEqual({
        answer: { check, verdict: null },
        document: { verdict: "supported", reason: null },
      });
    }
  });

  // protects=a sentence at another scale than its number's label is Unsupported with the label's line in both checks and both languages, whether the scale is a word (31万千克 under 千克, 500亿吨 under 万吨/年) or spelled in the unit (31克 under 千克, 31瓦时 under 千瓦时, 31千瓦 under 兆瓦, 31 Mt under "thousand tonnes", 31 tonnes under "kt"); fails_when=any of them keeps its ✓ or reads Supported; no_claim=a unit the reader reads no figure in (31帕 under 千帕).
  test.each([
    ["重量（千克）", KILOGRAMS, "B重量为31克。", "B\t31", "31（千克）", "31克"],
    ["重量（千克）", KILOGRAMS, "B重量为31万千克。", "B\t31", "31", "31万千克"],
    ["各项数值（千克）", KILOGRAM_ROWS, "B的数值为31克。", "B: 31", "31（千克）", "31克"],
    ["数值（千米）", underOneHeading("千米"), "B的数值为31米。", "B\t31", "31（千米）", "31米"],
    [
      "数值（千瓦时）",
      underOneHeading("千瓦时"),
      "B的数值为31瓦时。",
      "B\t31",
      "31（千瓦时）",
      "31瓦时",
    ],
    [
      "数值（千瓦时）",
      underOneHeading("千瓦时"),
      "B的数值为31万千瓦时。",
      "B\t31",
      "31",
      "31万千瓦时",
    ],
    ["数值（千瓦）", underOneHeading("千瓦"), "B的数值为31瓦。", "B\t31", "31（千瓦）", "31瓦"],
    ["数值（兆瓦）", underOneHeading("兆瓦"), "B的数值为31千瓦。", "B\t31", "31（兆瓦）", "31千瓦"],
    ["产能（万吨/年）", PER_YEAR, "一期产能为500吨。", "一期\t500", "500（万吨/年）", "500吨"],
    ["产能（万吨/年）", PER_YEAR, "一期产能为500亿吨。", "一期\t500", "500", "500亿吨"],
    [
      "数值（万桶/日）",
      underOneHeading("万桶/日"),
      "B的数值为31桶/日。",
      "B\t31",
      "31（万桶/日）",
      "31桶",
    ],
    [
      "Output (thousand tonnes)",
      THOUSAND_TONNES,
      "Mill B's output was 31 Mt.",
      "B\t31",
      "31 thousand tonnes",
      "31 Mt",
    ],
    ["Output (kt)", KILOTONNES, "Mill B's output was 31 tonnes.", "B\t31", "31 (kt)", "31 tonnes"],
  ] as const)("under %s, %s is Unsupported", async (_, file, sentence, quote, given, figure) => {
    for (const [language, reason] of linesOf(given, figure)) {
      expect(await judged(sentence, quote, file, language), language).toEqual({
        answer: { check: "unsupported", verdict: reason },
        document: { verdict: "unsupported", reason },
      });
    }
  });
});

describe("Of two numbers written the same, a label states a unit only for its own (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=in an Answer a label over another column, of another measure or a share, states nothing for the sentence's figure, so the sentence keeps the model's ✓ while Check against Documents reads it as on main, in English and Chinese; fails_when="二厂产量为31万吨。" loses its ✓ in the Answer because the same 31 stands under 同比（%） or 人数（人）, or "Freight revenue was $12 million." because 12 stands under Margin (%); no_claim=a number whose every like-written number carries such a label, which stays Unsupported (the kilowatt-hour heading above).
  test.each([
    [
      "同比（%） in the next column",
      BESIDE_A_SHARE,
      "二厂产量为31万吨。",
      "二厂\t31\t31",
      "31",
      "31万吨",
    ],
    [
      "人数（人） in the next column",
      BESIDE_A_COUNT,
      "二厂产量为31万吨。",
      "二厂\t31\t31",
      "31",
      "31万吨",
    ],
    [
      "人数（人） in the next column",
      BESIDE_A_COUNT,
      "二厂产量为31吨。",
      "二厂\t31\t31",
      "31",
      "31吨",
    ],
    [
      "Margin (%) in the next column",
      BESIDE_A_MARGIN,
      "Freight revenue was $12 million.",
      "Freight\t12\t12",
      "12",
      "$12 million",
    ],
  ] as const)(
    "with %s, %s keeps the model's ✓ in the Answer",
    async (_, file, sentence, quote, given, figure) => {
      for (const [language, reason] of linesOf(given, figure)) {
        expect(await judged(sentence, quote, file, language), language).toEqual({
          answer: { check: "found", verdict: null },
          document: { verdict: "unsupported", reason },
        });
      }
    },
  );

  // protects=a label fixes a scale against the sentence only when no number written the same has a label that gives the sentence's scale, in both checks and both languages; fails_when="二厂库存为31吨。" reads Unsupported for 产量（万吨） though the same 31 stands under 库存（吨）, or "二厂产量为31吨。" keeps its ✓ when the stock column holds 30; no_claim=which of the two numbers a sentence reads, so "二厂库存为31万吨。" passes here.
  test.each([
    ["产量（万吨） beside 库存（吨）", TWO_SCALES, "二厂库存为31吨。", "二厂\t31\t31"],
    [
      "产量（万吨） beside 库存（吨）",
      TWO_SCALES,
      "二厂产量为31万吨，库存为31吨。",
      "二厂\t31\t31",
    ],
    ["产量（万吨） beside 库存（吨）", TWO_SCALES, "二厂产量为31万吨。", "二厂\t31\t31"],
  ] as const)("under %s, %s keeps its ✓", async (_, file, sentence, quote) => {
    for (const language of ["en", "zh-CN"] as const) {
      expect(await judged(sentence, quote, file, language), language).toEqual({
        answer: { check: "found", verdict: null },
        document: { verdict: "supported", reason: null },
      });
    }
  });

  test("二厂产量为31吨。 is Unsupported when no other 31 stands under a label in tonnes", async () => {
    for (const [language, reason] of linesOf("31（万吨）", "31吨")) {
      expect(
        await judged("二厂产量为31吨。", "二厂\t31\t30", TWO_SCALES_APART, language),
        language,
      ).toEqual({
        answer: { check: "unsupported", verdict: reason },
        document: { verdict: "unsupported", reason },
      });
    }
  });
});
