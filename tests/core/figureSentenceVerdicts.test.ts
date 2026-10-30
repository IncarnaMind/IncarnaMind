/**
 * A sentence with a figure that the Documents contradict is Contradicted (#2184): the figure step
 * can only make the sentence's own verdict stricter, never weaker, and a figure its quote doesn't
 * hold is no reason to ask the model again. The replies are those Claude Haiku 5.5 and Sonnet 5.5
 * wrote for the agreements of `eval/repeats` (en-conflicts, zh-conflicts).
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  checkGenerate,
  isCheckRun,
  type Plan,
  requestedFigures,
  sentenceOf,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

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

/**
 * How the model checks one sentence: the quotes it records, as markers 1, 2, …, its verdict
 * lines, each figure's item, and how the contradiction's two judgements come out.
 */
interface Reply {
  quotes: string[];
  lines: string;
  item: Record<string, unknown>;
  remainder?: Record<string, unknown> | null;
  judgement?: Plan["judgement"];
  /** Asked about its Figures line, it writes that line again with this item, and nothing else. */
  repair?: Record<string, unknown>;
  /** Asked about its Figures line with no `repair`, what it writes instead; `CANT_REWRITE` when absent. */
  prose?: string;
  /** Its Figures line leaves the remainder out, so a Supported reply is asked for it. */
  omitsRemainder?: boolean;
  /** It never calls cite, and writes its record into the reply instead, as Claude Haiku 5.5 did. */
  neverCites?: boolean;
}

/** What a model asked to rewrite its Figures line about a number its quote lacks wrote back. */
const CANT_REWRITE =
  'I can\'t rewrite that Figures entry, because the cited quote has no number "14" for it to point to.';

const contradicted = { verdict: "contradicted", scope: "same", topic: "found", roles: "same" };

const SALARY =
  "The salary is 61,500 per year, paid monthly in arrears on the last working day of the month.";

const SUPPORTED_SALARY = {
  verdict: "supported",
  scope: "same",
  topic: "found",
  roles: "same",
  reading: 1,
  source: { citation: 1, number: "61,500", reading: null, unitQuote: null },
};

const RENT = "The Employee pays the Company a rent of 950 per month.";
const RENT_ZH = "乙方每月向甲方支付租金人民币一千五百元。";
const SALARY_ZH = "乙方月工资为人民币一万八千元";

/** The record a model that never calls cite writes into its reply instead. */
const writtenRecord = (quote: string) =>
  `cite\n${JSON.stringify([{ marker: 1, passage: "P1", location: "p. 1", quote }])}`;

