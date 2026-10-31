import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  ChatNotReadyError,
  ConsentDeclinedError,
  type Core,
  DATABASE_FILE,
  type DataFlowId,
  InvalidInputError,
  NotFoundError,
  type SaveChatProviderInput,
  type TestChatConnectionInput,
} from "../../src/core";
import { CHAT_FLOW_SENDS } from "../../src/core/providers/chat";
import { openDatabase } from "../../src/core/storage";
import {
  createMemoryKeychain,
  createTempDataFolder,
  nextEvent,
  queryDatabase,
  saveProviderUnasked,
  startCore,
  tickingClock,
} from "../helpers/core";
import { replyingModel, scriptedModels } from "../helpers/models";

/** Works both for saving a provider and for testing it. */
type ProviderInput = SaveChatProviderInput & TestChatConnectionInput;

const OPENAI: ProviderInput = {
  kind: "openai",
  apiKey: "sk-test-openai",
  modelId: "gpt-5.4-mini",
};
const OPENAI_SERVICE = { id: "https://api.openai.com", name: "OpenAI" };
const ANTHROPIC: ProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-sonnet-4-6",
};
const ANTHROPIC_SERVICE = { id: "https://api.anthropic.com", name: "Anthropic" };
const AT = "2026-09-01T09:00:00.000Z";

async function startWithModel(dataDir?: string, keychain = createMemoryKeychain()) {
  const models = scriptedModels(replyingModel());
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
    keychain,
    createChatModel: models.createChatModel,
  });
  return { core, models };
}

/** Asks for the chat model as an Answer does, and returns that with the consent request it raised. */
async function askAndWaitForConsent(core: Core) {
  const requested = nextEvent(core, "consent.requested");
  const result = core.prepareChatModel();
  // Handled here so a decline isn't reported as unhandled before the test awaits it.
  result.catch(() => undefined);
  return { result, request: await requested };
}

/** Counts the consent requests from now on. */
function countRequests(core: Core) {
  const requests: string[] = [];
  core.on("consent.requested", (request) => requests.push(request.flow.id));
  return requests;
}

