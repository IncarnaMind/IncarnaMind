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

const NINE = ["new", "full", "half", "red", "blue", "low", "high", "late", "early"].map(
  (moon) => `Spring tides come at the ${moon} moon.`,
);

const PLANS: Record<string, Plan> = {
  ...Object.fromEntries(NINE.map((sentence) => [sentence, { verdict: "unsupported" }])),
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
async function setUp(sentences: readonly string[] = [MOON, YEARLY, PENGUINS]) {
  const host = await startDecisionHost();
  const checks: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      checks.push(call);
      return checkReply(call, PLANS);
    },
    { generate: checkGenerate(PLANS) },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    keychain: createMemoryKeychain(),
    decisionOrigins: { openrouter: host.url },
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
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
  return { core, client, host, mindId: mind.id, run, readByAiModel, aiModelId: AI_MODEL };
}

const choose = (core: Core, model: CheckDecisionModel | null = DECIDER) =>
  core.updateSettings({ device: { checkDecisionModel: model } });

/** Each sentence's Mark as stored: its verdict, its quote and the model that gave it. */
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

  // protects=a score inside the band of its line is not a verdict: the AI model checks that sentence; fails_when=a score just over the line marks the sentence; no_claim=how wide the band should be.
  test("a score too near its line leaves the sentence to the AI model", async () => {
    const { core, client, host, run, readByAiModel, aiModelId } = await setUp();
    await choose(core);
    host.answers((state) => {
      const given = sure(state);
      return "B" in given ? { B: Math.min(given.B, 0.983), C: Math.min(given.C, 0.903) } : given;
    });

    await core.checkMind(run());

    expect(readByAiModel().sort()).toEqual([MOON, PENGUINS, YEARLY].sort());
    expect((await marks(client))[MOON]).toEqual({ state: "supported", quote: MOON, by: aiModelId });
  });

  // protects=a sentence with a figure keeps its own check, which matches each figure to its source's: the decision model never gives its verdict; fails_when=a sentence with a figure is marked by the decision model; no_claim=the figure check itself.
  test("a sentence with a figure is left to the AI model's figure check", async () => {
    const { core, host, run, readByAiModel } = await setUp([TONNES]);
    await choose(core);

    await core.checkMind(run());

    expect(host.asked).toEqual([]);
    expect(readByAiModel()).toEqual([TONNES]);
  });

  // protects=a decision host that refuses stops being asked for the rest of the run, the AI model checks every sentence, and the result says why the decision model stopped; fails_when=sentences stay unchecked, the host keeps being asked, or the failure is silent; no_claim=which failures a real host returns.
  test("a host that refuses leaves every sentence to the AI model, and the run says so", async () => {
    const { core, client, host, run, readByAiModel } = await setUp(NINE);
    await choose(core);
    host.answers(() => ({ status: 401 }));

    const result = await core.checkMind(run());

    expect(result).toMatchObject({
      kind: "checked",
      checked: 9,
      decisionStopped: { kind: "auth" },
    });
    expect(readByAiModel().sort()).toEqual([...NINE].sort());
    expect(Object.values(await marks(client)).map((mark) => mark.state)).toEqual(
      NINE.map(() => "unsupported"),
    );
    // Six sentences are checked at once: the three that start after the refusal are never sent.
    expect(new Set(host.asked.map(({ state }) => state.sentence)).size).toBeLessThanOrEqual(6);
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
