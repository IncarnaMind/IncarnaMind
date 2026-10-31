import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText, jsonSchema, streamText, tool } from "ai";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  ChatNotReadyError,
  ConsentDeclinedError,
  type ConversationAnswer,
  type ConversationAskResult,
  type Core,
  type CoreEventName,
  type CoreEvents,
  createAiSdkChatModel,
} from "../../src/core";
import { DATABASE_FILE } from "../../src/core/core";
import { CHAT_FLOW_SENDS } from "../../src/core/providers/chat";
import { planResetTime, shapePlanRequest } from "../../src/core/providers/chatgpt/planEndpoint";
import { classifyProviderError } from "../../src/core/providers/providerErrors";
import { migrate, migrations, openDatabase } from "../../src/core/storage";
import { createFileKeychain, SECRETS_FILE } from "../../src/main/secretsFile";
import { firstReset, nextPlanModel } from "../../src/shared/planLimits";
import {
  ACCOUNT_MODELS,
  ANSWER,
  answerResponses,
  createFakeBrowser,
  EMAIL,
  type FakeBrowser,
  type FakeOpenAI,
  type FakeOpenAIServer,
  FULL_SCOPE,
  RESOURCE,
  startFakeOpenAI,
} from "../helpers/chatgpt";
import { createFakeCipher } from "../helpers/cipher";
import { answerEnded } from "../helpers/citations";
import {
  createMemoryKeychain,
  createTempDataFolder,
  type MemoryKeychain,
  manualClock,
  nextEvent,
  saveProviderUnasked,
  startCore,
  type TestAdapters,
} from "../helpers/core";

const CHATGPT_SERVICE = { id: "chatgpt-plan", name: "ChatGPT" };
const MODEL = "gpt-6.1-sol";

interface Setup {
  core: Core;
  fake: FakeOpenAIServer;
  browser: FakeBrowser;
  keychain: MemoryKeychain;
  clock: ReturnType<typeof manualClock>;
  dataDir: string;
}

/** A core whose ChatGPT plan provider talks to a fresh fake OpenAI through the real adapter. */
async function setUp(overrides: TestAdapters = {}): Promise<Setup> {
  const clock = manualClock();
  const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
  const browser = createFakeBrowser(fake);
  const keychain = createMemoryKeychain();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    keychain,
    browser,
    now: clock.now,
    createChatModel: createAiSdkChatModel,
    chatGptPlan: fake.endpoints,
    ...overrides,
  });
  return { core, fake, browser, keychain, clock, dataDir };
}

function acceptConsentAutomatically(core: Core): void {
  core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
}

/** Signs in, accepts the chat flow and makes the plan the default chat model. */
async function signedIn(
  overrides: TestAdapters = {},
  models: FakeOpenAI["modelList"] = ACCOUNT_MODELS,
): Promise<Setup> {
  const setup = await setUp(overrides);
  setup.fake.modelList = models;
  const result = await setup.core.signInToChatGpt();
  expect(result.ok).toBe(true);
  acceptConsentAutomatically(setup.core);
  await setup.core.saveChatProvider({ kind: "chatgpt", modelId: MODEL });
  return setup;
}

/** Records every payload of an event from now on. */
function collect<E extends CoreEventName>(core: Core, event: E): CoreEvents[E][] {
  const payloads: CoreEvents[E][] = [];
  core.on(event, (payload) => payloads.push(payload));
  return payloads;
}

const refreshes = (fake: FakeOpenAI) =>
  fake.tokenRequests.filter((request) => request.grant_type === "refresh_token");

/** Asks one Question-sized request through the model Answers get. */
async function ask(core: Core) {
  const { model } = await core.prepareChatModel();
  return generateText({ model, prompt: "What is attention?", maxRetries: 0 });
}

const stored = (keychain: MemoryKeychain) => [...keychain.secrets.values()].join("\n");

const fiveMinutes = 5 * 60_000;

