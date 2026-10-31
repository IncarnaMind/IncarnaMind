import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText, streamText } from "ai";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { version } from "../../package.json";
import { type Core, createAiSdkChatModel } from "../../src/core";
import type { SignInRouteProblem } from "../../src/core/api";
import { createClaudeAccount } from "../../src/core/providers/claudeAccount/account";
import { createAccountFetch } from "../../src/core/providers/claudeAccount/messages";
import { CLAUDE_ACCOUNT_SERVICE } from "../../src/core/providers/claudeAccount/service";
import { classifyProviderError } from "../../src/core/providers/providerErrors";
import { SIGN_IN_ROUTES, wayBackLabel } from "../../src/core/providers/signInRoutes";
import { createFileKeychain, SECRETS_FILE } from "../../src/main/secretsFile";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { createFakeCipher } from "../helpers/cipher";
import {
  createMemoryKeychain,
  createTempDataFolder,
  type MemoryKeychain,
  manualClock,
  nextTurn,
  startCore,
  type TestAdapters,
} from "../helpers/core";
import {
  ANSWER,
  BETA_FLAG,
  createFakeAnthropic,
  createFakeClaudeBrowser,
  type FakeAnthropic,
  type FakeClaudeBrowser,
  SYSTEM_BLOCK,
} from "../helpers/fakeAnthropic";

const MODEL = "claude-sonnet-5-5";

async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const fake = await createFakeAnthropic();
  onTestFinished(() => fake.close());
  return fake;
}

interface Setup {
  dataDir: string;
  core: Core;
  fake: FakeAnthropic;
  browser: FakeClaudeBrowser;
  keychain: MemoryKeychain;
  clock: ReturnType<typeof manualClock>;
}

async function setUp(
  redirect: "page" | "loopback" = "page",
  overrides: TestAdapters = {},
): Promise<Setup> {
  const clock = manualClock();
  const fake = await startFakeAnthropic();
  const browser = createFakeClaudeBrowser(fake);
  const keychain = createMemoryKeychain();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    keychain,
    browser,
    now: clock.now,
    createChatModel: createAiSdkChatModel,
    claudeAccount: fake.profile(redirect),
    ...overrides,
  });
  return { dataDir, core, fake, browser, keychain, clock };
}

/** Waits until the browser is open and the sign-in can take a pasted address. */
async function browserOpened(browser: FakeClaudeBrowser, count = 1) {
  await vi.waitFor(() => expect(browser.opened).toHaveLength(count));
  await nextTurn();
}

/** Signs in by pasting the code Anthropic's page shows, as the User does. */
async function signIn({ core, browser }: Pick<Setup, "core" | "browser">) {
  const result = core.signInToClaude();
  await browserOpened(browser, browser.opened.length + 1);
  expect(await core.pasteClaudeSignInAddress(browser.shown?.code ?? "")).toEqual({ ok: true });
  expect(await result).toMatchObject({ ok: true });
}

/** Signs in and makes a Claude account model the default, which allows its flows. */
async function signedIn(
  redirect: "page" | "loopback" = "page",
  overrides: TestAdapters = {},
): Promise<Setup> {
  const setup = await setUp(redirect, overrides);
  await signIn(setup);
  await setup.core.saveChatProvider({ kind: "claude-account", modelId: MODEL });
  return setup;
}

async function ask(core: Core) {
  const { model } = await core.prepareChatModel();
  return generateText({ model, system: "IncarnaMind's own.", prompt: "Hi", maxRetries: 0 });
}

async function failure(core: Core) {
  try {
    await ask(core);
  } catch (error) {
    return classifyProviderError(error);
  }
  throw new Error("The request didn't fail.");
}

const stored = (keychain: MemoryKeychain) => [...keychain.secrets.values()].join("\n");

const fiveMinutes = 5 * 60_000;