describe("Choosing a service is the consent (ADR-0022)", () => {
  test("choosing the chat model's provider allows what runs by itself, and tagging and sorting wait for the User: nothing asks", async () => {
    const { core, models } = await startWithModel();
    const requests = countRequests(core);
    const changed = nextEvent(core, "dataFlows.changed");

    await core.saveChatProvider(OPENAI);

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
    await core.prepareChatModel();
    expect(models.specs).toHaveLength(1);
    expect(requests).toEqual([]);
    const allowed = (id: DataFlowId, sends: string[]) => ({
      flow: { id, service: OPENAI_SERVICE, sends },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: true,
    });
    expect(await core.listDataFlows()).toEqual([
      allowed("chat", [...CHAT_FLOW_SENDS]),
      allowed("suggestions", ["writing", "writing-passages"]),
      allowed("edits", ["selection"]),
      allowed("checks", ["selection", "passages", "verified-document", "blocks"]),
      // Tagging and sorting Documents aren't what choosing a provider allows: the User turns them on.
      {
        flow: { id: "tagging", service: OPENAI_SERVICE, sends: ["tags", "document-excerpts"] },
        consent: "not-asked",
        decidedAt: null,
        chosen: false,
      },
    ]);
    // The Privacy page hears of it at once.
    expect((await changed).find((flow) => flow.id === "chat")?.services).toEqual([
      allowed("chat", [...CHAT_FLOW_SENDS]),
    ]);
  });

  test("a User who allowed Chat before its line named the Document names, another Mind and the live Transcript is asked once more, for those alone", async () => {
    const dataDir = await createTempDataFolder();
    const { core, models } = await startWithModel(dataDir);
    await core.saveChatProvider(OPENAI);
    // As the allowance was kept before those kinds were named.
    queryDatabase(
      dataDir,
      "UPDATE data_flow_consents SET data_kinds = ? WHERE flow = 'chat' RETURNING flow",
      [JSON.stringify(["blocks", "passages"])],
    );
    const requests: string[][] = [];
    core.on("consent.requested", (request) => requests.push(request.newKinds));

    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "chat" }),
        consent: "not-asked",
        decidedAt: expect.any(String),
      }),
    );
    const first = await askAndWaitForConsent(core);
    expect(first.request.newKinds).toEqual([
      "document-names",
      "other-minds",
      "live-transcript",
      "pictures",
    ]);
    await core.respondToConsent(first.request.requestId, true);
    expect(await first.result).toMatchObject({ modelId: "gpt-5.4-mini" });

    // Once: the next Question goes without asking.
    await core.prepareChatModel();
    expect(requests).toHaveLength(1);
    expect(models.specs.length).toBeGreaterThan(0);
  });

  test("a connection test sends only the key and a fixed prompt, so it asks nothing", async () => {
    const { core, models } = await startWithModel();
    const requests = countRequests(core);

    expect(await core.testChatConnection(OPENAI)).toEqual({ ok: true });

    expect(requests).toEqual([]);
    expect(models.model.doGenerateCalls).toHaveLength(1);
    // Testing isn't choosing: nothing is allowed.
    expect(await core.listDataFlows()).toEqual([]);
  });

  test("in Local mode a connection test to a cloud provider sends nothing, and says so", async () => {
    const { core, models } = await startWithModel();
    await core.setLocalOnly(true);
    const requests = countRequests(core);

    const result = await core.testChatConnection(OPENAI);

    expect(result).toMatchObject({ ok: false, error: { kind: "local-mode" } });
    expect(models.model.doGenerateCalls).toHaveLength(0);
    expect(requests).toEqual([]);

    // The key is stored as it is: the first use after Local mode is off tests it.
    const saved = await core.saveChatProvider(OPENAI);
    expect(saved.hasApiKey).toBe(true);
    expect(models.model.doGenerateCalls).toHaveLength(0);

    await core.setLocalOnly(false);
    expect(await core.testChatConnection(OPENAI)).toEqual({ ok: true });
    expect(models.model.doGenerateCalls).toHaveLength(1);
  });

  test("in Local mode a server on this computer is still tested", async () => {
    const { core, models } = await startWithModel();
    await core.setLocalOnly(true);

    const result = await core.testChatConnection({
      kind: "openai-compatible",
      baseUrl: "http://localhost:1234/v1",
      modelId: "local-model",
    });

    expect(result).toEqual({ ok: true });
    expect(models.model.doGenerateCalls).toHaveLength(1);
  });

  test("choosing the provider again is a new choice: it replaces an earlier decline, and nothing asks", async () => {
    const { core, models } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const { result, request } = await askAndWaitForConsent(core);
    await core.respondToConsent(request.requestId, false);
    await expect(result).rejects.toThrow(ConsentDeclinedError);
    expect(await core.getChatReadiness()).toMatchObject({ reason: "consent-declined" });
    const requests = countRequests(core);

    await core.saveChatProvider(OPENAI);

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
    await core.prepareChatModel();
    expect(models.specs).toHaveLength(1);
    expect(requests).toEqual([]);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "chat" }),
        consent: "accepted",
        chosen: true,
      }),
    );
  });
});