describe("Continue with ChatGPT", () => {
  test("the first sign-in registers IncarnaMind with OpenAI, with PKCE, a nonce and this computer's host ID", async () => {
    const { core, fake, browser, keychain } = await setUp();
    const changes = collect(core, "chatGptPlan.changed");

    const result = await core.signInToChatGpt();

    expect(browser.opened).toHaveLength(1);
    const authorize = new URL(browser.opened[0] ?? "");
    expect(`${authorize.origin}${authorize.pathname}`).toBe(fake.endpoints.authorizeUrl);
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toEqual({
      response_type: "code",
      client_id: "dynamic_agent_client",
      agent_name_hint: "IncarnaMind",
      ext_agent_host_id: expect.stringMatching(/^urn:uuid:[0-9a-f-]{36}$/),
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/),
      scope: FULL_SCOPE,
      resource: RESOURCE,
      nonce: expect.stringMatching(/^[\w-]{32}$/),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: "S256",
      state: expect.any(String),
    });
    // The code went back for the client OpenAI issued, with the verifier the fake checks.
    expect(fake.clients).toEqual(["oaiapp_test_1"]);
    expect(fake.tokenRequests).toEqual([
      {
        grant_type: "authorization_code",
        client_id: "oaiapp_test_1",
        code: "code-1",
        redirect_uri: params.redirect_uri,
        code_verifier: expect.stringMatching(/^[\w-]{43}$/),
        resource: RESOURCE,
      },
    ]);
    expect((await browser.visits[0])?.html).toContain("You can close this tab");

    expect(result).toEqual({
      ok: true,
      firstTime: true,
      status: {
        account: { state: "signed-in", email: EMAIL },
        signingIn: false,
        models: [
          { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
          { id: "gpt-6-luna", name: "GPT-6 Luna" },
        ],
        limits: { usedUp: [], standIn: null },
      },
    });
    await expect.poll(() => changes.map((status) => status.signingIn)).toEqual([true, false]);
    // The tokens are in the secret store, and the loopback port is free again.
    const issued = fake.issued[0];
    for (const token of [issued?.accessToken, issued?.refreshToken, issued?.idToken]) {
      expect(stored(keychain)).toContain(token);
    }
    await expect(fetch(params.redirect_uri ?? "")).rejects.toThrow();
  });

  test("signing in again reuses the client OpenAI issued and the same host ID, and isn't a first time", async () => {
    const { core, fake } = await setUp();
    await core.signInToChatGpt();
    await core.signOutOfChatGpt();

    const again = await core.signInToChatGpt();

    expect(again).toMatchObject({ ok: true, firstTime: false });
    const [first, second] = fake.authorizations;
    expect(second).toMatchObject({
      client_id: "oaiapp_test_1",
      ext_agent_host_id: first?.ext_agent_host_id,
      login_hint: EMAIL,
      scope: FULL_SCOPE,
    });
    // No registration name, and no ID token hint after signing out.
    expect(second).not.toHaveProperty("agent_name_hint");
    expect(second).not.toHaveProperty("id_token_hint");
    expect(fake.clients).toEqual(["oaiapp_test_1"]);
    expect(fake.tokenRequests.at(-1)).toMatchObject({ client_id: "oaiapp_test_1" });
  });

  test("declining in the browser is reported, and no tokens are kept", async () => {
    const { core, browser, keychain } = await setUp();
    browser.behaviour = "decline";

    const result = await core.signInToChatGpt();

    expect(result).toMatchObject({ ok: false, error: { kind: "denied" } });
    expect((await browser.visits[0])?.html).toContain("Close this tab and try again");
    expect(stored(keychain)).not.toContain("access-token");
    expect((await core.getChatGptPlan()).account).toEqual({ state: "signed-out" });
  });

  test("a sign-in that doesn't allow plan use keeps nothing usable, and the next one asks again", async () => {
    const { core, fake, browser, keychain } = await setUp();
    browser.approval = { allowPlan: false };

    const result = await core.signInToChatGpt();

    expect(result).toMatchObject({ ok: false, error: { kind: "plan-not-allowed" } });
    expect((await core.getChatGptPlan()).account).toEqual({ state: "signed-out" });
    expect(stored(keychain)).not.toContain(fake.issued[0]?.accessToken);
    // The session it did get is ended at OpenAI.
    expect(fake.revocations).toEqual([
      {
        token: fake.issued[0]?.refreshToken,
        token_type_hint: "refresh_token",
        client_id: "oaiapp_test_1",
      },
    ]);

    browser.approval = {};
    expect((await core.signInToChatGpt()).ok).toBe(true);
    expect(fake.authorizations[1]).toMatchObject({ client_id: "oaiapp_test_1", prompt: "consent" });
    expect(fake.authorizations[1]).not.toHaveProperty("id_token_hint");
  });

  test.each([
    { name: "another nonce", tamper: (c: Record<string, unknown>) => ({ ...c, nonce: "other" }) },
    { name: "another audience", tamper: (c: Record<string, unknown>) => ({ ...c, aud: "app_x" }) },
    {
      name: "another issuer",
      tamper: (c: Record<string, unknown>) => ({ ...c, iss: "https://x" }),
    },
    {
      name: "an expired token",
      tamper: (c: Record<string, unknown>) => ({ ...c, exp: (c.iat as number) - 3600 }),
    },
  ])("an ID token with $name is refused, and nothing is kept", async ({ tamper }) => {
    const { core, fake, keychain } = await setUp();
    fake.tamperIdToken = tamper;

    const result = await core.signInToChatGpt();

    expect(result).toMatchObject({ ok: false, error: { kind: "failed" } });
    expect(stored(keychain)).not.toContain(fake.issued[0]?.accessToken);
    expect((await core.getChatGptPlan()).account).toEqual({ state: "signed-out" });
  });

  test("an ID token signed with a key OpenAI doesn't publish is refused", async () => {
    const { core, fake } = await setUp();
    fake.foreignSigner = true;

    expect(await core.signInToChatGpt()).toMatchObject({ ok: false, error: { kind: "failed" } });
    expect(await core.getChatReadiness()).toEqual({ ready: false, reason: "no-provider" });
  });

  test("signing in as another account is refused, until the User chooses another account", async () => {
    const { core, fake, browser } = await setUp();
    await core.signInToChatGpt();
    await core.signOutOfChatGpt();
    browser.approval = { subject: "user-0002", email: "other@example.com" };

    const other = await core.signInToChatGpt();

    expect(other).toMatchObject({ ok: false, error: { kind: "other-account" } });
    expect((await core.getChatGptPlan()).account).toEqual({ state: "signed-out" });

    const switched = await core.signInToChatGpt({ anotherAccount: true });

    expect(switched).toMatchObject({
      ok: true,
      status: { account: { state: "signed-in", email: "other@example.com" } },
    });
    expect(fake.authorizations.at(-1)).toMatchObject({
      client_id: "dynamic_agent_client",
      ext_agent_host_id: fake.authorizations[0]?.ext_agent_host_id,
    });
    expect(fake.clients).toEqual(["oaiapp_test_1", "oaiapp_test_2"]);
  });

  test("the Privacy page lists the sign-in's traffic to OpenAI once the User has signed in", async () => {
    const { core, fake } = await setUp();
    const ids = async () => (await core.listNetworkTraffic()).map((traffic) => traffic.id);
    expect(await ids()).not.toContain("chatgpt-sign-in");

    await core.signInToChatGpt();
    await core.signOutOfChatGpt();

    expect(await core.listNetworkTraffic()).toContainEqual({
      id: "chatgpt-sign-in",
      service: { id: new URL(fake.endpoints.authorizeUrl).origin, name: "OpenAI" },
      enabled: true,
    });
  });

  test("a device that can't store secrets securely is told so before the browser opens", async () => {
    const { core, browser } = await setUp({ keychain: createMemoryKeychain("unavailable") });

    const result = await core.signInToChatGpt();

    expect(result).toMatchObject({ ok: false, error: { kind: "secret-storage" } });
    expect(browser.opened).toEqual([]);
  });

  test("a sign-in nobody finishes times out", async () => {
    const clock = manualClock();
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    const { core, browser } = await setUp({
      chatGptPlan: { ...fake.endpoints, signInTimeoutMs: 100 },
    });
    browser.behaviour = "ignore";

    const result = await core.signInToChatGpt();

    expect(result).toMatchObject({ ok: false, error: { kind: "timed-out" } });
    expect((await core.getChatGptPlan()).signingIn).toBe(false);
  });

  test("a waiting sign-in can be cancelled, which frees its port", async () => {
    const { core, browser } = await setUp();
    browser.behaviour = "ignore";

    const result = core.signInToChatGpt();
    await expect.poll(() => browser.opened).toHaveLength(1);
    expect((await core.getChatGptPlan()).signingIn).toBe(true);
    await core.cancelChatGptSignIn();

    expect(await result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect((await core.getChatGptPlan()).signingIn).toBe(false);
    const redirect = new URL(browser.opened[0] ?? "").searchParams.get("redirect_uri") ?? "";
    await expect(fetch(redirect)).rejects.toThrow();
  });

  test("a waiting sign-in's page can be opened again, and nothing is opened when none waits", async () => {
    const { core, browser } = await setUp();
    expect(await core.reopenChatGptSignIn()).toBe(false);
    browser.behaviour = "ignore";

    const result = core.signInToChatGpt();
    await expect.poll(() => browser.opened).toHaveLength(1);
    expect(await core.reopenChatGptSignIn()).toBe(true);

    expect(browser.opened).toHaveLength(2);
    expect(browser.opened[1]).toBe(browser.opened[0]);
    await core.cancelChatGptSignIn();
    await result;
    expect(await core.reopenChatGptSignIn()).toBe(false);
  });

  test("starting again replaces a sign-in still waiting, e.g. after the User closed the tab", async () => {
    const { core, browser } = await setUp();
    browser.behaviour = "ignore";
    const abandoned = core.signInToChatGpt();
    await expect.poll(() => browser.opened).toHaveLength(1);

    browser.behaviour = "approve";
    const retried = await core.signInToChatGpt();

    expect(await abandoned).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(retried).toMatchObject({ ok: true, status: { account: { state: "signed-in" } } });
  });
});

describe("Pasting the address the browser shows", () => {
  /** A sign-in whose browser never comes back, and the address OpenAI's page sent it to. */
  async function waitingSignIn({ core, browser, fake }: Setup) {
    browser.behaviour = "ignore";
    const opened = browser.opened.length;
    const result = core.signInToChatGpt();
    await expect.poll(() => browser.opened).toHaveLength(opened + 1);
    const address = fake.redirectFor(browser.opened.at(-1) ?? "", { approve: {} }).href;
    return { result, address };
  }

  const exchanges = (fake: FakeOpenAI) =>
    fake.tokenRequests.filter((request) => request.grant_type === "authorization_code");

  test("a pasted address finishes the sign-in, with spaces and quotes around it, and is never logged", async () => {
    const setup = await setUp();
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level),
    );
    onTestFinished(() => {
      for (const spy of logged) spy.mockRestore();
    });
    const { result, address } = await waitingSignIn(setup);

    expect(await setup.core.pasteChatGptSignInAddress(`  "${address}"\n`)).toEqual({ ok: true });

    expect(await result).toMatchObject({
      ok: true,
      firstTime: true,
      status: { account: { state: "signed-in", email: EMAIL }, signingIn: false },
    });
    expect(exchanges(setup.fake)).toEqual([
      expect.objectContaining({ client_id: "oaiapp_test_1", code: "code-1" }),
    ]);
    const callback = new URL(address);
    callback.search = "";
    await expect(fetch(callback)).rejects.toThrow();
    const output = logged.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    expect(output).not.toContain("code-1");
    expect(output).not.toContain(new URL(address).searchParams.get("state"));
  });

  test("an address with another state is refused and changes nothing; the right one still works", async () => {
    const setup = await setUp();
    const { result, address } = await waitingSignIn(setup);
    const other = new URL(address);
    other.searchParams.set("state", "from-another-sign-in");

    expect(await setup.core.pasteChatGptSignInAddress(other.href)).toEqual({
      ok: false,
      problem: "other-sign-in",
    });

    expect(setup.fake.tokenRequests).toEqual([]);
    expect((await setup.core.getChatGptPlan()).signingIn).toBe(true);
    expect(await setup.core.pasteChatGptSignInAddress(address)).toEqual({ ok: true });
    expect(await result).toMatchObject({ ok: true });
  });

  test("an earlier sign-in's address, its code already used, is refused", async () => {
    const setup = await setUp();
    const first = await waitingSignIn(setup);
    await setup.core.pasteChatGptSignInAddress(first.address);
    expect(await first.result).toMatchObject({ ok: true });
    await setup.core.signOutOfChatGpt();
    const second = await waitingSignIn(setup);

    expect(await setup.core.pasteChatGptSignInAddress(first.address)).toEqual({
      ok: false,
      // The new sign-in listens on another free port, unless the system hands out the same one.
      problem: expect.stringMatching(/^(not-sign-in-address|other-sign-in)$/),
    });

    expect(exchanges(setup.fake)).toHaveLength(1);
    expect((await setup.core.getChatGptPlan()).account).toEqual({ state: "signed-out" });
    await setup.core.cancelChatGptSignIn();
    expect(await second.result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  });

  test("pasting twice, or the browser coming back after a paste, exchanges the code once", async () => {
    const setup = await setUp();
    const { result, address } = await waitingSignIn(setup);
    let release = () => {};
    setup.fake.holdCodeExchange = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(await setup.core.pasteChatGptSignInAddress(address)).toEqual({ ok: true });
    await expect.poll(() => exchanges(setup.fake)).toHaveLength(1);
    expect(await setup.core.pasteChatGptSignInAddress(address)).toEqual({
      ok: false,
      problem: "finished",
    });
    const late = await fetch(address);
    expect(late.status).toBe(409);
    release();

    expect(await result).toMatchObject({ ok: true });
    expect(exchanges(setup.fake)).toHaveLength(1);
  });

  test("an address pasted after the browser came back is ignored", async () => {
    const { core, browser, fake, keychain } = await setUp();
    expect(await core.signInToChatGpt()).toMatchObject({ ok: true });
    const before = { status: await core.getChatGptPlan(), stored: stored(keychain) };
    const address = fake.redirectFor(browser.opened[0] ?? "", { approve: {} }).href;

    expect(await core.pasteChatGptSignInAddress(address)).toEqual({
      ok: false,
      problem: "finished",
    });

    expect(exchanges(fake)).toHaveLength(1);
    expect({ status: await core.getChatGptPlan(), stored: stored(keychain) }).toEqual(before);
  });

  test("an address of another host, port, scheme or path, or without a code or state, isn't the sign-in address", async () => {
    const setup = await setUp();
    const { result, address } = await waitingSignIn(setup);
    const changed = (change: (url: URL) => void) => {
      const url = new URL(address);
      change(url);
      return url.href;
    };
    const refused = [
      changed((url) => {
        url.hostname = "localhost";
      }),
      changed((url) => {
        url.port = "1";
      }),
      changed((url) => {
        url.protocol = "https:";
      }),
      changed((url) => {
        url.pathname = "/auth/other";
      }),
      changed((url) => url.searchParams.delete("state")),
      changed((url) => url.searchParams.delete("code")),
      `${address} trailing`,
      address.replace("/auth/", "/auth/\n"),
      `"${address}`,
      "",
      "not an address",
      setup.fake.endpoints.authorizeUrl,
    ];

    for (const text of refused) {
      expect(await setup.core.pasteChatGptSignInAddress(text)).toEqual({
        ok: false,
        problem: "not-sign-in-address",
      });
    }

    expect(setup.fake.tokenRequests).toEqual([]);
    expect((await setup.core.getChatGptPlan()).signingIn).toBe(true);
    await setup.core.cancelChatGptSignIn();
    expect(await result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  });
});

describe("Answers with the ChatGPT plan", () => {
  test("go to the public Responses API with the plan's token, stored nowhere, streamed", async () => {
    const { core, fake } = await signedIn();
    expect(await core.getChatReadiness()).toMatchObject({
      ready: true,
      provider: { kind: "chatgpt", service: CHATGPT_SERVICE },
      modelId: MODEL,
    });

    const { model } = await core.prepareChatModel();
    const generated = await generateText({
      model,
      system: "Answer briefly.",
      prompt: "What is attention?",
      maxOutputTokens: 200,
      temperature: 0.2,
      maxRetries: 0,
    });
    const streamed = streamText({ model, prompt: "And transformers?", maxRetries: 0 });
    let streamedText = "";
    for await (const delta of streamed.textStream) streamedText += delta;

    expect(generated.text).toBe(ANSWER);
    expect(streamedText).toBe(ANSWER);
    const [first, second] = fake.responses();
    expect(first?.headers).toMatchObject({
      authorization: `Bearer ${fake.issued[0]?.accessToken}`,
      accept: "text/event-stream",
    });
    // Nothing of another app's: no account header, no Codex originator.
    expect(first?.headers).not.toHaveProperty("chatgpt-account-id");
    expect(first?.headers).not.toHaveProperty("originator");
    expect(first?.body).toMatchObject({
      model: MODEL,
      instructions: "Answer briefly.",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      input: [{ role: "user", content: [{ type: "input_text", text: "What is attention?" }] }],
    });
    // Fields the route rejects are left out.
    for (const field of ["max_output_tokens", "temperature", "previous_response_id", "metadata"]) {
      expect(first?.body).not.toHaveProperty(field);
    }
    expect(second?.body).not.toHaveProperty("instructions");
  });

  test("Tools go in a namespace, as the route asks", async () => {
    const { core, fake } = await signedIn();
    const { model } = await core.prepareChatModel();

    await generateText({
      model,
      prompt: "Search my Documents.",
      tools: {
        search_documents: tool({
          description: "Searches the Documents.",
          inputSchema: jsonSchema<{ query: string }>({
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          }),
        }),
      },
      maxRetries: 0,
    });

    expect(fake.responses()[0]?.body.tools).toEqual([
      {
        type: "namespace",
        name: "functions",
        description: "",
        tools: [expect.objectContaining({ type: "function", name: "search_documents" })],
      },
    ]);
  });

  test("history sent back names the namespace of each Tool call, and system messages become developer ones", () => {
    const shaped = shapePlanRequest({
      model: MODEL,
      tools: [{ type: "function", name: "search_documents", parameters: {} }],
      input: [
        { role: "system", content: "Cite." },
        { role: "user", content: [{ type: "input_text", text: "Q" }] },
        { type: "function_call", call_id: "c1", name: "search_documents", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "[]" },
        { role: "system", content: "Now answer." },
      ],
      max_output_tokens: 10,
      user: "someone",
    });

    expect(shaped).toEqual({
      model: MODEL,
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "",
          tools: [{ type: "function", name: "search_documents", parameters: {} }],
        },
      ],
      instructions: "Cite.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Q" }] },
        {
          type: "function_call",
          call_id: "c1",
          name: "search_documents",
          arguments: "{}",
          namespace: "functions",
        },
        { type: "function_call_output", call_id: "c1", output: "[]" },
        { role: "developer", content: "Now answer." },
      ],
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    });
  });

  test("the connection test sends one small request and reports success", async () => {
    const { core, fake } = await signedIn();

    expect(await core.testChatConnection({ kind: "chatgpt", modelId: MODEL })).toEqual({
      ok: true,
    });
    expect(fake.responses()).toHaveLength(1);
  });

  test("the model picker lists the account's own models, and the known ones when OpenAI can't say", async () => {
    const { core, fake } = await signedIn();

    const groups = await core.listChatModels();
    expect(groups.find((group) => group.provider.kind === "chatgpt")?.models).toEqual([
      "gpt-6.1-sol",
      "gpt-6-luna",
    ]);
    // The names are the account's own, for the picker to show.
    expect(groups.find((group) => group.provider.kind === "chatgpt")?.names).toEqual({
      "gpt-6.1-sol": "GPT-6.1 Sol",
      "gpt-6-luna": "GPT-6 Luna",
    });
    const asked = fake.apiRequests.find((request) => request.path === "/v1/models");
    expect(asked?.headers.authorization).toBe(`Bearer ${fake.issued[0]?.accessToken}`);

    // Signed out, nothing is asked: the known models are offered.
    await core.signOutOfChatGpt();
    const before = fake.apiRequests.length;
    expect((await core.getChatGptPlan()).models[0]).toEqual({ id: MODEL, name: "GPT-6.1 Sol" });
    expect(fake.apiRequests).toHaveLength(before);
  });
});

