import { describe, expect, test } from "vitest";
import type {
  DecisionHost,
  DecisionHostStatus,
  JevSettings,
  TaggingModelOption,
  TaggingModels,
} from "../../src/core/api";
import {
  automaticRow,
  hostSetUpOffers,
  jevStateOf,
  keyProviderOf,
  offersJevSetUp,
  sortingOptions,
} from "../../src/renderer/src/components/providers/sortingOptions";

/*
 * The sorting picker's list (#2615): with no Jev key it ends with "Use TypeSafe Jev…", which sets
 * Jev up in place; with a key Jev comes first and the set-up row goes; in Local mode only a Jev
 * server on this computer is offered.
 */

const TYPESAFE = { id: "https://api.typesafe.ai", name: "TypeSafe Jev" };
const CHAT = { providerId: "anthropic-1", modelId: "claude-haiku-5-5" };

const jevSettings = (overrides: Partial<JevSettings>): JevSettings => ({
  enabled: false,
  hasApiKey: false,
  endpoint: null,
  model: "jev-latest",
  reviewBand: { low: 0.35, high: 0.65 },
  service: TYPESAFE,
  ...overrides,
});

const JEV_OPTION: TaggingModelOption = {
  classifier: { kind: "jev" },
  group: "keys",
  name: "TypeSafe Jev",
  provider: { en: "TypeSafe", zh: "TypeSafe" },
  goodForTagging: true,
  decisionModel: false,
  likelihoods: true,
  cost: { kind: "unknown" },
};

const CHAT_OPTION: TaggingModelOption = {
  classifier: { kind: "chat", choice: CHAT },
  group: "keys",
  name: "Claude Haiku 5.5",
  provider: { en: "Anthropic", zh: "Anthropic" },
  goodForTagging: true,
  decisionModel: false,
  likelihoods: false,
  cost: { kind: "unknown" },
};

const models = (options: TaggingModelOption[], localMode = false): TaggingModels => ({
  automatic: null,
  options,
  localMode,
  planPausedUntil: null,
  saved: null,
});

/** The picker's rows, as it draws them: the choices, then the set-up row when it is offered. */
function rows(jev: JevSettings | null, options: TaggingModelOption[], localMode = false) {
  const state = jevStateOf(jev);
  const list = sortingOptions(models(options, localMode), {
    chatModel: CHAT,
    language: "en",
    localMode,
    jev: state,
    chatLabel: "Use your AI model",
    chatName: "Claude Haiku 5.5",
  }).map((option) => option.label);
  return offersJevSetUp(state, localMode) ? [...list, "Use TypeSafe Jev…"] : list;
}

describe("the sorting picker's Jev rows (#2615)", () => {
  test("with no Jev key, the set-up row comes last, after the choices that can run", () => {
    expect(rows(jevSettings({}), [CHAT_OPTION])).toEqual([
      "Use your AI model",
      "Use TypeSafe Jev…",
    ]);
  });

  test("set up, but with no key on this device, the set-up row is offered to enter it again", () => {
    expect(rows(jevSettings({ enabled: true }), [JEV_OPTION, CHAT_OPTION])).toEqual([
      "Use your AI model",
      "Use TypeSafe Jev…",
    ]);
  });

  test("with a Jev key, Jev comes first and there is no set-up row", () => {
    expect(
      rows(jevSettings({ enabled: true, hasApiKey: true }), [JEV_OPTION, CHAT_OPTION]),
    ).toEqual(["TypeSafe Jev", "Use your AI model"]);
  });

  test("in Local mode, without a Jev server on this computer, no Jev row appears", () => {
    const local: TaggingModelOption = {
      ...CHAT_OPTION,
      classifier: { kind: "chat", choice: { providerId: "ollama-1", modelId: "qwen3.5:4b" } },
      group: "local",
      name: "Qwen 3.5 4B",
      provider: null,
    };
    expect(rows(jevSettings({}), [local], true)).toEqual([]);
    expect(rows(jevSettings({ enabled: true, hasApiKey: true }), [JEV_OPTION], true)).toEqual([]);
  });

  test("in Local mode, a Jev server on this computer without its key here offers the set-up row", () => {
    const here = jevSettings({ enabled: true, endpoint: "http://127.0.0.1:8080", service: null });
    expect(rows(here, [JEV_OPTION], true)).toEqual(["Use TypeSafe Jev…"]);
  });

  test("in Local mode, a Jev server on this computer is a choice, first, with no set-up row", () => {
    const here = jevSettings({
      enabled: true,
      hasApiKey: true,
      endpoint: "http://127.0.0.1:8080",
      service: null,
    });
    expect(rows(here, [JEV_OPTION], true)).toEqual(["TypeSafe Jev"]);
  });

  test("before Jev's settings are read, no set-up row is drawn", () => {
    expect(rows(null, [CHAT_OPTION])).toEqual(["Use your AI model"]);
  });
});

