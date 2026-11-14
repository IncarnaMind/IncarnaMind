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

const PARTS = /<part number="(\d+)">([\s\S]*?)<\/part>/g;

/** A first reply's part, as a check's Run would give it after the same search, its quote under `marker`. */
function partReply(part: string, quote: string | null, marker: number): string {
  return quote
    ? `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\nTime: none / none, same\n${SAME_DETAIL}\nExplanation: The Document says so. [^${marker}]\nEvidence: [${marker}]`
    : `Verdict: unsupported\nAbsence: no\nScope: none, same\nTopic: not found\nRoles: ${part} / none, same\nTime: none / none, same\n${SAME_DETAIL}\nExplanation: The Documents don't say so.\nEvidence: []`;
}

/**
 * A Note to check: its Document, its sentences, the parts each is sorted into, the quote that
 * supports each part (none: the Documents don't state it), and how a part's Run checks it.
 */
interface Scenario {
  language: Case["language"];
  terms: string;
  sentences: readonly string[];
  parts: Record<string, readonly string[]>;
  quotes: Record<string, string>;
  runs: Record<string, Plan>;
}

function scenarioOf(each: Case): Scenario {
  return {
    language: each.language,
    terms: each.terms,
    sentences: [each.stated, each.twoParts],
    parts: { [each.stated]: [each.statedPart], [each.twoParts]: [each.found, each.absent] },
    quotes: { [each.statedPart]: each.statedPart, [each.found]: each.found },
    runs: {
      [each.statedPart]: { verdict: "supported", quote: each.statedPart },
      [each.found]: { verdict: "supported", quote: each.found },
      [each.absent]: { verdict: "unsupported" },
    },
  };
}

/**
 * A core checking `scenario`'s Note. `firstReplied`: a first reply in place of the one its plans
 * give; `firstWait`: what each first reply waits for before it comes.
 */
