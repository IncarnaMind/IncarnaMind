import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type {
  AnswerToolCall,
  Connector,
  ConnectorState,
  Core,
  RemoteConnector,
} from "../../src/core";
import { createFileKeychain, SECRETS_FILE } from "../../src/main/secretsFile";
import { createFakeCipher } from "../helpers/cipher";
import { askAndFinish } from "../helpers/citations";
import { waitForState } from "../helpers/connectors";
import {
  createMemoryKeychain,
  createTempDataFolder,
  type MemoryKeychain,
  manualClock,
  nextEvent,
  queryDatabase,
  startCore,
  type TestAdapters,
} from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, answerText } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import {
  createFakeBrowser,
  type FakeBrowser,
  type FakeRemote,
  MANUAL_CLIENT_ID,
  MANUAL_CLIENT_SECRET,
  SCOPE,
  startFakeRemote,
} from "../helpers/remoteMcp";

const SEARCH = "wiki__search_wiki";
const EDIT = "wiki__edit_wiki";
const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:\d+\/callback$/;

/** A model that searches the wiki through the Connector when it can, then answers with what it found. */
function wikiModel(): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall) => {
    if (!call.tools.includes(SEARCH)) return { text: "I can't reach the wiki." };
    const found = call.results.find((result) => result.tool === SEARCH);
    if (!found)
      return { text: "Let me look.", calls: [{ tool: SEARCH, input: { query: "tides" } }] };
    return { text: `The wiki says: ${found.text}` };
  });
}

interface Setup {
  core: Core;
  fake: FakeRemote;
  browser: FakeBrowser;
  keychain: MemoryKeychain;
  dataDir: string;
  model: MockLanguageModelV4;
}

/** A core with a local chat model (no chat consent) and a fresh fake service, with a fake browser. */
async function setUp(
  overrides: TestAdapters = {},
  model: MockLanguageModelV4 = wikiModel(),
): Promise<Setup> {
  const fake = await startFakeRemote();
  onTestFinished(() => fake.close());
  const browser = createFakeBrowser(fake);
  const keychain = createMemoryKeychain();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    keychain,
    browser,
    createChatModel: scriptedModels(model).createChatModel,
    ...overrides,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, fake, browser, keychain, dataDir, model };
}

const remote = (connector: Connector | undefined): RemoteConnector => {
  if (connector?.transport !== "http") throw new Error("Not a remote Connector.");
  return connector;
};

async function connectorState(core: Core, id: string, state: ConnectorState) {
  return remote(await waitForState(core, id, state));
}

/** Adds the fake service as a Connector named "Wiki"; it ends up waiting for a sign-in. */
async function addWiki(setup: Setup) {
  const added = await setup.core.addConnector({ name: "Wiki", url: setup.fake.url });
  await connectorState(setup.core, added.id, "needs-sign-in");
  return added;
}

/** Adds the fake service and signs in to it. */
async function signedIn(overrides: TestAdapters = {}, model?: MockLanguageModelV4) {
  const setup = await setUp(overrides, model);
  const added = await addWiki(setup);
  const result = await setup.core.signInToConnector(added.id);
  expect(result).toMatchObject({ ok: true, connector: { state: "ready" } });
  return { ...setup, id: added.id };
}

const answerConsentAlways = (core: Core, accept = true) =>
  core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, accept));

/** Asks a Question in a new Mind and returns the Answer's text. */
async function ask(core: Core, text = "What do the tide tables say?") {
  return (await askFor(core, text)).text;
}

/** Asks a Question in a new Mind; returns the Answer's text and its Tool-call cards. */
async function askFor(core: Core, text = "What do the tide tables say?") {
  const mind = await core.createMind({ title: "Questions" });
  const client = await connectToMind(core, mind.id);
  const { answerId } = await askAndFinish(core, client, mind.id, text);
  const toolCalls = JSON.parse(
    String(answerIn(client, answerId).attrs.toolCalls ?? "[]"),
  ) as AnswerToolCall[];
  return { text: answerText(client, answerId), toolCalls };
}