describe("Tokens", () => {
  test("an access token is refreshed shortly before it expires, for the issued client, and the new tokens are stored", async () => {
    const { core, fake, clock, keychain } = await signedIn();
    const first = fake.issued[0];

    await ask(core);
    clock.advance(fake.expiresIn * 1000 - fiveMinutes + 1000);
    await ask(core);
    await ask(core);

    expect(refreshes(fake)).toEqual([
      {
        grant_type: "refresh_token",
        client_id: "oaiapp_test_1",
        refresh_token: first?.refreshToken,
        resource: RESOURCE,
      },
    ]);
    const second = fake.issued[1];
    expect(fake.responses().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${first?.accessToken}`,
      `Bearer ${second?.accessToken}`,
      `Bearer ${second?.accessToken}`,
    ]);
    expect(stored(keychain)).toContain(second?.refreshToken);
    expect(stored(keychain)).not.toContain(first?.refreshToken);
  });

  test("concurrent requests share one refresh", async () => {
    const { core, fake, clock } = await signedIn();
    fake.refreshDelayMs = 50;
    clock.advance(fake.expiresIn * 1000);

    await Promise.all([ask(core), ask(core), ask(core)]);

    expect(refreshes(fake)).toHaveLength(1);
    const fresh = `Bearer ${fake.issued[1]?.accessToken}`;
    expect(fake.responses().map((request) => request.headers.authorization)).toEqual([
      fresh,
      fresh,
      fresh,
    ]);
  });

  test("a token the API refuses early is refreshed once and the request retried", async () => {
    const { core, fake } = await signedIn();
    fake.revokeAccessTokens();

    const answer = await ask(core);

    expect(answer.text).toBe(ANSWER);
    expect(refreshes(fake)).toHaveLength(1);
    expect(fake.responses()).toHaveLength(2);
  });

  test("a refused refresh asks the User to sign in again, and Questions wait for it", async () => {
    const { core, fake, clock, keychain } = await signedIn();
    fake.refreshRefusal = { status: 400, body: { error: "refresh_token_expired" } };
    clock.advance(fake.expiresIn * 1000);
    const readinessChanged = collect(core, "chatReadiness.changed");
    const planChanged = collect(core, "chatGptPlan.changed");

    const result = await core.testChatConnection({ kind: "chatgpt", modelId: MODEL });

    expect(result).toMatchObject({ ok: false, error: { kind: "not-signed-in" } });
    expect(fake.responses()).toEqual([]);
    expect(stored(keychain)).not.toContain(fake.issued[0]?.accessToken);
    expect((await core.getChatGptPlan()).account).toEqual({ state: "expired" });
    await expect.poll(() => planChanged.at(-1)?.account).toEqual({ state: "expired" });
    const readiness = await core.getChatReadiness();
    expect(readiness).toMatchObject({ ready: false, reason: "sign-in-required" });
    await expect.poll(() => readinessChanged.at(-1)).toEqual(readiness);
    await expect(core.prepareChatModel()).rejects.toThrow(ChatNotReadyError);

    // Signing in again brings Questions back; the expired sign-in's ID token skips the account picker.
    fake.refreshRefusal = null;
    expect((await core.signInToChatGpt()).ok).toBe(true);
    expect(fake.authorizations.at(-1)).toMatchObject({
      client_id: "oaiapp_test_1",
      id_token_hint: fake.issued[0]?.idToken,
    });
    expect(await core.getChatReadiness()).toMatchObject({ ready: true });
  });

  test("a client OpenAI no longer knows is forgotten, and the next sign-in registers again", async () => {
    const { core, fake, clock } = await signedIn();
    fake.refreshRefusal = { status: 401, body: { error: "invalid_client" } };
    clock.advance(fake.expiresIn * 1000);

    expect(await core.testChatConnection({ kind: "chatgpt", modelId: MODEL })).toMatchObject({
      ok: false,
      error: { kind: "not-signed-in" },
    });
    fake.refreshRefusal = null;
    await core.signInToChatGpt();

    expect(fake.authorizations.at(-1)).toMatchObject({ client_id: "dynamic_agent_client" });
    expect(fake.clients).toEqual(["oaiapp_test_1", "oaiapp_test_2"]);
  });

  test("a refresh that fails for a passing reason keeps the sign-in", async () => {
    const { core, fake, clock } = await signedIn();
    fake.refreshRefusal = { status: 503, body: { error: "temporarily_unavailable" } };
    clock.advance(fake.expiresIn * 1000);

    const result = await core.testChatConnection({ kind: "chatgpt", modelId: MODEL });

    expect(result).toMatchObject({ ok: false, error: { kind: "provider" } });
    expect((await core.getChatGptPlan()).account.state).toBe("signed-in");
  });

  test("signing out ends the session at OpenAI, deletes the tokens, and nothing is sent afterwards", async () => {
    const { core, fake, keychain } = await signedIn();

    const result = await core.signOutOfChatGpt();

    expect(result).toMatchObject({ revoked: true, status: { account: { state: "signed-out" } } });
    expect(fake.revocations).toEqual([
      {
        token: fake.issued[0]?.refreshToken,
        token_type_hint: "refresh_token",
        client_id: "oaiapp_test_1",
      },
    ]);
    for (const token of [fake.issued[0]?.accessToken, fake.issued[0]?.refreshToken]) {
      expect(stored(keychain)).not.toContain(token);
    }
    expect(await core.getChatReadiness()).toMatchObject({
      ready: false,
      reason: "sign-in-required",
    });
    expect(await core.testChatConnection({ kind: "chatgpt", modelId: MODEL })).toEqual({
      ok: false,
      error: { kind: "not-signed-in", message: expect.any(String) },
    });
    expect(fake.responses()).toEqual([]);
  });

  test("signing out while OpenAI can't be reached still forgets the tokens, and says it wasn't confirmed", async () => {
    const { core, fake, keychain } = await signedIn();
    fake.revokeStatus = 503;

    const result = await core.signOutOfChatGpt();

    expect(result).toMatchObject({ revoked: false, status: { account: { state: "signed-out" } } });
    expect(fake.revocations.length).toBeGreaterThan(1);
    expect(stored(keychain)).not.toContain(fake.issued[0]?.refreshToken);
  });

  test("tokens never reach the SQLite database, only the encrypted secrets file", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createFileKeychain(join(dataDir, SECRETS_FILE), createFakeCipher());
    const { core, fake, clock } = await signedIn({ keychain, paths: { dataDir } });
    clock.advance(fake.expiresIn * 1000);
    await ask(core); // refreshes, so two sets of tokens have been stored
    core.close();

    const tokens = fake.issued.flatMap((set) => [set.accessToken, set.refreshToken, set.idToken]);
    expect(tokens).toHaveLength(6);
    const files = (await readdir(dataDir, { withFileTypes: true, recursive: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files).toContain(join(dataDir, "incarnamind.db"));
    expect(files).toContain(join(dataDir, SECRETS_FILE));
    for (const file of files) {
      const bytes = await readFile(file);
      for (const token of tokens) {
        expect(bytes.includes(token), `${file} contains a token`).toBe(false);
      }
    }
    // The tokens are there, encrypted: a restart is still signed in.
    const restarted = startCore(dataDir, {
      keychain: createFileKeychain(join(dataDir, SECRETS_FILE), createFakeCipher()),
    });
    expect((await restarted.getChatGptPlan()).account).toMatchObject({ state: "signed-in" });
  });
});

describe("A ChatGPT test profile shared by several data folders", () => {
  test("one sign-in serves both, their refreshes don't race, and neither data folder holds the tokens", async () => {
    const clock = manualClock();
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    const profile = await createTempDataFolder();
    const chatGptStore = () => ({
      keychain: createFileKeychain(join(profile, SECRETS_FILE), createFakeCipher()),
      lockFile: join(profile, "refresh.lock"),
    });
    const start = async () => {
      const dataDir = await createTempDataFolder();
      const keychain = createMemoryKeychain();
      const core = startCore(dataDir, {
        keychain,
        browser: createFakeBrowser(fake),
        now: clock.now,
        createChatModel: createAiSdkChatModel,
        chatGptPlan: fake.endpoints,
        chatGptStore: chatGptStore(),
      });
      acceptConsentAutomatically(core);
      return { core, keychain };
    };
    const owner = await start();
    const agent = await start();

    // The owner signs in once; the agent's core, with its own data folder, is signed in too.
    expect((await owner.core.signInToChatGpt()).ok).toBe(true);
    expect((await agent.core.getChatGptPlan()).account).toEqual({
      state: "signed-in",
      email: EMAIL,
    });
    await agent.core.saveChatProvider({ kind: "chatgpt", modelId: MODEL });
    await owner.core.saveChatProvider({ kind: "chatgpt", modelId: MODEL });

    // Both need a fresh token at once: one process refreshes, the other uses its result.
    fake.refreshDelayMs = 50;
    clock.advance(fake.expiresIn * 1000);
    await Promise.all([ask(owner.core), ask(agent.core)]);

    expect(refreshes(fake)).toHaveLength(1);
    expect(fake.responses().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${fake.issued[1]?.accessToken}`,
      `Bearer ${fake.issued[1]?.accessToken}`,
    ]);
    for (const { keychain } of [owner, agent]) expect(keychain.secrets.size).toBe(0);
  });

  test("without a keyring, the profile saves the sign-in once the User accepts plain text", async () => {
    const clock = manualClock();
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    const profile = await createTempDataFolder();
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain("plain-text"),
      browser: createFakeBrowser(fake),
      now: clock.now,
      createChatModel: createAiSdkChatModel,
      chatGptPlan: fake.endpoints,
      chatGptStore: {
        keychain: createFileKeychain(join(profile, SECRETS_FILE), createFakeCipher("plain-text")),
        lockFile: join(profile, "refresh.lock"),
      },
    });

    expect(await core.signInToChatGpt()).toMatchObject({
      ok: false,
      error: { kind: "secret-storage" },
    });

    await core.acceptPlainTextSecretStorage();

    expect(await core.signInToChatGpt()).toMatchObject({ ok: true });
    expect((await core.getChatGptPlan()).account).toMatchObject({ state: "signed-in" });
  });
});