async function setUp(
  scenario: Scenario,
  searchFirst: boolean,
  {
    firstReplied,
    firstWait,
  }: { firstReplied?: (call: GenerateCall) => GeneratedReply; firstWait?: Promise<void> } = {},
) {
  const { parts, quotes, runs } = scenario;
  const streamed: ModelCall[] = [];
  const firstReplies: GenerateCall[] = [];
  const reranked: string[] = [];
  const heard: { sentence: string; part: string; outcome: string }[] = [];
  const generate = (call: GenerateCall): GeneratedReply => {
    if (call.question === "first-reply" && firstReplied) {
      firstReplies.push(call);
      return firstReplied(call);
    }
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
        ...(firstWait && { until: firstWait }),
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
    checkPaths: {
      searchFirst: () => searchFirst,
      firstReplied: (one) => heard.push(one),
    },
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
  return { core, client, mindId: mind.id, streamed, firstReplies, reranked, heard };
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
    const { core, client, mindId, streamed, firstReplies } = await setUp(scenarioOf(each), true);
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
    const { core, mindId, streamed } = await setUp(scenarioOf(each), true);
    await checkNote(core, mindId);
    const [first] = streamed.filter((call) => call.prompt.includes(`<sentence>\n${each.absent}\n`));
    expect(first?.results[0]?.tool).toBe("search_documents");
    expect(first?.results[0]?.text).toContain(HANDED_NOTE);
    core.close();
  });

  test("the Passage that states a sentence word for word comes first, unreranked, and at most four are handed", async () => {
    const { core, mindId, firstReplies, reranked } = await setUp(scenarioOf(each), true);
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
    const { core, client, mindId, streamed, firstReplies } = await setUp(scenarioOf(each), false);
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

  test("a Note's searches go to the reranker as its sentences are named, before their checks have a place", async () => {
    const rooms: Scenario = {
      language: each.language,
      terms: `# Rooms\n\n${each.rooms.map((room) => room.rule).join(" ")}\n`,
      sentences: each.rooms.map((room) => room.sentence),
      parts: Object.fromEntries(each.rooms.map((room) => [room.sentence, [room.sentence]])),
      quotes: Object.fromEntries(each.rooms.map((room) => [room.sentence, room.rule])),
      runs: {},
    };
    let allSearched = () => {};
    const searched = new Promise<void>((resolve) => {
      allSearched = resolve;
    });
    // Each sentence's first reply waits for all eight searches: two more than the six checks that
    // can run at once, so a search made only once its check had a place would never come.
    const set = await setUp(rooms, true, { firstWait: searched });
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

  test("a first reply that fails leaves every part to its Run", async () => {
    const { core, client, mindId, firstReplies } = await setUp(scenarioOf(each), true, {
      firstReplied: () => ({ error: { status: 500, message: "The server is down." } }),
    });
    await checkNote(core, mindId);
    expect(firstReplies.length).toBeGreaterThan(0);
    expect(await verdicts(client)).toEqual({
      [each.statedPart]: "supported",
      [each.found]: "supported",
      [each.absent]: "unsupported",
    });
    core.close();
  });

  test("a sentence of one part its first reply can't settle is searched once, for the reply and its Run", async () => {
    const bare = (text: string) => text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
    const part = bare(each.car);
    const car: Scenario = {
      language: each.language,
      terms: each.terms,
      sentences: [each.car],
      parts: { [each.car]: [part] },
      quotes: {},
      runs: { [part]: { verdict: "unsupported" } },
    };
    const { core, client, mindId, reranked, streamed } = await setUp(car, true);
    await checkNote(core, mindId);
    expect(await verdicts(client)).toEqual({ [part]: "unsupported" });
    expect(runsOf(streamed).length).toBeGreaterThan(0);
    expect(reranked.filter((query) => bare(query) === part)).toHaveLength(1);
    core.close();
  });
});

const FIGURE_TERMS = {
  en: "# Charges\n\nA ride costs 1.50 pounds for each started 30 minutes.\n\n# The year in numbers\n\nRides in 2026: 1.2 million. Revenue in 2026: 2.4 million pounds.\n",
  "zh-CN":
    "# 费用\n\n每开始一个30分钟，骑行收费1.5元。\n\n# 年度数据\n\n2026年骑行次数：120万次。2026年收入：240万元。\n",
} as const;

const FIGURES_IN = /<figures part="(\d+)">\n([\s\S]*?)\n<\/figures>/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/**
 * A first reply that calls every part Supported and binds each of its figures to a number of
 * `quotes[part]`: the figure's own when the quote writes it, else the quote's first. With no quote
 * it cites nothing and gives no source; `worked` gives every figure as one no Passage states.
 */
function figuresYes(quotes: Record<string, string>, worked = false) {
  return (call: GenerateCall): GeneratedReply => {
    const shown = shownPassages(call.prompt);
    const asked = [...call.prompt.matchAll(PARTS)].map((match) => match[2] ?? "");
    const figures = new Map(
      [...call.prompt.matchAll(FIGURES_IN)].map((match) => [
        Number(match[1]),
        JSON.parse(match[2] ?? "[]") as { id: string; shown: string }[],
      ]),
    );
    const citations = asked.flatMap((part, at) => {
      const quote = quotes[part];
      const passage = quote ? shown.find((each) => each.text.includes(quote)) : undefined;
      return quote && passage ? [{ marker: at + 1, passage: passage.id, quote }] : [];
    });
    return {
      text: JSON.stringify({
        parts: asked.map((part, at) => {
          const quote = quotes[part];
          const numbers = quote?.match(NUMBER) ?? [];
          const items = (figures.get(at + 1) ?? []).map(({ id, shown: own }) => {
            const number = numbers.find((each) => each === own.match(NUMBER)?.[0]) ?? numbers[0];
            const source = !worked && quote && number ? { citation: at + 1, number } : null;
            return {
              id,
              verdict: worked ? "unsupported" : "supported",
              scope: "same",
              topic: "found",
              roles: "same",
              measure: null,
              says: worked ? "No Passage states it as a number." : null,
              reading: null,
              relation: "equals",
              source,
              calculation: null,
            };
          });
          return {
            part: at + 1,
            reply: `${partReply(part, quote ?? part, at + 1)}\nFigures: ${JSON.stringify({ items, remainder: null })}`,
          };
        }),
        citations,
      }),
    };
  };
}

describe.each([
  {
    language: "en" as const,
    price: "A ride costs 1.50 pounds for each started 30 minutes.",
    wrongPrice: "A ride costs 2.00 pounds for each started 30 minutes.",
    wrongScale: "Revenue in 2026 was 2.4 billion pounds.",
    revenue: "Revenue in 2026: 2.4 million pounds.",
    perRide: "Lumen Bay earned 2 pounds of revenue per ride in 2026.",
  },
  {
    language: "zh-CN" as const,
    price: "每开始一个30分钟，骑行收费1.5元。",
    wrongPrice: "每开始一个30分钟，骑行收费2元。",
    wrongScale: "2026年收入为2.4亿元。",
    revenue: "2026年收入：240万元。",
    perRide: "2026年每次骑行的收入为2元。",
  },
])("a sentence's figures in its first reply, in $language", (each) => {
  const bare = (text: string) => text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  const figureScenario = (sentence: string): Scenario => ({
    language: each.language,
    terms: FIGURE_TERMS[each.language],
    sentences: [sentence],
    parts: { [sentence]: [bare(sentence)] },
    quotes: {},
    runs: { [bare(sentence)]: { verdict: "unsupported" } },
  });
  const outcomeOf = (heard: readonly { part: string; outcome: string }[], sentence: string) =>
    heard.filter((one) => one.part === bare(sentence)).map((one) => one.outcome);
  const SETTLED = ["supported", "contradicted", "unsupported"];

  test("a wrong figure the reply calls Supported is settled by the figure's own check, never Supported", async () => {
    const { core, client, mindId, heard } = await setUp(figureScenario(each.wrongPrice), true, {
      firstReplied: figuresYes({ [bare(each.wrongPrice)]: each.price }),
    });
    await checkNote(core, mindId);
    const outcome = outcomeOf(heard, each.wrongPrice);
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).not.toBe("supported");
    expect(Object.values(await verdicts(client))).not.toContain("supported");
    core.close();
  });

  test("a figure of another scale the reply calls Supported is never Supported", async () => {
    const { core, client, mindId, heard } = await setUp(figureScenario(each.wrongScale), true, {
      firstReplied: figuresYes({ [bare(each.wrongScale)]: each.revenue }),
    });
    await checkNote(core, mindId);
    const outcome = outcomeOf(heard, each.wrongScale);
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).not.toBe("supported");
    expect(Object.values(await verdicts(client))).not.toContain("supported");
    core.close();
  });

  test("a figure no Passage states as a number goes on to its Run, which may work it out", async () => {
    const { core, mindId, heard, streamed } = await setUp(figureScenario(each.perRide), true, {
      firstReplied: figuresYes({ [bare(each.perRide)]: each.revenue }, true),
    });
    await checkNote(core, mindId);
    expect(outcomeOf(heard, each.perRide)).toEqual(["figure-not-settled"]);
    expect(runsOf(streamed).length).toBeGreaterThan(0);
    core.close();
  });

  test("a figure the reply calls Supported with no quote goes on to its Run", async () => {
    const { core, mindId, heard, streamed } = await setUp(figureScenario(each.wrongPrice), true, {
      firstReplied: figuresYes({}),
    });
    await checkNote(core, mindId);
    const outcome = outcomeOf(heard, each.wrongPrice);
    expect(outcome).toHaveLength(1);
    expect(SETTLED).not.toContain(outcome[0]);
    expect(runsOf(streamed).length).toBeGreaterThan(0);
    core.close();
  });
});