const tokensIn = (keychain: MemoryKeychain, id: string) => {
  const raw = keychain.secrets.get(`connector:${id}:oauth-tokens`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

const refreshes = (fake: FakeRemote) =>
  fake.tokenRequests.filter((request) => request.grant_type === "refresh_token");

/** A port something else is listening on, until the test finishes. */
async function occupy(port: number): Promise<boolean> {
  const server = createServer((_request, response) => response.end());
  const ok = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (ok) onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return ok;
}

describe("Adding a remote Connector", { timeout: 30_000 }, () => {
  test("added by URL, a server that requires a sign-in waits for one, without opening the browser or registering", async () => {
    const setup = await setUp();
    const { core, fake, browser, dataDir } = setup;

    const added = await core.addConnector({ name: "Wiki", url: fake.url });

    expect(added).toMatchObject({
      name: "Wiki",
      transport: "http",
      url: fake.url,
      clientId: null,
      enabled: true,
      state: "connecting",
    });
    const waiting = await connectorState(core, added.id, "needs-sign-in");
    expect(waiting).toMatchObject({
      error: null,
      tools: null,
      signIn: { signedIn: false, expired: false, heldBack: false, error: null },
    });
    // Discovery happened: the protected-resource metadata the 401 pointed to, then the authorization server's.
    const paths = fake.requests.map((request) => request.path);
    expect(paths.slice(0, 3)).toEqual([
      "mcp:/mcp",
      "mcp:/.well-known/oauth-protected-resource/mcp",
      "auth:/.well-known/oauth-authorization-server",
    ]);
    // But nothing the User didn't ask for: no registration, no browser.
    expect(fake.registrations).toEqual([]);
    expect(browser.opened).toEqual([]);
    expect(
      queryDatabase(dataDir, "SELECT name, transport, config, enabled FROM connectors"),
    ).toEqual([
      {
        name: "Wiki",
        transport: "http",
        config: JSON.stringify({
          url: fake.url,
          clientId: null,
          connection: "http",
          headers: [],
          headerKey: added.id,
        }),
        enabled: 1,
      },
    ]);
  });

  test("a server that requires no sign-in is ready at once, with its Tools", async () => {
    const { core, fake } = await setUp();
    fake.open = true;

    const added = await core.addConnector({ name: "Wiki", url: fake.url });

    const ready = await connectorState(core, added.id, "ready");
    expect(ready.tools).toEqual([
      { name: "search_wiki", title: null, description: "Searches the team wiki.", readOnly: true },
      { name: "edit_wiki", title: null, description: "Edits a wiki page.", readOnly: false },
    ]);
    expect(ready.signIn.signedIn).toBe(false);
  });

  test("its URL must be https, or http only on this computer", async () => {
    const { core } = await setUp();
    const add = (url: string) => core.addConnector({ name: "Remote", url });

    await expect(add("http://mcp.example.com/mcp")).rejects.toThrow(/must start with https/);
    await expect(add("ftp://mcp.example.com/mcp")).rejects.toThrow(/must start with https/);
    await expect(add("mcp.example.com")).rejects.toThrow(/isn’t a valid URL/);
    await expect(add("https://me:secret@mcp.example.com/mcp")).rejects.toThrow(/login/);
    await expect(add("  ")).rejects.toThrow(/Enter the server’s URL/);
    await expect(
      core.addConnector({ name: "Both", url: "https://a.example", command: "npx" } as never),
    ).rejects.toThrow(/either a command or a URL/);
    expect(await core.listConnectors()).toEqual([]);
  });

  test("an mcpServers configuration's Streamable HTTP server is imported as a remote Connector", async () => {
    const { core, fake } = await setUp();
    const json = JSON.stringify({ mcpServers: { Wiki: { type: "http", url: fake.url } } });

    expect(await core.previewConnectorImport(json)).toEqual([
      {
        name: "Wiki",
        command: null,
        args: [],
        env: [],
        url: fake.url,
        action: "add",
        connection: "http",
        headers: [],
      },
    ]);
    const { added } = await core.importConnectors(json);

    expect(added).toMatchObject([{ name: "Wiki", transport: "http", url: fake.url }]);
    await connectorState(core, added[0]?.id ?? "", "needs-sign-in");
  });
});

describe("Signing in", { timeout: 30_000 }, () => {
  test("discovers the authorization server, registers IncarnaMind, and signs in in the browser with PKCE, a loopback redirect and the resource", async () => {
    const setup = await setUp();
    const { core, fake, browser, keychain } = setup;
    const added = await addWiki(setup);
    const states: string[] = [];
    core.on("connectors.changed", (list) => {
      const state = list[0]?.state;
      if (state && state !== states.at(-1)) states.push(state);
    });

    const result = await core.signInToConnector(added.id);

    expect(result).toMatchObject({
      ok: true,
      connector: { state: "ready", signIn: { signedIn: true, expired: false, error: null } },
    });
    expect(states).toEqual(["signing-in", "connecting", "ready"]);
    // Dynamic client registration, as a native app with a loopback redirect and no secret.
    expect(fake.registrations).toHaveLength(1);
    const registration = fake.registrations[0]?.metadata ?? {};
    expect(registration).toMatchObject({
      client_name: "IncarnaMind",
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    });
    const redirectUri = (registration.redirect_uris as string[])[0] ?? "";
    expect(redirectUri).toMatch(LOOPBACK_REDIRECT);
    // The browser opened the authorization request once: PKCE, state, the resource and the scope.
    expect(browser.opened).toHaveLength(1);
    expect(fake.authorizeRequests).toEqual([
      {
        response_type: "code",
        client_id: "registered-client-1",
        code_challenge: expect.stringMatching(/^[\w-]{43}$/),
        code_challenge_method: "S256",
        redirect_uri: redirectUri,
        state: expect.stringMatching(/^[\w-]{16,}$/),
        scope: SCOPE,
        resource: fake.resource,
      },
    ]);
    // The code was exchanged with its verifier, for the same resource.
    expect(fake.tokenRequests).toEqual([
      {
        grant_type: "authorization_code",
        code: "code-1",
        code_verifier: expect.stringMatching(/^[\w.~-]{43,128}$/),
        redirect_uri: redirectUri,
        client_id: "registered-client-1",
        resource: fake.resource,
      },
    ]);
    // The tab says so, then the loopback server is gone.
    const visit = await browser.visits[0];
    expect(visit?.status).toBe(200);
    expect(visit?.html).toContain("Signed in to Wiki");
    expect(visit?.html).toContain("You can close this tab");
    await expect(fetch(redirectUri)).rejects.toThrow();
    // Ready: the Tools, listed with the new access token.
    const ready = remote((await core.listConnectors())[0]);
    expect(ready.tools?.map((tool) => tool.name)).toEqual(["search_wiki", "edit_wiki"]);
    const token = fake.issued[0]?.accessToken;
    expect(fake.requests.at(-1)?.authorization).toBe(`Bearer ${token}`);
    // The tokens are in the keychain.
    expect(tokensIn(keychain, added.id)).toMatchObject({
      tokens: { access_token: token, refresh_token: fake.issued[0]?.refreshToken },
      expiresAt: expect.any(Number),
    });
  });

  test("Tools are listed and called through the Connector with the token, which connecting it allowed", async () => {
    const { core, fake, id, model } = await signedIn();
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    expect(await ask(core)).toBe('The wiki says: Wiki results for "tides": Tide tables.');
    // Connecting it allowed sending to the server's origin (ADR-0022): nothing asked.
    expect(requests).toEqual([]);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: {
          id: "connectors",
          service: { id: fake.mcpOrigin, name: new URL(fake.mcpOrigin).host },
          sends: ["tool-arguments"],
        },
        consent: "accepted",
        chosen: true,
      }),
    );
    // Both Tools were offered; the one that claims to only read ran without asking.
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([SEARCH, EDIT]);
    expect(fake.toolCalls).toEqual([
      { tool: "search_wiki", arguments: { query: "tides" }, token: fake.issued[0]?.accessToken },
    ]);
    expect(id).toBeTruthy();
  });

  test("a redirect that carries another state is refused, and the sign-in still finishes", async () => {
    const setup = await setUp();
    const added = await addWiki(setup);
    setup.browser.forgedStateFirst = true;

    const result = await setup.core.signInToConnector(added.id);

    expect(result.ok).toBe(true);
    const [forged, real] = await Promise.all(setup.browser.visits);
    expect(forged?.status).toBe(400);
    expect(forged?.html).toContain("The sign-in state didn&#39;t match.");
    expect(real?.status).toBe(200);
    // The forged code never reached the token endpoint.
    expect(setup.fake.tokenRequests.map((request) => request.code)).toEqual(["code-1"]);
  });

  test("declining in the browser is reported, and nothing is stored", async () => {
    const setup = await setUp();
    const added = await addWiki(setup);
    setup.browser.behaviour = "decline";

    const result = await setup.core.signInToConnector(added.id);

    expect(result).toEqual({
      ok: false,
      error: { kind: "denied", message: expect.stringContaining("The User declined.") },
    });
    const after = await connectorState(setup.core, added.id, "needs-sign-in");
    expect(after.signIn).toEqual({
      signedIn: false,
      expired: false,
      heldBack: false,
      error: { kind: "denied", message: expect.any(String) },
    });
    expect(tokensIn(setup.keychain, added.id)).toBeNull();
    expect((await setup.browser.visits[0])?.status).toBe(400);
  });

  test("a sign-in nobody finishes times out, and frees its port", async () => {
    const setup = await setUp({ connectorSignInTimeoutMs: 300 });
    const added = await addWiki(setup);
    setup.browser.behaviour = "ignore";

    const result = await setup.core.signInToConnector(added.id);

    expect(result).toMatchObject({ ok: false, error: { kind: "timed-out" } });
    const redirect = new URL(setup.browser.opened[0] ?? "").searchParams.get("redirect_uri");
    await expect(fetch(redirect ?? "")).rejects.toThrow();
    await connectorState(setup.core, added.id, "needs-sign-in");
  });

  test("a sign-in waiting for the User can be cancelled", async () => {
    const setup = await setUp();
    const added = await addWiki(setup);
    setup.browser.behaviour = "ignore";

    const signingIn = setup.core.signInToConnector(added.id);
    await connectorState(setup.core, added.id, "signing-in");
    await vi.waitFor(() => expect(setup.browser.opened).toHaveLength(1));
    await setup.core.cancelConnectorSignIn(added.id);

    expect(await signingIn).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    const after = await connectorState(setup.core, added.id, "needs-sign-in");
    expect(after.signIn.error).toBeNull();
  });

  test("a service that can't register IncarnaMind asks for a client ID; with the User's own OAuth app, it signs in", async () => {
    const setup = await setUp();
    const { core, fake, browser, keychain, dataDir } = setup;
    fake.dynamicRegistration = false;
    const added = await addWiki(setup);

    const first = await core.signInToConnector(added.id);

    expect(first).toMatchObject({ ok: false, error: { kind: "client-id-required" } });
    expect(browser.opened).toEqual([]);
    const waiting = await connectorState(core, added.id, "needs-sign-in");
    expect(waiting.signIn.error?.kind).toBe("client-id-required");

    const updated = await core.setConnectorClient(added.id, {
      clientId: MANUAL_CLIENT_ID,
      clientSecret: MANUAL_CLIENT_SECRET,
    });
    expect(updated).toMatchObject({ clientId: MANUAL_CLIENT_ID, state: "needs-sign-in" });
    const second = await core.signInToConnector(added.id);

    expect(second).toMatchObject({ ok: true, connector: { state: "ready" } });
    expect(fake.authorizeRequests[0]?.client_id).toBe(MANUAL_CLIENT_ID);
    expect(fake.tokenRequests[0]).toMatchObject({
      grant_type: "authorization_code",
      client_id: MANUAL_CLIENT_ID,
      client_secret: MANUAL_CLIENT_SECRET,
      resource: fake.resource,
    });
    // The client ID is configuration; its secret is in the keychain only.
    expect(keychain.secrets.get(`connector:${added.id}:oauth-client`)).toContain(
      MANUAL_CLIENT_SECRET,
    );
    const stored = JSON.stringify(queryDatabase(dataDir, "SELECT * FROM connectors"));
    expect(stored).toContain(MANUAL_CLIENT_ID);
    expect(stored).not.toContain(MANUAL_CLIENT_SECRET);
  });

  test("the browser's answer must come from the authorization server IncarnaMind asked (RFC 9207)", async () => {
    const setup = await setUp();
    const added = await addWiki(setup);
    setup.fake.forgedIss = "https://attacker.example";

    const result = await setup.core.signInToConnector(added.id);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "failed", message: expect.stringContaining("another server") },
    });
    // The code was never sent to a token endpoint.
    expect(setup.fake.tokenRequests).toEqual([]);
    expect((await setup.browser.visits[0])?.status).toBe(400);
  });

  test("authorization-server metadata that names another issuer isn't used", async () => {
    const setup = await setUp();
    setup.fake.metadataIssuer = "https://honest.example";
    const added = await setup.core.addConnector({ name: "Wiki", url: setup.fake.url });

    // Connecting says what is wrong, and signing in refuses to go on.
    const failing = await connectorState(setup.core, added.id, "error");
    expect(failing.error).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("names another issuer"),
    });
    const result = await setup.core.signInToConnector(added.id);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "failed", message: expect.stringContaining("names another issuer") },
    });
    expect(setup.browser.opened).toEqual([]);
    expect(setup.fake.registrations).toEqual([]);
  });

  test("signing in again reuses the registration and its port; on another port, it registers again", async () => {
    const { core, fake, browser, id } = await signedIn();
    const firstRedirect = fake.authorizeRequests[0]?.redirect_uri ?? "";

    await core.signOutOfConnector(id);
    expect(await core.signInToConnector(id)).toMatchObject({ ok: true });
    expect(fake.registrations).toHaveLength(1);
    expect(fake.authorizeRequests[1]?.redirect_uri).toBe(firstRedirect);

    await core.signOutOfConnector(id);
    expect(await occupy(Number(new URL(firstRedirect).port))).toBe(true);
    expect(await core.signInToConnector(id)).toMatchObject({ ok: true });
    expect(fake.registrations).toHaveLength(2);
    const third = fake.authorizeRequests[2];
    expect(third?.client_id).toBe("registered-client-2");
    expect(third?.redirect_uri).toMatch(LOOPBACK_REDIRECT);
    expect(third?.redirect_uri).not.toBe(firstRedirect);
    expect(browser.opened).toHaveLength(3);
  });
});

