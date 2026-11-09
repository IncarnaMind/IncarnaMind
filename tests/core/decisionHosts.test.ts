import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  type Core,
  type DecisionHost,
  type Document,
  InvalidInputError,
  type SaveChatProviderInput,
  type TaggingClassifier,
} from "../../src/core";
import { LocalModeError } from "../../src/core/errors";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { proposedTagNamesOf, taggingModel, waitForTagging } from "../helpers/tags";

/*
 * Decision models on the hosts other than TypeSafe (#1907), through the core as Settings ›
 * Models and the sorting picker drive it. Every host's requests go to one local fake that answers
 * each host's path in that host's own shape: TypeSafe's protocol for OpenRouter, Perplexity,
 * Liquid, Cloudflare (wrapped in its REST envelope) and Alibaba Cloud, and OpenAI's own.
 */

const PAPER_TEXT = `Attention Is All You Need

Abstract. The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose a new simple network architecture, the Transformer.`;

const KEYS = {
  openrouter: "sk-or-test",
  openai: "sk-openai-test",
  qwen: "sk-qwen-test",
  liquid: "liquid_test",
  perplexity: "pplx-test",
  cloudflare: "cf-token-test",
};
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WORKSPACE = "llm-test";
const CHECK_TEXT = "IncarnaMind is checking that it can reach this service.";

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
const PROVIDERS = {
  openrouter: { kind: "openrouter", apiKey: KEYS.openrouter, modelId: "openai/gpt-6-luna" },
  openai: { kind: "openai", apiKey: KEYS.openai, modelId: "gpt-6-luna" },
  qwen: { kind: "qwen", endpoint: "cn", apiKey: KEYS.qwen, modelId: "qwen3.7-plus" },
} satisfies Record<string, SaveChatProviderInput>;

interface HostRequest {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

type Question = { type: string; instructions: string; criteria?: Record<string, string> };

/** The Tag a tagging question asks about: the text between “ and ”. */
const tagOf = (instructions: string) => /“(.+)”/.exec(instructions)?.[1] ?? "";

/** Every host's decision endpoint on one server, each checked and answered as its docs say. */
async function startFakeHosts() {
  const requests: HostRequest[] = [];
  /** OpenRouter's model listing, asked for: its own count, as it sends nothing of the User's. */
  const listings: (string | undefined)[] = [];
  let probabilities: Record<string, number> = {};
  const probability = (instructions: string) =>
    instructions.includes("connection check") ? 0.9 : (probabilities[tagOf(instructions)] ?? 0.02);
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || "{}") as Record<string, unknown>;
    const path = request.url ?? "";
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    // OpenRouter's public listing: a model released since this copy, and a free variant.
    if (request.method === "GET" && path === "/api/v1/models?output_modalities=decisions") {
      listings.push(request.headers.authorization);
      send(200, {
        data: [
          {
            id: "perplexity/pplx-decider-v1.2",
            name: "Perplexity: Decider V1.2",
            pricing: { prompt: "0.00000002" },
          },
          { id: "newco/decide-9", name: "NewCo: Decide 9", pricing: { prompt: "0.00000003" } },
          { id: "newco/decide-9:free", name: "NewCo: Decide 9 (free)", pricing: { prompt: "0" } },
        ],
      });
      return;
    }
    requests.push({ path, authorization: request.headers.authorization, body });
    const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!Object.values(KEYS).includes(bearer)) {
      send(401, { error: { message: "Invalid API key." } });
      return;
    }
    if (body.model === "gone-model") {
      send(400, { detail: "Unknown model: gone-model" });
      return;
    }
    if (path === "/v1/decisions" && Array.isArray(body.questions)) {
      // OpenAI: a list of named questions, answered as a list in the same order.
      send(200, {
        model: body.model,
        answers: (body.questions as (Question & { name: string })[]).map((question) =>
          question.type === "predicate"
            ? {
                type: "predicate",
                name: question.name,
                probability: probability(question.instructions),
              }
            : { type: "refusal", name: question.name },
        ),
        usage: { input_tokens: 10, output_tokens: 0 },
      });
      return;
    }
    const questions = (body.questions ?? {}) as Record<string, Question>;
    if (path === "/api/v1/systemone") {
      const lacking = Object.values(questions).some(
        (question) =>
          question.type === "noul" && (!question.criteria?.true || !question.criteria?.false),
      );
      if (lacking) {
        send(400, { error: { message: "invalid_union" } });
        return;
      }
    }
    if (path === "/compatible-mode/v1/systemone" && Object.keys(questions).length > 16) {
      send(400, { error: { message: "At most 16 questions." } });
      return;
    }
    const known =
      path === "/api/v1/systemone" ||
      path === "/v1/decisions" ||
      path === "/decisions/v1/systemone" ||
      path === "/compatible-mode/v1/systemone" ||
      path.startsWith(`/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/`);
    if (!known) {
      send(404, { detail: "Not Found" });
      return;
    }
    const answers = Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === "choice"
          ? { type: "choice", choice: Object.keys(question.criteria ?? {})[0] }
          : { type: "noul", noul: probability(question.instructions) },
      ]),
    );
    const answer = { model: body.model, answers, usage: { input_tokens: 10, output_tokens: 0 } };
    // Cloudflare's REST API may wrap what the model answers.
    send(
      200,
      path.startsWith("/client/v4/") ? { result: answer, success: true, errors: [] } : answer,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    listings,
    answer(next: Record<string, number>) {
      probabilities = next;
    },
    /** The requests that weren't a key's check. */
    tagging: () =>
      requests.filter((each) => each.body.state !== CHECK_TEXT && each.body.input !== CHECK_TEXT),
  };
}

