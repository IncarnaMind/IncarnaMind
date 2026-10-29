/**
 * A sentence with a figure that the Documents contradict is Contradicted (#2184): the figure step
 * can only make the sentence's own verdict stricter, never weaker, and a figure its quote doesn't
 * hold is no reason to ask the model again. The replies are those Claude Haiku 5.5 and Sonnet 5.5
 * wrote for the agreements of `eval/repeats` (en-conflicts, zh-conflicts).
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, isCheckRun, requestedFigures, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const AGREEMENT = {
  name: "Staff flat and salary - T. Okoro.md",
  contents: [
    "# Staff flat and salary",
    "",
    "Between Larkfield Provisions Ltd (the Company) and Tunde Okoro (the Employee).",
    "",
    "The salary is 61,500 per year, paid monthly in arrears on the last working day of the month.",
    "",
    "The Company lets the flat at 14 Mill Lane to the Employee: the Company is the landlord and the Employee the tenant.",
    "",
    "The Employee pays the Company a rent of 950 per month.",
    "",
  ].join("\n"),
};

const CONTRACT = {
  name: "劳动合同及宿舍协议 - 林晓.md",
  contents: [
    "# 劳动合同及宿舍协议",
    "",
    "甲方：明川食品有限公司　乙方：林晓",
    "",
    "第二条　劳动报酬：乙方月工资为人民币一万八千元，于每月最后一个工作日发放。",
    "",
    "第三条　员工宿舍：甲方将明川路14号2室出租给乙方，甲方为出租方，乙方为承租方。",
    "",
    "乙方每月向甲方支付租金人民币一千五百元。",
    "",
  ].join("\n"),
};

/** How the model checks one sentence: its quote, its verdict lines and each figure's item. */
interface Reply {
  quote: string;
  lines: string;
  item: Record<string, unknown>;
  remainder?: Record<string, unknown> | null;
}

/** What a model asked to rewrite its Figures line about a number its quote lacks wrote back. */
const CANT_REWRITE =
  'I can\'t rewrite that Figures entry, because the cited quote has no number "14" for it to point to.';

const contradicted = { verdict: "contradicted", scope: "same", topic: "found", roles: "same" };

const CASES: Record<string, Reply> = {
  // The address's "14" isn't in the quote the model recorded, and its remainder copies the
  // whole sentence, number and all.
  "The Employee is the landlord of the flat at 14 Mill Lane and the Company the tenant.": {
    quote: "the Company is the landlord and the Employee the tenant",
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: the Employee is the landlord, the Company the tenant / the Company is the landlord and the Employee the tenant, differs",
      "The Document says the Company is the landlord of the flat and the Employee the tenant, the reverse of the sentence [^1].",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "14", reading: null, unitQuote: null },
    },
    remainder: {
      ...contradicted,
      roles: "differs",
      text: "The Employee is the landlord of the flat at 14 Mill Lane and the Company the tenant.",
      says: "The Company is the landlord and the Employee the tenant.",
      citation: 1,
    },
  },
  // The sentence's own wrong figure named as the source, which its quote doesn't hold.
  "乙方月工资为人民币两万元。": {
    quote: "乙方月工资为人民币一万八千元",
    lines: [
      "Verdict: contradicted",
      "Scope: 乙方, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元，不是两万元[^1]。",
    ].join("\n"),
    item: { ...contradicted, source: { citation: 1, number: "两万", reading: null } },
  },
  // The parties the other way round, the rent the same.
  "The Company pays the Employee a rent of 950 per month for the flat.": {
    quote: "The Employee pays the Company a rent of 950 per month.",
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: the Company pays the Employee / the Employee pays the Company, differs",
      "The flat agreement says the Employee pays the Company a rent of 950 per month [^1].",
    ].join("\n"),
    item: {
      ...contradicted,
      roles: "differs",
      says: "The Employee pays the Company, not the Company the Employee.",
      source: { citation: 1, number: "950", reading: null, unitQuote: null },
    },
  },
  "乙方将明川路14号2室出租给甲方。": {
    quote: "甲方将明川路14号2室出租给乙方，甲方为出租方，乙方为承租方。",
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: 乙方 lets to 甲方 / 甲方 lets to 乙方, differs",
      "协议写明甲方将明川路14号2室出租给乙方，与该句的双方相反[^1]。",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "2", reading: null, unitQuote: null },
    },
  },
  // The figure the Document states, for another period.
  "The salary is 61,500 per month.": {
    quote: "The salary is 61,500 per year",
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "The agreement gives the salary as 61,500 per year, not per month [^1].",
    ].join("\n"),
    // Its comma may be a decimal point, so the model names its reading, as the request offers.
    item: {
      ...contradicted,
      reading: 1,
      says: "The salary is 61,500 per year, not per month.",
      source: { citation: 1, number: "61,500", reading: null, unitQuote: null },
    },
  },
  // 一万八千 is 两万 at the figure's own shown precision, which is a figure's rounding, not the
  // sentence's: it says the salary is twenty thousand.
  "乙方的月工资是人民币两万元。": {
    quote: "乙方月工资为人民币一万八千元",
    lines: [
      "Verdict: contradicted",
      "Scope: 乙方, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元，不是两万元[^1]。",
    ].join("\n"),
    item: { ...contradicted, source: { citation: 1, number: "一万八千", reading: null } },
  },
};