describe("A ChatGPT profile whose sign-in can't be read", () => {
  const ACCOUNT_SECRET = "chatgpt:account";

  /** A core that keeps its ChatGPT sign-in in a profile holding `record`, if one is given. */
  async function setUpProfile(record: string | null = null) {
    const clock = manualClock();
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    const browser = createFakeBrowser(fake);
    const profile = await createTempDataFolder();
    const file = join(profile, SECRETS_FILE);
    if (record !== null) {
      const encrypted = createFakeCipher().encrypt(record).toString("base64");
      await writeFile(file, JSON.stringify({ [ACCOUNT_SECRET]: encrypted }), { mode: 0o600 });
    }
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      browser,
      now: clock.now,
      createChatModel: createAiSdkChatModel,
      chatGptPlan: fake.endpoints,
      chatGptStore: {
        keychain: createFileKeychain(file, createFakeCipher()),
        lockFile: join(profile, "refresh.lock"),
      },
    });
    return { core, fake, browser, file };
  }

  /** A core whose profile's secrets file is left by `damage` before it starts. */
  async function setUpDamagedProfile(damage: (file: string) => Promise<void>) {
    const clock = manualClock();
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    const browser = createFakeBrowser(fake);
    const profile = await createTempDataFolder();
    const file = join(profile, SECRETS_FILE);
    await damage(file);
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      browser,
      now: clock.now,
      createChatModel: createAiSdkChatModel,
      chatGptPlan: fake.endpoints,
      chatGptStore: {
        keychain: createFileKeychain(file, createFakeCipher()),
        lockFile: join(profile, "refresh.lock"),
      },
    });
    return { core, fake, browser, file };
  }

  /** What a profile's secrets file is now: its bytes, or a folder where the file belongs. */
  async function storeState(file: string) {
    const info = await lstat(file);
    return info.isDirectory() ? { directory: true } : { bytes: await readFile(file) };
  }

  /** What a profile's stored record says now, read the way the app reads it. */
  async function readRecord(file: string) {
    const entries = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    return JSON.parse(
      createFakeCipher().decrypt(Buffer.from(entries[ACCOUNT_SECRET] ?? "", "base64")),
    );
  }

  test("an abandoned sign-in leaves a signed-in profile byte-for-byte unchanged, and a completed one replaces it", async () => {
    const { core, fake, browser, file } = await setUpProfile();
    expect(await core.signInToChatGpt()).toMatchObject({ ok: true, firstTime: true });
    const before = await readFile(file);
    browser.behaviour = "ignore";

    const abandoned = core.signInToChatGpt();
    await expect.poll(() => browser.opened).toHaveLength(2);
    await core.cancelChatGptSignIn();

    expect(await abandoned).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect((await readFile(file)).equals(before)).toBe(true);

    browser.behaviour = "approve";
    expect(await core.signInToChatGpt()).toMatchObject({ ok: true, firstTime: false });

    expect((await readFile(file)).equals(before)).toBe(false);
    expect(await readRecord(file)).toMatchObject({
      clientId: "oaiapp_test_1",
      tokens: { accessToken: fake.issued[1]?.accessToken },
    });
    expect((await core.getChatGptPlan()).account).toEqual({
      state: "signed-in",
      email: EMAIL,
    });
  });

  test("a profile that can't be read is reported and left as it is; only a completed sign-in replaces it", async () => {
    const { core, fake, browser, file } = await setUpProfile("not a sign-in record");
    const before = await readFile(file);

    expect(await core.signInToChatGpt()).toMatchObject({
      ok: false,
      error: { kind: "record-unreadable" },
    });
    expect(browser.opened).toEqual([]);
    expect((await readFile(file)).equals(before)).toBe(true);
    expect((await core.getChatGptPlan()).account).toEqual({ state: "unreadable" });

    // The User signs in again and the sign-in fails after OpenAI registered it: still nothing is written.
    fake.tamperIdToken = (claims) => ({ ...claims, nonce: "other" });
    expect(await core.signInToChatGpt({ replaceUnreadable: true })).toMatchObject({
      ok: false,
      error: { kind: "failed" },
    });
    expect((await readFile(file)).equals(before)).toBe(true);
    fake.tamperIdToken = null;

    // Abandoning the sign-in the User chose writes nothing either.
    browser.behaviour = "ignore";
    const abandoned = core.signInToChatGpt({ replaceUnreadable: true });
    await expect.poll(() => browser.opened).toHaveLength(1);
    await core.cancelChatGptSignIn();
    expect(await abandoned).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect((await readFile(file)).equals(before)).toBe(true);

    browser.behaviour = "approve";
    expect(await core.signInToChatGpt({ replaceUnreadable: true })).toMatchObject({ ok: true });

    expect((await readFile(file)).equals(before)).toBe(false);
    expect((await core.getChatGptPlan()).account).toEqual({
      state: "signed-in",
      email: EMAIL,
    });
  });

  test.each([
    {
      name: "empty",
      damage: async (file: string) => {
        await writeFile(file, "");
      },
    },
    {
      name: "truncated JSON",
      damage: async (file: string) => {
        await writeFile(file, '{"chatgpt:account":"half');
      },
    },
    {
      name: "a folder where its file belongs",
      damage: async (file: string) => {
        await mkdir(file);
      },
    },
  ])(
    "a secrets file that is $name is reported and can't be replaced by signing in",
    async ({ damage }) => {
      const { core, browser, file } = await setUpDamagedProfile(damage);
      const before = await storeState(file);

      for (const input of [undefined, { replaceUnreadable: true }]) {
        expect(await core.signInToChatGpt(input)).toMatchObject({
          ok: false,
          error: { kind: "store-unreadable" },
        });
      }

      expect(browser.opened).toEqual([]);
      expect(await storeState(file)).toEqual(before);
      expect((await core.getChatGptPlan()).account).toEqual({ state: "unreadable" });
      expect(await core.signOutOfChatGpt()).toMatchObject({ revoked: true });
      expect(await storeState(file)).toEqual(before);
    },
  );

  test("a record that can't be saved after the sign-in revokes the tokens it got", async () => {
    const clock = manualClock();
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    const profile = await createTempDataFolder();
    const keychain = createFileKeychain(join(profile, SECRETS_FILE), createFakeCipher());
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      browser: createFakeBrowser(fake),
      now: clock.now,
      createChatModel: createAiSdkChatModel,
      chatGptPlan: fake.endpoints,
      chatGptStore: {
        keychain: {
          ...keychain,
          set: async () => {
            throw new Error("The disk is full.");
          },
        },
        lockFile: join(profile, "refresh.lock"),
      },
    });

    expect(await core.signInToChatGpt()).toMatchObject({ ok: false, error: { kind: "failed" } });

    expect(fake.revocations).toEqual([
      {
        token: fake.issued[0]?.refreshToken,
        token_type_hint: "refresh_token",
        client_id: "oaiapp_test_1",
      },
    ]);
    expect((await core.getChatGptPlan()).account).toEqual({ state: "signed-out" });
  });

  test("a sign-in that doesn't allow plan use leaves a signed-in record as it was", async () => {
    const { core, fake, browser, file } = await setUpProfile();
    expect(await core.signInToChatGpt()).toMatchObject({ ok: true, firstTime: true });
    const before = await readFile(file);
    browser.approval = { allowPlan: false };

    expect(await core.signInToChatGpt()).toMatchObject({
      ok: false,
      error: { kind: "plan-not-allowed" },
    });

    expect((await readFile(file)).equals(before)).toBe(true);
    expect((await core.getChatGptPlan()).account).toEqual({ state: "signed-in", email: EMAIL });
    expect(fake.revocations).toEqual([
      {
        token: fake.issued[1]?.refreshToken,
        token_type_hint: "refresh_token",
        client_id: "oaiapp_test_1",
      },
    ]);
  });
});

