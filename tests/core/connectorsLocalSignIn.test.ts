import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { Connector, Core, RemoteConnector } from "../../src/core";
import { translate } from "../../src/shared/i18n";
import { askAndFinish } from "../helpers/citations";
import { waitForState } from "../helpers/connectors";
import {
  createMemoryKeychain,
  createTempDataFolder,
  manualClock,
  startCore,
  type TestAdapters,
} from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerText } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { createFakeBrowser, type FakeRemote, startFakeRemote } from "../helpers/remoteMcp";

/**
 * "Keep everything on this computer" and a Connector whose MCP server is on
 * this computer but whose sign-in is with a server elsewhere (the MCP server
 * names it): its sign-in isn't renewed or started while Local mode is on, it
 * waits for a sign-in saying why, and it goes on without signing in again once
 * Local mode is off. The server "elsewhere" is a fake on this one, reached
 * under a name that is not a loopback address (the test stands in for DNS).
 */

const FAR_HOST = "auth.example.test";
const SEARCH = "wiki__search_wiki";

/** A model that searches the wiki when it can, then says what it got; else says it can't. */
function wikiModel(): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall) => {
    if (!call.tools.includes(SEARCH)) return { text: "No such Tool." };
    const got = call.results.find((result) => result.tool === SEARCH);
    if (!got) return { text: "Let me look.", calls: [{ tool: SEARCH, input: { query: "tides" } }] };
    return { text: `Got: ${got.text}` };
  });
}

/** The fake's authorization server at `FAR_HOST`, which this test forwards to it, and the names it was asked for. */
function authorizationServerElsewhere(fake: FakeRemote) {
  const far = `https://${FAR_HOST}:${new URL(fake.issuer).port}`;
  fake.authorizationServer = far;
  const asked: string[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== FAR_HOST) return real(input, init);
    asked.push(url.href);
    const here = new URL(fake.issuer);
    url.protocol = here.protocol;
    url.hostname = here.hostname;
    url.port = here.port;
    return real(url, init);
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return { far, asked };
}

const heardByAuthorizationServer = (fake: FakeRemote) =>
  fake.requests.filter((request) => request.path.startsWith("auth:"));

const refreshes = (fake: FakeRemote) =>
  fake.tokenRequests.filter((request) => request.grant_type === "refresh_token");

const remote = (connector: Connector | undefined): RemoteConnector => {
  if (connector?.transport !== "http") throw new Error("Not a remote Connector.");
  return connector;
};

/** A core with the fake as its browser and a model, a Connector "Wiki" signed in to it with Local mode off, and a clock to move. */
async function signedInWiki(fake: FakeRemote) {
  const clock = manualClock();
  const keychain = createMemoryKeychain();
  const dataDir = await createTempDataFolder();
  const overrides: TestAdapters = {
    keychain,
    now: clock.now,
    paths: { dataDir },
    browser: createFakeBrowser(fake),
    createChatModel: scriptedModels(wikiModel()).createChatModel,
  };
  const start = async () => {
    const core = startCore(dataDir, overrides);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    return core;
  };
  const core = await start();
  const added = await core.addConnector({ name: "Wiki", url: fake.url });
  await waitForState(core, added.id, "needs-sign-in");
  expect(await core.signInToConnector(added.id)).toMatchObject({
    ok: true,
    connector: { state: "ready" },
  });
  return { core, id: added.id, clock, start };
}

async function ask(core: Core, text: string) {
  const mind = await core.createMind({ title: "Questions" });
  const client = await connectToMind(core, mind.id);
  const { answerId } = await askAndFinish(core, client, mind.id, text);
  return answerText(client, answerId);
}

