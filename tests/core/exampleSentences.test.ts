/**
 * The shipped credit example's own sentences, written into a new Note, read Supported (#3088): a
 * part of a longer sentence ("against £118 million a year earlier") is checked with the sentence
 * it is part of named on its own, and told how to read a part, and a short Note's "£1,284 million"
 * needs no reading when its Passage writes it the same way. A wrong twin of each stays not ✓.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document } from "../../src/core";
import type { Language } from "../../src/core/language";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  checkGenerate,
  isCheckRun,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
  unsupportedReply,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const EXAMPLES = resolve(__dirname, "../../resources/examples");

/** A sentence as the scripted sort splits it, at its first comma, and the quote numbers that back each part. */
interface Line {
  text: string;
  quote: string;
  numbers: readonly [string, string];
}

const SETS = {
  en: {
    report: "Northwind Retail · Q3 2026 results",
    ebitda: {
      text: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
      quote: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
      numbers: ["£96 million", "£118 million"],
    },
    revenue: {
      text: "Revenue was £1,284 million, up 4.2% year on year.",
      quote: "Group revenue was £1,284 million, up 4.2% on the third quarter of 2025.",
      numbers: ["£1,284 million", "4.2%"],
    },
    ebitdaTwin: "Underlying EBITDA was £96 million, against £128 million a year earlier.",
    revenueTwin: "Revenue was £1,248 million, up 4.2% year on year.",
    whole: {
      text: "Underlying EBITDA came to £96 million.",
      quote: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
      numbers: ["£96 million", ""],
    },
  },
  "zh-CN": {
    report: "Northwind Retail · 2026 年第三季度业绩",
    ebitda: {
      text: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
      quote: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
      numbers: ["9,600 万英镑", "1.18 亿英镑"],
    },
    revenue: {
      text: "集团收入为 12.84 亿英镑，同比增长 4.2%。",
      quote: "集团收入为 12.84 亿英镑，同比增长 4.2%。",
      numbers: ["12.84 亿英镑", "4.2%"],
    },
    ebitdaTwin: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。",
    revenueTwin: "集团收入为 12.48 亿英镑，同比增长 4.2%。",
    whole: {
      text: "基础 EBITDA 合计 9,600 万英镑。",
      quote: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
      numbers: ["9,600 万英镑", ""],
    },
  },
} as const satisfies Record<
  Language,
  {
    report: string;
    ebitda: Line;
    revenue: Line;
    ebitdaTwin: string;
    revenueTwin: string;
    whole: Line;
  }
>;

/** A sentence's parts as the scripted sort names them: before and after its first comma. */
function partsOf(text: string): string[] {
  const comma = /,\s+|，/u.exec(text);
  if (!comma) return [text];
  return [
    text.slice(0, comma.index),
    text.slice(comma.index + comma[0].length).replace(/[.。]$/u, ""),
  ];
}

/** What the lenient judge cites and binds for each sentence or part: the right line's numbers. */
function plansFor(lines: readonly { text: string; like: Line }[]) {
  const plans = new Map<string, { quote: string; numbers: string[] }>();
  for (const { text, like } of lines) {
    const parts = partsOf(text);
    const whole = { quote: like.quote, numbers: like.numbers.filter(Boolean) };
    plans.set(text, whole);
    plans.set(text.replace(/[.。]$/u, ""), whole);
    if (parts.length < 2) continue;
    for (const [index, part] of parts.entries())
      plans.set(part, { quote: like.quote, numbers: [like.numbers[index] ?? ""] });
  }
  return plans;
}

/**
 * A judge that calls every figure Supported and binds it to the number the right sentence has
 * there: what the app's own reading of the figures decides.
 */
function lenient(plans: ReturnType<typeof plansFor>, call: ModelCall): ScriptedReply {
  const claim = sentenceOf(call);
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0)
    return { calls: [{ tool: "search_documents", input: { query: claim } }] };
  const plan = plans.get(claim);
  const shown = [
    ...searches.flatMap((each) => shownPassages(each.text)),
    ...shownPassages(call.prompt),
  ];
  const holding = plan ? shown.find((each) => each.text.includes(plan.quote)) : undefined;
  if (!plan || !holding) return { text: unsupportedReply(call) };
  if (!call.results.some((result) => result.tool === "cite"))
    return {
      calls: [
        {
          tool: "cite",
          input: { citations: [{ marker: 1, passage: holding.id, quote: plan.quote }] },
        },
      ],
    };
  const items = requestedFigures(call).map(({ id }, index) => ({
    id,
    verdict: "supported",
    scope: "same",
    topic: "found",
    roles: "same",
    says: null,
    reading: null,
    relation: "equals",
    source: { citation: 1, number: plan.numbers[index] ?? plan.numbers[0] },
    measure: null,
    calculation: null,
  }));
  return {
    text: `Verdict: supported\nAbsence: no\n${SAME_DETAIL}\nExplanation: It says so. [^1]\nEvidence: [1]\nFigures: ${JSON.stringify({ items, remainder: null })}`,
  };
}

async function examplesReady(core: Core): Promise<Document[]> {
  const examples = await core.getExamples();
  return vi.waitFor(
    async () => {
      const read = await core.listDocuments({ linkedFolderId: examples.linkedFolderId ?? "" });
      expect(read.length).toBe(2);
      expect(read.every((each) => each.status === "ready")).toBe(true);
      return read;
    },
    { timeout: 30_000 },
  );
}