/** The shapes of Claude Haiku 5.5's replies in the real-model run of #2184 that a check misread. */
const SHAPES: Record<string, Reply> = {
  // A contradiction whose quote was never recorded: its reply cites [^1], which no cite call made.
  "Every month the Company pays the Employee a rent of 950.": {
    quotes: [RENT],
    neverCites: true,
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
      source: { citation: 1, number: "950", reading: null, unitQuote: null },
    },
  },
  "乙方年工资为人民币一万八千元。": {
    quotes: [SALARY_ZH],
    neverCites: true,
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元，而非年工资[^1]。",
    ].join("\n"),
    item: { ...contradicted, source: { citation: 1, number: "一万八千", reading: null } },
  },
  // A first verdict, then a correction and the verdict that supersedes it, the record written out.
  "甲方每月向乙方支付租金人民币一千五百元。": {
    quotes: [RENT_ZH],
    neverCites: true,
    lines: [
      "Verdict: supported",
      "Scope: none, same",
      "Topic: found",
      "Roles: 甲方 pays 乙方 / 甲方 pays 乙方, same",
      "",
      "Wait — the Document says 乙方 pays 甲方, the reverse of the sentence. Let me correct that verdict.",
      "",
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: 甲方向乙方支付 / 乙方向甲方支付, differs",
      "协议写明乙方每月向甲方支付租金人民币一千五百元，付款方向与该句相反[^1]。",
      "",
      writtenRecord(RENT_ZH),
    ].join("\n"),
    item: {
      ...contradicted,
      roles: "differs",
      source: { citation: 1, number: "一千五百", reading: null, unitQuote: null },
    },
  },
  "The salary is 61,500 a year.": {
    quotes: [SALARY],
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "",
      "Correction to the verdict above: the agreement gives the very same salary, so the sentence is supported.",
      "",
      "Verdict: supported",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "The agreement says the salary is 61,500 per year [^1].",
    ].join("\n"),
    item: SUPPORTED_SALARY,
  },
  // The reasoning first, then the verdict and its fields, and the Figures line straight after.
  "The Company pays the Employee 950 per month in rent.": {
    quotes: [RENT],
    lines: [
      "The flat agreement says the Employee pays the Company a rent of 950 per month: the parties are the other way round [^1].",
      "",
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: the Company pays the Employee / the Employee pays the Company, differs",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "950", reading: null, unitQuote: null },
    },
  },
  "甲方每月向乙方支付人民币一千五百元租金。": {
    quotes: [RENT_ZH],
    lines: [
      "协议写明乙方每月向甲方支付租金人民币一千五百元，付款方向与该句相反[^1]。",
      "",
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: 甲方向乙方支付 / 乙方向甲方支付, differs",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "一千五百", reading: null, unitQuote: null },
    },
  },
  // A verdict whose own words say what the Documents can't show, in words a refusal also uses.
  "The salary is 65,000 per year, paid monthly.": {
    quotes: [SALARY],
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "I am unable to find 65,000 in the agreement: it gives the salary as 61,500 per year [^1].",
    ].join("\n"),
    item: {
      ...contradicted,
      reading: 1,
      source: { citation: 1, number: "61,500", reading: null, unitQuote: null },
    },
  },
  "乙方月薪为人民币两万元。": {
    quotes: [SALARY_ZH],
    lines: [
      "Verdict: contradicted",
      "Scope: 乙方, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元，两万元无法核对[^1]。",
    ].join("\n"),
    item: { ...contradicted, source: { citation: 1, number: "一万八千", reading: null } },
  },
  // Asked about a number its quote lacks, it declines in a refusal's words: the reply asked about stands.
  "The Employee is the landlord of the flat at 14 Mill Lane, and the Company is the tenant.": {
    quotes: ["the Company is the landlord and the Employee the tenant"],
    prose: "I'm sorry, I can't do that: the cited quote has no number \"14\" for it to point to.",
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: the Employee is the landlord / the Company is the landlord, differs",
      "The Document says the Company is the landlord of the flat and the Employee the tenant [^1].",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "14", reading: null, unitQuote: null },
    },
  },
  // The Document's figure quoted in another notation or unit than the sentence's.
  "乙方月工资为人民币2万元。": {
    quotes: [SALARY_ZH],
    lines: [
      "Verdict: contradicted",
      "Scope: 乙方, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元，不是2万元[^1]。",
    ].join("\n"),
    item: { ...contradicted, source: { citation: 1, number: "18,000", reading: null } },
  },
  "The salary is £65,000 per year.": {
    quotes: [SALARY],
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "The agreement gives the salary as 61,500 per year, not £65,000 [^1].",
    ].join("\n"),
    item: {
      ...contradicted,
      reading: 1,
      source: { citation: 1, number: "61,500", reading: null, unitQuote: null },
    },
  },
};

/** Asked for its remainder, it writes its verdict again with no Figures line. */
const VERDICT_AGAIN: Record<string, Reply> = {
  "The Company pays the Employee 950 a month for the flat.": {
    quotes: [RENT],
    omitsRemainder: true,
    lines: [
      "Verdict: supported",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "The flat agreement gives the rent as 950 per month [^1].",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "950", reading: null, unitQuote: null },
    },
    prose: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: the Company pays the Employee / the Employee pays the Company, differs",
      "The flat agreement says the Employee pays the Company the rent, the reverse of the sentence [^1].",
    ].join("\n"),
  },
  "甲方每月向乙方支付一千五百元租金。": {
    quotes: [RENT_ZH],
    omitsRemainder: true,
    lines: [
      "Verdict: supported",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "协议写明每月租金为人民币一千五百元[^1]。",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "一千五百", reading: null, unitQuote: null },
    },
    prose: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: 甲方向乙方支付 / 乙方向甲方支付, differs",
      "协议写明乙方每月向甲方支付租金，付款方向与该句相反[^1]。",
    ].join("\n"),
  },
  // Its figure is wrong though it calls it supported, twice: the figure's own comparison decides.
  "The salary is 62,000 per year.": {
    quotes: [SALARY],
    omitsRemainder: true,
    lines: [
      "Verdict: supported",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "The agreement says the salary is 61,500 per year [^1].",
    ].join("\n"),
    item: SUPPORTED_SALARY,
    prose: [
      "Verdict: supported",
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "The agreement says the salary is 61,500 per year [^1].",
    ].join("\n"),
  },
  "乙方月工资为人民币两万五千元。": {
    quotes: [SALARY_ZH],
    omitsRemainder: true,
    lines: [
      "Verdict: supported",
      "Scope: 乙方, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元[^1]。",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "一万八千", reading: null },
    },
    prose: [
      "Verdict: supported",
      "Scope: 乙方, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元[^1]。",
    ].join("\n"),
  },
};

