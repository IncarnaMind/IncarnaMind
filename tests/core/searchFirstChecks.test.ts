/**
 * The search-first check (#2532): on a model listed for it, Check this Note searches each
 * sentence's own words as soon as the sentence is named and hands its check's Run those Passages in
 * its first request, the one that states it word for word first and unreranked, four at most. The
 * Run keeps its search and decides for itself whether to search again.
 */
import { describe, expect, test } from "vitest";
import type { Core, Reranker } from "../../src/core";
import { HANDED_NOTE } from "../../src/core/answers/checks/checkSetup";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkReply, listedSentences, type Plan } from "../helpers/checks";
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
    car: "The Employee gets a company car.",
    rooms: ["Oak", "Elm", "Ash", "Pine", "Birch", "Cedar", "Maple", "Willow"].map((room) => ({
      rule: `The ${room} room is open to members on Mondays.`,
      sentence: `Members can use the ${room} room on Mondays.`,
    })),
  },
  {
    language: "zh-CN",
    terms: "# 条款\n\n雇员享有25天年假。雇主在每月最后一个工作日支付工资。\n",
    stated: "雇员享有25天年假。",
    statedPart: "雇员享有25天年假",
    twoParts: "雇主在每月最后一个工作日支付工资，雇员还配有公司用车。",
    found: "雇主在每月最后一个工作日支付工资",
    absent: "雇员还配有公司用车",
    car: "雇员配有公司用车。",
    rooms: ["橡树", "榆树", "白蜡", "松树", "桦树", "雪松", "枫树", "柳树"].map((room) => ({
      rule: `${room}会议室每周一向会员开放。`,
      sentence: `会员可在周一使用${room}会议室。`,
    })),
  },
] as const;

type Case = (typeof LANGUAGES)[number];

/** A Note to check: its Document, its sentences, the parts each is sorted into, and how each part's Run checks it. */
interface Scenario {
  language: Case["language"];
  terms: string;
  sentences: readonly string[];
  parts: Record<string, readonly string[]>;
  runs: Record<string, Plan>;
}

function scenarioOf(each: Case): Scenario {
  return {
    language: each.language,
    terms: each.terms,
    sentences: [each.stated, each.twoParts],
    parts: { [each.stated]: [each.statedPart], [each.twoParts]: [each.found, each.absent] },
    runs: {
      [each.statedPart]: { verdict: "supported", quote: each.statedPart },
      [each.found]: { verdict: "supported", quote: each.found },
      [each.absent]: { verdict: "unsupported" },
    },
  };
}

/** A core checking `scenario`'s Note; `runWait`: what each Run's verdict waits for before it comes. */
async function setUp(scenario: Scenario, searchFirst: boolean, runWait?: Promise<void>) {
  const { parts, runs } = scenario;
  const streamed: ModelCall[] = [];
  const reranked: string[] = [];
  const generate = (call: GenerateCall): GeneratedReply => {
    if (call.question === "find-claims") {
      const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
        number,
        parts: (parts[text] ?? []).map((part) => ({ kind: "fact", text: part })),
      }));
      return { text: JSON.stringify({ sentences }) };
    }
    return checkGenerate(runs)(call);
  };
  const model = scriptedModel(
    (call) => {
      streamed.push(call);
      const reply = checkReply(call, runs);
      return runWait && !("error" in reply) && reply.text
        ? { ...reply, pause: { after: 0, until: runWait } }
        : reply;
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
  await core.updateSettings({ user: { language: scenario.language } });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (provider.service) await core.allowDataFlow("checks", provider.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, "Terms.md", scenario.terms)]);
  const mind = await core.createMind({ title: "Leave notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "one" },
      content: [{ type: "text", text: scenario.sentences.join(" ") }],
    },
  ]);
  await client.settled();
  reranked.length = 0;
  return { core, client, mindId: mind.id, streamed, reranked };
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

/** The first request of the Run that checks `words`. */
const runOf = (calls: readonly ModelCall[], words: string) =>
  runsOf(calls).find((call) => call.prompt.includes(`<sentence>\n${words}\n`));

