import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type {
  AnswerToolCall,
  ApprovalRequest,
  Connector,
  Core,
  CoreEvents,
  Keychain,
} from "../../src/core";
import { answerEnded, askAndFinish, askNew } from "../helpers/citations";
import {
  logFileIn,
  markServerLog,
  serverLog,
  testProcesses,
  tideServer,
  waitForState,
} from "../helpers/connectors";
import {
  createMemoryKeychain,
  createTempDataFolder,
  nextEvent,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerIn, answerText } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { importSkill, simpleSkillMd, writeFolder } from "../helpers/skills";

const BOOK = "tides__book_boat";
const LOOKUP = "tides__lookup_tide";

/**
 * A model that calls one of the Connector's Tools once (`book_boat` unless
 * told otherwise), then answers with what the call gave back.
 */
function toolModel(tool = BOOK): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall) => {
    const result = call.results.find((each) => each.tool === tool);
    if (!result) return { text: "One moment.", calls: [{ tool, input: { place: "Dover" } }] };
    return { text: `The Connector said: ${result.text}` };
  });
}

interface SetUpOptions {
  dataDir?: string;
  keychain?: Keychain;
  logFile?: string;
}

/**
 * A core with a local chat model, the tiny server as a ready Connector whose
 * data flow the User accepts whenever asked, and a Mind with a client.
 */
async function setUp(model: MockLanguageModelV4, options: SetUpOptions = {}) {
  const dataDir = options.dataDir ?? (await createTempDataFolder());
  const core = startCore(dataDir, {
    keychain: options.keychain ?? createMemoryKeychain(),
    createChatModel: scriptedModels(model).createChatModel,
    processes: testProcesses(),
  });
  acceptConsent(core);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const logFile = options.logFile ?? logFileIn(dataDir);
  const connector = await core.addConnector(tideServer(logFile));
  await waitForState(core, connector.id, "ready");
  const mind = await core.createMind({ title: "Boats" });
  const client = await connectToMind(core, mind.id);
  return { core, dataDir, connector, logFile, mind, client };
}

/** Accepts every consent request: these tests are about approvals, not consent. */
function acceptConsent(core: Core) {
  core.on("consent.requested", (request) => {
    void core.respondToConsent(request.requestId, true);
  });
}

/** The Tool calls that reached the tiny server, by Tool name. */
async function callsReceived(logFile: string): Promise<string[]> {
  return (await serverLog(logFile)).flatMap((record) =>
    record.event === "call" ? [record.tool] : [],
  );
}

const toolCallsOf = (client: MindClient, answerId: string): AnswerToolCall[] =>
  JSON.parse(String(answerIn(client, answerId).attrs.toolCalls ?? "[]")) as AnswerToolCall[];

/** Collects every approval request and resolution the core announces. */
function recordApprovals(core: Core) {
  const requested: ApprovalRequest[] = [];
  const resolved: CoreEvents["approval.resolved"][] = [];
  core.on("approval.requested", (request) => requested.push(request));
  core.on("approval.resolved", (event) => resolved.push(event));
  return { requested, resolved };
}

