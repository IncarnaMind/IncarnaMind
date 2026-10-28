import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { AnswerToolCall, Connector, Core, CoreEvents } from "../../src/core";
import { CHAT_FLOW_SENDS } from "../../src/core/providers/chat";
import {
  answerEnded,
  askAndFinish,
  askNew,
  citationsIn,
  setUpWithDocuments,
} from "../helpers/citations";
import {
  logFileIn,
  serverLog,
  testProcesses,
  tideServer,
  waitForState,
} from "../helpers/connectors";
import { createMemoryKeychain, createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, answerText } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { importSkill, simpleSkillMd, writeFolder } from "../helpers/skills";

const LOOKUP = "tides__lookup_tide";
const BOOK = "tides__book_boat";

/**
 * A model that looks the tide up through the Connector once, then answers
 * with what it got back (or says it couldn't).
 */
function tideModel(): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall) => {
    const looked = call.results.find((result) => result.tool === LOOKUP);
    if (!looked)
      return { text: "Let me check.", calls: [{ tool: LOOKUP, input: { place: "Dover" } }] };
    return { text: `The tide service says: ${looked.text}` };
  });
}

/**
 * A core with a local chat model (no chat consent), the tiny server as a
 * ready Connector, and a Mind. Connecting it allows its Tool calls
 * (ADR-0022); `unasked`, it is as one connected before that left it.
 */
