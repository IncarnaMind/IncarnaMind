import { generateText } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { fakeProvider } from "../helpers/fakeProvider";

afterEach(() => vi.unstubAllGlobals());

const HOSTS = { cn: "api.moonshot.cn", intl: "api.moonshot.ai" } as const;
const CHOICES = [
  ["cn", HOSTS.cn],
  ["intl", HOSTS.intl],
] as const;

const hostsAsked = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(
      ([input]) => new URL(String(input instanceof Request ? input.url : input)).host,
    );

const MODELS = { data: [{ id: "kimi-k2.6" }] };
const answering = (host: string) =>
  fakeProvider(host, {
    protocol: "chat",
    models: MODELS,
    query: "",
    records: () => [],
    answer: "OK",
  });

const kimiCore = async () =>
  startCore(await createTempDataFolder(), { createChatModel: createAiSdkChatModel });

describe.each(CHOICES)("Kimi on the %s endpoint", (endpoint, host) => {
  // protects=the key form's endpoint choice is the host of the test of the key, of saving it, of the model list and of a small call; fails_when=any of them goes to the other region's host; no_claim=what Kimi answers.
  test(`testing the key, saving it, listing models and a small call all ask ${host} and no other host`, async () => {
    const core = await kimiCore();
    answering(host);

    expect(
      await core.testChatConnection({
        kind: "kimi",
        endpoint,
        apiKey: "key-for-the-test",
        modelId: "kimi-k2.6",
      }),
    ).toEqual({ ok: true });
    const saved = await core.saveChatProvider({
      kind: "kimi",
      endpoint,
      apiKey: "key-for-the-test",
      modelId: "kimi-k2.6",
    });
    await core.allowDataFlow("chat", `https://${host}`);
    const groups = await core.listChatModels();
    expect(groups.find((each) => each.provider.id === saved.id)?.models).toContain("kimi-k2.6");

    expect(await core.testChatProvider(saved.id)).toMatchObject({ ok: true });

    const hosts = hostsAsked();
    expect(hosts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(hosts)).toEqual(new Set([host]));
  });

  // protects=a model made from a spec that names a hosted provider's endpoint and no base URL asks that endpoint's host; fails_when=it asks the provider's first endpoint instead; no_claim=how the app builds its specs.
  test(`a spec that names the endpoint and no base URL asks ${host}`, async () => {
    answering(host);

    const reply = await generateText({
      model: createAiSdkChatModel({
        kind: "kimi",
        baseUrl: null,
        endpoint,
        apiKey: "key-for-the-test",
        modelId: "kimi-k2.6",
        thinking: "off",
      }),
      prompt: "Reply with the word OK.",
      maxRetries: 0,
    });

    expect(reply.text).toBe("OK");
    expect(hostsAsked()).toEqual([host]);
  });
});

describe("Kimi's endpoints", () => {
  // protects=a spec that names no endpoint asks the provider's first, as every install saved before the choice did; fails_when=the default moves to International; no_claim=none beyond protects.
  test("a spec that names no endpoint still asks the China host", async () => {
    answering(HOSTS.cn);

    await generateText({
      model: createAiSdkChatModel({
        kind: "kimi",
        baseUrl: null,
        apiKey: "key-for-the-test",
        modelId: "kimi-k2.6",
      }),
      prompt: "Reply with the word OK.",
      maxRetries: 0,
    });

    expect(hostsAsked()).toEqual([HOSTS.cn]);
  });

  // protects=a key made for one region is refused by the other region's host and is tested only on the endpoint chosen, so the other is never asked on its behalf; fails_when=a refused International key is retried on China, or a test of the China choice reaches International; no_claim=what Kimi says to a refused key.
  test("a key is tested on the chosen endpoint only: the other region's host is never asked", async () => {
    const core = await kimiCore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        return url.host === HOSTS.intl
          ? Response.json({
              id: "chat_1",
              object: "chat.completion",
              created: 1_790_000_000,
              model: "kimi-k2.6",
              choices: [
                { index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            })
          : Response.json({ error: { message: "Invalid Authentication" } }, { status: 401 });
      }),
    );
    const input = {
      kind: "kimi" as const,
      apiKey: "key-from-the-international-site",
      modelId: "kimi-k2.6",
    };

    expect(await core.testChatConnection({ ...input, endpoint: "intl" })).toEqual({ ok: true });
    expect(new Set(hostsAsked())).toEqual(new Set([HOSTS.intl]));

    vi.mocked(fetch).mockClear();
    const refused = await core.testChatConnection({ ...input, endpoint: "cn" });
    expect(refused).toMatchObject({ ok: false, error: { kind: "auth" } });
    expect(new Set(hostsAsked())).toEqual(new Set([HOSTS.cn]));
  });
});