describe("Consent and Local mode", () => {
  test("nothing goes to OpenAI before the User accepts the chat flow to ChatGPT", async () => {
    const { core, fake } = await setUp();
    await core.signInToChatGpt();
    await saveProviderUnasked(core, { kind: "chatgpt", modelId: MODEL });
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "needed" });

    const requested = nextEvent(core, "consent.requested");
    const result = core.prepareChatModel();
    result.catch(() => undefined);
    const request = await requested;

    expect(request.flow).toEqual({
      id: "chat",
      service: CHATGPT_SERVICE,
      sends: [...CHAT_FLOW_SENDS],
    });
    expect(fake.responses()).toEqual([]);

    await core.respondToConsent(request.requestId, false);

    await expect(result).rejects.toThrow(ConsentDeclinedError);
    expect(await core.getChatReadiness()).toMatchObject({
      ready: false,
      reason: "consent-declined",
    });
    await expect(core.prepareChatModel()).rejects.toThrow(ChatNotReadyError);
    expect(fake.responses()).toEqual([]);
  });

  test("Local mode blocks the plan: nothing goes to OpenAI", async () => {
    const { core, fake } = await signedIn();
    await core.updateSettings({ user: { suggestWhileWriting: true } });

    await core.setLocalOnly(true);

    expect(await core.getChatReadiness()).toMatchObject({
      ready: false,
      reason: "local-mode",
      provider: { service: CHATGPT_SERVICE },
    });
    await expect(core.prepareChatModel()).rejects.toThrow(ChatNotReadyError);
    expect((await core.getSuggestionStatus()).paused).toEqual({ reason: "local-mode" });
    expect(fake.responses()).toEqual([]);
  });
});