describe("A Tool that may change something asks first", { timeout: 30_000 }, () => {
  test("its call pauses the Answer with an approval request: the Tool, its Connector and the arguments, and nothing is sent until the User decides", async () => {
    const model = toolModel();
    const { core, connector, logFile, mind, client } = await setUp(model);

    const requested = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "Book me a boat from Dover.");
    const request = await requested;

    expect(request).toEqual({
      requestId: expect.any(String),
      mindId: mind.id,
      answerId,
      toolCallId: expect.any(String),
      subject: { kind: "tool", connectorId: connector.id, tool: "book_boat" },
      connector: { id: connector.id, name: "Tides" },
      tool: "book_boat",
      title: null,
      input: { place: "Dover" },
      readOnly: false,
      // What the call can do: change something at the Connector's service, sending it data.
      effects: ["write", "network"].map((action) => ({
        action,
        scope: { kind: "service", serviceId: `connector:${connector.id}`, name: "Tides" },
      })),
      // Nothing untrusted was read before it: there are no Documents to search.
      tainted: false,
    });
    expect(await core.listApprovalRequests()).toEqual([request]);
    // Paused: the card says it waits, the model wasn't asked again, and the server got nothing.
    await vi.waitFor(() =>
      expect(toolCallsOf(client, answerId)).toEqual([
        {
          id: request.toolCallId,
          tool: "book_boat",
          source: "connector",
          connector: { id: connector.id, name: "Tides" },
          input: { place: "Dover" },
          status: "running",
          resultCount: null,
          approval: "waiting",
        },
      ]),
    );
    expect(answerIn(client, answerId).attrs.status).toBe("streaming");
    expect(model.doStreamCalls).toHaveLength(1);

    // Nothing is sent until the User decides: the call is in the server's log after this mark.
    await markServerLog(logFile, "decided");
    const ended = answerEnded(core, answerId);
    await core.respondToApproval(request.requestId, "allow-once");
    expect((await ended).payload).toMatchObject({ status: "done" });
    expect((await serverLog(logFile)).map((record) => record.event)).toEqual([
      "start",
      "mark",
      "call",
    ]);
  });

  // protects=the wait an Answer keeps for its first words leaves out the time the User took to decide; fails_when=the wait includes the second the approval stood open; no_claim=the time before the approval is whatever the machine takes.
  test("the time the User takes to decide isn't in how long the Answer waited for its words", async () => {
    const { core, mind } = await setUp(toolModel());
    const requested = nextEvent(core, "approval.requested");
    const ended = new Promise<string>((resolve) => {
      const stop = core.on("answer.finished", ({ answerId }) => {
        stop();
        resolve(answerId);
      });
    });
    const asked = await core.askInConversation({
      text: "Book me a boat from Dover.",
      mindId: mind.id,
    });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    const request = await requested;
    const decidedAfter = 1_000;
    await new Promise((resolve) => setTimeout(resolve, decidedAfter));
    await core.respondToApproval(request.requestId, "allow-once");
    const answerId = await ended;
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");
    expect(answer.steps?.firstWordMs).toBeLessThan(decidedAfter);
  });

  test("Allow once: the call is made and the Answer carries on to the end; the next call asks again", async () => {
    const { core, logFile, mind, client } = await setUp(toolModel());
    const { requested, resolved } = recordApprovals(core);

    const first = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "Book me a boat from Dover.");
    const ended = answerEnded(core, answerId);
    await core.respondToApproval((await first).requestId, "allow-once");

    expect((await ended).payload).toMatchObject({ status: "done" });
    expect(answerText(client, answerId)).toBe("The Connector said: Booked a boat trip from Dover.");
    expect(await callsReceived(logFile)).toEqual(["book_boat"]);
    expect(resolved).toEqual([{ requestId: requested[0]?.requestId, decision: "allow-once" }]);
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "book_boat", input: { place: "Dover" }, status: "done", approval: "allowed" },
    ]);
    expect(await core.listApprovalRequests()).toEqual([]);
    expect(await core.listApprovalPolicies()).toEqual([]);

    // Allowed once only: asking again asks again.
    const second = nextEvent(core, "approval.requested");
    const again = await askNew(core, client, mind.id, "And another from Dover.");
    const endedAgain = answerEnded(core, again);
    await core.respondToApproval((await second).requestId, "allow-once");
    await endedAgain;
    expect(requested).toHaveLength(2);
    expect(await callsReceived(logFile)).toEqual(["book_boat", "book_boat"]);
  });

  test("Always allow: the call is made, the policy is kept, and later calls of the Tool don't ask", async () => {
    const { core, connector, logFile, mind, client } = await setUp(toolModel());
    const { requested } = recordApprovals(core);
    const changes: CoreEvents["approvals.changed"][] = [];
    core.on("approvals.changed", (policies) => changes.push(policies));

    const asked = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "Book me a boat from Dover.");
    const ended = answerEnded(core, answerId);
    await core.respondToApproval((await asked).requestId, "always-allow");
    await ended;

    const policy = {
      id: expect.any(String),
      subject: { kind: "tool", connectorId: connector.id, tool: "book_boat" },
      policy: "always",
      ownerName: "Tides",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    };
    expect(await core.listApprovalPolicies()).toEqual([policy]);
    expect(changes).toEqual([[policy]]);
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "book_boat", status: "done", approval: "allowed" },
    ]);

    const { answerId: next } = await askAndFinish(core, client, mind.id, "Another one, please.");
    expect(requested).toHaveLength(1);
    expect(await callsReceived(logFile)).toEqual(["book_boat", "book_boat"]);
    // It didn't ask, so its card has no approval to show; it still shows the arguments sent.
    const [call] = toolCallsOf(client, next);
    expect(call).toMatchObject({ tool: "book_boat", input: { place: "Dover" }, status: "done" });
    expect(call).not.toHaveProperty("approval");
  });

  test("Always allow also lets calls of the same Tool already waiting go ahead", async () => {
    const model = scriptedModel((call: ModelCall) =>
      call.results.length === 0
        ? {
            calls: [
              { tool: BOOK, input: { place: "Dover" } },
              { tool: BOOK, input: { place: "Calais" } },
            ],
          }
        : { text: `Done: ${call.results.map((each) => each.text).join(" ")}` },
    );
    const { core, logFile, mind, client } = await setUp(model);
    const { requested, resolved } = recordApprovals(core);

    const answerId = await askNew(core, client, mind.id, "Book boats from Dover and Calais.");
    const ended = answerEnded(core, answerId);
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    await core.respondToApproval((requested[0] as ApprovalRequest).requestId, "always-allow");

    expect((await ended).payload).toMatchObject({ status: "done" });
    expect(resolved.map((each) => each.decision)).toEqual(["always-allow", "always-allow"]);
    expect((await callsReceived(logFile)).sort()).toEqual(["book_boat", "book_boat"]);
    expect(answerText(client, answerId)).toContain("Booked a boat trip from Calais.");
  });

  test("Deny: the call isn't made, the model gets a Tool result saying the User denied it, and the Answer carries on", async () => {
    const model = toolModel();
    const { core, logFile, mind, client } = await setUp(model);
    const consents: unknown[] = [];
    core.on("consent.requested", (request) => consents.push(request));

    const asked = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "Book me a boat from Dover.");
    const ended = answerEnded(core, answerId);
    const request = await asked;
    const resolved = nextEvent(core, "approval.resolved");
    await core.respondToApproval(request.requestId, "deny");

    expect(await resolved).toEqual({ requestId: request.requestId, decision: "deny" });
    expect((await ended).payload).toMatchObject({ status: "done" });
    expect(answerText(client, answerId)).toBe(
      "The Connector said: The User denied this call of book_boat (from the Connector \"Tides\"), so it wasn't made and nothing was sent. Carry on without it, don't call it again, and say what wasn't done.",
    );
    // A Tool result, not an error, and nothing reached the Connector: not even a consent question.
    const lastPrompt = model.doStreamCalls[1]?.prompt ?? [];
    const result = lastPrompt
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .find((part) => part.type === "tool-result");
    expect(result).toMatchObject({ toolName: BOOK, output: { type: "text" } });
    expect(await callsReceived(logFile)).toEqual([]);
    expect(consents).toEqual([]);
    // The card shows what the model wanted to send, and that it was denied.
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "book_boat", input: { place: "Dover" }, status: "failed", approval: "denied" },
    ]);
    expect(await core.listApprovalPolicies()).toEqual([]);
  });

  test("Stop while waiting for approval ends the wait at once: the request is withdrawn and nothing is sent", async () => {
    const { core, logFile, mind, client } = await setUp(toolModel());

    const asked = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "Book me a boat from Dover.");
    const request = await asked;
    const ended = answerEnded(core, answerId);
    const resolved = nextEvent(core, "approval.resolved");
    await core.stopAnswer({ mindId: mind.id, answerId });

    expect(await resolved).toEqual({ requestId: request.requestId, decision: "deny" });
    expect((await ended).payload).toMatchObject({ status: "stopped" });
    expect(await core.listApprovalRequests()).toEqual([]);
    expect(answerIn(client, answerId).attrs.status).toBe("stopped");
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "book_boat", status: "failed", approval: "denied" },
    ]);

    // Deciding afterwards, e.g. in another window, does nothing: it resolves no request.
    const later = recordApprovals(core);
    await core.respondToApproval(request.requestId, "allow-once");
    expect(later.resolved).toEqual([]);
    expect(await callsReceived(logFile)).toEqual([]);
  });

  test("closing IncarnaMind while a call waits denies it: after a restart the Answer is stopped, its card says so, and nothing was sent", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const first = await setUp(toolModel(), { dataDir, keychain });

    const asked = nextEvent(first.core, "approval.requested");
    const resolved = nextEvent(first.core, "approval.resolved");
    const answerId = await askNew(first.core, first.client, first.mind.id, "Book me a boat.");
    const request = await asked;
    first.core.close();

    expect(await resolved).toEqual({ requestId: request.requestId, decision: "deny" });
    const second = startCore(dataDir, {
      keychain,
      createChatModel: scriptedModels(toolModel()).createChatModel,
      processes: testProcesses(),
    });
    await waitForState(second, first.connector.id, "ready");
    expect(await second.listApprovalRequests()).toEqual([]);
    const client = await connectToMind(second, first.mind.id);
    expect(answerIn(client, answerId).attrs.status).toBe("stopped");
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "book_boat", input: { place: "Dover" }, status: "failed", approval: "denied" },
    ]);
    expect(await callsReceived(first.logFile)).toEqual([]);
  });
});