async function startWithHosts() {
  const hosts = await startFakeHosts();
  const keychain = createMemoryKeychain();
  const tagging = taggingModel(["Letter"]);
  const origins = Object.fromEntries(
    (["openrouter", "perplexity", "liquid", "cloudflare", "openai", "alibaba"] as const).map(
      (host) => [host, hosts.url],
    ),
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(tagging.model).createChatModel,
    keychain,
    decisionOrigins: origins,
  });
  await core.saveChatProvider(LOCAL);
  return { core, hosts, keychain, tagging };
}

/** The picker's Use this, with its sends line on screen: the choice, tagging turned on, and its consent. */
async function chooseAndTurnOn(core: Core, classifier: TaggingClassifier) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, classifier, automatic: true, turnOn: true });
}

async function addDocument(core: Core, name: string, text: string): Promise<Document> {
  const sources = await createTempDataFolder();
  const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

const flowsTo = async (core: Core, serviceId: string) =>
  (await core.listDataFlows())
    .filter((each) => each.flow.service.id === serviceId)
    .map((each) => `${each.flow.id}: ${each.consent}`)
    .sort();

const status = async (core: Core, host: DecisionHost) =>
  (await core.listDecisionHosts()).find((each) => each.host === host);

describe("Decision model hosts (#1907)", { timeout: 30_000 }, () => {
  test("every host is listed; a chat provider's key readies its host, but Automatic never starts it", async () => {
    const { core, hosts } = await startWithHosts();
    const listed = await core.listDecisionHosts();
    expect(listed.map((each) => `${each.host} ${each.key} ${each.ready}`)).toEqual([
      "openrouter provider false",
      "perplexity own false",
      "liquid own false",
      "cloudflare own false",
      "openai provider false",
      "alibaba provider false",
    ]);

    await core.saveChatProvider({ ...PROVIDERS.openrouter, keepDefault: true });
    expect(await status(core, "openrouter")).toMatchObject({
      hasKey: true,
      ready: true,
      service: { id: "https://openrouter.ai", name: "OpenRouter" },
    });
    const models = await core.getTaggingModels();
    const offered = models.options
      .filter((option) => option.classifier.kind === "decision")
      .map((option) => option.name);
    expect(offered[0]).toBe("Decider v1.2");
    expect(offered).toContain("d1-ultra");
    // The measured nine, then what OpenRouter's own listing adds: never its free variants.
    expect(offered).toHaveLength(10);
    expect(offered.at(-1)).toBe("Decide 9");
    // A key given for chat doesn't cover sending Documents: Automatic keeps to what it used.
    expect(models.automatic?.classifier.kind).not.toBe("decision");
    expect(hosts.requests).toEqual([]);
  });

  test("Liquid from the picker: the key is checked with a fixed text and kept; Use this chooses d1-ultra and is the consent", async () => {
    const { core, hosts, keychain, tagging } = await startWithHosts();
    const asked: string[] = [];
    core.on("consent.requested", (request) => asked.push(request.flow.id));

    const listed = await core.setDecisionKey({ host: "liquid", apiKey: KEYS.liquid });
    expect(listed.find((each) => each.host === "liquid")).toMatchObject({
      hasKey: true,
      ready: true,
    });
    expect(hosts.requests).toHaveLength(1);
    expect(hosts.requests[0]).toMatchObject({
      path: "/decisions/v1/systemone",
      authorization: `Bearer ${KEYS.liquid}`,
      body: { model: "d1-ultra", state: CHECK_TEXT },
    });
    expect(keychain.secrets.get("decision:liquid:api-key")).toBe(KEYS.liquid);
    expect(await flowsTo(core, "https://api.liquid.ai")).toEqual([]);

    hosts.answer({ Paper: 0.95, Report: 0.6 });
    await chooseAndTurnOn(core, { kind: "decision", host: "liquid", modelId: "d1-ultra" });
    expect(await flowsTo(core, "https://api.liquid.ai")).toEqual([
      "classification: accepted",
      "tagging: accepted",
    ]);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    // One kind a Document: the likelier.
    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Paper"]);
    expect(tagging.requests).toEqual([]);
    expect(asked).toEqual([]);
    const [sent] = hosts.tagging();
    expect(sent).toMatchObject({
      path: "/decisions/v1/systemone",
      body: {
        model: "d1-ultra",
        state: { name: "Attention", excerpt: expect.stringContaining("transduction") },
      },
    });
    expect(await core.getTaggingModels()).toMatchObject({
      saved: {
        classifier: { kind: "decision", host: "liquid", modelId: "d1-ultra" },
        destination: { kind: "service", service: { id: "https://api.liquid.ai" } },
      },
    });
  });

  test("a model a host released since is offered and used by name; one it doesn't serve fails in its words", async () => {
    const { core, hosts } = await startWithHosts();
    await core.saveChatProvider({ ...PROVIDERS.openrouter, keepDefault: true });
    expect(
      (await status(core, "openrouter"))?.models.map((model) => `${model.maker}: ${model.name}`),
    ).toContain("NewCo: Decide 9");
    hosts.answer({ Paper: 0.93 });
    await chooseAndTurnOn(core, {
      kind: "decision",
      host: "openrouter",
      modelId: "newco/decide-9",
    });
    const paper = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [paper.id]);
    expect(await proposedTagNamesOf(core, paper.id)).toEqual(["Paper"]);
    expect(hosts.tagging().at(-1)?.body.model).toBe("newco/decide-9");

    await core.setDecisionKey({ host: "liquid", apiKey: KEYS.liquid });
    await chooseAndTurnOn(core, { kind: "decision", host: "liquid", modelId: "gone-model" });
    const notes = await addDocument(core, "Notes.md", "Notes from the weekly call.");
    const [failed] = await waitForTagging(core, [notes.id], (each) => each.tagging === "failed");
    expect(failed?.taggingError?.message).toContain("Unknown model: gone-model");
  });

  test("OpenRouter's list is read only where a Question could go, without the key, and once for a while", async () => {
    const { core, hosts } = await startWithHosts();
    await core.listDecisionHosts();
    expect(hosts.listings).toEqual([]);

    await core.saveChatProvider({ ...PROVIDERS.openrouter, keepDefault: true });
    await core.listDecisionHosts();
    await core.getTaggingModels();
    expect(hosts.listings).toEqual([undefined]);

    // With its chat flow withdrawn on the Privacy page, or in Local mode, it isn't asked for.
    const restricted = await startWithHosts();
    await restricted.core.saveChatProvider({ ...PROVIDERS.openrouter, keepDefault: true });
    await restricted.core.revokeConsent("chat", "https://openrouter.ai");
    expect((await status(restricted.core, "openrouter"))?.models).toHaveLength(9);
    const local = await startWithHosts();
    await local.core.saveChatProvider({ ...PROVIDERS.openrouter, keepDefault: true });
    await local.core.setLocalOnly(true);
    expect((await status(local.core, "openrouter"))?.models).toHaveLength(9);
    expect([restricted.hosts.listings, local.hosts.listings]).toEqual([[], []]);
  });

  test("a refused key is kept nowhere, and says why in words", async () => {
    const { core, keychain } = await startWithHosts();
    await expect(
      core.setDecisionKey({ host: "perplexity", apiKey: "a-wrong-key" }),
    ).rejects.toThrow("Perplexity didn’t accept this key: Invalid API key.");
    expect(keychain.secrets.has("decision:perplexity:api-key")).toBe(false);
    expect(await status(core, "perplexity")).toMatchObject({ hasKey: false, ready: false });
  });

  test("OpenRouter: the OpenRouter key's own host, each yes-or-no question with both criteria", async () => {
    const { core, hosts } = await startWithHosts();
    await core.saveChatProvider({ ...PROVIDERS.openrouter, keepDefault: true });
    hosts.answer({ Paper: 0.9 });
    await chooseAndTurnOn(core, {
      kind: "decision",
      host: "openrouter",
      modelId: "perplexity/pplx-decider-v1.2",
    });
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Paper"]);
    const [sent] = hosts.tagging();
    expect(sent).toMatchObject({
      path: "/api/v1/systemone",
      authorization: `Bearer ${KEYS.openrouter}`,
      body: { model: "perplexity/pplx-decider-v1.2" },
    });
    for (const question of Object.values(sent?.body.questions as Record<string, Question>)) {
      expect(question.criteria?.false).toBe("The tag does not describe the document.");
    }
  });

  test("OpenAI: its own shape, the questions a named list and the answers one too", async () => {
    const { core, hosts } = await startWithHosts();
    await core.saveChatProvider({ ...PROVIDERS.openai, keepDefault: true });
    hosts.answer({ Paper: 0.88 });
    await chooseAndTurnOn(core, { kind: "decision", host: "openai", modelId: "gpt-6-luna" });
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Paper"]);
    const [sent] = hosts.tagging();
    expect(sent?.path).toBe("/v1/decisions");
    expect(sent?.body).toMatchObject({
      model: "gpt-6-luna",
      input: expect.stringContaining("Attention"),
    });
    expect(sent?.body.questions).toContainEqual({
      type: "predicate",
      name: expect.any(String),
      instructions: expect.stringContaining("Does the Tag “Paper” fit this Document as a whole?"),
    });
  });

  test("Cloudflare asks for its account ID; its model is named in the address, and a wrapped answer is read", async () => {
    const { core, hosts } = await startWithHosts();
    await expect(
      core.setDecisionKey({ host: "cloudflare", apiKey: KEYS.cloudflare }),
    ).rejects.toThrow(InvalidInputError);
    expect(hosts.requests).toEqual([]);
    await core.setDecisionKey({ host: "cloudflare", apiKey: KEYS.cloudflare, account: ACCOUNT });
    expect(await status(core, "cloudflare")).toMatchObject({
      ready: true,
      account: { kind: "cloudflare-account", value: ACCOUNT },
    });

    hosts.answer({ Paper: 0.97 });
    await chooseAndTurnOn(core, { kind: "decision", host: "cloudflare", modelId: "clef" });
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Paper"]);
    expect(hosts.tagging()[0]).toMatchObject({
      path: `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef`,
      body: { model: "clef" },
    });
  });

  test("Alibaba Cloud: the Qwen key and a workspace, Beijing for a Beijing key, and no more than 16 questions a request", async () => {
    const { core, hosts } = await startWithHosts();
    await core.saveChatProvider({ ...PROVIDERS.qwen, keepDefault: true });
    expect(await status(core, "alibaba")).toMatchObject({ hasKey: true, ready: false });

    await core.setDecisionKey({ host: "alibaba", account: WORKSPACE });
    expect(await status(core, "alibaba")).toMatchObject({
      ready: true,
      service: { id: `https://${WORKSPACE}.cn-beijing.maas.aliyuncs.com` },
    });

    // 14 Tags of the User's the Document is about, beside the 9 kinds: 23 questions.
    for (let at = 0; at < 14; at++) await core.createTag({ name: `Attention ${at}` });
    hosts.answer({ Paper: 0.91 });
    await chooseAndTurnOn(core, {
      kind: "decision",
      host: "alibaba",
      modelId: "decision-model-preview",
    });
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Paper"]);
    const sent = hosts.tagging();
    expect(sent.length).toBe(2);
    expect(sent.map((each) => Object.keys(each.body.questions as object).length)).toEqual([16, 7]);
    for (const each of sent) {
      expect(each.path).toBe("/compatible-mode/v1/systemone");
      expect(Object.keys(each.body.questions as object).length).toBeLessThanOrEqual(16);
    }
  });

  test("a Qwen key for another region than the workspace's sends nothing until the workspace is saved again", async () => {
    const { core, hosts } = await startWithHosts();
    await core.saveChatProvider({ ...PROVIDERS.qwen, keepDefault: true });
    await core.setDecisionKey({ host: "alibaba", account: WORKSPACE });
    const beijing = `https://${WORKSPACE}.cn-beijing.maas.aliyuncs.com`;
    const beijingKey = (await core.listChatProviders()).find((each) => each.endpoint === "cn");
    if (!beijingKey) throw new Error("No Beijing Qwen key.");
    await core.deleteChatProvider(beijingKey.id);
    await core.saveChatProvider({ ...PROVIDERS.qwen, endpoint: "intl", keepDefault: true });

    // Consent and the Privacy page name Beijing: requests may not go to Singapore meanwhile.
    expect(await status(core, "alibaba")).toMatchObject({
      hasKey: true,
      ready: false,
      service: { id: beijing },
    });
    await chooseAndTurnOn(core, {
      kind: "decision",
      host: "alibaba",
      modelId: "decision-model-preview",
    });
    const before = hosts.requests.length;
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    // It waits, as with no key: nothing goes to either region.
    await waitForTagging(core, [document.id], (each) => each.tagging === "waiting-for-provider");
    expect(hosts.requests.length).toBe(before);

    await core.setDecisionKey({ host: "alibaba", account: WORKSPACE });
    expect(await status(core, "alibaba")).toMatchObject({
      ready: true,
      service: { id: `https://${WORKSPACE}.ap-southeast-1.maas.aliyuncs.com` },
    });
  });

  test("in Local mode no host is offered, and none takes a key", async () => {
    const { core, hosts } = await startWithHosts();
    await core.setDecisionKey({ host: "liquid", apiKey: KEYS.liquid });
    await core.setLocalOnly(true);

    const models = await core.getTaggingModels();
    expect(models.options.filter((option) => option.classifier.kind === "decision")).toEqual([]);
    await expect(
      core.setDecisionKey({ host: "perplexity", apiKey: KEYS.perplexity }),
    ).rejects.toThrow(LocalModeError);
    expect(hosts.requests).toHaveLength(1);
  });

  test("Remove forgets the host's own key, and its account", async () => {
    const { core, keychain } = await startWithHosts();
    await core.setDecisionKey({ host: "cloudflare", apiKey: KEYS.cloudflare, account: ACCOUNT });
    const changed = new Promise((resolve) => core.on("decisions.changed", resolve));

    const listed = await core.removeDecisionKey("cloudflare");

    expect(listed.find((each) => each.host === "cloudflare")).toMatchObject({
      hasKey: false,
      ready: false,
      account: { value: null },
    });
    expect(keychain.secrets.has("decision:cloudflare:api-key")).toBe(false);
    await changed;
  });
});