describe("Refusals", () => {
  test.each([
    {
      name: "the plan's usage limit",
      status: 429,
      body: {
        error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit reached." },
      },
      kind: "plan-limit",
    },
    {
      name: "a plan that can't be used in other apps",
      status: 403,
      body: { error: { code: "subscription_sharing_user_not_eligible", message: "No." } },
      kind: "blocked",
    },
    {
      name: "a region OpenAI doesn't serve",
      status: 403,
      body: { detail: "Unsupported country." },
      kind: "blocked",
    },
    {
      name: "usage that can't be checked just now",
      status: 503,
      body: { error: { code: "subscription_sharing_usage_unavailable", message: "Later." } },
      kind: "provider",
    },
    {
      name: "an unknown model",
      status: 404,
      body: { error: { message: "Model not found", type: "invalid_request_error" } },
      kind: "model",
    },
    {
      name: "a server error",
      status: 500,
      body: { error: { message: "Internal error", type: "server_error" } },
      kind: "provider",
    },
  ])("$name is reported as $kind", async ({ status, body, kind }) => {
    const { core, fake } = await signedIn();
    fake.reply = { kind: "error", status, body };

    const result = await core.testChatConnection({ kind: "chatgpt", modelId: MODEL });

    expect(result).toMatchObject({ ok: false, error: { kind } });
  });

  test("the usage limit reached after an answer has begun is a plan limit too", async () => {
    const { core, fake } = await signedIn();
    fake.reply = {
      kind: "fails-midway",
      error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit reached." },
    };
    const { model } = await core.prepareChatModel();
    let failure: unknown = null;

    const streamed = streamText({
      model,
      prompt: "What is attention?",
      maxRetries: 0,
      onError: ({ error }) => {
        failure = error;
      },
    });
    try {
      for await (const _ of streamed.textStream) {
        // Read to the end.
      }
    } catch (error) {
      failure ??= error;
    }

    // What the Answer shows: the plan's limit, with "Manage usage".
    expect(classifyProviderError(failure)).toMatchObject({ kind: "plan-limit" });
  });

  test("a usage limit's reset time comes from what the refusal carries, and is never guessed", () => {
    const now = Date.parse("2026-10-06T09:00:00.000Z");
    const limit = (fields: object) => ({
      error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit.", ...fields },
    });
    const noHeaders = new Headers();

    expect(planResetTime(limit({ resets_at: now / 1000 + 600 }), noHeaders, now)).toBe(
      now + 600_000,
    );
    expect(planResetTime(limit({ resets_in_seconds: 90 }), noHeaders, now)).toBe(now + 90_000);
    expect(planResetTime(limit({}), new Headers({ "retry-after": "120" }), now)).toBe(
      now + 120_000,
    );
    expect(
      planResetTime(
        { type: "response.failed", response: limit({ resets_at: 1_791_000_000 }) },
        null,
      ),
    ).toBe(1_791_000_000_000);
    expect(planResetTime(limit({}), noHeaders, now)).toBeNull();
  });

  test("a 401 that a fresh token doesn't fix means OpenAI refused the sign-in for plan use", async () => {
    const { core, fake } = await signedIn();
    fake.reply = { kind: "error", status: 401, body: { error: { message: "Unauthorized" } } };

    const result = await core.testChatConnection({ kind: "chatgpt", modelId: MODEL });

    expect(result).toMatchObject({ ok: false, error: { kind: "blocked" } });
    expect(refreshes(fake)).toHaveLength(1);
    expect((await core.getChatGptPlan()).account.state).toBe("signed-in");
  });
});