describe("Sign in with Claude", () => {
  test("a record that can't be read leaves the status signed out, and signing in replaces it", async () => {
    const dataDir = await createTempDataFolder();
    const file = join(dataDir, SECRETS_FILE);
    const unreadable = Buffer.from("not a sign-in record").toString("base64");
    await writeFile(file, JSON.stringify({ "claude:account": unreadable }), { mode: 0o600 });
    const before = await readFile(file);
    const fake = await startFakeAnthropic();
    const browser = createFakeClaudeBrowser(fake);
    const core = startCore(dataDir, {
      keychain: createFileKeychain(file, createFakeCipher()),
      browser,
      claudeAccount: fake.profile("page"),
    });

    expect(await core.getClaudeAccount()).toMatchObject({ account: { state: "signed-out" } });
    expect((await readFile(file)).equals(before)).toBe(true);

    browser.behaviour = "wait";
    const abandoned = core.signInToClaude();
    await browserOpened(browser);
    await core.cancelClaudeSignIn();
    expect(await abandoned).toMatchObject({ ok: false });
    expect((await readFile(file)).equals(before)).toBe(true);

    browser.behaviour = "approve";
    const result = core.signInToClaude();
    await browserOpened(browser, 2);
    expect(await core.pasteClaudeSignInAddress(browser.shown?.code ?? "")).toEqual({ ok: true });
    expect(await result).toMatchObject({ ok: true, status: { account: { state: "signed-in" } } });
    expect((await readFile(file)).equals(before)).toBe(false);
    expect(await core.getClaudeAccount()).toMatchObject({ account: { state: "signed-in" } });
  });

  test("Anthropic's page is opened with PKCE (S256) and a state, and the code pasted from it signs in", async () => {
    const { core, fake, browser, keychain } = await setUp();
    const result = core.signInToClaude();
    await browserOpened(browser);

    const authorize = new URL(browser.opened[0] ?? "");
    const params = Object.fromEntries(authorize.searchParams);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${fake.origin}/oauth/authorize`);
    expect(params).toEqual({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: `${fake.origin}/oauth/code/callback`,
      scope: "user:profile user:inference",
      code: "true",
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: "S256",
      state: expect.stringMatching(/^[\w-]{43}$/),
    });
    expect((await core.getClaudeAccount()).signingIn).toBe(true);

    expect(await core.pasteClaudeSignInAddress(` ${browser.shown?.code} `)).toEqual({ ok: true });
    expect(await result).toMatchObject({
      ok: true,
      status: { available: true, experimental: true, account: { state: "signed-in" } },
    });

    const [exchange] = fake.tokenRequests;
    expect(exchange).toEqual({
      grant_type: "authorization_code",
      client_id: "test-client",
      code: "code-1",
      state: params.state,
      redirect_uri: params.redirect_uri,
      code_verifier: expect.stringMatching(/^[\w-]{43}$/),
    });
    const verifier = String(exchange?.code_verifier);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(params.code_challenge);
    expect(stored(keychain)).toContain(fake.issued[0]?.accessToken);
  });

  test("a profile's extra parameters can't replace the protocol's own", async () => {
    const fake = await startFakeAnthropic();
    const taken = {
      response_type: "token",
      client_id: "other-client",
      redirect_uri: "https://elsewhere.example.test/callback",
      code_challenge: "chosen-challenge",
      code_challenge_method: "plain",
      state: "chosen-state",
    };
    const browser = createFakeClaudeBrowser(fake);
    const keychain = createMemoryKeychain();
    const core = startCore(await createTempDataFolder(), {
      keychain,
      browser,
      claudeAccount: { ...fake.profile("page"), authorizeParams: { code: "true", ...taken } },
    });

    await signIn({ core, browser });

    const params = Object.fromEntries(new URL(browser.opened[0] ?? "").searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: `${fake.origin}/oauth/code/callback`,
      code_challenge_method: "S256",
      code: "true",
    });
    expect(params.code_challenge).not.toBe(taken.code_challenge);
    expect(params.state).not.toBe(taken.state);
  });

  test("a code with another state is refused and changes nothing; the page's address still works", async () => {
    const { core, fake, browser } = await setUp();
    const result = core.signInToClaude();
    await browserOpened(browser);
    const [code] = (browser.shown?.code ?? "").split("#");

    expect(await core.pasteClaudeSignInAddress(`${code}#another-state`)).toEqual({
      ok: false,
      problem: "other-sign-in",
    });
    expect(await core.pasteClaudeSignInAddress("not an address")).toEqual({
      ok: false,
      problem: "not-sign-in-address",
    });
    const { searchParams } = new URL(browser.shown?.address ?? "");
    for (const elsewhere of [
      `https://elsewhere.example/oauth/code/callback?${searchParams}`,
      `${fake.origin}/another/path?${searchParams}`,
    ]) {
      expect(await core.pasteClaudeSignInAddress(elsewhere), elsewhere).toEqual({
        ok: false,
        problem: "not-sign-in-address",
      });
    }
    expect(fake.tokenRequests).toHaveLength(0);

    expect(await core.pasteClaudeSignInAddress(browser.shown?.address ?? "")).toEqual({ ok: true });
    expect(await result).toMatchObject({ ok: true });
    expect(await core.pasteClaudeSignInAddress(browser.shown?.code ?? "")).toEqual({
      ok: false,
      problem: "finished",
    });
    expect(fake.tokenRequests).toHaveLength(1);
  });

  test("with a loopback redirect, the browser and a pasted address race: the first wins, and the code is exchanged once", async () => {
    const { core, fake, browser } = await setUp("loopback");
    browser.behaviour = "wait";
    const result = core.signInToClaude();
    await browserOpened(browser);
    const address = browser.shown?.address ?? "";
    expect(new URL(address).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(await core.pasteClaudeSignInAddress(address)).toEqual({ ok: true });
    const late = await fetch(address);
    await late.text();

    expect(late.status).toBe(409);
    expect(await result).toMatchObject({ ok: true });
    expect(fake.tokenRequests).toHaveLength(1);
  });

  test("with a loopback redirect, the browser coming back signs in by itself", async () => {
    const { core, browser } = await setUp("loopback");

    expect(await core.signInToClaude()).toMatchObject({ ok: true });
    expect(await browser.visits[0]).toBe(200);
  });

  test("the waiting sign-in's page can be opened again, and not once it has finished", async () => {
    const setup = await setUp();
    const result = setup.core.signInToClaude();
    await browserOpened(setup.browser);

    expect(await setup.core.reopenClaudeSignIn()).toBe(true);
    expect(setup.browser.opened).toHaveLength(2);
    expect(setup.browser.opened[1]).toBe(setup.browser.opened[0]);

    await setup.core.pasteClaudeSignInAddress(setup.browser.shown?.code ?? "");
    await result;
    expect(await setup.core.reopenClaudeSignIn()).toBe(false);
  });

  test("cancelling a waiting sign-in keeps nothing", async () => {
    const { core, browser, keychain } = await setUp();
    const result = core.signInToClaude();
    await browserOpened(browser);

    await core.cancelClaudeSignIn();

    expect(await result).toMatchObject({ ok: false, error: { kind: "sign-in-cancelled" } });
    expect(keychain.secrets.size).toBe(0);
    expect((await core.getClaudeAccount()).account).toEqual({ state: "signed-out" });
  });

  test("declining on Anthropic's page is a refused sign-in", async () => {
    const { core, browser, keychain } = await setUp("loopback");
    browser.behaviour = "decline";

    expect(await core.signInToClaude()).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(keychain.secrets.size).toBe(0);
  });

  test("a code pasted short is a failed sign-in, which signing in again fixes, not a refusal", async () => {
    const { core, browser, keychain } = await setUp();
    const result = core.signInToClaude();
    await browserOpened(browser);

    expect(await core.pasteClaudeSignInAddress((browser.shown?.code ?? "").slice(1))).toEqual({
      ok: true,
    });

    expect(await result).toMatchObject({ ok: false, error: { kind: "failed" } });
    expect(keychain.secrets.size).toBe(0);
  });

  test("a token endpoint that redirects is never followed", async () => {
    const { core, fake, browser, keychain } = await setUp();
    fake.redirects = true;
    const result = core.signInToClaude();
    await browserOpened(browser);
    await core.pasteClaudeSignInAddress(browser.shown?.code ?? "");

    expect(await result).toMatchObject({ ok: false });
    expect(fake.redirected).toEqual([]);
    expect(keychain.secrets.size).toBe(0);
  });

  test("signed in, the status names the account and organization, until sign-out", async () => {
    const { core } = await signedIn();

    expect((await core.getClaudeAccount()).account).toEqual({
      state: "signed-in",
      email: "reader@example.test",
      organization: "Reader's Organization",
    });
    await core.signOutOfClaude();
    expect((await core.getClaudeAccount()).account).toEqual({ state: "signed-out" });
  });

  test("a build without a client profile doesn't offer the route", async () => {
    const account = createClaudeAccount({
      config: null,
      secrets: {
        status: () => ({ protection: "os", plainTextAccepted: false, canSave: true }),
        acceptPlainText: () => ({ protection: "os", plainTextAccepted: false, canSave: true }),
        get: async () => null,
        tryGet: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      language: () => "en",
      browser: { open: async () => {} },
      now: () => 0,
      onChange: () => {},
    });

    expect(await account.status()).toMatchObject({ available: false, experimental: false });
    expect(await account.signIn()).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  });
});