const CASES: Record<string, Reply> = {
  ...VERDICT_AGAIN,
  // The address's "14" isn't in the quote the model recorded, and its remainder copies the
  // whole sentence, number and all.
  "The Employee is the landlord of the flat at 14 Mill Lane and the Company the tenant.": {
    quotes: ["the Company is the landlord and the Employee the tenant"],
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
    quotes: ["乙方月工资为人民币一万八千元"],
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
    quotes: ["The Employee pays the Company a rent of 950 per month."],
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
    quotes: ["甲方将明川路14号2室出租给乙方，甲方为出租方，乙方为承租方。"],
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
    quotes: ["The salary is 61,500 per year"],
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
    quotes: ["乙方月工资为人民币一万八千元"],
    lines: [
      "Verdict: contradicted",
      "Scope: 乙方, same",
      "Topic: found",
      "Roles: none, same",
      "劳动合同写明乙方月工资为人民币一万八千元，不是两万元[^1]。",
    ].join("\n"),
    item: { ...contradicted, source: { citation: 1, number: "一万八千", reading: null } },
  },
  // The figure's quote backs the figure; the sentence's own quote, under another marker, the
  // parties the other way round.
  "The Company pays the Employee a rent of 950 per month.": {
    quotes: ["a rent of 950 per month", "The Employee pays the Company"],
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: the Company pays the Employee / the Employee pays the Company, differs",
      "The flat agreement says the Employee pays the Company, not the Company the Employee [^2].",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "950", reading: null, unitQuote: null },
    },
  },
  // Asked about a number its quote doesn't hold, the model writes only its Figures line again.
  "The Company pays the Employee a monthly rent of 950.": {
    quotes: ["The Employee pays the Company a rent of 950 per month."],
    lines: [
      "Verdict: contradicted",
      "Scope: none, same",
      "Topic: found",
      "Roles: the Company pays the Employee / the Employee pays the Company, differs",
      "The flat agreement says the Employee pays the Company the rent [^1].",
    ].join("\n"),
    item: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "9,500", reading: null, unitQuote: null },
    },
    repair: {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      source: { citation: 1, number: "950", reading: null, unitQuote: null },
    },
  },
  ...SHAPES,
  ...Object.fromEntries(
    (
      [
        ["The salary is 61,500 per year, paid monthly in arrears.", "supported", "conflict", []],
        ["The salary is 61,500 per year, paid weekly.", "contradicted", "conflict", []],
        [
          "The salary is 61,500 per year, paid in two parts.",
          "contradicted",
          "same",
          ["Covered: the salary of 61,500 per year", "Not covered: payment in two parts"],
        ],
        [
          "The salary is 61,500 per year, paid by the parent company.",
          "unsupported",
          "conflict",
          [],
        ],
      ] as const
    ).map(([sentence, verdict, judgement, parts]): [string, Reply] => [
      sentence,
      {
        quotes: [SALARY],
        lines: [
          `Verdict: ${verdict}`,
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "The agreement says the salary is 61,500 per year, paid monthly in arrears [^1].",
          ...parts,
        ].join("\n"),
        // Its comma may be a decimal point, so the model names its reading, as the request offers.
        item: SUPPORTED_SALARY,
        judgement,
      },
    ]),
  ),
};

/** The asks a check makes about a reply's Figures line, as their notes start. */
const ASKS = ["can't be read", "you call it contradicted", "gives no remainder", "no Figures line"];