describe("Tokens", { timeout: 30_000 }, () => {
  test("an access token the server refuses is refreshed, with the resource, and the call retried", async () => {
    const { core, fake, keychain, id } = await signedIn();
    answerConsentAlways(core);
    fake.revokeAccessTokens();

    expect(await ask(core)).toContain("Tide tables.");

    expect(refreshes(fake)).toEqual([
      {
        grant_type: "refresh_token",
        refresh_token: fake.issued[0]?.refreshToken,
        client_id: "registered-client-1",
        resource: fake.resource,
      },
    ]);
    expect(fake.toolCalls.map((call) => call.token)).toEqual([fake.issued[1]?.accessToken]);
    expect(tokensIn(keychain, id)).toMatchObject({
      tokens: { access_token: fake.issued[1]?.accessToken },
    });
  });

  test("an access token that has expired is renewed before connecting", async () => {
    const clock = manualClock();
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const { core, fake } = await signedIn({ now: clock.now, keychain, paths: { dataDir } });
    core.close();
    clock.advance(2 * 3600_000);

    const restarted = startCore(dataDir, {
      keychain,
      now: clock.now,
      browser: createFakeBrowser(fake),
    });
    const [connector] = await restarted.listConnectors();
    await connectorState(restarted, connector?.id ?? "", "ready");

    expect(refreshes(fake)).toHaveLength(1);
    // The stale token was never sent: the first request after the restart carried the new one.
    const afterRestart = fake.requests.filter(
      (request) => request.authorization === `Bearer ${fake.issued[0]?.accessToken}`,
    );
    const firstNew = fake.requests.findIndex(
      (request) => request.authorization === `Bearer ${fake.issued[1]?.accessToken}`,
    );
    expect(firstNew).toBeGreaterThan(-1);
    expect(afterRestart.every((request) => fake.requests.indexOf(request) < firstNew)).toBe(true);
  });

  test("calls that find the token refused at the same time share one refresh", async () => {
    const model = scriptedModel((call: ModelCall) => {
      const found = call.results.filter((result) => result.tool === SEARCH);
      if (found.length === 0) {
        return {
          calls: [
            { tool: SEARCH, input: { query: "tides" } },
            { tool: SEARCH, input: { query: "moon" } },
          ],
        };
      }
      return { text: found.map((result) => result.text).join(" ") };
    });
    const { core, fake } = await signedIn({}, model);
    answerConsentAlways(core);
    fake.refreshDelayMs = 50;
    fake.revokeAccessTokens();

    const text = await ask(core);

    expect(text).toContain('"tides"');
    expect(text).toContain('"moon"');
    expect(refreshes(fake)).toHaveLength(1);
    expect(new Set(fake.toolCalls.map((call) => call.token))).toEqual(
      new Set([fake.issued[1]?.accessToken]),
    );
  });

  test("a refused refresh means signing in again: the tokens go, and Answers skip its Tools with a note", async () => {
    const { core, fake, keychain, id, model } = await signedIn();
    answerConsentAlways(core);
    fake.revokeAccessTokens();
    fake.refreshRefusal = { status: 400, body: { error: "invalid_grant" } };

    // The call that finds out tells the model why it failed.
    expect(await ask(core)).toContain('sign in to the Connector "Wiki" again');
    const failed = model.doStreamCalls.length;
    const expired = await connectorState(core, id, "needs-sign-in");

    expect(expired.signIn).toEqual({
      signedIn: false,
      expired: true,
      heldBack: false,
      error: null,
    });
    expect(expired.tools).toBeNull();
    expect(tokensIn(keychain, id)).toEqual({ expired: true });
    expect(fake.toolCalls).toEqual([]);

    // The next Answer has no Wiki Tools: a card in it says why, and so do its instructions.
    const nextAnswer = await askFor(core);
    expect(nextAnswer.text).toBe("I can't reach the wiki.");
    expect(nextAnswer.toolCalls).toEqual([
      {
        id: `sign-in:${id}`,
        tool: "sign_in",
        source: "connector",
        connector: { id, name: "Wiki" },
        input: {},
        status: "failed",
        resultCount: null,
        signInRequired: true,
      },
    ]);
    const next = model.doStreamCalls[failed];
    expect(next?.tools ?? []).toEqual([]);
    const system = String(next?.prompt.find((message) => message.role === "system")?.content);
    expect(system).toContain(
      'Connector "Wiki" needs the User to sign in again (in Settings → Connectors)',
    );

    // Signing in again works, and clears it.
    fake.refreshRefusal = null;
    expect(await core.signInToConnector(id)).toMatchObject({
      ok: true,
      connector: { state: "ready", signIn: { signedIn: true, expired: false } },
    });
  });

  test("signing out deletes the tokens; the registration stays for the next sign-in", async () => {
    const { core, keychain, id } = await signedIn();

    const after = remote(await core.signOutOfConnector(id));

    expect(after).toMatchObject({
      state: "needs-sign-in",
      tools: null,
      signIn: { signedIn: false, expired: false, heldBack: false, error: null },
    });
    expect(keychain.secrets.has(`connector:${id}:oauth-tokens`)).toBe(false);
    expect(keychain.secrets.get(`connector:${id}:oauth-client`)).toContain("registered-client-1");
    // Answers no longer offer its Tools.
    expect(await ask(core)).toBe("I can't reach the wiki.");
  });

  test("tokens never reach the SQLite database, only the encrypted secrets file", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createFileKeychain(join(dataDir, SECRETS_FILE), createFakeCipher());
    const { core, fake } = await signedIn({ keychain, paths: { dataDir } });
    answerConsentAlways(core);
    fake.revokeAccessTokens();
    await ask(core); // refreshes, so two sets of tokens have been stored
    core.close();

    const tokens = fake.issued.flatMap((set) => [set.accessToken, set.refreshToken]);
    expect(tokens).toHaveLength(4);
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
    // They are there, encrypted: after a restart it is still signed in.
    const restarted = startCore(dataDir, {
      keychain: createFileKeychain(join(dataDir, SECRETS_FILE), createFakeCipher()),
      browser: createFakeBrowser(fake),
    });
    const [connector] = await restarted.listConnectors();
    const ready = await connectorState(restarted, connector?.id ?? "", "ready");
    expect(ready.signIn.signedIn).toBe(true);
  });
});