describe("Tokens", () => {
  test("are kept only in the secret store, never in the data folder's other files", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createFileKeychain(join(dataDir, SECRETS_FILE), createFakeCipher());
    const { core, fake, clock } = await signedIn("page", { keychain, paths: { dataDir } });
    clock.advance(fake.expiresIn * 1000);
    await ask(core);
    core.close();

    const tokens = fake.issued.flatMap((set) => [set.accessToken, set.refreshToken]);
    expect(tokens).toHaveLength(4);
    const files = (await readdir(dataDir, { withFileTypes: true, recursive: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files).toContain(join(dataDir, SECRETS_FILE));
    for (const file of files) {
      const bytes = await readFile(file);
      for (const token of tokens) expect(bytes.includes(token), file).toBe(false);
    }
    const restarted = startCore(dataDir, {
      keychain: createFileKeychain(join(dataDir, SECRETS_FILE), createFakeCipher()),
      claudeAccount: fake.profile("page"),
    });
    expect((await restarted.getClaudeAccount()).account).toMatchObject({
      state: "signed-in",
      email: "reader@example.test",
    });
  });

  test("an access token is refreshed shortly before it expires, and the new tokens replace the old", async () => {
    const { core, fake, clock, keychain } = await signedIn();
    clock.advance(fake.expiresIn * 1000 - fiveMinutes - 1000);
    await ask(core);
    expect(fake.tokenRequests).toHaveLength(1);

    clock.advance(2000);
    await ask(core);

    expect(fake.tokenRequests[1]).toEqual({
      grant_type: "refresh_token",
      client_id: "test-client",
      refresh_token: fake.issued[0]?.refreshToken,
    });
    expect(fake.messages.at(-1)?.headers.authorization).toBe(
      `Bearer ${fake.issued[1]?.accessToken}`,
    );
    expect(stored(keychain)).toContain(fake.issued[1]?.refreshToken);
    expect(stored(keychain)).not.toContain(fake.issued[0]?.refreshToken);
  });

  test("a token the API refuses early is refreshed once and the request retried", async () => {
    const { core, fake } = await signedIn();
    fake.replies.push({
      kind: "error",
      status: 401,
      body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "" } }),
    });

    const { text } = await ask(core);

    expect(text).toBe(ANSWER);
    expect(fake.tokenRequests.map((request) => request.grant_type)).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  test("a refused refresh ends the sign-in: the Answer says it expired, with Sign in again", async () => {
    const { core, fake, clock } = await signedIn();
    fake.refuseRefresh = "invalid_grant";
    clock.advance(fake.expiresIn * 1000);
    const sent = fake.messages.length;

    const error = await failure(core);

    expect(error).toMatchObject({ kind: "not-signed-in", signInRoute: "sign-in-expired" });
    expect(fake.messages).toHaveLength(sent);
    expect((await core.getClaudeAccount()).account).toEqual({ state: "expired" });
    expect(await core.getChatReadiness()).toMatchObject({
      ready: false,
      reason: "sign-in-required",
    });
  });

  test("signing out while a refresh is being saved forgets the tokens it brings too", async () => {
    const memory = createMemoryKeychain();
    let release = () => {};
    let held = false;
    const keychain: MemoryKeychain = {
      ...memory,
      async set(name, value) {
        if (value.includes("access-2")) {
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await memory.set(name, value);
      },
    };
    const { core, fake, clock } = await signedIn("page", { keychain });
    clock.advance(fake.expiresIn * 1000);
    const asking = ask(core).catch(() => undefined);
    await vi.waitFor(() => expect(held).toBe(true));

    const signingOut = core.signOutOfClaude();
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    release();
    await Promise.all([asking, signingOut]);

    expect(fake.issued).toHaveLength(2);
    for (const tokens of fake.issued) {
      expect(stored(memory)).not.toContain(tokens.accessToken);
      expect(stored(memory)).not.toContain(tokens.refreshToken);
    }
    expect((await core.getClaudeAccount()).account).toEqual({ state: "signed-out" });
  });

  test("signing out during a refresh revokes the refresh token it brings, where the profile can revoke", async () => {
    const fake = await startFakeAnthropic();
    const browser = createFakeClaudeBrowser(fake);
    const keychain = createMemoryKeychain();
    const clock = manualClock();
    const core = startCore(await createTempDataFolder(), {
      keychain,
      browser,
      now: clock.now,
      createChatModel: createAiSdkChatModel,
      claudeAccount: { ...fake.profile("page"), revokeUrl: `${fake.origin}/v1/oauth/revoke` },
    });
    await signIn({ core, browser });
    await core.saveChatProvider({ kind: "claude-account", modelId: MODEL });
    let release = () => {};
    fake.holdRefresh = new Promise<void>((resolve) => {
      release = resolve;
    });
    clock.advance(fake.expiresIn * 1000);
    const asking = ask(core).catch(() => undefined);
    await vi.waitFor(() => expect(fake.tokenRequests).toHaveLength(2));

    const signingOut = core.signOutOfClaude();
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    release();
    await Promise.all([asking, signingOut]);

    expect(fake.issued).toHaveLength(2);
    expect(fake.revoked).toContain(fake.issued[1]?.refreshToken);
    expect(stored(keychain)).not.toContain(fake.issued[1]?.refreshToken);
  });

  test("signing out forgets the tokens, and nothing is sent afterwards", async () => {
    const { core, fake, keychain } = await signedIn();
    await ask(core);
    const sent = fake.messages.length;

    expect((await core.signOutOfClaude()).account).toEqual({ state: "signed-out" });

    for (const tokens of fake.issued) {
      expect(stored(keychain)).not.toContain(tokens.accessToken);
      expect(stored(keychain)).not.toContain(tokens.refreshToken);
    }
    await expect(core.prepareChatModel()).rejects.toThrow();
    expect(fake.messages).toHaveLength(sent);
  });
});

describe("Requests", () => {
  test("carry the account's token, IncarnaMind's User-Agent, and what the profile adds first", async () => {
    const { core, fake } = await signedIn();

    const { text } = await ask(core);

    expect(text).toBe(ANSWER);
    const [request] = fake.messages;
    expect(request?.headers).toMatchObject({
      authorization: `Bearer ${fake.issued[0]?.accessToken}`,
      "user-agent": `IncarnaMind/${version}`,
    });
    expect(request?.headers["x-api-key"]).toBeUndefined();
    expect(request?.headers["anthropic-beta"]?.split(",")).toContain(BETA_FLAG);
    expect(request?.body.system).toEqual([
      expect.objectContaining({ text: SYSTEM_BLOCK }),
      expect.objectContaining({ text: "IncarnaMind's own." }),
    ]);
  });

  test("an API key's requests carry nothing of the account route's profile", async () => {
    const { fake } = await setUp();
    const model = createAiSdkChatModel({
      kind: "anthropic",
      baseUrl: `${fake.origin}/v1`,
      apiKey: "test-key",
      modelId: MODEL,
    });

    await generateText({ model, system: "IncarnaMind's own.", prompt: "Hi", maxRetries: 0 });

    const [request] = fake.messages;
    expect(request?.headers["x-api-key"]).toBe("test-key");
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers["anthropic-beta"] ?? "").not.toContain(BETA_FLAG);
    expect(JSON.stringify(request?.body.system)).not.toContain(SYSTEM_BLOCK);
  });

  test("a streamed Answer comes through", async () => {
    const { core } = await signedIn();
    const { model } = await core.prepareChatModel();

    const result = streamText({ model, prompt: "Hi", maxRetries: 0 });

    expect(await result.text).toBe(ANSWER);
  });

  test("choosing the route allows its flows to the Claude account's own service, and nothing is sent before", async () => {
    const setup = await setUp();
    await signIn(setup);
    const { core, fake } = setup;
    expect(fake.messages).toHaveLength(0);

    await core.saveChatProvider({ kind: "claude-account", modelId: MODEL });

    const chat = (await core.listDataFlows()).find(
      (flow) => flow.flow.id === "chat" && flow.flow.service.id === CLAUDE_ACCOUNT_SERVICE.id,
    );
    expect(chat).toMatchObject({ consent: "accepted", chosen: true });
    expect(await core.getChatReadiness()).toMatchObject({ ready: true });
  });

  test("the Privacy page lists the sign-in's traffic to Anthropic once the User has signed in", async () => {
    const setup = await setUp();
    const ids = async () => (await setup.core.listNetworkTraffic()).map((traffic) => traffic.id);
    expect(await ids()).not.toContain("claude-sign-in");

    await signIn(setup);

    expect(await setup.core.listNetworkTraffic()).toContainEqual({
      id: "claude-sign-in",
      service: { id: setup.fake.origin, name: new URL(setup.fake.origin).host },
      enabled: true,
    });
  });

  test("the Privacy page lists each origin the sign-in reaches, when they differ", async () => {
    const fake = await startFakeAnthropic();
    const profile = {
      ...fake.profile("page"),
      authorizeUrl: "https://login.example.test/authorize",
      revokeUrl: "https://revoke.example.test/oauth/revoke",
    };
    const browser = createFakeClaudeBrowser(fake);
    const keychain = createMemoryKeychain();
    const core = startCore(await createTempDataFolder(), {
      keychain,
      browser,
      claudeAccount: profile,
    });
    await signIn({ core, browser });

    const services = (await core.listNetworkTraffic())
      .filter((traffic) => traffic.id === "claude-sign-in")
      .map((traffic) => traffic.service.id);
    expect(services.sort()).toEqual(
      ["https://login.example.test", "https://revoke.example.test", fake.origin].sort(),
    );
  });

  test("a Messages API that redirects is never followed, so the token stays with the API", async () => {
    const { core, fake } = await signedIn();
    fake.redirects = true;

    await expect(ask(core)).rejects.toThrow();
    expect(fake.redirected).toEqual([]);
  });

  test("the account's token is never sent to another origin than the API's", async () => {
    const calls: string[] = [];
    const accountFetch = createAccountFetch(
      { access: async () => ({ accessToken: "test-access" }) },
      {},
      "https://api.example.test/v1",
      async (input) => {
        calls.push(String(input));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    );

    await expect(
      accountFetch("https://elsewhere.example.test/v1/messages", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/only sent to https:\/\/api\.example\.test/);
    expect(calls).toEqual([]);
    await accountFetch("https://api.example.test/v1/messages", { method: "POST", body: "{}" });
    expect(calls).toEqual(["https://api.example.test/v1/messages"]);
  });

  test("codes and tokens are never logged", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        logged.push(...args);
      });
    }
    const { core, fake, clock } = await signedIn();
    clock.advance(fake.expiresIn * 1000);
    await ask(core);
    fake.refuseRefresh = "invalid_grant";
    clock.advance(fake.expiresIn * 1000);
    await failure(core);
    vi.restoreAllMocks();

    const text = logged.map((each) => String(each instanceof Error ? each.stack : each)).join("\n");
    const secrets = [
      "code-1",
      ...fake.issued.flatMap((set) => [set.accessToken, set.refreshToken]),
    ];
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});