describe("A Connector on this computer with its sign-in on another, in Local mode", {
  timeout: 40_000,
}, () => {
  // protects=in Local mode a stale token isn't renewed at an authorization server on another computer, which hears nothing, and the Connector's Tools aren't offered; fails_when=any request reaches that server, or the Tools are offered; no_claim=none beyond protects.
  test("a restart in Local mode with an expired token sends the far server nothing, and waits with the reason", async () => {
    const fake = await startFakeRemote();
    onTestFinished(() => fake.close());
    const { asked } = authorizationServerElsewhere(fake);
    const { core, id, clock, start } = await signedInWiki(fake);
    expect(asked.length).toBeGreaterThan(0);
    await core.setLocalOnly(true);
    core.close();
    clock.advance(2 * 3600_000);
    const heard = heardByAuthorizationServer(fake).length;
    asked.length = 0;

    const restarted = await start();
    const held = remote(await waitForState(restarted, id, "needs-sign-in"));
    const text = await ask(restarted, "What does the wiki say?");

    expect(held.signIn).toMatchObject({ signedIn: true, expired: false, heldBack: true });
    expect(text).toBe("No such Tool.");
    expect(asked).toEqual([]);
    expect(heardByAuthorizationServer(fake)).toHaveLength(heard);
    expect(refreshes(fake)).toEqual([]);
  });

  // protects=turning Local mode off lets the held-back Connector renew its token and come back with its Tools, with no new sign-in; fails_when=it needs signing in again, never renews, or stays held back; no_claim=none beyond protects.
  test("turning Local mode off renews it, and its Tools come back, with no new sign-in", async () => {
    const fake = await startFakeRemote();
    onTestFinished(() => fake.close());
    const { asked } = authorizationServerElsewhere(fake);
    const { core, id, clock, start } = await signedInWiki(fake);
    await core.setLocalOnly(true);
    core.close();
    clock.advance(2 * 3600_000);
    const restarted = await start();
    await waitForState(restarted, id, "needs-sign-in");
    asked.length = 0;

    await restarted.setLocalOnly(false);
    const back = remote(await waitForState(restarted, id, "ready"));
    const text = await ask(restarted, "What does the wiki say?");

    expect(back.signIn).toMatchObject({ signedIn: true, heldBack: false });
    expect(refreshes(fake)).toHaveLength(1);
    expect(fake.authorizeRequests).toHaveLength(1);
    expect(fake.registrations).toHaveLength(1);
    expect(asked.length).toBeGreaterThan(0);
    expect(text).toMatch(/^Got: /);
  });

  // protects=a Connector that is connected when Local mode goes on is held back once its token needs renewing, and its Tools are left out, with nothing sent; fails_when=its Tools are offered and then refused, or the far server is asked; no_claim=none beyond protects.
  test("connected when Local mode goes on, it is held back when its token needs renewing", async () => {
    const fake = await startFakeRemote();
    onTestFinished(() => fake.close());
    const { asked } = authorizationServerElsewhere(fake);
    const { core, id, clock } = await signedInWiki(fake);
    await core.setLocalOnly(true);
    clock.advance(2 * 3600_000);
    const heard = heardByAuthorizationServer(fake).length;
    asked.length = 0;

    const text = await ask(core, "What does the wiki say?");
    const held = remote((await core.listConnectors()).find((each) => each.id === id));

    expect(text).toBe("No such Tool.");
    expect(held.state).toBe("needs-sign-in");
    expect(held.signIn.heldBack).toBe(true);
    expect(asked).toEqual([]);
    expect(heardByAuthorizationServer(fake)).toHaveLength(heard);
  });

  // protects=signing in to a held-back Connector is refused with the reason, and nothing is sent or opened; fails_when=a browser opens, or the far server hears anything; no_claim=none beyond protects.
  test("signing in to it starts nothing", async () => {
    const fake = await startFakeRemote();
    onTestFinished(() => fake.close());
    const { asked } = authorizationServerElsewhere(fake);
    const setup = await signedInWiki(fake);
    await setup.core.setLocalOnly(true);
    setup.core.close();
    setup.clock.advance(2 * 3600_000);
    const core = await setup.start();
    await waitForState(core, setup.id, "needs-sign-in");
    const heard = heardByAuthorizationServer(fake).length;
    const opened = fake.authorizeRequests.length;
    asked.length = 0;

    const result = await core.signInToConnector(setup.id);

    expect(result).toMatchObject({ ok: false, error: { kind: "held-back" } });
    expect(remote((await core.listConnectors())[0]).signIn.error).toBeNull();
    expect(asked).toEqual([]);
    expect(heardByAuthorizationServer(fake)).toHaveLength(heard);
    expect(fake.authorizeRequests).toHaveLength(opened);
  });

  // protects=the Privacy page doesn't list the far authorization server as traffic while it isn't used, and lists it again when it is; fails_when=it is listed in Local mode, or missing outside it; no_claim=none beyond protects.
  test("the Privacy page lists the authorization server only while it is used", async () => {
    const fake = await startFakeRemote();
    onTestFinished(() => fake.close());
    const { far } = authorizationServerElsewhere(fake);
    const { core } = await signedInWiki(fake);
    const traffic = async () =>
      (await core.listNetworkTraffic())
        .filter((each) => each.id === "remote-connectors")
        .map((each) => each.service.id);

    expect(await traffic()).toEqual([fake.mcpOrigin, far]);
    await core.setLocalOnly(true);
    expect(await traffic()).toEqual([fake.mcpOrigin]);
    await core.setLocalOnly(false);
    expect(await traffic()).toEqual([fake.mcpOrigin, far]);
  });

  // protects=a Connector whose authorization server is on this computer too is unchanged by Local mode: its stale token renews and its Tools stay; fails_when=it is held back or stops renewing; no_claim=none beyond protects.
  test("with its authorization server on this computer too, nothing changes", async () => {
    const fake = await startFakeRemote();
    onTestFinished(() => fake.close());
    const { core, id, clock } = await signedInWiki(fake);
    await core.setLocalOnly(true);
    clock.advance(2 * 3600_000);

    const text = await ask(core, "What does the wiki say?");
    const connector = remote((await core.listConnectors()).find((each) => each.id === id));

    expect(text).toMatch(/^Got: /);
    expect(connector.state).toBe("ready");
    expect(connector.signIn.heldBack).toBe(false);
    expect(refreshes(fake)).toHaveLength(1);
  });
});

describe("Why a sign-in is held back, in words", () => {
  // protects=the Connector's page says why in English and Chinese; fails_when=either wording goes; no_claim=none beyond protects.
  test("the notice names the setting and what happens when it is off", () => {
    expect(translate("en", "remoteConnectors.signIn.heldBack.details")).toContain(
      "“Keep everything on this computer” is on",
    );
    expect(translate("zh-CN", "remoteConnectors.signIn.heldBack.details")).toContain(
      "已开启“所有内容都留在这台电脑上”",
    );
  });
});
