import { describe, expect, test } from "vitest";
import type {
  ChatProvider,
  EmbeddingProvider,
  RerankSettings,
  TranscriptionServiceStatus,
} from "../../src/core/api";
import { accountUses } from "../../src/renderer/src/components/ai/accountUses";
import { groupByPayer, payerOf } from "../../src/renderer/src/components/ai/payers";
import {
  entryKey,
  entryName,
  jobsOf,
  type ServiceEntry,
  serviceDirectory,
} from "../../src/renderer/src/components/ai/serviceDirectory";

const name = (entry: ServiceEntry) =>
  entry.kind === "plan" ? entry.plan : (entryName(entry, "en") ?? "");

describe("Add an account or key: the directory (#2835)", () => {
  test("its groups, in order: plans, popular keys, this computer, meetings only, Organize only, more", () => {
    expect(serviceDirectory("en", { name }).map((each) => each.group)).toEqual([
      "plans",
      "popular",
      "local",
      "meetings",
      "organize",
      "more",
    ]);
    const groups = serviceDirectory("en", { name });
    const keys = (group: string) =>
      groups.find((each) => each.group === group)?.entries.map(entryKey) ?? [];
    expect(keys("plans")).toEqual(["plan:chatgpt", "plan:claude-account", "plan:copilot"]);
    expect(keys("popular").slice(0, 3)).toEqual([
      "provider:anthropic",
      "provider:openai",
      "provider:google",
    ]);
    expect(keys("local")).toContain("provider:ollama");
    expect(keys("meetings")).toEqual(
      expect.arrayContaining(["transcription:soniox", "transcription:deepgram"]),
    );
    expect(keys("meetings")).not.toContain("transcription:openai");
    expect(keys("organize")).toEqual(expect.arrayContaining(["decision:perplexity", "jev"]));
    expect(keys("organize")).not.toContain("decision:openrouter");
    expect(keys("more")).toEqual(expect.arrayContaining(["provider:cohere", "rerank:voyage"]));
    expect(keys("more")).not.toContain("rerank:cohere");
  });

  test("lists every service once, and puts China's companies first for a Chinese User", () => {
    const all = serviceDirectory("en", { name }).flatMap((each) => each.entries.map(entryKey));
    expect(new Set(all).size).toBe(all.length);
    const chinese = serviceDirectory("zh-CN", { name });
    expect(chinese.find((each) => each.group === "popular")?.entries.map(entryKey)[0]).toBe(
      "provider:deepseek",
    );
  });

  test("tags each service with the jobs it can do", () => {
    const groups = serviceDirectory("en", { name });
    const entry = (key: string) =>
      groups.flatMap((each) => each.entries).find((each) => entryKey(each) === key);
    const jobs = (key: string) => {
      const found = entry(key);
      return found ? jobsOf(found) : [];
    };
    expect(jobs("provider:openai")).toEqual(["answers", "transcription", "search", "organize"]);
    expect(jobs("provider:anthropic")).toEqual(["answers"]);
    expect(jobs("provider:ollama")).toEqual(["answers", "search", "organize"]);
    expect(jobs("transcription:soniox")).toEqual(["transcription"]);
    expect(jobs("jev")).toEqual(["organize", "hints"]);
    expect(jobs("provider:cohere")).toEqual(["answers", "search"]);
    expect(jobs("rerank:voyage")).toEqual(["search"]);
  });

  test("finds a service by its name, leaves out a plan this copy can't set up, and drops empty groups", () => {
    expect(
      serviceDirectory("en", { name, query: "cohe" }).flatMap((each) => each.entries.map(entryKey)),
    ).toEqual(["provider:cohere"]);
    expect(serviceDirectory("en", { name, query: "zzqx" })).toEqual([]);
    const plans = serviceDirectory("en", { name, offered: (plan) => plan === "chatgpt" }).find(
      (each) => each.group === "plans",
    );
    expect(plans?.entries.map(entryKey)).toEqual(["plan:chatgpt"]);
  });
});

const provider = (id: string, catalogId: string, local = false): ChatProvider => ({
  id,
  kind: catalogId === "ollama" ? "ollama" : catalogId === "chatgpt" ? "chatgpt" : "openai",
  catalogId: catalogId === "chatgpt" ? null : catalogId,
  endpoint: null,
  baseUrl: null,
  hasApiKey: !local,
  service: local ? null : { id: `https://${catalogId}`, name: catalogId },
});

const service = (
  route: TranscriptionServiceStatus["route"],
  key: "provider" | "own",
  providerId: string | null,
): TranscriptionServiceStatus => ({
  route,
  name: route,
  recipient: { en: route, zh: route },
  model: "m",
  perHour: { currency: "USD", amount: 1 },
  region: null,
  dataUse: null,
  key,
  providerId,
  hasKey: true,
  refused: false,
  liveSpeakers: false,
  keyUrl: null,
  billingUrl: null,
  server: null,
  keyOptional: false,
  keyChecked: true,
  languages: [],
  missingLanguages: [],
  chooseAgain: false,
});