/** A decision model on a host, as the core lists it. */
const hosted = (
  host: DecisionHost,
  provider: string,
  modelId: string,
  name: string,
): TaggingModelOption => ({
  classifier: { kind: "decision", host, modelId },
  group: "keys",
  name,
  provider: { en: provider, zh: provider },
  goodForTagging: true,
  decisionModel: true,
  likelihoods: true,
  cost: { kind: "unknown" },
});

const LOCAL_DECISION: TaggingModelOption = {
  classifier: { kind: "ollama", baseUrl: "http://127.0.0.1:11434", modelId: "tev1:4b" },
  group: "local",
  name: "Tev1 4B",
  provider: null,
  goodForTagging: true,
  decisionModel: true,
  likelihoods: true,
  cost: { kind: "free" },
};

const status = (
  host: DecisionHost,
  overrides: Partial<DecisionHostStatus> = {},
): DecisionHostStatus => ({
  host,
  name: { en: host, zh: host },
  key: "own",
  provider: null,
  account: null,
  hasKey: false,
  ready: false,
  models: [{ id: `${host}-best`, name: `${host} best`, maker: host }],
  service: null,
  keyUrl: "https://example.com/keys",
  pricingUrl: "https://example.com/pricing",
  ...overrides,
});

describe("the sorting picker's hosts (#1907)", () => {
  const options = [
    hosted("openai", "OpenAI", "gpt-6-luna", "GPT-6 Luna Decisions"),
    hosted("liquid", "Liquid AI", "d1-ultra", "d1-ultra"),
    hosted("openrouter", "OpenRouter", "perplexity/pplx-decider-v1.2", "Decider v1.2"),
    hosted("openrouter", "OpenRouter", "liquid/d1-ultra", "d1-ultra"),
    JEV_OPTION,
    CHAT_OPTION,
    LOCAL_DECISION,
  ];

  test("the best first, as measured, one model per host, OpenAI's after the User's AI model", () => {
    expect(rows(jevSettings({ enabled: true, hasApiKey: true }), options)).toEqual([
      "Decider v1.2 · OpenRouter",
      "TypeSafe Jev",
      "d1-ultra · Liquid AI",
      "Use your AI model",
      "GPT-6 Luna Decisions · OpenAI",
      "Tev1 4B",
    ]);
  });

  test("in Local mode, no host is offered", () => {
    expect(rows(jevSettings({}), options, true)).toEqual(["Tev1 4B"]);
  });

  test("a host is set up in place when it needs a key of its own, or its account beside a chat key", () => {
    const offers = hostSetUpOffers(
      [
        status("openrouter", { key: "provider", provider: "openrouter", hasKey: false }),
        status("perplexity"),
        status("liquid", { hasKey: true, ready: true }),
        status("alibaba", {
          key: "provider",
          provider: "qwen",
          hasKey: true,
          account: { kind: "alibaba-workspace", value: null },
        }),
      ],
      false,
      (host) => `Use ${host.models[0]?.name}…`,
    );
    expect(offers).toEqual([
      { id: "perplexity", label: "Use perplexity best…" },
      { id: "alibaba", label: "Use alibaba best…" },
    ]);
    expect(hostSetUpOffers([status("perplexity")], true, () => "")).toEqual([]);
  });

  test("Alibaba's row stays while the Qwen key is there, as its workspace is changed where it was entered", () => {
    const alibaba = status("alibaba", {
      key: "provider",
      provider: "qwen",
      hasKey: true,
      ready: true,
      account: { kind: "alibaba-workspace", value: "ws-1" },
    });
    const offers = hostSetUpOffers(
      [alibaba, status("cloudflare", { hasKey: true, ready: true })],
      false,
      (host) => host.host,
    );
    expect(offers).toEqual([{ id: "alibaba", label: "alibaba" }]);
    expect(
      hostSetUpOffers([{ ...alibaba, hasKey: false, ready: false }], false, (host) => host.host),
    ).toEqual([]);
  });

  test("the sorting row names the chat key a host uses, and no other", () => {
    const hosts = [
      status("openrouter", { key: "provider", provider: "openrouter", hasKey: true, ready: true }),
      status("perplexity", { hasKey: true, ready: true }),
    ];
    const option = (host: DecisionHost) => ({
      classifier: { kind: "decision" as const, host, modelId: `${host}-best` },
      label: host,
      provider: host,
      decisionModel: true,
    });
    expect(keyProviderOf(option("openrouter"), hosts)).toBe("openrouter");
    expect(keyProviderOf(option("perplexity"), hosts)).toBeNull();
    expect(keyProviderOf(option("openrouter"), null)).toBeNull();
    expect(
      keyProviderOf(
        {
          classifier: { kind: "jev" },
          label: "TypeSafe Jev",
          provider: "TypeSafe",
          decisionModel: true,
        },
        hosts,
      ),
    ).toBeNull();
  });
});