describe.each(LANGUAGES)("the search-first check in $language", (each) => {
  test("every part's Run starts from the Passages of its own words handed over, and keeps its search", async () => {
    const { core, client, mindId, streamed } = await setUp(scenarioOf(each), true);
    await checkNote(core, mindId);
    expect(await verdicts(client)).toEqual({
      [each.statedPart]: "supported",
      [each.found]: "supported",
      [each.absent]: "unsupported",
    });
    for (const words of [each.statedPart, each.found, each.absent]) {
      const first = runOf(streamed, words);
      expect(first?.results[0]?.tool).toBe("search_documents");
      expect(first?.results[0]?.text).toContain(HANDED_NOTE);
      expect(first?.tools).toContain("search_documents");
    }
    core.close();
  });

  test("the Passage that states a sentence word for word comes first, unreranked, and at most four are handed", async () => {
    const { core, mindId, streamed, reranked } = await setUp(scenarioOf(each), true);
    await checkNote(core, mindId);
    const shown = shownPassages(runOf(streamed, each.statedPart)?.results[0]?.text ?? "");
    expect(shown[0]?.text).toContain(each.statedPart);
    expect(shown.length).toBeLessThanOrEqual(4);
    expect(reranked).not.toContain(each.stated);
    core.close();
  });

  test("Check against Documents, which the gate didn't measure, checks as before on a listed model", async () => {
    const { core, streamed } = await setUp(scenarioOf(each), true);
    await core.checkClaim({ claim: each.stated });
    const starts = runsOf(streamed).filter((call) => call.results.length === 0);
    expect(starts.length).toBeGreaterThan(0);
    for (const run of runsOf(streamed)) expect(run.prompt).not.toContain(HANDED_NOTE);
    core.close();
  });

  test("Verify, which the gate didn't measure, checks as before on a listed model", async () => {
    const { core, streamed } = await setUp(scenarioOf(each), true);
    const file = await writeSourceFile(await createTempDataFolder(), "Notes.txt", each.stated);
    const made = await core.verifyDocument({ path: file });
    if (!made.ok) throw new Error("The test Document could not be verified.");
    const input = () => ({ requestId: crypto.randomUUID(), mindId: made.mind.id });
    expect(await core.findClaims(input())).toEqual({ kind: "found", claims: 1 });
    expect(await core.verifyClaims(input())).toMatchObject({ kind: "checked", claims: 1 });
    const starts = runsOf(streamed).filter((call) => call.results.length === 0);
    expect(starts.length).toBeGreaterThan(0);
    for (const run of runsOf(streamed)) expect(run.prompt).not.toContain(HANDED_NOTE);
    core.close();
  });

  test("a model not listed checks every sentence as before: its Run searches first", async () => {
    const { core, client, mindId, streamed } = await setUp(scenarioOf(each), false);
    await checkNote(core, mindId);
    for (const run of runsOf(streamed)) expect(run.prompt).not.toContain(HANDED_NOTE);
    expect(runsOf(streamed).filter((call) => call.results.length === 0)).toHaveLength(3);
    expect(await verdicts(client)).toEqual({
      [each.statedPart]: "supported",
      [each.found]: "supported",
      [each.absent]: "unsupported",
    });
    core.close();
  });

  test("a Note's searches go to the reranker as its sentences are named, before their checks have a place", async () => {
    const rooms: Scenario = {
      language: each.language,
      terms: `# Rooms\n\n${each.rooms.map((room) => room.rule).join(" ")}\n`,
      sentences: each.rooms.map((room) => room.sentence),
      parts: Object.fromEntries(each.rooms.map((room) => [room.sentence, [room.sentence]])),
      runs: Object.fromEntries(
        each.rooms.map((room) => [room.sentence, { verdict: "supported", quote: room.rule }]),
      ),
    };
    let allSearched = () => {};
    const searched = new Promise<void>((resolve) => {
      allSearched = resolve;
    });
    // Each sentence's Run waits for all eight searches before its verdict: two more than the six
    // checks that can run at once, so a search made only once its check had a place would never come.
    const set = await setUp(rooms, true, searched);
    const waiting = setInterval(() => {
      if (rooms.sentences.every((sentence) => set.reranked.includes(sentence))) allSearched();
    }, 5);
    try {
      await checkNote(set.core, set.mindId);
      expect(Object.values(await verdicts(set.client))).toEqual(
        rooms.sentences.map(() => "supported"),
      );
    } finally {
      clearInterval(waiting);
      set.core.close();
    }
  });

  test("a sentence of one part is searched once, ahead, for its Run", async () => {
    const bare = (text: string) => text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
    const part = bare(each.car);
    const car: Scenario = {
      language: each.language,
      terms: each.terms,
      sentences: [each.car],
      parts: { [each.car]: [part] },
      runs: { [part]: { verdict: "unsupported" } },
    };
    const { core, client, mindId, reranked, streamed } = await setUp(car, true);
    await checkNote(core, mindId);
    expect(await verdicts(client)).toEqual({ [part]: "unsupported" });
    expect(runOf(streamed, part)?.results[0]?.text).toContain(HANDED_NOTE);
    expect(reranked.filter((query) => bare(query) === part)).toHaveLength(1);
    core.close();
  });
});