describe("A model's usage limit, used up", { timeout: 30_000 }, () => {
  const SOL = "gpt-6.1-sol";
  const ASTRA = "gpt-6-astra";
  const LUNA = "gpt-6-luna";
  const PLAN_MODELS = [
    { slug: SOL, display_name: "GPT-6.1 Sol", visibility: "list" },
    { slug: ASTRA, display_name: "GPT-6 Astra", visibility: "list" },
    { slug: LUNA, display_name: "GPT-6 Luna", visibility: "list" },
  ];
  const START = Date.parse("2026-10-06T09:00:00.000Z");
  const hours = (count: number) => count * 60 * 60_000;

  /** The plan refuses `model` for its usage limit, saying when it resets (epoch milliseconds) or not. */
  const usedUp = (fake: FakeOpenAI, model: string, resetsAt: number | null) => {
    fake.replyFor[model] = {
      kind: "error",
      status: 429,
      body: {
        error: {
          code: "subscription_sharing_usage_limit_exceeded",
          message: "Limit reached.",
          ...(resetsAt !== null && { resets_at: resetsAt / 1000 }),
        },
      },
    };
  };

  const onPlan = () => signedIn({}, PLAN_MODELS);

  /** Asks in a conversation, or regenerates its Answer, and resolves once the Answer ended. */
  async function settled(core: Core, result: Promise<ConversationAskResult>) {
    const asked = await result;
    if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
    const { event } = await answerEnded(core, asked.answerId);
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");
    return { event, answer: answer as ConversationAnswer, conversationId: asked.conversation.id };
  }

  const lastModel = (fake: FakeOpenAI) => answerResponses(fake).at(-1)?.body.model;

  /** What the Problem line offers for an Answer `modelId` couldn't write: the next model, or the first reset. */
  async function offered(core: Core, modelId: string) {
    const { models, limits } = await core.getChatGptPlan();
    return { next: nextPlanModel(models, limits, modelId)?.id ?? null, reset: firstReset(limits) };
  }

  test("the chosen model's limit offers the next model in the plan's order; one click answers with it, in place, until the reset", async () => {
    const { core, fake } = await onPlan();
    const resetsAt = START + hours(2);
    usedUp(fake, SOL, resetsAt);

    const failed = await settled(core, core.askInConversation({ text: "What is attention?" }));

    expect(failed.event).toBe("failed");
    expect(failed.answer).toMatchObject({ errorKind: "plan-limit", model: { modelId: SOL } });
    expect((await core.getChatGptPlan()).limits).toEqual({
      usedUp: [{ modelId: SOL, resetsAt: new Date(resetsAt).toISOString() }],
      standIn: null,
    });
    expect(await offered(core, SOL)).toEqual({
      next: ASTRA,
      reset: new Date(resetsAt).toISOString(),
    });

    const status = await core.answerWithPlanModel({ insteadOf: SOL, modelId: ASTRA });
    expect(status.limits.standIn).toEqual({
      insteadOf: SOL,
      modelId: ASTRA,
      until: new Date(resetsAt).toISOString(),
    });
    const again = await settled(
      core,
      core.regenerateConversationAnswer({
        conversationId: failed.conversationId,
        answerId: failed.answer.id,
      }),
    );
    expect(again).toMatchObject({
      event: "finished",
      answer: { id: failed.answer.id, text: ANSWER },
    });
    expect(again.answer.model?.modelId).toBe(ASTRA);
    expect(lastModel(fake)).toBe(ASTRA);

    const followUp = await settled(
      core,
      core.askInConversation({ text: "And transformers?", conversationId: failed.conversationId }),
    );
    expect(followUp.answer.model?.modelId).toBe(ASTRA);
  });

  test("a model whose limit is already used up is passed over, and with none left the first reset is all there is", async () => {
    const { core, fake } = await onPlan();
    usedUp(fake, SOL, START + hours(3));
    const first = await settled(core, core.askInConversation({ text: "What is attention?" }));
    await core.answerWithPlanModel({ insteadOf: SOL, modelId: ASTRA });
    usedUp(fake, ASTRA, START + hours(1));

    const second = await settled(
      core,
      core.askInConversation({ text: "And transformers?", conversationId: first.conversationId }),
    );

    expect(second.answer).toMatchObject({ errorKind: "plan-limit", model: { modelId: ASTRA } });
    expect((await offered(core, ASTRA)).next).toBe(LUNA);
    // Luna stands in for the model the User chose, until that one's reset.
    const status = await core.answerWithPlanModel({ insteadOf: ASTRA, modelId: LUNA });
    expect(status.limits.standIn).toEqual({
      insteadOf: SOL,
      modelId: LUNA,
      until: new Date(START + hours(3)).toISOString(),
    });

    usedUp(fake, LUNA, START + hours(2));
    const third = await settled(
      core,
      core.askInConversation({
        text: "And attention heads?",
        conversationId: first.conversationId,
      }),
    );
    expect(third.answer).toMatchObject({ errorKind: "plan-limit", model: { modelId: LUNA } });
    expect(await offered(core, LUNA)).toEqual({
      next: null,
      reset: new Date(START + hours(1)).toISOString(),
    });
  });

  test("after the reset time the chosen model answers again, with nothing to click", async () => {
    const { core, fake, clock } = await onPlan();
    usedUp(fake, SOL, START + hours(2));
    const first = await settled(core, core.askInConversation({ text: "What is attention?" }));
    await core.answerWithPlanModel({ insteadOf: SOL, modelId: ASTRA });
    fake.replyFor = {};

    clock.advance(hours(2));
    const after = await settled(
      core,
      core.askInConversation({ text: "And transformers?", conversationId: first.conversationId }),
    );

    expect(after.answer.model?.modelId).toBe(SOL);
    expect(lastModel(fake)).toBe(SOL);
    expect((await core.getChatGptPlan()).limits).toEqual({ usedUp: [], standIn: null });
  });

  test("the User's own pick wins over the stand-in", async () => {
    const { core, fake } = await onPlan();
    usedUp(fake, SOL, START + hours(2));
    const first = await settled(core, core.askInConversation({ text: "What is attention?" }));
    await core.answerWithPlanModel({ insteadOf: SOL, modelId: ASTRA });

    expect((await core.endPlanStandIn()).limits.standIn).toBeNull();
    const picked = await settled(
      core,
      core.askInConversation({ text: "And transformers?", conversationId: first.conversationId }),
    );

    // Sol is still used up: the Answer says so again, rather than switch by itself.
    expect(picked.answer).toMatchObject({ errorKind: "plan-limit", model: { modelId: SOL } });
    expect(lastModel(fake)).toBe(SOL);
  });

  test("nothing switches model without the click", async () => {
    const { core, fake } = await onPlan();
    usedUp(fake, SOL, START + hours(2));
    const first = await settled(core, core.askInConversation({ text: "What is attention?" }));

    const again = await settled(
      core,
      core.askInConversation({ text: "And transformers?", conversationId: first.conversationId }),
    );

    expect(again.answer).toMatchObject({ errorKind: "plan-limit", model: { modelId: SOL } });
    expect(fake.responses().map((request) => request.body.model)).toEqual([SOL, SOL]);
  });

  test("with no reset time, it lasts for now: the chosen model gets one small try an hour, and answers once it can", async () => {
    const { core, fake, clock } = await onPlan();
    usedUp(fake, SOL, null);
    const first = await settled(core, core.askInConversation({ text: "What is attention?" }));
    expect((await core.getChatGptPlan()).limits.usedUp).toEqual([{ modelId: SOL, resetsAt: null }]);
    await core.answerWithPlanModel({ insteadOf: SOL, modelId: LUNA });
    const ask = (text: string) =>
      settled(core, core.askInConversation({ text, conversationId: first.conversationId }));

    clock.advance(hours(1) - 60_000);
    expect((await ask("Second?")).answer.model?.modelId).toBe(LUNA);
    clock.advance(60_000);
    const sent = answerResponses(fake).length;
    expect((await ask("Third?")).answer.model?.modelId).toBe(LUNA);
    // One small try of Sol first, refused, then the Question to Luna.
    expect(
      answerResponses(fake)
        .slice(sent)
        .map((request) => request.body.model),
    ).toEqual([SOL, LUNA]);
    expect((await core.getChatGptPlan()).limits.standIn).toMatchObject({ modelId: LUNA });

    fake.replyFor = {};
    clock.advance(hours(1));
    const back = await ask("Fourth?");
    expect(back.answer.model?.modelId).toBe(SOL);
    expect((await core.getChatGptPlan()).limits).toEqual({ usedUp: [], standIn: null });
  });
});