const embeddingOf = (kind: EmbeddingProvider["kind"]): EmbeddingProvider => ({
  kind,
  baseUrl: null,
  modelId: "m",
  hasApiKey: kind === "openai",
  dimensions: null,
  service: null,
});

const rerankOf = (kind: RerankSettings["kind"]): RerankSettings => ({
  enabled: kind !== null,
  byDefault: false,
  kind,
  modelId: null,
  hasApiKey: kind !== "built-in",
  service: null,
  paused: false,
  model: {
    name: "reranker",
    host: "example.com",
    state: "ready",
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
  },
  runsOn: null,
});

describe("Accounts and keys: what each row is used for (#2835)", () => {
  const openai = provider("p-openai", "openai");
  const plan = provider("p-plan", "chatgpt");
  const ollama = provider("p-ollama", "ollama", true);
  const providers = [plan, openai, ollama];
  const none = {
    providers,
    chatModel: null,
    roles: null,
    sorting: null,
    transcriptionRoute: null,
    services: [],
    embedding: null,
    rerank: null,
  };

  test("one row per company, whatever it is used for: OpenAI's key answers, transcribes and searches", () => {
    const uses = accountUses({
      ...none,
      chatModel: { providerId: openai.id, modelId: "gpt-6-luna" },
      roles: {
        quickTasks: { providerId: openai.id, modelId: "gpt-6-luna" },
        images: null,
        callHelp: null,
      },
      transcriptionRoute: "openai",
      services: [service("openai", "provider", openai.id)],
      embedding: embeddingOf("openai"),
    });
    expect(uses.get(`provider:${openai.id}`)).toEqual([
      "answers",
      "quick",
      "transcription",
      "search",
    ]);
    expect(uses.has("search:openai")).toBe(false);
  });

  test("a key kept for one job is its own row; what runs built in is the built-in row", () => {
    const uses = accountUses({
      ...none,
      transcriptionRoute: "soniox",
      services: [service("soniox", "own", null)],
      embedding: embeddingOf("built-in"),
      rerank: rerankOf("cohere"),
      sorting: { kind: "decision", host: "perplexity", modelId: "decider-v1.2" },
    });
    expect(uses.get("transcription:soniox")).toEqual(["transcription"]);
    expect(uses.get("rerank:cohere")).toEqual(["rerank"]);
    expect(uses.get("sorting:perplexity")).toEqual(["organize", "hints"]);
    expect(uses.get("built-in")).toEqual(["search"]);
  });

  test("a decision host on a company's key is that company's row; a local model is Ollama's", () => {
    const openrouter = provider("p-or", "openrouter");
    const uses = accountUses({
      ...none,
      providers: [...providers, openrouter],
      sorting: { kind: "decision", host: "openrouter", modelId: "decider-v1.2" },
      transcriptionRoute: "local",
      embedding: embeddingOf("ollama"),
      rerank: rerankOf("built-in"),
    });
    expect(uses.get(`provider:${openrouter.id}`)).toEqual(["organize", "hints"]);
    expect(uses.get(`provider:${ollama.id}`)).toEqual(["search"]);
    expect(uses.get("built-in")).toEqual(["transcription", "rerank"]);
  });

  test("a Cohere account reranks on its own row: no separate reranker key", () => {
    const cohere = provider("p-cohere", "cohere");
    const uses = accountUses({
      ...none,
      providers: [...providers, cohere],
      rerank: rerankOf("cohere"),
    });
    expect(uses.get(`provider:${cohere.id}`)).toEqual(["rerank"]);
    expect(uses.has("rerank:cohere")).toBe(false);
  });

  // protects=an Ollama on another computer is never credited to this computer's Ollama row; fails_when=a remote search reads as local; no_claim=how the remote server is named.
  test("search on an Ollama at another address isn't this computer's Ollama row", () => {
    const remote = { ...embeddingOf("ollama"), baseUrl: "http://192.168.1.20:11434" };
    const uses = accountUses({ ...none, embedding: remote });
    expect(uses.has(`provider:${ollama.id}`)).toBe(false);
    expect(
      accountUses({ ...none, embedding: embeddingOf("ollama") }).get(`provider:${ollama.id}`),
    ).toEqual(["search"]);
  });

  test("a search key kept from before, with no account of that company, keeps a row of its own", () => {
    const uses = accountUses({ ...none, providers: [plan], embedding: embeddingOf("openai") });
    expect(uses.get("search:openai")).toEqual(["search"]);
  });

  test("nothing used: no row says it is", () => {
    expect(accountUses({ ...none, transcriptionRoute: "openai" }).size).toBe(0);
  });
});

describe("Pickers group models by who pays (#2835)", () => {
  test("each plan first, then the User's keys, then this computer, keeping each group's order", () => {
    const plan = provider("p-plan", "chatgpt");
    const openai = provider("p-openai", "openai");
    const ollama = provider("p-ollama", "ollama", true);
    const groups = groupByPayer([ollama, openai, plan, ollama], payerOf);
    expect(groups.map((each) => each.payer.kind)).toEqual(["plan", "keys", "local"]);
    expect(groups[2]?.items).toEqual([ollama, ollama]);
  });
});
