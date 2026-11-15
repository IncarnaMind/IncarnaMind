/**
 * A decision model reads each sentence of Check this Note first (#3118), through the core's
 * public interface, with a scripted AI model and a decision host that stands in for OpenRouter.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import type { CheckDecisionModel, CheckMindInput, Core } from "../../src/core";
import { type PassageScores, readingOf } from "../../src/core/answers/checks/decisionLines";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const LINES = {
  verdict: { supported: 0.98, contradicted: 0.9, band: 0.005 },
  firstReading: { supported: 0.8, contradicted: 0.5 },
};

const scores = (...each: [states: number, opposes: number][]): PassageScores[] =>
  each.map(([states, opposes], index) => ({ passageId: `p${index}`, states, opposes }));

describe("What a sentence's scores come to", () => {
  // protects=a verdict needs a score clear of its line by the band, a Passage that says the opposite outranks one that states the sentence, and a lower score is only a first reading; fails_when=a score inside the band, or a Supported beside a Passage that opposes, becomes a verdict; no_claim=that the lines themselves are right, which the gate's real-model run measures.
  test.each([
    ["states it, clear of the line", scores([0.99, 0.01], [0.2, 0.02]), "supported p0 final"],
    ["states it, inside the band", scores([0.983, 0.01]), "supported p0 first reading"],
    ["states it, below the line", scores([0.85, 0.01]), "supported p0 first reading"],
    ["one states it, one opposes", scores([0.99, 0.01], [0.1, 0.95]), "contradicted p1 final"],
    ["states it, one nearly opposes", scores([0.99, 0.01], [0.1, 0.897]), "nothing"],
    ["opposes, inside the band", scores([0.1, 0.903]), "contradicted p0 first reading"],
    ["opposes, below the line", scores([0.1, 0.6]), "contradicted p0 first reading"],
    ["both lean", scores([0.85, 0.6]), "nothing"],
    ["neither", scores([0.3, 0.1]), "nothing"],
    ["no Passage", scores(), "nothing"],
  ])("%s", (_, given, expected) => {
    const reading = readingOf(given, LINES);
    expect(
      reading
        ? `${reading.verdict} ${reading.passageId} ${reading.final ? "final" : "first reading"}`
        : "nothing",
    ).toBe(expected);
  });

  // protects=a model with no measured verdict lines never gives a verdict; fails_when=its high score is final; no_claim=which models have lines.
  test("a model without verdict lines only gives a first reading", () => {
    const reading = readingOf(scores([0.999, 0.001]), { firstReading: LINES.firstReading });
    expect(reading).toEqual({ verdict: "supported", passageId: "p0", final: false });
  });
});

const DECIDER: CheckDecisionModel = { host: "openrouter", modelId: "perplexity/pplx-decider-v1.2" };
const KEY = "sk-or-test";
const AI_MODEL = "anthropic/claude-haiku-5.5";

// A Passage's line is its paragraph: the quote a decision verdict shows is the whole of it.
const TIDES_LINE = "Spring tides come at new and full moon. Neap tides come at the quarter moons.";
const TIDES = { name: "Tides.md", contents: `# Tides\n\n${TIDES_LINE}\n` };
const OFFICE = {
  name: "Harbour office.md",
  contents:
    "# Harbour office\n\nThe harbour office publishes the times of high water every week.\n",
};
const WEEKLY = "The harbour office publishes the times of high water every week.";

const MOON = "Spring tides come at new and full moon.";
const YEARLY = "The harbour office publishes the times of high water every year.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const TONNES = "The harbour office handled 54,000 tonnes of cargo.";

// More sentences than a cloud model checks at once, and more requests than the host is sent at once.
const MOONS = [
  ...["new", "full", "half", "red", "blue", "low", "high", "late", "early", "pale"],
  ...["dark", "cold", "warm", "thin", "wide", "first", "last", "white", "grey", "gold"],
].map((moon) => `Spring tides come at the ${moon} moon.`);

const LAMP = "The lighthouse lamp is lit at dusk every evening of the year.";
// One Document of many Passages: a search returns a few of them, not the lamp's.
const LOG = {
  name: "Harbour log.md",
  contents: [
    "# Harbour log",
    ...["Ferries", "Moorings", "Pilots", "Cranes", "Dredging", "Customs", "Fishing", "Lamp"].map(
      (topic, at) =>
        `## ${topic}\n\n${
          topic === "Lamp"
            ? LAMP
            : `Entry ${at} on ${topic.toLowerCase()} in the harbour, kept by the clerk. `.repeat(30)
        }`,
    ),
  ].join("\n\n"),
};

const PLANS: Record<string, Plan> = {
  ...Object.fromEntries(MOONS.map((sentence) => [sentence, { verdict: "unsupported" }])),
  [MOON]: { verdict: "supported", quote: MOON },
  [YEARLY]: {
    verdict: "contradicted",
    quote: WEEKLY,
    says: "The harbour office says every week, not every year.",
  },
  [PENGUINS]: { verdict: "unsupported" },
  [TONNES]: { verdict: "unsupported" },
};

interface Asked {
  sentence: string;
  context?: { paragraph: string };
  passage: { document: string; page?: string; text: string };
}

type Answer = { B: number; C: number } | { status: number };

/** What the decision model says by default: sure of the two sentences the Documents decide. */
const sure = ({ sentence, passage }: Asked): Answer => ({
  B: sentence === MOON && passage.text.includes(MOON) ? 0.995 : 0.03,
  C: sentence === YEARLY && passage.text.includes(WEEKLY) ? 0.97 : 0.02,
});