function replying(calls: ModelCall[], judged: GenerateCall[], evidence: GenerateCall[]) {
  const plans = Object.fromEntries(
    Object.entries(CASES).map(([sentence, { judgement }]) => [sentence, { judgement }]),
  );
  const generate = checkGenerate(plans);
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
      const passages = planned.quotes.map((quote) =>
        shown.find((each) => each.text.includes(quote)),
      );
      if (passages.some((passage) => !passage)) return { text: "Verdict: unsupported" };
      if (!planned.neverCites && !call.results.some((result) => result.tool === "cite"))
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: planned.quotes.map((quote, index) => ({
                  marker: index + 1,
                  passage: passages[index]?.id,
                  quote,
                })),
              },
            },
          ],
        };
      const asked = ASKS.some((ask) => call.prompt.includes(ask));
      if (asked && !planned.repair) return { text: planned.prose ?? CANT_REWRITE };
      const items = requestedFigures(call).map(({ id }) => ({
        id,
        says: null,
        reading: null,
        relation: "equals",
        calculation: null,
        ...(asked ? planned.repair : planned.item),
      }));
      const line = planned.omitsRemainder
        ? { items }
        : { items, remainder: planned.remainder ?? null };
      const figures = `Figures: ${JSON.stringify(line)}`;
      return { text: asked ? figures : `${planned.lines}\n\n${figures}` };
    },
    {
      generate(call) {
        if (call.system.startsWith("Compare a sentence")) judged.push(call);
        if (call.system.startsWith("You checked a sentence")) {
          evidence.push(call);
          const quote =
            CASES[/<sentence>\n(.*)\n<\/sentence>/.exec(call.prompt)?.[1] ?? ""]?.quotes[0];
          const passage = [
            ...call.prompt.matchAll(/<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g),
          ].find((each) => quote && each[2]?.includes(quote));
          return {
            text: JSON.stringify(
              passage ? { passage: passage[1], location: "p. 1", quote } : { passage: null },
            ),
          };
        }
        return generate(call);
      },
    },
  );
}

const paragraph = (id: string, value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: value }],
});

async function checkSentence(sentence: string) {
  const calls: ModelCall[] = [];
  const judged: GenerateCall[] = [];
  const evidence: GenerateCall[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(replying(calls, judged, evidence)).createChatModel,
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
  return { check: span?.check, asked, judged, evidence };
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
    evidence: { quote: CASES[sentence]?.quotes[0] },
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
    // Its reply to the ask gives only the Figures line: the verdict before it stands.
    {
      sentence: "The Company pays the Employee a monthly rent of 950.",
      figures: ["supported"],
      asks: 1,
    },
  ])("the parties swapped, the figure the same: $sentence", expectContradicted);

  test.each<Expected>([
    { sentence: "The salary is 61,500 per month.", figures: ["not-checked"], asks: 1 },
    // 人民币一万八千元 states its currency, so the figure is compared, agrees at its shown precision,
    // and is called contradicted: a figure in doubt.
    { sentence: "乙方的月工资是人民币两万元。", figures: ["not-checked"], asks: 0 },
  ])(
    "the Document's own figure for another period, or one at its own rounding: $sentence",
    expectContradicted,
  );

  test("the sentence's contradiction is judged on the quote its own sentence names, not the figure's", async () => {
    const sentence = "The Company pays the Employee a rent of 950 per month.";
    const { check, judged } = await checkSentence(sentence);
    expect(check).toMatchObject({
      state: "contradicted",
      evidence: { quote: "The Employee pays the Company" },
    });
    expect(check?.figures?.map((figure) => figure.state)).toEqual(["supported"]);
    expect(judged.map((call) => /<quote>\n(.*)\n<\/quote>/.exec(call.prompt)?.[1])).toEqual([
      "The Employee pays the Company",
      "The Employee pays the Company",
    ]);
  });
});

interface Verdict {
  sentence: string;
  shown: string;
  judgements: number;
  card?: Record<string, unknown>;
}

test.each<Verdict>([
  {
    sentence: "The salary is 61,500 per year, paid monthly in arrears.",
    shown: "supported",
    judgements: 0,
  },
  { sentence: "The salary is 61,500 per year, paid weekly.", shown: "contradicted", judgements: 2 },
  // The judgements don't uphold the contradiction: never Supported, though its figure is, and
  // the card quotes the part the agreement states, as for a sentence without figures.
  {
    sentence: "The salary is 61,500 per year, paid in two parts.",
    shown: "unsupported",
    judgements: 1,
    card: {
      covered: "the salary of 61,500 per year",
      uncovered: "payment in two parts",
      found: true,
      quoted: { quote: SALARY },
    },
  },
  {
    sentence: "The salary is 61,500 per year, paid by the parent company.",
    shown: "unsupported",
    judgements: 0,
  },
])(
  "a Supported figure never weakens the check's own verdict on the sentence: $sentence (#2184)",
  async ({ sentence, shown, judgements, card }: Verdict) => {
    const { check, judged } = await checkSentence(sentence);
    expect(check?.state).toBe(shown);
    if (card) expect(check?.unsupported).toMatchObject(card);
    expect(check?.figures?.map((figure) => figure.state)).toEqual(["supported"]);
    expect(judged).toHaveLength(judgements);
  },
);