describe("Settings' row under Automatic (#1907)", () => {
  const QUICK: TaggingModelOption = {
    ...CHAT_OPTION,
    classifier: { kind: "chat", choice: { providerId: "google-1", modelId: "gemini-flash-lite" } },
    name: "Gemini Flash-Lite",
    provider: { en: "Google", zh: "Google" },
  };
  const decider = hosted(
    "openrouter",
    "OpenRouter",
    "perplexity/pplx-decider-v1.2",
    "Decider v1.2",
  );
  const listed = (automatic: TaggingModels["automatic"], options: TaggingModelOption[]) => {
    const all = { ...models(options), automatic };
    return sortingOptions(all, {
      chatModel: CHAT,
      language: "en",
      localMode: false,
      jev: null,
      chatLabel: "Use your AI model",
      chatName: "Claude Haiku 5.5",
    });
  };

  test("Automatic's pick, not the best listed, is the row: a host first in the list is not what sorts", () => {
    const options = listed({ ...CHAT_OPTION, reason: "answers-model" }, [decider, CHAT_OPTION]);
    const all = {
      ...models([decider, CHAT_OPTION]),
      automatic: { ...CHAT_OPTION, reason: "answers-model" as const },
    };
    expect(options[0]?.label).toBe("Decider v1.2 · OpenRouter");
    expect(automaticRow(all, options, "en")).toMatchObject({
      row: { label: "Use your AI model" },
      listed: true,
    });
  });

  test("a pick the list doesn't offer (the provider's quick model) is named with where it sends", () => {
    const all = {
      ...models([decider, CHAT_OPTION]),
      automatic: { ...QUICK, reason: "quick-model" as const },
    };
    const options = listed(all.automatic, [decider, CHAT_OPTION]);
    expect(automaticRow(all, options, "en")).toEqual({
      row: {
        classifier: QUICK.classifier,
        label: "Gemini Flash-Lite · Google",
        provider: "Google",
        decisionModel: false,
        modelName: "Gemini Flash-Lite",
      },
      listed: false,
    });
  });

  test("with nothing Automatic can use, there is no row, whatever the list offers", () => {
    const options = listed(null, [decider]);
    expect(automaticRow(models([decider]), options, "en")).toEqual({ row: null, listed: false });
  });
});