async function startDecisionHost() {
  const asked: { model: unknown; state: Asked; questions: string[] }[] = [];
  let answer: (state: Asked) => Answer | Promise<Answer> = sure;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET") return send(200, { data: [] });
    const body = JSON.parse(text) as { model: unknown; state: Asked; questions: object };
    asked.push({ model: body.model, state: body.state, questions: Object.keys(body.questions) });
    const given = await answer(body.state);
    if ("status" in given) return send(given.status, { error: { message: "Refused." } });
    send(200, {
      model: body.model,
      answers: {
        B: { type: "noul", noul: given.B },
        C: { type: "noul", noul: given.C },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    answers(next: typeof answer) {
      answer = next;
    },
  };
}

const text = (value: string): JSONContent => ({ type: "text", text: value });

/** A core with the two Documents, a Note of `sentences`, an AI model on OpenRouter and its decision host. */
async function setUp(
  sentences: readonly string[] = [MOON, YEARLY, PENGUINS],
  { readsByDefault = false } = {},
) {
  const host = await startDecisionHost();
  const checks: ModelCall[] = [];
  let held: Promise<void> | null = null;
  const model = scriptedModel(
    (call) => {
      checks.push(call);
      const reply = checkReply(call, PLANS);
      return held && isCheckRun(call) ? { ...reply, pause: { after: 0, until: held } } : reply;
    },
    { generate: checkGenerate(PLANS) },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    keychain: createMemoryKeychain(),
    decisionOrigins: { openrouter: host.url },
    decisionReadsByDefault: readsByDefault,
  });
  let accepts = true;
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, accepts));
  const provider = await core.saveChatProvider({
    kind: "openrouter",
    apiKey: KEY,
    modelId: AI_MODEL,
  });
  if (provider.service) await core.allowDataFlow("checks", provider.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, TIDES.name, TIDES.contents),
    await writeSourceFile(sources, OFFICE.name, OFFICE.contents),
  ]);
  const mind = await core.createMind({ title: "Harbour notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "one" }, content: [text(sentences.join(" "))] },
  ]);
  await client.settled();
  const run = (id = "run"): CheckMindInput => ({ requestId: id, mindId: mind.id, mode: "all" });
  /** The sentences the AI model's own check read. */
  const readByAiModel = () => [
    ...new Set(checks.filter((call) => isCheckRun(call)).map((call) => sentenceOf(call))),
  ];
  /** The AI model's checks wait from now until the returned function is called. */
  const holdAiModel = () => {
    const waiting = Promise.withResolvers<void>();
    held = waiting.promise;
    return waiting.resolve;
  };
  /** What the AI model's own checks were sent, from the `from`th request on, in no order. */
  const sentToAiModel = (from = 0) =>
    checks
      .slice(from)
      .filter((call) => isCheckRun(call))
      .map((call) => JSON.stringify([call.system, call.prompt, call.tools, call.results]))
      .sort();
  return {
    core,
    client,
    host,
    run,
    readByAiModel,
    sentToAiModel,
    aiRequests: () => checks.length,
    holdAiModel,
    aiModelId: AI_MODEL,
    service: provider.service,
    /** From now on the User declines whatever they are asked to allow. */
    declineFromNow() {
      accepts = false;
    },
  };
}