async function setUp(model: MockLanguageModelV4, { unasked = false } = {}) {
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(model);
  const core = startCore(dataDir, {
    createChatModel: models.createChatModel,
    processes: testProcesses(),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const logFile = logFileIn(dataDir);
  const connector = await core.addConnector(tideServer(logFile));
  if (unasked) await core.revokeConsent("connectors", `connector:${connector.id}`);
  await waitForState(core, connector.id, "ready");
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  return { core, models, connector, logFile, mind, client };
}

/** Answers the next consent request. */
async function answerConsent(core: Core, accept: boolean) {
  const request = await nextEvent(core, "consent.requested");
  await core.respondToConsent(request.requestId, accept);
  return request;
}

const toolCalls = (attribute: unknown): AnswerToolCall[] =>
  JSON.parse(String(attribute)) as AnswerToolCall[];

describe("Answers use Connector Tools", { timeout: 30_000 }, () => {
  test("every Tool is offered, namespaced by Connector; one marked read-only runs without asking, and its card carries the arguments sent", async () => {
    const model = tideModel();
    const { core, connector, logFile, mind, client } = await setUp(model);
    const started: CoreEvents["answer.toolCallStarted"][] = [];
    const ended: CoreEvents["answer.toolCallFinished"][] = [];
    const approvals: unknown[] = [];
    core.on("answer.toolCallStarted", (event) => started.push(event));
    core.on("answer.toolCallFinished", (event) => ended.push(event));
    core.on("approval.requested", (request) => approvals.push(request));
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    const { answerId, finished } = await askAndFinish(core, client, mind.id, "When is high tide?");

    // Connecting it allowed its Tool calls, though it runs on this computer: nothing asked.
    expect(requests).toEqual([]);
    expect(await core.listDataFlows()).toContainEqual({
      flow: {
        id: "connectors",
        service: { id: `connector:${connector.id}`, name: "Tides" },
        sends: ["tool-arguments"],
      },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: true,
    });
    // Both Tools, under the Connector's name; no Documents, so no search.
    const first = model.doStreamCalls[0];
    expect(first?.tools?.map((each) => each.name).sort()).toEqual([BOOK, LOOKUP]);
    expect(first?.tools?.find((each) => each.name === LOOKUP)).toMatchObject({
      description: expect.stringContaining('Connector "Tides"'),
    });
    const system = String(first?.prompt.find((message) => message.role === "system")?.content);
    expect(system).toMatch(/Tools from the User's Connectors \("Tides"\)/);
    // The call reached the server with the model's arguments, and the model got the result.
    expect((await serverLog(logFile)).filter((record) => record.event === "call")).toEqual([
      { event: "call", tool: "lookup_tide", arguments: { place: "Dover" } },
    ]);
    expect(answerText(client, answerId)).toBe(
      "The tide service says: High water at Dover: 06:12 and 18:40.",
    );
    // The Connector says the Tool only reads, so it didn't ask.
    expect(approvals).toEqual([]);

    // The Tool-call card: the Connector, the Tool and the arguments sent; no Citations.
    const call: AnswerToolCall = {
      id: expect.any(String),
      tool: "lookup_tide",
      source: "connector",
      connector: { id: connector.id, name: "Tides" },
      input: { place: "Dover" },
      status: "running",
      resultCount: null,
    };
    expect(started.map((event) => event.call)).toEqual([call]);
    expect(ended.map((event) => event.call)).toEqual([{ ...call, status: "done" }]);
    expect(toolCalls(answerIn(client, answerId).attrs.toolCalls)).toEqual([
      { ...call, status: "done" },
    ]);
    expect(citationsIn(client, answerId)).toEqual([]);
    expect(finished).toMatchObject({ status: "done", citations: [], citationSupport: null });
  });

  test("connecting it tells the Privacy page at once", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { processes: testProcesses() });
    const changed = nextEvent(core, "dataFlows.changed");

    const connector = await core.addConnector(tideServer(logFileIn(dataDir)));

    const connectors = (await changed).find((flow) => flow.id === "connectors");
    expect(connectors?.services).toEqual([
      expect.objectContaining({
        flow: expect.objectContaining({
          service: { id: `connector:${connector.id}`, name: "Tides" },
        }),
        consent: "accepted",
        chosen: true,
      }),
    ]);
  });

  test("connected before, it asks once: later calls through the Connector don't ask again", async () => {
    const { core, logFile, mind, client } = await setUp(tideModel(), { unasked: true });
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    const consent = answerConsent(core, true);
    await askAndFinish(core, client, mind.id, "When is high tide?");
    await consent;
    await askAndFinish(core, client, mind.id, "And tomorrow?");

    expect(requests).toEqual(["connectors"]);
    expect((await serverLog(logFile)).filter((record) => record.event === "call")).toHaveLength(2);
  });

  test("declining sends nothing to the Connector; the Answer goes on without the Tool", async () => {
    const model = tideModel();
    const { core, logFile, mind, client } = await setUp(model, { unasked: true });

    const consent = answerConsent(core, false);
    const { answerId } = await askAndFinish(core, client, mind.id, "When is high tide?");
    await consent;

    expect((await serverLog(logFile)).filter((record) => record.event === "call")).toEqual([]);
    // The model was told why, and to go on.
    expect(answerText(client, answerId)).toMatch(
      /^The tide service says: (Error: )?The User didn't allow sending data to the Connector "Tides", so lookup_tide wasn't called\. Go on without it\.$/,
    );
    expect(toolCalls(answerIn(client, answerId).attrs.toolCalls)).toMatchObject([
      { tool: "lookup_tide", input: { place: "Dover" }, status: "failed" },
    ]);

    // The decision is kept: the next Answer doesn't ask, and still sends nothing.
    const requests: unknown[] = [];
    core.on("consent.requested", (request) => requests.push(request));
    await askAndFinish(core, client, mind.id, "And tomorrow?");
    expect(requests).toEqual([]);
    expect((await serverLog(logFile)).filter((record) => record.event === "call")).toEqual([]);
  });

  test("after a restart, the Connector is back, its consent is kept, and earlier Tool-call cards are still there", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const logFile = logFileIn(dataDir);
    const start = () =>
      startCore(dataDir, {
        keychain,
        createChatModel: scriptedModels(tideModel()).createChatModel,
        processes: testProcesses(),
      });
    const first = start();
    await first.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const connector = await first.addConnector(tideServer(logFile));
    await waitForState(first, connector.id, "ready");
    const mind = await first.createMind({ title: "Tides" });
    const { answerId } = await askAndFinish(
      first,
      await connectToMind(first, mind.id),
      mind.id,
      "When is high tide?",
    );
    first.close();

    const second = start();
    const requests: unknown[] = [];
    second.on("consent.requested", (request) => requests.push(request));
    await waitForState(second, connector.id, "ready");
    const client = await connectToMind(second, mind.id);
    expect(toolCalls(answerIn(client, answerId).attrs.toolCalls)).toMatchObject([
      { tool: "lookup_tide", input: { place: "Dover" }, status: "done" },
    ]);

    await askAndFinish(second, client, mind.id, "And tomorrow?");

    expect(requests).toEqual([]);
    expect((await serverLog(logFile)).filter((record) => record.event === "call")).toHaveLength(2);
  });

  test("stopping an Answer while it waits for consent sends nothing", async () => {
    const { core, logFile, mind, client } = await setUp(tideModel(), { unasked: true });

    const requested = nextEvent(core, "consent.requested");
    const answerId = await askNew(core, client, mind.id, "When is high tide?");
    await requested;
    const ended = answerEnded(core, answerId);
    await core.stopAnswer({ mindId: mind.id, answerId });

    expect((await ended).payload).toMatchObject({ status: "stopped" });
    expect((await serverLog(logFile)).filter((record) => record.event === "call")).toEqual([]);
  });

  test("Connectors that are off, or not ready, offer no Tools", async () => {
    const model = scriptedModel(() => ({ text: "No Tools needed." }));
    const { core, connector, mind, client } = await setUp(model);
    await core.setConnectorEnabled(connector.id, false);

    await askAndFinish(core, client, mind.id, "When is high tide?");

    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
    const system = String(
      model.doStreamCalls[0]?.prompt.find((message) => message.role === "system")?.content,
    );
    expect(system).not.toMatch(/Connectors/);
  });

  test("a Tool the User turned off isn't offered to Answers; turned back on, it is", async () => {
    const model = scriptedModel(() => ({ text: "No Tools needed." }));
    const { core, connector, mind, client } = await setUp(model);
    const offered = (index: number) =>
      (model.doStreamCalls[index]?.tools ?? []).map((tool) => tool.name);

    const set = await core.setApprovalPolicy({
      subject: { kind: "tool", connectorId: connector.id, tool: "book_boat" },
      policy: "off",
    });
    expect(set).toMatchObject({ policy: "off", ownerName: "Tides" });
    await askAndFinish(core, client, mind.id, "When is high tide?");
    expect(offered(0)).toContain(LOOKUP);
    expect(offered(0)).not.toContain(BOOK);

    await core.setApprovalPolicy({
      subject: { kind: "tool", connectorId: connector.id, tool: "book_boat" },
      policy: null,
    });
    await askAndFinish(core, client, mind.id, "And tomorrow?");
    expect(offered(1)).toEqual(expect.arrayContaining([LOOKUP, BOOK]));
  });

  test("a Skill's scripts can't be turned off: they ask, or always run", async () => {
    const { core } = await setUp(scriptedModel(() => ({ text: "No Tools needed." })));
    const skill = await importSkill(
      core,
      await writeFolder(await createTempDataFolder(), "tide-tables", {
        "SKILL.md": simpleSkillMd("tide-tables", "Read tide tables."),
      }),
    );

    await expect(
      core.setApprovalPolicy({
        subject: { kind: "skill-script", skillId: skill.id },
        policy: "off",
      }),
    ).rejects.toThrow('A Skill\'s scripts always ask unless set to "always".');
  });

  test("document search, the Skill Tools and the Connector Tools are offered together, and each call's card says where it came from", async () => {
    const model = scriptedModel((call: ModelCall) =>
      call.results.length === 0
        ? {
            calls: [
              { tool: "search_documents", input: { query: "high tide" } },
              { tool: "use_skill", input: { name: "tide-tables" } },
              { tool: LOOKUP, input: { place: "Dover" } },
            ],
          }
        : { text: "Twice a day." },
    );
    const { core, mind, client } = await setUpWithDocuments(
      model,
      [{ name: "Tides.txt", contents: "High water comes twice a day." }],
      { processes: testProcesses() },
    );
    const sources = await createTempDataFolder();
    await importSkill(
      core,
      await writeFolder(sources, "tide-tables", {
        "SKILL.md": simpleSkillMd("tide-tables", "Read tide tables."),
      }),
    );
    const connector: Connector = await core.addConnector(tideServer(logFileIn(sources)));
    await waitForState(core, connector.id, "ready");

    const { answerId } = await askAndFinish(core, client, mind.id, "How often is high tide?");

    expect(model.doStreamCalls[0]?.tools?.map((each) => each.name).sort()).toEqual([
      "cite",
      "read_document",
      "read_skill_file",
      "search_documents",
      BOOK,
      LOOKUP,
      "use_skill",
    ]);
    const system = String(
      model.doStreamCalls[0]?.prompt.find((message) => message.role === "system")?.content,
    );
    expect(system).toMatch(/search_documents/);
    expect(system).toMatch(/tide-tables/);
    expect(system).toMatch(/also call Tools from the User's Connectors \("Tides"\)/);
    expect(
      toolCalls(answerIn(client, answerId).attrs.toolCalls).map(({ tool, source, status }) => ({
        tool,
        source,
        status,
      })),
    ).toEqual([
      { tool: "search_documents", source: "documents", status: "done" },
      { tool: "use_skill", source: "skill", status: "done" },
      { tool: "lookup_tide", source: "connector", status: "done" },
    ]);
  });
});

describe("The chat flow with Connectors", { timeout: 30_000 }, () => {
  test("with a Connector on, a cloud chat provider is asked again, for Tool results", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(scriptedModel(() => ({ text: "OK" }))).createChatModel,
      processes: testProcesses(),
    });
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-5.4-mini" });
    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });

    const connector = await core.addConnector({ name: "Mine", command: "tide-cli-not-installed" });

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "needed" });
    const chat = (await core.listDataFlows()).find((status) => status.flow.id === "chat");
    expect(chat?.flow.sends).toEqual([...CHAT_FLOW_SENDS, "tool-results"]);

    // Off again, chat sends what the User accepted.
    await core.setConnectorEnabled(connector.id, false);
    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });
  });

  test("choosing a cloud provider with a Connector on doesn't allow Tool results, which its line doesn't name: the first Question asks", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(scriptedModel(() => ({ text: "OK" }))).createChatModel,
      processes: testProcesses(),
    });
    await core.addConnector({ name: "Mine", command: "tide-cli-not-installed" });

    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-5.4-mini" });

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "needed" });
    const requested = nextEvent(core, "consent.requested");
    const prepared = core.prepareChatModel();
    const request = await requested;
    expect(request.newKinds).toEqual(["tool-results"]);
    await core.respondToConsent(request.requestId, true);
    await prepared;
    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });
  });

  test("Skills alone don't make it ask again: their Tools return only the Skills' own text", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(scriptedModel(() => ({ text: "OK" }))).createChatModel,
    });
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-5.4-mini" });

    const sources = await createTempDataFolder();
    await importSkill(
      core,
      await writeFolder(sources, "tide-tables", {
        "SKILL.md": simpleSkillMd("tide-tables", "Read tide tables."),
      }),
    );

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
    const chat = (await core.listDataFlows()).find((status) => status.flow.id === "chat");
    expect(chat?.flow.sends).toEqual([...CHAT_FLOW_SENDS]);
  });
});