describe("Consent and removal", { timeout: 30_000 }, () => {
  test("declining the server's consent means nothing is sent to it", async () => {
    let revoke = () => {};
    const model = scriptedModel((call) => {
      const result = call.results.find((each) => each.tool === SEARCH);
      if (result) return { text: result.text };
      revoke();
      return { calls: [{ tool: SEARCH, input: { query: "tides" } }] };
    });
    const { core, fake } = await signedIn({}, model);
    revoke = () => {
      void core.revokeConsent("connectors", fake.mcpOrigin);
    };
    answerConsentAlways(core, false);

    expect(await ask(core)).toContain("didn't allow sending data");

    expect(fake.toolCalls).toEqual([]);
    const flows = await core.listDataFlows();
    expect(flows.find((flow) => flow.flow.id === "connectors")).toMatchObject({
      flow: { service: { id: fake.mcpOrigin } },
      consent: "declined",
    });
  });

  test("deleting a remote Connector removes its sign-in and registration, and forgets its consent", async () => {
    const { core, fake, keychain, id } = await signedIn();
    answerConsentAlways(core);
    await ask(core);
    const decided = (await core.listDataFlows()).filter(
      (flow) => flow.flow.service.id === fake.mcpOrigin,
    );
    expect(decided).toMatchObject([{ consent: "accepted" }]);

    await core.deleteConnector(id);

    expect([...keychain.secrets.keys()].filter((name) => name.startsWith("connector:"))).toEqual(
      [],
    );
    expect(
      (await core.listDataFlows()).filter((flow) => flow.flow.service.id === fake.mcpOrigin),
    ).toEqual([]);
    expect(await core.listConnectors()).toEqual([]);
  });

  test("a sign-in waits for the keychain: without safe storage, it doesn't start, and the Connector says why", async () => {
    const setup = await setUp({ keychain: createMemoryKeychain("unavailable") });
    const added = await addWiki(setup);

    const result = await setup.core.signInToConnector(added.id);

    expect(result).toMatchObject({ ok: false, error: { kind: "secret-storage" } });
    expect(setup.browser.opened).toEqual([]);
    // The row shows it under the sign-in button, so the click doesn't seem to do nothing.
    const [connector] = await setup.core.listConnectors();
    expect(connector).toMatchObject({ signIn: { error: { kind: "secret-storage" } } });
  });
});

