/**
 * The search-first check (#2532): on a model listed for it, Check this Note searches each
 * sentence's own words as soon as the sentence is named and hands its check those Passages, the
 * one that states it word for word first and unreranked, four at most. A sentence whose parts are
 * known is answered part by part in one reply, and a part that reply can't settle, and only that
 * part, goes on to its check's Run, which starts from the Passages handed over.
 */
import { describe, expect, test } from "vitest";
import type { Core, Reranker } from "../../src/core";
import { HANDED_NOTE } from "../../src/core/answers/checks/checkSetup";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  checkGenerate,
  checkReply,
  listedSentences,
  type Plan,
  SAME_DETAIL,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const LANGUAGES = [
  {
    language: "en",
    terms:
      "# Terms\n\nThe Employee has 25 days of annual leave. The Employer pays the salary on the last working day of each month.\n",
    stated: "The Employee has 25 days of annual leave.",
    statedPart: "The Employee has 25 days of annual leave",
    twoParts:
      "The Employer pays the salary on the last working day of each month, and the Employee gets a company car.",
    found: "The Employer pays the salary on the last working day of each month",
    absent: "the Employee gets a company car",
  },
  {
    language: "zh-CN",
    terms: "# 条款\n\n雇员享有25天年假。雇主在每月最后一个工作日支付工资。\n",
    stated: "雇员享有25天年假。",
    statedPart: "雇员享有25天年假",
    twoParts: "雇主在每月最后一个工作日支付工资，雇员还配有公司用车。",
    found: "雇主在每月最后一个工作日支付工资",
    absent: "雇员还配有公司用车",
  },
] as const;

type Case = (typeof LANGUAGES)[number];

const PARTS = /<part number="(\d+)">([\s\S]*?)<\/part>/g;

/** A first reply's part, as a check's Run would give it after the same search, its quote under `marker`. */
function partReply(part: string, quote: string | null, marker: number): string {
  return quote
    ? `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\nTime: none / none, same\n${SAME_DETAIL}\nExplanation: The Document says so. [^${marker}]\nEvidence: [${marker}]`
    : `Verdict: unsupported\nAbsence: no\nScope: none, same\nTopic: not found\nRoles: ${part} / none, same\nTime: none / none, same\n${SAME_DETAIL}\nExplanation: The Documents don't say so.\nEvidence: []`;
}

/** The parts each sentence is sorted into, and the quote each part is supported by, if any. */
function plansOf(each: Case) {
  const parts: Record<string, readonly string[]> = {
    [each.stated]: [each.statedPart],
    [each.twoParts]: [each.found, each.absent],
  };
  const quotes: Record<string, string> = {
    [each.statedPart]: each.statedPart,
    [each.found]: each.found,
  };
  const runs: Record<string, Plan> = {
    [each.statedPart]: { verdict: "supported", quote: each.statedPart },
    [each.found]: { verdict: "supported", quote: each.found },
    [each.absent]: { verdict: "unsupported" },
  };
  return { parts, quotes, runs };
}

async function setUp(each: Case, searchFirst: boolean) {
  const { parts, quotes, runs } = plansOf(each);
  const streamed: ModelCall[] = [];
  const firstReplies: GenerateCall[] = [];
  const reranked: string[] = [];
  const generate = (call: GenerateCall): GeneratedReply => {
    if (call.question === "find-claims") {
      const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
        number,
        parts: (parts[text] ?? []).map((part) => ({ kind: "fact", text: part })),
      }));
      return { text: JSON.stringify({ sentences }) };
    }
    if (call.question === "first-reply") {
      firstReplies.push(call);
      const shown = shownPassages(call.prompt);
      const asked = [...call.prompt.matchAll(PARTS)].map((match) => match[2] ?? "");
      const citations = asked.flatMap((part, at) => {
        const quote = quotes[part];
        const passage = quote ? shown.find((passage) => passage.text.includes(quote)) : undefined;
        return quote && passage ? [{ marker: at + 1, passage: passage.id, quote }] : [];
      });
      return {
        text: JSON.stringify({
          parts: asked.map((part, at) => ({
            part: at + 1,
            reply: partReply(part, quotes[part] ?? null, at + 1),
          })),
          citations,
        }),
      };
    }
    return checkGenerate(runs)(call);
  };
  const model = scriptedModel(
    (call) => {
      streamed.push(call);
      return checkReply(call, runs);
    },
    { generate },
  );
  const reranker: Reranker = async (query, candidates) => {
    reranked.push(query);
    return [...candidates];
  };
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    reranker,
    checkPaths: { searchFirst: () => searchFirst },
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language: each.language } });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (provider.service) await core.allowDataFlow("checks", provider.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, "Terms.md", each.terms)]);
  const mind = await core.createMind({ title: "Leave notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "one" },
      content: [{ type: "text", text: `${each.stated} ${each.twoParts}` }],
    },
  ]);
  await client.settled();
  reranked.length = 0;
  return { core, client, mindId: mind.id, streamed, firstReplies, reranked };
}