describe("Read-only marks are hints from the Connector", { timeout: 30_000 }, () => {
  test("a Tool its Connector says only reads runs without asking, until the User switches it to ask", async () => {
    const { core, connector, logFile, mind, client } = await setUp(toolModel(LOOKUP));
    const { requested } = recordApprovals(core);

    await askAndFinish(core, client, mind.id, "When is high tide?");
    expect(requested).toEqual([]);
    expect(await callsReceived(logFile)).toEqual(["lookup_tide"]);

    const subject = { kind: "tool", connectorId: connector.id, tool: "lookup_tide" } as const;
    expect(await core.setApprovalPolicy({ subject, policy: "ask" })).toMatchObject({
      subject,
      policy: "ask",
      ownerName: "Tides",
    });
    expect(await core.listApprovalPolicies()).toMatchObject([{ subject, policy: "ask" }]);

    const asked = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "And tomorrow?");
    const ended = answerEnded(core, answerId);
    const request = await asked;
    // The card can say the Connector claims it only reads.
    expect(request).toMatchObject({
      tool: "lookup_tide",
      title: "Look up the tides",
      readOnly: true,
    });
    expect(await callsReceived(logFile)).toEqual(["lookup_tide"]);
    await core.respondToApproval(request.requestId, "allow-once");
    await ended;
    expect(await callsReceived(logFile)).toEqual(["lookup_tide", "lookup_tide"]);
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "lookup_tide", status: "done", approval: "allowed" },
    ]);
  });
});