describe("Decisions made before choosing was the consent", () => {
  test("stay as they were: a declined flow stays declined, and one never asked asks once", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const first = await startWithModel(dataDir, keychain);
    await first.core.saveChatProvider(OPENAI);
    first.core.close();
    // The data folder as it was before migration 87: decisions made in dialogs, and Questions never asked.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.exec("DELETE FROM data_flow_consents");
      db.exec("ALTER TABLE data_flow_consents DROP COLUMN chosen");
      db.run("DELETE FROM schema_migrations WHERE version = 87");
      const decided = (flow: DataFlowId, decision: string, kinds: string[]) =>
        db.run(
          `INSERT INTO data_flow_consents
             (id, flow, service_id, service_name, decision, data_kinds, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            flow,
            OPENAI_SERVICE.id,
            OPENAI_SERVICE.name,
            decision,
            JSON.stringify(kinds),
            AT,
            AT,
          ],
        );
      decided("checks", "accepted", ["selection", "passages", "verified-document", "blocks"]);
      decided("edits", "declined", []);
    } finally {
      db.close();
    }

    const { core, models } = await startWithModel(dataDir, keychain);
    const status = async (id: DataFlowId) =>
      (await core.listDataFlows()).find((each) => each.flow.id === id);
    expect(await status("checks")).toEqual({
      flow: {
        id: "checks",
        service: OPENAI_SERVICE,
        sends: ["selection", "passages", "verified-document", "blocks"],
      },
      consent: "accepted",
      decidedAt: AT,
      chosen: false,
    });
    expect(await status("edits")).toMatchObject({
      consent: "declined",
      decidedAt: AT,
      chosen: false,
    });
    expect(await status("chat")).toMatchObject({
      consent: "not-asked",
      decidedAt: null,
      chosen: false,
    });

    // Nothing is widened silently: the first Question asks, once.
    const requests = countRequests(core);
    const { result, request } = await askAndWaitForConsent(core);
    expect(request.flow).toEqual({
      id: "chat",
      service: OPENAI_SERVICE,
      sends: [...CHAT_FLOW_SENDS],
    });
    expect(models.specs).toEqual([]);
    await core.respondToConsent(request.requestId, true);
    await result;
    await core.prepareChatModel();
    expect(requests).toEqual(["chat"]);
    expect(models.specs).toHaveLength(2);
    expect(await status("chat")).toMatchObject({ consent: "accepted", chosen: false });
    expect(await status("edits")).toMatchObject({ consent: "declined" });
  });
});

describe("Data-flow consent", () => {
  test("nothing is sent until the User accepts, and the dialog says what goes where", async () => {
    const { core, models } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);

    const { result, request } = await askAndWaitForConsent(core);

    expect(request).toEqual({
      requestId: expect.any(String),
      flow: { id: "chat", service: OPENAI_SERVICE, sends: [...CHAT_FLOW_SENDS] },
      newKinds: [...CHAT_FLOW_SENDS],
    });
    expect(await core.listConsentRequests()).toEqual([request]);
    expect(models.specs).toEqual([]);

    const resolved = nextEvent(core, "consent.resolved");
    await core.respondToConsent(request.requestId, true);

    expect(await result).toMatchObject({ modelId: "gpt-5.4-mini" });
    expect(await resolved).toEqual({ requestId: request.requestId, accepted: true });
    expect(models.specs).toHaveLength(1);
    expect(await core.listConsentRequests()).toEqual([]);
  });

  test("an accepted flow isn't asked again, even after a restart", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const first = await startWithModel(dataDir, keychain);
    await saveProviderUnasked(first.core, OPENAI);
    const { result, request } = await askAndWaitForConsent(first.core);
    await first.core.respondToConsent(request.requestId, true);
    await result;
    first.core.close();

    const { core, models } = await startWithModel(dataDir, keychain);
    const requests = countRequests(core);

    await core.prepareChatModel();
    expect(requests).toEqual([]);
    expect(models.specs).toHaveLength(1);
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
    const notAsked = (id: DataFlowId, sends: string[]) => ({
      flow: { id, service: OPENAI_SERVICE, sends },
      consent: "not-asked",
      decidedAt: null,
      chosen: false,
    });
    expect(await core.listDataFlows()).toEqual([
      {
        flow: { id: "chat", service: OPENAI_SERVICE, sends: [...CHAT_FLOW_SENDS] },
        consent: "accepted",
        decidedAt: expect.any(String),
        chosen: false,
      },
      // Suggestions, Edit with AI, the checks (#96, #97) and tagging go there too.
      notAsked("suggestions", ["writing", "writing-passages"]),
      notAsked("edits", ["selection"]),
      notAsked("checks", ["selection", "passages", "verified-document", "blocks"]),
      notAsked("tagging", ["tags", "document-excerpts"]),
    ]);
  });

  test("declining sends nothing and keeps Questions disabled until another provider is chosen", async () => {
    const { core, models } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "needed" });

    const { result, request } = await askAndWaitForConsent(core);
    await core.respondToConsent(request.requestId, false);

    await expect(result).rejects.toThrow(ConsentDeclinedError);
    expect(models.specs).toEqual([]);
    expect(await core.getChatReadiness()).toMatchObject({
      ready: false,
      reason: "consent-declined",
      provider: { kind: "openai" },
    });

    // The service stays unused: asking again doesn't raise another dialog or send anything.
    const requests = countRequests(core);
    await expect(core.prepareChatModel()).rejects.toThrow(ChatNotReadyError);
    expect(requests).toEqual([]);
    expect(models.specs).toEqual([]);

    // A local model makes Questions available again.
    await core.saveChatProvider({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      modelId: "qwen3:4b",
    });
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "not-required" });

    // So does another cloud provider: choosing it allows its flows.
    await core.saveChatProvider(ANTHROPIC);
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
  });

  test("consent is recorded per service", async () => {
    const { core } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const openai = await askAndWaitForConsent(core);
    await core.respondToConsent(openai.request.requestId, true);
    await openai.result;

    await saveProviderUnasked(core, ANTHROPIC);
    const anthropic = await askAndWaitForConsent(core);

    expect(anthropic.request.flow.service).toEqual(ANTHROPIC_SERVICE);
    await core.respondToConsent(anthropic.request.requestId, false);
    await anthropic.result.catch(() => undefined);
    expect(await core.listDataFlows()).toEqual([
      expect.objectContaining({
        flow: expect.objectContaining({ service: OPENAI_SERVICE }),
        consent: "accepted",
      }),
      expect.objectContaining({
        flow: expect.objectContaining({ service: ANTHROPIC_SERVICE }),
        consent: "declined",
      }),
      // Edit with AI, checks, suggestions and tagging go to the default model's service only: Anthropic, saved last.
      expect.objectContaining({
        flow: expect.objectContaining({ id: "suggestions", service: ANTHROPIC_SERVICE }),
        consent: "not-asked",
      }),
      expect.objectContaining({
        flow: expect.objectContaining({ id: "edits", service: ANTHROPIC_SERVICE }),
        consent: "not-asked",
      }),
      expect.objectContaining({
        flow: expect.objectContaining({ id: "checks", service: ANTHROPIC_SERVICE }),
        consent: "not-asked",
      }),
      expect.objectContaining({
        flow: expect.objectContaining({ id: "tagging", service: ANTHROPIC_SERVICE }),
        consent: "not-asked",
      }),
    ]);
  });

  test("revoking forgets the decision: the next request asks again", async () => {
    const { core, models } = await startWithModel();
    await core.saveChatProvider(OPENAI);

    const readinessChanged = nextEvent(core, "chatReadiness.changed");
    await core.revokeConsent("chat", OPENAI_SERVICE.id);

    expect(await readinessChanged).toMatchObject({ ready: true, consent: "needed" });
    expect(await core.listDataFlows()).toEqual([
      expect.objectContaining({
        flow: expect.objectContaining({ id: "chat" }),
        consent: "not-asked",
        decidedAt: null,
      }),
      // Revoking one flow leaves the others allowed.
      expect.objectContaining({
        flow: expect.objectContaining({ id: "suggestions" }),
        consent: "accepted",
      }),
      expect.objectContaining({
        flow: expect.objectContaining({ id: "edits" }),
        consent: "accepted",
      }),
      expect.objectContaining({
        flow: expect.objectContaining({ id: "checks" }),
        consent: "accepted",
      }),
      expect.objectContaining({
        flow: expect.objectContaining({ id: "tagging" }),
        consent: "not-asked",
      }),
    ]);
    const second = await askAndWaitForConsent(core);
    expect(models.specs).toEqual([]);
    await core.respondToConsent(second.request.requestId, true);
    expect(await second.result).toMatchObject({ modelId: "gpt-5.4-mini" });
  });

  test("revoking a decline lets the User change their mind", async () => {
    const { core } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const declined = await askAndWaitForConsent(core);
    await core.respondToConsent(declined.request.requestId, false);
    await declined.result.catch(() => undefined);

    await core.revokeConsent("chat", OPENAI_SERVICE.id);

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "needed" });
  });

  test("a decision on a provider no longer saved is listed, so it can be revoked", async () => {
    const { core } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const declined = await askAndWaitForConsent(core);
    await core.respondToConsent(declined.request.requestId, false);
    await declined.result.catch(() => undefined);
    const [provider] = await core.listChatProviders();
    if (!provider) throw new Error("The provider wasn't saved.");
    await core.deleteChatProvider(provider.id);

    expect(await core.listDataFlows()).toEqual([
      {
        flow: { id: "chat", service: OPENAI_SERVICE, sends: [...CHAT_FLOW_SENDS] },
        consent: "declined",
        decidedAt: expect.any(String),
        chosen: false,
      },
    ]);
    await core.revokeConsent("chat", OPENAI_SERVICE.id);
    expect(await core.listDataFlows()).toEqual([]);
  });

  test("a flow that starts sending a new kind of data asks again, for the new kind", async () => {
    const { core, models } = await startWithModel();
    await core.saveChatProvider(OPENAI);

    // E.g. once Connectors exist, Answers also send Tool results: the line the User chose by didn't name them.
    const chat = core.dataFlows.get("chat");
    if (!chat) throw new Error("The chat flow isn't registered.");
    core.dataFlows.register({ ...chat, sends: [...chat.sends, "tool-results"] });

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "needed" });
    // Listed as not asked, but with the earlier decision's date: it asks again, it wasn't never asked.
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({ consent: "not-asked", decidedAt: expect.any(String) }),
    );
    const second = await askAndWaitForConsent(core);
    expect(second.request.flow.sends).toEqual([...CHAT_FLOW_SENDS, "tool-results"]);
    expect(second.request.newKinds).toEqual(["tool-results"]);
    expect(models.specs).toEqual([]);

    await core.respondToConsent(second.request.requestId, true);
    expect(await second.result).toMatchObject({ modelId: "gpt-5.4-mini" });
    expect((await core.listDataFlows())[0]).toMatchObject({ consent: "accepted" });
  });

  test("requests made while a dialog is open wait for the same answer", async () => {
    const { core, models } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const requests = countRequests(core);

    const first = core.prepareChatModel();
    const second = core.prepareChatModel();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const [request] = await core.listConsentRequests();
    if (!request) throw new Error("Nothing asked.");
    await core.respondToConsent(request.requestId, true);

    await Promise.all([first, second]);
    expect(requests).toHaveLength(1);
    expect(models.specs).toHaveLength(2);
  });

  test("answering a request twice, or one that doesn't exist, changes nothing", async () => {
    const { core } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const { result, request } = await askAndWaitForConsent(core);
    await core.respondToConsent(request.requestId, true);
    await result;

    await core.respondToConsent(request.requestId, false);
    await core.respondToConsent("no-such-request", false);

    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
  });

  test("Answers get a model only once the User has accepted its flow", async () => {
    const { core, models } = await startWithModel();
    await expect(core.prepareChatModel()).rejects.toThrow(ChatNotReadyError);
    await saveProviderUnasked(core, OPENAI);

    const { result, request } = await askAndWaitForConsent(core);
    expect(models.specs).toEqual([]);
    await core.respondToConsent(request.requestId, true);

    // The provider's model, counted by the meter on its way out.
    expect(await result).toMatchObject({
      model: { provider: models.model.provider, modelId: models.model.modelId },
      modelId: "gpt-5.4-mini",
    });
    expect(models.specs).toEqual([
      {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-openai",
        modelId: "gpt-5.4-mini",
        thinking: "summary",
      },
    ]);
  });

  test("Answers get no model after the User declined", async () => {
    const { core, models } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const { result, request } = await askAndWaitForConsent(core);
    await core.respondToConsent(request.requestId, false);

    await expect(result).rejects.toThrow(ConsentDeclinedError);
    await expect(core.prepareChatModel()).rejects.toThrow(ChatNotReadyError);
    expect(models.specs).toEqual([]);
  });
});

describe("Data flows on the Privacy page", () => {
  test("every registered flow is listed with what it sends, even one that sends nothing now", async () => {
    const { core } = await startWithModel();
    const flow = async (id: DataFlowId) =>
      (await core.listRegisteredDataFlows()).find((each) => each.id === id);

    // Every flow the core registers, whatever features add theirs.
    expect((await core.listRegisteredDataFlows()).map((each) => each.id)).toEqual(
      core.dataFlows.list().map((definition) => definition.id),
    );
    expect(await flow("chat")).toEqual({ id: "chat", sends: [...CHAT_FLOW_SENDS], services: [] });
    expect(await flow("tagging")).toEqual({
      id: "tagging",
      sends: ["tags", "document-excerpts"],
      services: [],
    });

    await core.saveChatProvider(OPENAI);
    expect(await flow("chat")).toEqual({
      id: "chat",
      sends: [...CHAT_FLOW_SENDS],
      services: [
        {
          flow: { id: "chat", service: OPENAI_SERVICE, sends: [...CHAT_FLOW_SENDS] },
          consent: "accepted",
          decidedAt: expect.any(String),
          chosen: true,
        },
      ],
    });
    expect(await flow("tagging")).toMatchObject({ services: [expect.anything()] });
  });

  test("a flow registered later, e.g. by a new feature, is listed too", async () => {
    const { core } = await startWithModel();
    const later = "a-later-feature" as DataFlowId; // Stands for a flow a later ticket adds.
    const service = { id: "https://later.example.com", name: "Later" };

    core.dataFlows.register({
      id: later,
      sends: ["tool-results"],
      services: async () => [service],
    });

    const flows = await core.listRegisteredDataFlows();
    expect(flows.at(-1)).toEqual({
      id: later,
      sends: ["tool-results"],
      services: [
        {
          flow: { id: later, service, sends: ["tool-results"] },
          consent: "not-asked",
          decidedAt: null,
          chosen: false,
        },
      ],
    });
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({ flow: expect.objectContaining({ id: later }) }),
    );
  });

  test("a declined flow can be allowed again in Settings: nothing asks, and it is sent", async () => {
    const { core, models } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const declined = await askAndWaitForConsent(core);
    await core.respondToConsent(declined.request.requestId, false);
    await declined.result.catch(() => undefined);

    const changed = nextEvent(core, "dataFlows.changed");
    const readiness = nextEvent(core, "chatReadiness.changed");
    await core.allowDataFlow("chat", OPENAI_SERVICE.id);

    const chat = (await changed).find((flow) => flow.id === "chat");
    expect(chat?.services).toEqual([
      // Allowed here, not by choosing the provider.
      expect.objectContaining({
        consent: "accepted",
        decidedAt: expect.any(String),
        chosen: false,
      }),
    ]);
    expect(await readiness).toMatchObject({ ready: true, consent: "accepted" });
    const requests = countRequests(core);
    await core.prepareChatModel();
    expect(requests).toEqual([]);
    expect(models.specs).toHaveLength(1);
  });

  test("revoke and allow again: after revoking the next request asks, after allowing it doesn't", async () => {
    const { core } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const chatStatus = async () =>
      (await core.listRegisteredDataFlows()).find((flow) => flow.id === "chat")?.services[0];

    // Allowed before ever being asked.
    await core.allowDataFlow("chat", OPENAI_SERVICE.id);
    expect(await chatStatus()).toMatchObject({ consent: "accepted" });

    await core.revokeConsent("chat", OPENAI_SERVICE.id);
    expect(await chatStatus()).toMatchObject({ consent: "not-asked", decidedAt: null });
    expect(await core.getChatReadiness()).toMatchObject({ consent: "needed" });

    await core.allowDataFlow("chat", OPENAI_SERVICE.id);
    expect(await chatStatus()).toMatchObject({ consent: "accepted" });
    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });
  });

  test("Undo of a revoke brings the decision back as it was: chosen, the date, the kinds accepted then", async () => {
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
      now: tickingClock(),
    });
    await core.saveChatProvider(OPENAI);
    const chatStatus = async () =>
      (await core.listRegisteredDataFlows()).find((flow) => flow.id === "chat")?.services[0];
    const before = await chatStatus();
    expect(before).toMatchObject({
      consent: "accepted",
      chosen: true,
      decidedAt: expect.any(String),
    });

    const revokedAt = await core.revokeConsent("chat", OPENAI_SERVICE.id);
    if (!revokedAt) throw new Error("There was no decision to revoke.");
    const changed = nextEvent(core, "dataFlows.changed");
    const readiness = nextEvent(core, "chatReadiness.changed");
    await core.restoreConsent("chat", OPENAI_SERVICE.id, revokedAt);

    expect((await changed).find((flow) => flow.id === "chat")?.services).toEqual([before]);
    expect(await readiness).toMatchObject({ ready: true, consent: "accepted" });

    // Taken back again, then the flow sends more: the decision comes back without the new kind.
    const again = await core.revokeConsent("chat", OPENAI_SERVICE.id);
    if (!again) throw new Error("There was no decision to revoke.");
    const chat = core.dataFlows.get("chat");
    if (!chat) throw new Error("The chat flow isn't registered.");
    core.dataFlows.register({ ...chat, sends: [...chat.sends, "tool-results"] });
    await core.restoreConsent("chat", OPENAI_SERVICE.id, again);
    expect(await core.getChatReadiness()).toMatchObject({ consent: "needed" });
  });

  test("Undo of a revoke leaves a decision made since, and a revoke with nothing to forget gives no time", async () => {
    const { core } = await startWithModel();
    await core.saveChatProvider(OPENAI);
    const revokedAt = await core.revokeConsent("chat", OPENAI_SERVICE.id);
    if (!revokedAt) throw new Error("There was no decision to revoke.");
    expect(await core.revokeConsent("chat", OPENAI_SERVICE.id)).toBeNull();

    const declined = await askAndWaitForConsent(core);
    await core.respondToConsent(declined.request.requestId, false);
    await declined.result.catch(() => undefined);
    await core.restoreConsent("chat", OPENAI_SERVICE.id, revokedAt);

    expect(await core.getChatReadiness()).toMatchObject({
      ready: false,
      reason: "consent-declined",
    });
    await expect(
      core.restoreConsent("chat", OPENAI_SERVICE.id, undefined as unknown as string),
    ).rejects.toThrow(InvalidInputError);
  });

  test("Undo of an older revoke can't bring a decision back after a later allow and stop", async () => {
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
      now: tickingClock(),
    });
    await core.saveChatProvider(OPENAI);
    const chatConsent = async () =>
      (await core.listDataFlows()).find(
        (each) => each.flow.id === "chat" && each.flow.service.id === OPENAI_SERVICE.id,
      )?.consent;

    const first = await core.revokeConsent("chat", OPENAI_SERVICE.id);
    await core.allowDataFlow("chat", OPENAI_SERVICE.id);
    const second = await core.revokeConsent("chat", OPENAI_SERVICE.id);
    if (!first || !second) throw new Error("There was no decision to revoke.");
    expect(await chatConsent()).toBe("not-asked");

    await core.restoreConsent("chat", OPENAI_SERVICE.id, first);
    expect(await chatConsent()).toBe("not-asked");
    await core.restoreConsent("chat", OPENAI_SERVICE.id, second);
    expect(await chatConsent()).toBe("accepted");
  });

  test("Undo of a revoke answers a dialog waiting for the same flow and service, unless the flow has grown", async () => {
    const { core } = await startWithModel();
    await core.saveChatProvider(OPENAI);
    const revokedAt = await core.revokeConsent("chat", OPENAI_SERVICE.id);
    if (!revokedAt) throw new Error("There was no decision to revoke.");
    const { result, request } = await askAndWaitForConsent(core);

    const resolved = nextEvent(core, "consent.resolved");
    await core.restoreConsent("chat", OPENAI_SERVICE.id, revokedAt);

    expect(await resolved).toEqual({ requestId: request.requestId, accepted: true });
    expect(await result).toMatchObject({ modelId: "gpt-5.4-mini" });
    expect(await core.listConsentRequests()).toEqual([]);

    // Grown since it was forgotten: what is new still asks.
    const again = await core.revokeConsent("chat", OPENAI_SERVICE.id);
    if (!again) throw new Error("There was no decision to revoke.");
    const chat = core.dataFlows.get("chat");
    if (!chat) throw new Error("The chat flow isn't registered.");
    core.dataFlows.register({ ...chat, sends: [...chat.sends, "tool-results"] });
    const waiting = await askAndWaitForConsent(core);
    await core.restoreConsent("chat", OPENAI_SERVICE.id, again);
    expect(await core.listConsentRequests()).toEqual([waiting.request]);
    await core.respondToConsent(waiting.request.requestId, false);
    await waiting.result.catch(() => undefined);
  });

  test("allowing a flow while its dialog is open answers the dialog", async () => {
    const { core } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);
    const { result, request } = await askAndWaitForConsent(core);

    const resolved = nextEvent(core, "consent.resolved");
    await core.allowDataFlow("chat", OPENAI_SERVICE.id);

    expect(await resolved).toEqual({ requestId: request.requestId, accepted: true });
    expect(await result).toMatchObject({ modelId: "gpt-5.4-mini" });
    expect(await core.listConsentRequests()).toEqual([]);
  });

  test("allowing also accepts the kinds of data a flow started sending since", async () => {
    const { core } = await startWithModel();
    await core.saveChatProvider(OPENAI);
    const chat = core.dataFlows.get("chat");
    if (!chat) throw new Error("The chat flow isn't registered.");
    core.dataFlows.register({ ...chat, sends: [...chat.sends, "tool-results"] });
    expect(await core.getChatReadiness()).toMatchObject({ consent: "needed" });

    await core.allowDataFlow("chat", OPENAI_SERVICE.id);

    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });
  });

  test("only a service the flow goes to, or was decided on, can be allowed", async () => {
    const { core } = await startWithModel();
    await saveProviderUnasked(core, OPENAI);

    await expect(core.allowDataFlow("chat", "https://api.anthropic.com")).rejects.toThrow(
      NotFoundError,
    );
    await expect(core.allowDataFlow("nonsense" as DataFlowId, OPENAI_SERVICE.id)).rejects.toThrow(
      InvalidInputError,
    );
    expect(await core.getChatReadiness()).toMatchObject({ consent: "needed" });
  });
});