async function checkNote(core: Core, mindId: string) {
  const result = await core.checkMind({ requestId: `check-${mindId}`, mindId, mode: "all" });
  expect(result.kind).toBe("checked");
}

/** Each part's verdict, by its words, as the Note holds them after the check. */
async function verdicts(client: MindClient) {
  await client.settled();
  return Object.fromEntries(
    claimSpans(readMind(client)).flatMap((span) =>
      (span.check?.parts ?? []).map((part) => [
        span.sentence.text.trim().slice(part.span.start, part.span.end),
        part.verdict,
      ]),
    ),
  );
}

/** The Runs a check started: each begins with a request that carries no reply of the model's yet. */
const runsOf = (calls: readonly ModelCall[]) =>
  calls.filter(
    (call) => call.system.startsWith("You check one sentence") && !call.prompt.includes("Verdict:"),
  );

describe.each(LANGUAGES)("the search-first check in $language", (each) => {
  test("one reply settles the parts its Passages decide, and only the rest go on to a Run", async () => {
    const { core, client, mindId, streamed, firstReplies } = await setUp(each, true);
    await checkNote(core, mindId);
    expect(await verdicts(client)).toEqual({
      [each.statedPart]: "supported",
      [each.found]: "supported",
      [each.absent]: "unsupported",
    });
    // One reply a sentence, both parts of the second in one.
    expect(firstReplies).toHaveLength(2);
    const firstRuns = runsOf(streamed).filter((call) => call.results.length > 0);
    const sentences = firstRuns.map(
      (call) => /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(call.prompt)?.[1],
    );
    expect(new Set(sentences)).toEqual(new Set([each.absent]));
    core.close();
  });

  test("the Run of a part that goes on starts from the sentence's Passages handed over", async () => {
    const { core, mindId, streamed } = await setUp(each, true);
    await checkNote(core, mindId);
    const [first] = streamed.filter((call) => call.prompt.includes(`<sentence>\n${each.absent}\n`));
    expect(first?.results[0]?.tool).toBe("search_documents");
    expect(first?.results[0]?.text).toContain(HANDED_NOTE);
    core.close();
  });

  test("the Passage that states a sentence word for word comes first, unreranked, and at most four are handed", async () => {
    const { core, mindId, firstReplies, reranked } = await setUp(each, true);
    await checkNote(core, mindId);
    const stated = firstReplies.find((call) =>
      call.prompt.includes(`<sentence>\n${each.stated}\n`),
    );
    const shown = shownPassages(stated?.prompt ?? "");
    expect(shown[0]?.text).toContain(each.statedPart);
    expect(shown.length).toBeLessThanOrEqual(4);
    expect(reranked).not.toContain(each.stated);
    core.close();
  });

  test("a model not listed checks every sentence as before: its Run searches first", async () => {
    const { core, client, mindId, streamed, firstReplies } = await setUp(each, false);
    await checkNote(core, mindId);
    expect(firstReplies).toHaveLength(0);
    for (const run of runsOf(streamed).filter((call) => call.results.length === 0))
      expect(run.prompt).not.toContain(HANDED_NOTE);
    expect(runsOf(streamed).filter((call) => call.results.length === 0)).toHaveLength(3);
    expect(await verdicts(client)).toEqual({
      [each.statedPart]: "supported",
      [each.found]: "supported",
      [each.absent]: "unsupported",
    });
    core.close();
  });
});