describe("Approval policies", { timeout: 30_000 }, () => {
  test("revoking a policy goes back to the default: a Tool always allowed asks again, and one switched to ask runs without asking", async () => {
    const model = scriptedModel((call: ModelCall) =>
      call.results.length === 0
        ? {
            calls: [
              { tool: BOOK, input: { place: "Dover" } },
              { tool: LOOKUP, input: { place: "Dover" } },
            ],
          }
        : { text: "Done." },
    );
    const { core, connector, mind, client } = await setUp(model);
    const { requested } = recordApprovals(core);
    const book = { kind: "tool", connectorId: connector.id, tool: "book_boat" } as const;
    const lookup = { kind: "tool", connectorId: connector.id, tool: "lookup_tide" } as const;
    await core.setApprovalPolicy({ subject: book, policy: "always" });
    await core.setApprovalPolicy({ subject: lookup, policy: "ask" });

    // The approvals page lists both, by Connector, then Tool.
    const policies = await core.listApprovalPolicies();
    expect(policies.map(({ subject, policy }) => ({ subject, policy }))).toEqual([
      { subject: book, policy: "always" },
      { subject: lookup, policy: "ask" },
    ]);

    // As set: only the read-only Tool asks.
    const answerId = await askNew(core, client, mind.id, "Book a boat when the tide is high.");
    const ended = answerEnded(core, answerId);
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    expect(requested[0]?.tool).toBe("lookup_tide");
    await core.respondToApproval((requested[0] as ApprovalRequest).requestId, "allow-once");
    await ended;

    // Revoked: back to the default, where only the Tool that may change something asks.
    const changed = nextEvent(core, "approvals.changed");
    for (const policy of policies) await core.revokeApprovalPolicy(policy.id);
    expect(await changed).toHaveLength(1);
    expect(await core.listApprovalPolicies()).toEqual([]);
    const again = await askNew(core, client, mind.id, "Once more.");
    const endedAgain = answerEnded(core, again);
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    expect(requested[1]?.tool).toBe("book_boat");
    await core.respondToApproval((requested[1] as ApprovalRequest).requestId, "deny");
    await endedAgain;
    expect(requested).toHaveLength(2);

    // Revoking one that's gone, or setting the default, changes nothing.
    await core.revokeApprovalPolicy((policies[0] as { id: string }).id);
    expect(await core.setApprovalPolicy({ subject: book, policy: null })).toBeNull();
  });

  test("policies survive a restart", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const first = await setUp(toolModel(), { dataDir, keychain });
    const book = { kind: "tool", connectorId: first.connector.id, tool: "book_boat" } as const;
    const lookup = { kind: "tool", connectorId: first.connector.id, tool: "lookup_tide" } as const;
    await first.core.setApprovalPolicy({ subject: book, policy: "always" });
    await first.core.setApprovalPolicy({ subject: lookup, policy: "ask" });
    const before = await first.core.listApprovalPolicies();
    first.core.close();

    const second = startCore(dataDir, {
      keychain,
      createChatModel: scriptedModels(toolModel()).createChatModel,
      processes: testProcesses(),
    });
    acceptConsent(second);
    expect(await second.listApprovalPolicies()).toEqual(before);
    await waitForState(second, first.connector.id, "ready");
    const { requested } = recordApprovals(second);
    const client = await connectToMind(second, first.mind.id);
    await askAndFinish(second, client, first.mind.id, "Book me a boat from Dover.");
    expect(requested).toEqual([]);
    expect(await callsReceived(first.logFile)).toEqual(["book_boat"]);
  });

  test("policies follow the sync-ready rules: UUIDs, timestamps and soft deletes", async () => {
    const { core, dataDir, connector } = await setUp(toolModel());
    const subject = { kind: "tool", connectorId: connector.id, tool: "book_boat" } as const;
    const policy = await core.setApprovalPolicy({ subject, policy: "always" });
    await core.setApprovalPolicy({ subject, policy: "ask" });

    const rows = () =>
      queryDatabase<Record<string, string | null>>(
        dataDir,
        "SELECT id, subject_kind, subject_id, policy, created_at, updated_at, deleted_at FROM approval_policies",
      );
    // Changing the policy updates the one row.
    expect(rows()).toEqual([
      {
        id: policy?.id,
        subject_kind: "tool",
        subject_id: `${connector.id}:book_boat`,
        policy: "ask",
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        deleted_at: null,
      },
    ]);
    expect(policy?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await core.revokeApprovalPolicy(policy?.id as string);
    expect(rows()).toMatchObject([{ id: policy?.id, deleted_at: expect.any(String) }]);
  });

  test("deleting a Connector removes its policies; added again, it is a new Connector that asks again", async () => {
    const { core, connector, logFile } = await setUp(toolModel());
    await core.setApprovalPolicy({
      subject: { kind: "tool", connectorId: connector.id, tool: "book_boat" },
      policy: "always",
    });

    const changed = nextEvent(core, "approvals.changed");
    await core.deleteConnector(connector.id);

    expect(await changed).toEqual([]);
    expect(await core.listApprovalPolicies()).toEqual([]);
    const again: Connector = await core.addConnector(tideServer(logFile));
    expect(await core.listApprovalPolicies()).toEqual([]);
    expect(again.id).not.toBe(connector.id);
  });

  test("a policy needs a subject that exists, and a valid value", async () => {
    const { core, connector } = await setUp(toolModel());
    const tool = { kind: "tool", connectorId: connector.id, tool: "book_boat" } as const;

    await expect(
      core.setApprovalPolicy({
        subject: { kind: "tool", connectorId: "no-such-connector", tool: "book_boat" },
        policy: "always",
      }),
    ).rejects.toThrow(/Connector doesn’t exist/);
    await expect(
      core.setApprovalPolicy({ subject: tool, policy: "sometimes" as never }),
    ).rejects.toThrow(/policy must be/);
    await expect(
      core.setApprovalPolicy({ subject: { kind: "plugin" } as never, policy: "always" }),
    ).rejects.toThrow(/subject.kind/);
    await expect(core.respondToApproval("no-such-request", "maybe" as never)).rejects.toThrow(
      /decision must be/,
    );
    // Answering a request that isn't waiting does nothing.
    await core.respondToApproval("no-such-request", "deny");
  });

  test("the policy model also covers a Skill's scripts (#41): always run, once the risk is accepted, listed under the Skill's name", async () => {
    const { core } = await setUp(toolModel());
    const sources = await createTempDataFolder();
    const skill = await importSkill(
      core,
      await writeFolder(sources, "tide-tables", {
        "SKILL.md": simpleSkillMd("tide-tables", "Read tide tables."),
      }),
    );
    const subject = { kind: "skill-script", skillId: skill.id } as const;

    await expect(core.setApprovalPolicy({ subject, policy: "ask" })).rejects.toThrow(/always ask/);
    // "Always run" only after the User has confirmed the warning.
    await expect(core.setApprovalPolicy({ subject, policy: "always" })).rejects.toThrow(
      /Confirm the risk warning/,
    );
    expect(await core.listApprovalPolicies()).toEqual([]);
    expect(
      await core.setApprovalPolicy({ subject, policy: "always", riskAccepted: true }),
    ).toMatchObject({
      subject,
      policy: "always",
      ownerName: "tide-tables",
    });

    await core.removeSkill(skill.id);
    expect(await core.listApprovalPolicies()).toEqual([]);
  });
});