/*
 * Removing a key or workspace that sorting uses gives sorting back to Automatic (#1907), which
 * starts no host and turns nothing on: what it picks instead, the User's AI here, reads a new
 * Document only where the User has allowed that service.
 */
describe("Removing what sorting uses (#1907)", { timeout: 30_000 }, () => {
  const ANTHROPIC = {
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  } as const;

  /**
   * Liquid chosen with its Use this, then its key removed; Anthropic is the User's AI. `allowed`:
   * sorting was turned on with it before Liquid, the consent the footer's Allow gives.
   */
  async function liquidInUse(allowed: boolean) {
    const hosts = await startFakeHosts();
    const tagging = taggingModel(["Letter"]);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(tagging.model).createChatModel,
      keychain: createMemoryKeychain(),
      decisionOrigins: { liquid: hosts.url },
    });
    await core.saveChatProvider(ANTHROPIC);
    await core.createLibraryGroup({ name: "Research", description: "Papers and studies." });
    if (allowed) {
      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
    }
    await core.setDecisionKey({ host: "liquid", apiKey: KEYS.liquid });
    await chooseAndTurnOn(core, { kind: "decision", host: "liquid", modelId: "d1-ultra" });
    await core.removeDecisionKey("liquid");
    return { core, hosts, tagging };
  }

  test("with the User's AI service not allowed, a new Document waits with tagging off and nothing is sent", async () => {
    const { core, hosts, tagging } = await liquidInUse(false);
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "automatic" });

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const [waiting] = await waitForTagging(core, [document.id], (each) => each.tagging === "off");
    expect(waiting?.tagging).toBe("off");
    // The switch was turned on for Liquid only, so it reads off for Anthropic until it is turned
    // on there (#2308); and Organize asks its "Use Anthropic" before it keeps a model.
    expect((await core.getLibrary()).settings).toMatchObject({
      automatic: false,
      organizeWith: null,
    });
    expect(tagging.requests).toHaveLength(0);
    expect(hosts.tagging()).toEqual([]);
  });

  test("with the User's AI service allowed, the new Document is tagged by it, and Liquid gets nothing", async () => {
    const { core, hosts, tagging } = await liquidInUse(true);
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "automatic" });

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const [sorted] = await waitForTagging(core, [document.id]);
    expect(sorted?.tagging).toBe("tagged");
    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Letter"]);
    expect(tagging.requests.length).toBeGreaterThan(0);
    expect((await core.getLibrary()).sortWaitsFor).toBeUndefined();
    expect(hosts.tagging()).toEqual([]);
  });
  /** Decider through OpenRouter chosen with its Use this, beside Anthropic as the User's AI. */
  async function deciderInUse() {
    const hosts = await startFakeHosts();
    const tagging = taggingModel(["Letter"]);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(tagging.model).createChatModel,
      keychain: createMemoryKeychain(),
      decisionOrigins: { openrouter: hosts.url },
    });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    const openrouter = await core.saveChatProvider({ ...PROVIDERS.openrouter, keepDefault: true });
    await core.createLibraryGroup({ name: "Research", description: "Papers and studies." });
    await chooseAndTurnOn(core, {
      kind: "decision",
      host: "openrouter",
      modelId: "perplexity/pplx-decider-v1.2",
    });
    return { core, hosts, tagging, anthropic, openrouter };
  }

  test("deleting the OpenRouter provider that Decider reaches gives sorting back to Automatic: OpenRouter gets nothing", async () => {
    const { core, hosts, tagging, openrouter } = await deciderInUse();
    await core.deleteChatProvider(openrouter.id);
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "automatic" });
    expect((await status(core, "openrouter"))?.ready).toBe(false);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const [waiting] = await waitForTagging(core, [document.id], (each) => each.tagging === "off");
    expect(waiting?.tagging).toBe("off");
    expect(hosts.tagging()).toEqual([]);
    expect(tagging.requests).toHaveLength(0);
  });

  test("deleting another provider leaves Decider chosen, and a new Document goes to OpenRouter", async () => {
    const { core, hosts, anthropic } = await deciderInUse();
    await core.deleteChatProvider(anthropic.id);
    expect((await core.getLibrary()).settings.classifier).toMatchObject({ host: "openrouter" });

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);
    expect(hosts.tagging().map((each) => each.path)).toContain("/api/v1/systemone");
  });

  test("deleting a chat provider leaves a host's choice, and removing the host's key goes back to Automatic", async () => {
    const hosts = await startFakeHosts();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(taggingModel(["Letter"]).model).createChatModel,
      keychain: createMemoryKeychain(),
      decisionOrigins: { liquid: hosts.url },
    });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await core.setDecisionKey({ host: "liquid", apiKey: KEYS.liquid });
    const chosen = { kind: "decision", host: "liquid", modelId: "d1-ultra" } as const;
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, classifier: chosen });
    await core.deleteChatProvider(anthropic.id);
    expect((await core.getLibrary()).settings.classifier).toEqual(chosen);

    await core.removeDecisionKey("liquid");
    expect((await status(core, "liquid"))?.hasKey).toBe(false);
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "automatic" });
  });
});