describe("The experimental provider it replaces", () => {
  /** A data folder as the experimental "ChatGPT plan (via Codex sign-in)" left it, switch on or off. */
  async function oldDataFolder(switchOn: boolean) {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 53),
    );
    const at = "2026-10-01T00:00:00.000Z";
    db.run(
      `INSERT INTO chat_providers (id, kind, base_url, catalog_id, endpoint, created_at, updated_at)
       VALUES ('plan-provider', 'chatgpt', NULL, NULL, NULL, ?, ?)`,
      [at, at],
    );
    const setting = (table: string, key: string, value: unknown) =>
      db.run(
        `INSERT INTO ${table} (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [`${table}-${key}`, key, JSON.stringify(value), at, at],
      );
    setting("user_settings", "chatModel", { providerId: "plan-provider", modelId: "gpt-5.5" });
    setting("device_settings", "chatGptPlanEnabled", switchOn);
    setting("device_settings", "chatGptSignInExpired", false);
    db.run(
      `INSERT INTO data_flow_consents
         (id, flow, service_id, service_name, decision, data_kinds, created_at, updated_at)
       VALUES ('old-consent', 'chat', 'https://chatgpt.com', 'ChatGPT', 'accepted', '["blocks","passages"]', ?, ?)`,
      [at, at],
    );
    db.close();
    const keychain = createMemoryKeychain();
    await keychain.set("chatgpt-plan:tokens", JSON.stringify({ accessToken: "codex-token" }));
    await keychain.set("chat-provider:other:api-key", "sk-kept");
    return { dataDir, keychain };
  }

  const leftovers = (dataDir: string) => {
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      return db.all<{ key: string }>(
        `SELECT key FROM device_settings
         WHERE key IN ('chatGptPlanEnabled', 'chatGptSignInExpired') AND deleted_at IS NULL`,
      );
    } finally {
      db.close();
    }
  };

  test("where it was on, its provider stays and asks for Continue with ChatGPT, and its tokens go", async () => {
    const { dataDir, keychain } = await oldDataFolder(true);

    const core = startCore(dataDir, { keychain });

    await expect.poll(() => keychain.secrets.has("chatgpt-plan:tokens")).toBe(false);
    expect(keychain.secrets.get("chat-provider:other:api-key")).toBe("sk-kept");
    expect(await core.listChatProviders()).toMatchObject([
      { id: "plan-provider", kind: "chatgpt" },
    ]);
    expect((await core.getSettings()).user.chatModel).toEqual({
      providerId: "plan-provider",
      modelId: "gpt-5.5",
    });
    expect(await core.getChatReadiness()).toMatchObject({
      ready: false,
      reason: "sign-in-required",
    });
    // Nothing goes to chatgpt.com any more: the decision about it is gone, and so is the switch.
    const services = (await core.listDataFlows()).map((status) => status.flow.service.id);
    expect(services).not.toContain("https://chatgpt.com");
    expect(leftovers(dataDir)).toEqual([]);
  });

  test("where it was off, its hidden provider goes, with the default model on it", async () => {
    const { dataDir, keychain } = await oldDataFolder(false);

    const core = startCore(dataDir, { keychain });

    await expect.poll(() => keychain.secrets.has("chatgpt-plan:tokens")).toBe(false);
    expect(await core.listChatProviders()).toEqual([]);
    expect((await core.getSettings()).user.chatModel).toBeNull();
    expect(await core.getChatReadiness()).toEqual({ ready: false, reason: "no-provider" });
    expect(leftovers(dataDir)).toEqual([]);
  });
});