const choose = (core: Core, model: CheckDecisionModel | "off" | null = DECIDER) =>
  core.updateSettings({ device: { checkDecisionModel: model } });

/** Each sentence's Mark as stored: its verdict, its quote, the model that gave it and any first reading. */
async function marks(client: MindClient) {
  await client.settled();
  return Object.fromEntries(
    claimSpans(readMind(client)).map(({ sentence, check }) => {
      const part = check.parts?.[0];
      return [
        sentence.text.trim(),
        {
          state: check.state,
          quote: part?.evidence?.[0]?.quote ?? null,
          by: part?.modelId ?? check.modelId,
          ...(part?.firstReading && { firstReading: part.firstReading.verdict }),
        },
      ];
    }),
  );
}

describe("Check this Note with a decision model chosen (#3118)", { timeout: 30_000 }, () => {
  // protects=a sentence one Passage clearly states or contradicts gets its verdict from the decision model, with that Passage's own line as its quote and the decision model named on it, and costs no request to the AI model; every other sentence goes to the AI model's check; fails_when=the AI model is asked about a sentence the decision model decided, the quote isn't a line of the Passage, or an undecided sentence gets no check; no_claim=that a real decision model's scores are right, which the gate's real-model run measures.
  test("the decision model gives the clear verdicts and the AI model checks the rest", async () => {
    const { core, client, host, run, readByAiModel, aiModelId } = await setUp();
    await choose(core);

    const result = await core.checkMind(run());

    expect(result).toMatchObject({ kind: "checked", sentences: 3, checked: 3 });
    expect(result).not.toHaveProperty("decisionStopped");
    expect(await marks(client)).toEqual({
      [MOON]: { state: "supported", quote: TIDES_LINE, by: DECIDER.modelId },
      [YEARLY]: { state: "contradicted", quote: WEEKLY, by: DECIDER.modelId },
      [PENGUINS]: { state: "unsupported", quote: null, by: aiModelId },
    });
    expect(readByAiModel()).toEqual([PENGUINS]);
    const pairs = host.asked.map(({ state }) => `${state.sentence}\n${state.passage.text}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(host.asked.every((each) => each.model === DECIDER.modelId)).toBe(true);
    expect(host.asked.every((each) => each.questions.join() === "B,C")).toBe(true);
  });

  // protects=what goes to the decision model's host is the sentence, its paragraph and one Passage with its Document's name, and nothing else of the Note or the Library; fails_when=a request carries another field; no_claim=what the AI model's own check sends.
  test("a request holds one sentence, its paragraph and one Passage", async () => {
    const { core, host, run } = await setUp();
    await choose(core);
    await core.checkMind(run());

    const moon = host.asked.find(
      ({ state }) => state.sentence === MOON && state.passage.text.includes(MOON),
    );
    expect(moon?.state).toEqual({
      sentence: MOON,
      context: { paragraph: `${MOON} ${YEARLY} ${PENGUINS}` },
      passage: { document: "Tides", page: "1", text: expect.stringContaining(MOON) },
    });
  });

  // protects=a score inside the band of its line is a first reading, not a verdict: the Mark shows it while the AI model checks the sentence, and keeps it as the record once the AI model has answered; fails_when=a score just over the line marks the sentence, the first reading isn't on the Mark while the check runs, or it is gone afterwards; no_claim=how wide the band should be, or how the card draws a first reading.
  test("a score too near its line is a first reading the AI model confirms", async () => {
    const { core, client, host, run, readByAiModel, holdAiModel, aiModelId } = await setUp();
    await choose(core);
    host.answers((state) => {
      const given = sure(state);
      return "B" in given ? { B: Math.min(given.B, 0.983), C: Math.min(given.C, 0.903) } : given;
    });
    const release = holdAiModel();

    const running = core.checkMind(run());
    await expect.poll(async () => (await marks(client))[YEARLY]?.firstReading).toBe("contradicted");
    expect(await marks(client)).toMatchObject({
      [MOON]: { state: "checking", firstReading: "supported" },
      [YEARLY]: { state: "checking", firstReading: "contradicted" },
    });
    expect((await marks(client))[PENGUINS]).not.toHaveProperty("firstReading");
    release();
    await running;

    expect(readByAiModel().sort()).toEqual([MOON, PENGUINS, YEARLY].sort());
    expect(await marks(client)).toEqual({
      [MOON]: { state: "supported", quote: MOON, by: aiModelId, firstReading: "supported" },
      [YEARLY]: {
        state: "contradicted",
        quote: WEEKLY,
        by: aiModelId,
        firstReading: "contradicted",
      },
      [PENGUINS]: { state: "unsupported", quote: null, by: aiModelId },
    });
  });

  // protects=a first reading belongs to the run that made it: a sentence checked again with no decision model chosen shows none; fails_when=an old first reading stays on a Mark the AI model alone gave; no_claim=how the card draws a Mark.
  test("a sentence checked again with no decision model keeps no old first reading", async () => {
    const { core, client, host, run } = await setUp([MOON, PENGUINS]);
    await choose(core);
    host.answers(({ sentence, passage }) => ({
      B: sentence === MOON && passage.text.includes(MOON) ? 0.9 : 0.02,
      C: 0.01,
    }));
    await core.checkMind(run("with a decision model"));
    expect((await marks(client))[MOON]).toMatchObject({ firstReading: "supported" });

    await choose(core, null);
    await core.checkMind(run("without one"));

    expect((await marks(client))[MOON]).toMatchObject({ state: "supported" });
    expect((await marks(client))[MOON]).not.toHaveProperty("firstReading");
  });

  // protects=every sentence is read by the decision model as the run starts, not as its check gets one of the AI model's places: each Mark shows its first reading while the AI model has answered nothing; fails_when=a sentence past the first six waits for a place before it is read; no_claim=how long a real host takes.
  test("every sentence gets its first reading at once, before the AI model answers any", async () => {
    const { core, client, host, run, holdAiModel } = await setUp(MOONS);
    await choose(core);
    host.answers(({ passage }) => ({
      B: passage.text.includes("Spring tides") ? 0.9 : 0.02,
      C: 0.01,
    }));
    const release = holdAiModel();

    const running = core.checkMind(run());
    await expect
      .poll(async () => Object.values(await marks(client)).filter((mark) => mark.firstReading))
      .toHaveLength(MOONS.length);
    expect(Object.values(await marks(client)).map((mark) => mark.state)).toEqual(
      MOONS.map(() => "checking"),
    );
    release();

    expect(await running).toMatchObject({ kind: "checked", checked: MOONS.length });
  });

  // protects=a first reading is display only: the AI model's check of the sentence is sent what it is sent with no decision model chosen; fails_when=a reading adds to, or changes, a request to the AI model; no_claim=that the AI model's answers are the same, which a real model's run measures.
  test("a first reading changes nothing the AI model is asked", async () => {
    const { core, host, run, sentToAiModel, aiRequests } = await setUp([MOON, PENGUINS]);
    await core.checkMind(run("first"));
    const second = aiRequests();
    await core.checkMind(run("no decision model"));
    const third = aiRequests();
    const plain = sentToAiModel(second);

    await choose(core);
    host.answers(({ sentence, passage }) => ({
      B: sentence === MOON && passage.text.includes(MOON) ? 0.9 : 0.02,
      C: 0.01,
    }));
    await core.checkMind(run("first reading"));

    expect(host.asked.length).toBeGreaterThan(0);
    expect(plain.length).toBeGreaterThan(0);
    expect(sentToAiModel(third)).toEqual(plain);
  });

  // protects=the Passages a sentence cites are read by the decision model with those its search finds, so a verdict never rests on the search alone while the cited Passage says otherwise; fails_when=a cited Passage the search didn't return isn't sent to the decision model; no_claim=what the AI model's check does with a Citation.
  test("the Passage a sentence cites is read too, though the search doesn't find it", async () => {
    const { core, client, host, run } = await setUp([MOON]);
    const [log] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), LOG.name, LOG.contents),
    ]);
    const [lamp] = await core.searchPassages("lighthouse lamp", { mode: "keyword" });
    if (!log || !lamp?.text.includes(LAMP)) throw new Error("The log wasn't added.");
    expect((await core.searchPassages(MOON)).some((each) => each.text.includes(LAMP))).toBe(false);
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [
          text(`${MOON} `),
          {
            type: "citation",
            attrs: {
              passageId: lamp.passageId,
              documentId: log.id,
              documentName: "Harbour log",
              contentHash: log.contentHash,
              pageFrom: null,
              pageTo: null,
              quote: LAMP,
              check: "found",
              checkReason: null,
            },
          },
        ],
      },
    ]);
    await client.settled();
    await choose(core);

    await core.checkMind(run());

    const read = host.asked.filter(({ state }) => state.sentence === MOON);
    expect(read.filter(({ state }) => state.passage.text.includes(LAMP))).toHaveLength(1);
    expect(read.length).toBeGreaterThan(1);
  });

  // protects=a sentence with a figure never gets its verdict from the decision model, however sure it is: it shows a first reading and its own check, which ties each figure to its source's, gives the Mark; fails_when=a sentence with a figure is marked by the decision model; no_claim=the figure check itself.
  test("a sentence with a figure gets only a first reading", async () => {
    const { core, client, host, run, readByAiModel, aiModelId } = await setUp([TONNES]);
    await choose(core);
    host.answers(() => ({ B: 0.999, C: 0.01 }));

    await core.checkMind(run());

    expect(readByAiModel()).toEqual([TONNES]);
    expect((await marks(client))[TONNES]).toMatchObject({
      by: aiModelId,
      firstReading: "supported",
    });
  });

  // protects=a first reading the AI model never confirmed stays on the Mark, which reads not checked for the reason the check gave; fails_when=the first reading is lost with the failed check, or the sentence reads Supported on it; no_claim=the words the card puts to it.
  test("a first reading stays when the AI model's check is stopped", async () => {
    const { core, client, host, run, holdAiModel } = await setUp([MOON]);
    await choose(core);
    host.answers((state) => ({ B: state.passage.text.includes(MOON) ? 0.9 : 0.02, C: 0.01 }));
    holdAiModel();

    const running = core.checkMind(run("stopped"));
    await expect.poll(async () => (await marks(client))[MOON]?.firstReading).toBe("supported");
    await core.cancelCheck("stopped");
    await running;

    expect((await marks(client))[MOON]).toMatchObject({
      state: "not-checked",
      firstReading: "supported",
    });
  });

  // protects=a decision host that refuses every request stops being asked for the rest of the run, the AI model checks every sentence, and the run ends as one with no decision model does, with no problem to show; fails_when=sentences stay unchecked, the host keeps being asked, or the result carries a failure; no_claim=which failures a real host returns, or how long a host that never answers is waited for.
  test("a host that refuses every request leaves every sentence to the AI model, with no problem", async () => {
    const { core, client, host, run, readByAiModel } = await setUp(MOONS);
    const plain = await core.checkMind(run("plain"));
    await choose(core);
    host.answers(() => ({ status: 401 }));

    const result = await core.checkMind(run());

    expect(result).toEqual(plain);
    expect(result).toMatchObject({ kind: "checked", checked: MOONS.length });
    expect(readByAiModel().sort()).toEqual([...MOONS].sort());
    expect(Object.values(await marks(client)).map((mark) => mark.state)).toEqual(
      MOONS.map(() => "unsupported"),
    );
    // The host is sent 32 requests at once: those that would start after the refusal never go.
    expect(host.asked.length).toBeLessThanOrEqual(32);
  });

  // protects=nothing goes to a decision host until the User chooses a model for checks, choosing it is the consent to that host, and taking the consent back stops the requests; fails_when=a request leaves before the choice or after the consent is revoked; no_claim=the Settings row that makes the choice.
  test("nothing goes to the host before the choice, or after its consent is taken back", async () => {
    const { core, host, run, readByAiModel } = await setUp();
    await core.checkMind(run("before"));
    expect(host.asked).toEqual([]);
    expect(readByAiModel().sort()).toEqual([MOON, PENGUINS, YEARLY].sort());

    await choose(core);
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "decision-checks");
    expect(flow).toMatchObject({ consent: "accepted", flow: { sends: ["checked-sentences"] } });
    await core.checkMind(run("chosen"));
    const sent = host.asked.length;
    expect(sent).toBeGreaterThan(0);

    if (!flow) throw new Error("The flow isn't listed.");
    await core.revokeConsent("decision-checks", flow.flow.service.id);
    await core.checkMind(run("revoked"));
    expect(host.asked).toHaveLength(sent);
  });

  // protects=a second run reads the same sentences to the same Marks; fails_when=a Mark or its quote differs between two runs of the same Note; no_claim=a real model's run-to-run movement, which the band covers.
  test("checking twice gives the same Marks", async () => {
    const { core, client, run } = await setUp();
    await choose(core);
    await core.checkMind(run("first"));
    const first = await marks(client);

    await core.checkMind(run("second"));

    expect(await marks(client)).toEqual(first);
  });

  // protects=Stop ends a run whose sentences wait on the decision host; fails_when=the run goes on, or hangs, after Stop; no_claim=how fast a real host answers.
  test("Stop ends a run that waits on the decision host", async () => {
    const { core, host, run } = await setUp();
    await choose(core);
    const asked = Promise.withResolvers<void>();
    host.answers(() => {
      asked.resolve();
      return new Promise<Answer>(() => {});
    });

    const running = core.checkMind(run("stopped"));
    await asked.promise;
    await core.cancelCheck("stopped");

    expect(await running).toEqual({ kind: "cancelled" });
  });

  // protects=a host that refuses some requests costs no sentence its Mark: a sentence it read keeps its reading, every sentence it didn't goes to the AI model, and the run ends with no problem; fails_when=a sentence is left without a Mark, or the result carries a failure; no_claim=which sentences the host answered before it refused.
  test("a host that refuses some requests still leaves every sentence a Mark", async () => {
    const { core, client, host, run, readByAiModel, aiModelId } = await setUp([
      MOON,
      YEARLY,
      PENGUINS,
    ]);
    await choose(core);
    host.answers((state) => (state.sentence === YEARLY ? { status: 429 } : sure(state)));

    const result = await core.checkMind(run());

    expect(result).toEqual({
      kind: "checked",
      sentences: 3,
      checked: 3,
      smallModel: false,
      stop: null,
    });
    const marked = await marks(client);
    expect(marked[YEARLY]).toEqual({ state: "contradicted", quote: WEEKLY, by: aiModelId });
    expect(marked[PENGUINS]).toMatchObject({ state: "unsupported", by: aiModelId });
    expect(marked[MOON]?.state).toBe("supported");
    expect(readByAiModel()).toEqual(expect.arrayContaining([YEARLY, PENGUINS]));
  });

  // protects=only a model with measured lines can be chosen, and none while everything stays on this computer; fails_when=an unmeasured model or a host with no key is saved as the choice; no_claim=which models are measured.
  test("a model without measured lines, or a host without its key, can't be chosen", async () => {
    const { core } = await setUp();
    await expect(choose(core, { host: "openrouter", modelId: "liquid/d1-ultra" })).rejects.toThrow(
      /can’t use that decision model/,
    );
    await expect(choose(core, { host: "liquid", modelId: "d1-ultra" })).rejects.toThrow();
    expect((await core.getSettings()).device.checkDecisionModel).toBeNull();

    await choose(core);
    expect((await core.getSettings()).device.checkDecisionModel).toEqual(DECIDER);
    await choose(core, null);
    expect((await core.getSettings()).device.checkDecisionModel).toBeNull();
  });
});

describe("A decision model that reads by default (#3118)", { timeout: 30_000 }, () => {
  /** The decision-checks flow's services as Settings › Privacy lists them. */
  const listed = async (core: Core) =>
    (await core.listDataFlows())
      .filter(({ flow }) => flow.id === "decision-checks")
      .map(({ flow, consent }) => `${flow.service.id} ${consent}`);

  // protects=a User who never chose reads with the measured model where their check's AI model already runs on its host's service, and Privacy lists that from the first run; fails_when=nothing reads, the AI model is asked about a sentence the decision model decided, or Privacy doesn't list the flow; no_claim=that reading by default ships, which is one value, or that the model's scores are right.
  test("it reads where the check's AI model runs on its host's service, and Privacy lists it", async () => {
    const { core, client, run, readByAiModel, aiModelId, service } = await setUp(undefined, {
      readsByDefault: true,
    });
    expect(await listed(core)).toEqual([`${service?.id} not-asked`]);

    await core.checkMind(run());

    expect(await marks(client)).toEqual({
      [MOON]: { state: "supported", quote: TIDES_LINE, by: DECIDER.modelId },
      [YEARLY]: { state: "contradicted", quote: WEEKLY, by: DECIDER.modelId },
      [PENGUINS]: { state: "unsupported", quote: null, by: aiModelId },
    });
    expect(readByAiModel()).toEqual([PENGUINS]);
    expect(await listed(core)).toEqual([`${service?.id} accepted`]);
    expect((await core.getSettings()).device.checkDecisionModel).toBeNull();
  });

  // protects=turning it off ends it and forgets what allowed it, before its first run too, and so does taking it back in Privacy, which no later run puts back by itself; fails_when=a run reads after either, Privacy still lists the flow, or the flow is allowed again without the User; no_claim=how Settings draws the switch.
  test("off, or taken back in Privacy, ends it until the User turns it on again", async () => {
    const { core, host, run, readByAiModel, service } = await setUp(undefined, {
      readsByDefault: true,
    });
    const serviceId = service?.id ?? "";
    const readsNow = async (id: string) => {
      const before = host.asked.length;
      await core.checkMind(run(id));
      return host.asked.length > before;
    };
    await choose(core, "off");
    expect(await listed(core)).toEqual([]);
    expect(await readsNow("off before any run")).toBe(false);
    expect(readByAiModel().sort()).toEqual([MOON, YEARLY, PENGUINS].sort());

    await choose(core, null);
    expect(await readsNow("on again")).toBe(true);
    expect(await listed(core)).toEqual([`${serviceId} accepted`]);
    await choose(core, "off");
    expect(await listed(core)).toEqual([]);
    expect(await readsNow("off after a run")).toBe(false);

    await choose(core, null);
    expect(await readsNow("on once more")).toBe(true);
    await core.revokeConsent("decision-checks", serviceId);
    expect((await core.getSettings()).device.checkDecisionModel).toBe("off");
    expect(await listed(core)).toEqual([]);
    expect(await readsNow("taken back")).toBe(false);
  });

  // protects=reading by default is only for a check whose AI model runs on the decision model's own service: a key to that service saved beside an AI model elsewhere sends it nothing, and neither does Local mode; fails_when=the host is asked for a check that goes to another service, or in Local mode; no_claim=which services host a measured model.
  test("a check whose AI model runs elsewhere, or Local mode, sends the host nothing", async () => {
    const { core, host, run } = await setUp(undefined, { readsByDefault: true });
    const elsewhere = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (elsewhere.service) await core.allowDataFlow("checks", elsewhere.service.id);

    const checked = await core.checkMind({
      ...run("elsewhere"),
      model: { providerId: elsewhere.id, modelId: "claude-haiku-5-5" },
    });
    expect(checked).toMatchObject({ kind: "checked", checked: 3 });
    expect(host.asked).toEqual([]);

    await core.setLocalOnly(true);
    await core.checkMind(run("local"));
    expect(host.asked).toEqual([]);
  });

  // protects=reading by default rests on the User having allowed checks to that service: one who took that back, and declines when asked, sends the decision model's host nothing and Privacy lists no flow to it; fails_when=the host is asked, or the flow is listed or recorded; no_claim=what the check itself says when the User declines.
  test("a User who hasn't allowed checks to that service sends the host nothing", async () => {
    const { core, host, run, service, declineFromNow } = await setUp(undefined, {
      readsByDefault: true,
    });
    await core.revokeConsent("checks", service?.id ?? "");
    declineFromNow();
    expect(await listed(core)).toEqual([]);

    const result = await core.checkMind(run());

    expect(result.kind).not.toBe("checked");
    expect(host.asked).toEqual([]);
    expect(await listed(core)).toEqual([]);
  });

  // protects=with reading by default not shipped, a User who never chose is read by no decision model; fails_when=the host is asked; no_claim=nothing more.
  test("it reads nothing where it isn't on by default", async () => {
    const { core, host, run } = await setUp();
    await core.checkMind(run());
    expect(host.asked).toEqual([]);
  });
});