/** The asks a check makes about a reply's Figures line, as their notes start. */
const ASKS = ["can't be read", "you call it contradicted", "gives no remainder", "no Figures line"];

function replying(calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      calls.push(call);
      const sentence = sentenceOf(call);
      const planned = CASES[sentence];
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (!planned || searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: sentence } }] };
      const shown = shownPassages(searches.at(-1)?.text ?? "");
      const passage = shown.find((each) => each.text.includes(planned.quote));
      if (!passage) return { text: "Verdict: unsupported" };
      if (!call.results.some((result) => result.tool === "cite"))
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: planned.quote }] },
            },
          ],
        };
      if (ASKS.some((ask) => call.prompt.includes(ask))) return { text: CANT_REWRITE };
      const items = requestedFigures(call).map(({ id }) => ({
        id,
        says: null,
        reading: null,
        relation: "equals",
        calculation: null,
        ...planned.item,
      }));
      const figures = { items, remainder: planned.remainder ?? null };
      return { text: `${planned.lines}\n\nFigures: ${JSON.stringify(figures)}` };
    },
    { generate: checkGenerate({}) },
  );
}

const paragraph = (id: string, value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: value }],
});

async function checkSentence(sentence: string) {
  const calls: ModelCall[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(replying(calls)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, AGREEMENT.name, AGREEMENT.contents),
    await writeSourceFile(sources, CONTRACT.name, CONTRACT.contents),
  ]);
  const mind = await core.createMind({ title: "Agreement points" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [paragraph("point", sentence)]);
  await client.settled();
  await core.checkSentences({
    requestId: "check",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "point", offset: 0 },
    to: { blockId: "point", offset: sentence.length },
  });
  await client.settled();
  const span = claimSpans(readMind(client)).find((each) => each.sentence.text.trim() === sentence);
  const asked = calls.filter((call) => ASKS.some((ask) => call.prompt.includes(ask)));
  core.close();
  return { check: span?.check, asked };
}

interface Expected {
  sentence: string;
  /** Each figure's own result, which the sentence's verdict never overrides. */
  figures: string[];
  /** The asks about the reply's Figures line: never more than one. */
  asks: number;
}

async function expectContradicted({ sentence, figures, asks }: Expected) {
  const { check, asked } = await checkSentence(sentence);
  expect(check).toMatchObject({
    state: "contradicted",
    evidence: { quote: CASES[sentence]?.quote },
  });
  expect(check?.figures?.map((figure) => figure.state)).toEqual(figures);
  expect(asked).toHaveLength(asks);
}

describe("a sentence whose figure the Documents contradict is Contradicted (#2184)", () => {
  test.each<Expected>([
    // Asked once for the address's number, the model wrote prose: the reply before stands.
    {
      sentence:
        "The Employee is the landlord of the flat at 14 Mill Lane and the Company the tenant.",
      figures: ["not-checked"],
      asks: 1,
    },
    { sentence: "乙方月工资为人民币两万元。", figures: ["unsupported"], asks: 0 },
  ])("a figure no quote holds: $sentence", expectContradicted);

  test.each<Expected>([
    {
      sentence: "The Company pays the Employee a rent of 950 per month for the flat.",
      figures: ["unsupported"],
      asks: 0,
    },
    // The figure is the Document's own; only the parties are the other way round.
    { sentence: "乙方将明川路14号2室出租给甲方。", figures: ["supported"], asks: 0 },
  ])("the parties swapped, the figure the same: $sentence", expectContradicted);

  test.each<Expected>([
    { sentence: "The salary is 61,500 per month.", figures: ["not-checked"], asks: 1 },
    { sentence: "乙方的月工资是人民币两万元。", figures: ["unsupported"], asks: 0 },
  ])(
    "the Document's own figure for another period, or one at its own rounding: $sentence",
    expectContradicted,
  );
});