describe("Approvals and privacy", { timeout: 30_000 }, () => {
  test("a remote Tool that may change something asks first, like a local one; a read-only claim is only a hint the User can override", async () => {
    // The model calls `tool` through the Connector once, then says what came back.
    let tool = EDIT;
    const model = scriptedModel((call: ModelCall) => {
      const done = call.results.find((result) => result.tool === tool);
      if (!done) return { calls: [{ tool, input: { query: "Tides page" } }] };
      return { text: `Done: ${done.text}` };
    });
    const { core, fake, id } = await signedIn({}, model);
    answerConsentAlways(core);

    // A Tool that changes things: nothing is sent until the User allows it.
    const requested = nextEvent(core, "approval.requested");
    const asking = ask(core, "Fix the tides page.");
    const request = await requested;
    expect(request).toMatchObject({
      subject: { kind: "tool", connectorId: id, tool: "edit_wiki" },
      connector: { id, name: "Wiki" },
      tool: "edit_wiki",
      input: { query: "Tides page" },
      readOnly: false,
    });
    expect(fake.toolCalls).toEqual([]);
    await core.respondToApproval(request.requestId, "allow-once");
    expect(await asking).toContain("Wiki results");
    expect(fake.toolCalls.map((call) => call.tool)).toEqual(["edit_wiki"]);

    // The search claims to only read, so it runs without asking, until the User says to ask.
    tool = SEARCH;
    expect(await ask(core)).toContain("Wiki results");
    expect(fake.toolCalls.map((call) => call.tool)).toEqual(["edit_wiki", "search_wiki"]);
    const subject = { kind: "tool", connectorId: id, tool: "search_wiki" } as const;
    await core.setApprovalPolicy({ subject, policy: "ask" });
    const asked = nextEvent(core, "approval.requested");
    const searching = ask(core);
    expect(await asked).toMatchObject({ subject, readOnly: true });
    await core.respondToApproval((await asked).requestId, "deny");
    expect(await searching).toContain("denied");
    expect(fake.toolCalls.map((call) => call.tool)).toEqual(["edit_wiki", "search_wiki"]);
  });

  test("the Privacy page lists connecting and signing in to remote Connectors as traffic without User content", async () => {
    const { core, fake, id } = await signedIn();
    const remoteTraffic = async () =>
      (await core.listNetworkTraffic()).filter((traffic) => traffic.id === "remote-connectors");

    // The Connector's server, and the authorization server it named.
    expect(await remoteTraffic()).toEqual([
      {
        id: "remote-connectors",
        service: { id: fake.mcpOrigin, name: new URL(fake.mcpOrigin).host },
        enabled: true,
      },
      {
        id: "remote-connectors",
        service: { id: fake.issuer, name: new URL(fake.issuer).host },
        enabled: true,
      },
    ]);

    // Off, it makes no traffic.
    await core.setConnectorEnabled(id, false);
    expect(await remoteTraffic()).toEqual([]);
  });
});