describe("Failures", () => {
  const cases: {
    name: string;
    reply: { status: number; headers?: Record<string, string>; body: string };
    kind: string;
    problem: SignInRouteProblem;
  }[] = [
    {
      name: "the plan's usage limit",
      reply: {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": "1791300000",
        },
        body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
      },
      kind: "plan-limit",
      problem: "plan-limit",
    },
    {
      name: "a refused sign-in",
      reply: {
        status: 403,
        body: JSON.stringify({ type: "error", error: { type: "permission_error", message: "" } }),
      },
      kind: "blocked",
      problem: "refused",
    },
    {
      name: "a token the endpoint won't take for this request",
      reply: {
        status: 400,
        body: JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "This credential can't be used here." },
        }),
      },
      kind: "blocked",
      problem: "refused",
    },
    {
      name: "a page that isn't an answer",
      reply: { status: 200, headers: { "content-type": "text/html" }, body: "<html></html>" },
      kind: "provider",
      problem: "unexpected-response",
    },
  ];

  for (const { name, reply, kind, problem } of cases) {
    test(`${name} is "${problem}"`, async () => {
      const { core, fake } = await signedIn();
      fake.replies.push({ kind: "error", ...reply });

      expect(await failure(core)).toMatchObject({ kind, signInRoute: problem });
    });

    test(`${name} stops an Answer in the assistant, which keeps "${problem}" for its line`, async () => {
      const { core, fake } = await signedIn();
      const error = { kind: "error" as const, ...reply };
      // Every request fails alike, a search rewrite included.
      fake.replies.push(error, error, error, error);

      const answer = await askAssistant(core, { text: "What does my plan cover?" }, "failed");

      expect(answer).toMatchObject({ errorKind: kind, errorSignInRoute: problem });
    });
  }

  test("an Answer the expired sign-in stopped keeps its problem after a restart", async () => {
    const setup = await signedIn();
    const { core, fake, clock, keychain, dataDir } = setup;
    fake.refuseRefresh = "invalid_grant";
    clock.advance(fake.expiresIn * 1000);
    const answer = await askAssistant(core, { text: "What does my plan cover?" }, "failed");
    expect(answer.errorSignInRoute).toBe("sign-in-expired");
    core.close();

    const again = startCore(dataDir, { keychain, claudeAccount: fake.profile("page") });
    const { messages } = await again.getConversation(answer.conversationId);

    expect(messages.find((message) => message.id === answer.id)).toMatchObject({
      errorKind: "not-signed-in",
      errorSignInRoute: "sign-in-expired",
    });
  });

  test("the plan's limit says when it resets", async () => {
    const { core, fake } = await signedIn();
    fake.replies.push({ kind: "error", ...(cases[0]?.reply ?? { status: 429, body: "" }) });

    expect(await failure(core)).toMatchObject({
      resetsAt: new Date(1_791_300_000 * 1000).toISOString(),
    });
  });

  test("a prompt that is too long is an ordinary request error, not the route's", async () => {
    const { core, fake } = await signedIn();
    fake.replies.push({
      kind: "error",
      status: 400,
      body: JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens" },
      }),
    });

    const error = await failure(core);

    expect(error.kind).toBe("too-long");
    expect(error.signInRoute).toBeUndefined();
  });

  test("a passing rate limit isn't the plan's", async () => {
    const { core, fake } = await signedIn();
    fake.replies.push({
      kind: "error",
      status: 429,
      body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
    });

    const error = await failure(core);

    expect(error.kind).toBe("rate-limit");
    expect(error.signInRoute).toBeUndefined();
  });

  test("each problem has its own line naming Claude, and its ways back, in English and Chinese", () => {
    const { problems } = SIGN_IN_ROUTES["claude-account"];
    expect(Object.fromEntries(Object.entries(problems).map(([p, w]) => [p, w.waysBack]))).toEqual({
      "sign-in-cancelled": ["sign-in"],
      "signed-out": ["sign-in"],
      "sign-in-expired": ["sign-in-again"],
      refused: ["paste-api-key"],
      "plan-limit": ["use-another-model"],
      "unexpected-response": ["paste-api-key"],
    });
    for (const language of ["en", "zh-CN"] as const) {
      const lines = Object.values(problems).map(({ line }) => translate(language, line));
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) expect(line).toMatch(/Claude/);
      const waysBack = Object.values(problems).flatMap((words) => words.waysBack);
      for (const wayBack of waysBack) {
        const key = wayBackLabel("claude-account", wayBack);
        expect(translate(language, key)).not.toBe(key);
      }
      expect(
        translate(language, "claudeAccount.problem.planLimitUntil", { time: "15:20" }),
      ).toContain("15:20");
    }
  });
});