/** The shipped example in `language`, and a new Note of `lines`, the first citing the report's EBITDA line. */
async function noteOf(language: Language, lines: readonly { text: string; like: Line }[]) {
  const words = SETS[language];
  const plans = plansFor(lines);
  const calls: ModelCall[] = [];
  const judge = checkGenerate({});
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call) ? lenient(plans, call) : { text: "Done." };
    },
    {
      generate: (call) => {
        if (call.question !== "find-claims") return judge(call);
        const { sentences } = JSON.parse(call.prompt) as {
          sentences: { number: number; text: string }[];
        };
        return {
          text: JSON.stringify({
            sentences: sentences.map(({ number, text }) => ({
              number,
              parts: partsOf(text).map((part) => ({ kind: "fact", text: part })),
            })),
          }),
        };
      },
    },
  );
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.updateSettings({ user: { language } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.createExamples();
  const report = (await examplesReady(core)).find((each) => each.name === words.report);
  if (!report) throw new Error("The example's report isn't there.");
  const selected = await core.citeSelection({
    documentId: report.id,
    parts: [{ unit: 1, text: words.ebitda.quote }],
  });
  const citation: JSONContent = {
    type: "citation",
    attrs: {
      passageId: selected.passageId,
      documentId: report.id,
      documentName: report.name,
      contentHash: selected.contentHash,
      quote: selected.quote,
      pageFrom: selected.pageFrom,
      pageTo: selected.pageTo,
      location: selected.location,
      check: selected.check,
    },
  };
  const mind = await core.createMind({ title: "Summary of my documents" });
  const client: MindClient = await connectToMind(core, mind.id);
  writeMind(
    client,
    lines.map(({ text }, index) => ({
      type: "paragraph",
      attrs: { id: `line-${index}` },
      content: [{ type: "text", text }, ...(index === 0 ? [citation] : [])],
    })),
  );
  await client.settled();
  const run = await core.checkMind({ requestId: randomUUID(), mindId: mind.id, mode: "all" });
  expect(run).toMatchObject({ kind: "checked" });
  await client.settled();
  const states = new Map(
    claimSpans(readMind(client)).map(({ sentence, check }) => [sentence.text, check.state]),
  );
  core.close();
  return { states, runs: calls.filter(isCheckRun).filter((call) => call.results.length === 0) };
}

const runOf = (runs: readonly ModelCall[], claim: string) => {
  const found = runs.find((call) =>
    [claim, claim.replace(/[.。]$/u, "")].includes(sentenceOf(call)),
  );
  if (!found) throw new Error(`No check Run for ${claim}.`);
  return found;
};

describe.each(["en", "zh-CN"] as const)("the credit example's own sentences (%s)", (language) => {
  const words = SETS[language];

  // protects=the issue's Note, the EBITDA sentence citing its line and the revenue one with none, reads Supported in both parts when the judge binds each figure to its Passage's number, naming no reading (#3088); fails_when=the comparative part or the short Note's "£1,284 million" reads Not checked; no_claim=what a real model's first reply says (the gate on Claude Haiku 5.5).
  test("read Supported, the second part checked with its sentence named", async () => {
    const lines = [
      { text: words.ebitda.text, like: words.ebitda },
      { text: words.revenue.text, like: words.revenue },
    ];
    const { states, runs } = await noteOf(language, lines);
    expect(states.get(words.ebitda.text)).toBe("supported");
    expect(states.get(words.revenue.text)).toBe("supported");

    const [, second] = partsOf(words.ebitda.text) as [string, string];
    const part = runOf(runs, second);
    // The sentence it is part of is named once, on its own; its paragraph is that sentence.
    expect(part.prompt).toContain(`<whole-sentence>\n${words.ebitda.text}\n</whole-sentence>`);
    expect(part.prompt).not.toContain("<paragraph>");
    expect(part.system).toContain("is one part of a longer sentence of the User's");
    // The rule's own examples are none of the example's sentences.
    for (const line of [words.ebitda, words.revenue])
      for (const each of partsOf(line.text)) expect(part.system).not.toContain(each);
  });

  // protects=a sentence checked whole is told nothing of parts, and its prompt names no sentence it is part of (#3088); fails_when=the part rule reaches every check; no_claim=a part's own check (above).
  test("a sentence checked whole is told nothing of parts", async () => {
    const { states, runs } = await noteOf(language, [
      { text: words.ebitda.text, like: words.ebitda },
      { text: words.whole.text, like: words.whole },
    ]);
    expect(states.get(words.whole.text)).toBe("supported");
    const whole = runOf(runs, words.whole.text);
    expect(whole.system).not.toContain("is one part of a longer sentence of the User's");
    expect(whole.prompt).not.toContain("<whole-sentence>");
  });

  // protects=a wrong earlier-period figure ("£128 million a year earlier") and a wrong "£1,248 million" in a short Note stay not ✓ even when the judge calls every figure Supported, bound to the Passage's own number (#3088); fails_when=either reads Supported; no_claim=how a real model words the contradiction.
  test("their wrong twins stay not ✓", async () => {
    const { states } = await noteOf(language, [
      { text: words.ebitdaTwin, like: words.ebitda },
      { text: words.revenueTwin, like: words.revenue },
    ]);
    expect(states.get(words.ebitdaTwin)).toBe("contradicted");
    expect(states.get(words.revenueTwin)).toBe("contradicted");
  });
});