interface Shape {
  sentence: string;
  state: string;
  figures: string[];
  /** The asks about the reply's Figures line. */
  asks: number;
  /** The requests for the deciding quote once the Run has ended, as for a sentence without figures. */
  evidence: number;
}

describe("Claude Haiku 5.5's replies: its last verdict counts, a quote it never recorded is asked for, and only a reply with no verdict is a refusal (#2184)", () => {
  test.each<Shape>([
    {
      sentence: "Every month the Company pays the Employee a rent of 950.",
      state: "contradicted",
      figures: ["unsupported"],
      asks: 0,
      evidence: 1,
    },
    {
      sentence: "乙方年工资为人民币一万八千元。",
      state: "contradicted",
      figures: ["unsupported"],
      asks: 0,
      evidence: 1,
    },
    {
      sentence: "甲方每月向乙方支付租金人民币一千五百元。",
      state: "contradicted",
      figures: ["unsupported"],
      asks: 0,
      evidence: 1,
    },
    {
      sentence: "The salary is 61,500 a year.",
      state: "supported",
      figures: ["supported"],
      asks: 0,
      evidence: 0,
    },
    {
      sentence: "The Company pays the Employee 950 per month in rent.",
      state: "contradicted",
      figures: ["supported"],
      asks: 0,
      evidence: 0,
    },
    {
      sentence: "甲方每月向乙方支付人民币一千五百元租金。",
      state: "contradicted",
      figures: ["supported"],
      asks: 0,
      evidence: 0,
    },
    {
      sentence: "The salary is 65,000 per year, paid monthly.",
      state: "contradicted",
      figures: ["contradicted"],
      asks: 0,
      evidence: 0,
    },
    {
      sentence: "乙方月薪为人民币两万元。",
      state: "contradicted",
      figures: ["not-checked"],
      asks: 0,
      evidence: 0,
    },
    {
      sentence:
        "The Employee is the landlord of the flat at 14 Mill Lane, and the Company is the tenant.",
      state: "contradicted",
      figures: ["not-checked"],
      asks: 1,
      evidence: 0,
    },
    {
      sentence: "乙方月工资为人民币2万元。",
      state: "contradicted",
      figures: ["unsupported"],
      asks: 0,
      evidence: 0,
    },
    {
      sentence: "The salary is £65,000 per year.",
      state: "contradicted",
      figures: ["unsupported"],
      asks: 0,
      evidence: 0,
    },
  ])("$sentence", async ({ sentence, state, figures, asks, evidence }) => {
    const checked = await checkSentence(sentence);
    expect(checked.check).toMatchObject({
      state,
      evidence: { quote: CASES[sentence]?.quotes[0] },
    });
    // The Figures line is the reply's protocol, never what the Document says.
    expect(checked.check?.says ?? "").not.toMatch(/Figures|"items"/);
    expect(checked.check?.figures?.map((figure) => figure.state)).toEqual(figures);
    expect(checked.asked).toHaveLength(asks);
    expect(checked.evidence).toHaveLength(evidence);
  });
});

test.each<Shape>([
  {
    sentence: "The Company pays the Employee 950 a month for the flat.",
    state: "contradicted",
    figures: ["supported"],
    asks: 1,
    evidence: 0,
  },
  {
    sentence: "甲方每月向乙方支付一千五百元租金。",
    state: "contradicted",
    figures: ["supported"],
    asks: 1,
    evidence: 0,
  },
  {
    sentence: "The salary is 62,000 per year.",
    state: "contradicted",
    figures: ["contradicted"],
    asks: 1,
    evidence: 0,
  },
  {
    sentence: "乙方月工资为人民币两万五千元。",
    state: "contradicted",
    figures: ["contradicted"],
    asks: 1,
    evidence: 0,
  },
])(
  "asked for its remainder, a reply that gives its verdict again without a Figures line keeps the figures of the reply asked about: $sentence (#2184)",
  async ({ sentence, state, figures, asks, evidence }) => {
    const checked = await checkSentence(sentence);
    expect(checked.check).toMatchObject({
      state,
      evidence: { quote: CASES[sentence]?.quotes[0] },
    });
    expect(checked.check?.figures?.map((figure) => figure.state)).toEqual(figures);
    expect(checked.asked).toHaveLength(asks);
    expect(checked.evidence).toHaveLength(evidence);
  },
);
