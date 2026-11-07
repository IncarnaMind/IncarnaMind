import { describe, expect, test } from "vitest";
import { modelName, shortModelName } from "../../src/shared/modelName";

describe("modelName", () => {
  test("takes the catalog's name, for the provider's set or, with no provider, from any set", () => {
    expect(modelName("claude-haiku-5-5", { kind: "anthropic" })).toBe("Claude Haiku 5.5");
    expect(modelName("gpt-6-luna", { kind: "openai" })).toBe("GPT-6 Luna");
    expect(modelName("gpt-6-luna", { kind: "chatgpt" })).toBe("GPT-6 Luna");
    expect(modelName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelName("claude-haiku-4-5-20251001", { kind: "anthropic" })).toMatch(/^Claude Haiku/);
  });

  test("a model's own provider names it before one that only resells it", () => {
    expect(modelName("kimi-k2.6")).toBe("Kimi K2.6");
    expect(modelName("kimi-k2.6", { kind: "kimi", endpoint: "intl" })).toBe("Kimi K2.6");
  });

  test("leaves out models.dev's “(latest)”", () => {
    expect(modelName("claude-opus-4-5", { kind: "anthropic" })).toBe("Claude Opus 4.5");
  });

  test("takes the provider's own name when the catalog has none, and the catalog's first", () => {
    const names = { "gpt-9-new": "GPT-9 New", "gpt-6-luna": "Not this one" };
    expect(modelName("gpt-9-new", { kind: "chatgpt", names })).toBe("GPT-9 New");
    expect(modelName("gpt-6-luna", { kind: "chatgpt", names })).toBe("GPT-6 Luna");
  });

  test("uses a known local model's display name, leaving its tag for hover", () => {
    expect(modelName("qwen3.5:4b", { kind: "ollama" })).toBe("Qwen 3.5 4B");
    expect(modelName("qwen3.5:4b")).toBe("Qwen 3.5 4B");
    expect(modelName("glm-4.7-flash", { kind: "ollama" })).toBe("GLM 4.7 Flash");
  });

  test("falls back to the id for an id nothing names, an Ollama tag included", () => {
    expect(modelName("gpt-oss:20b-cloud", { kind: "ollama" })).toBe("gpt-oss:20b-cloud");
    expect(modelName("gpt-oss:20b-cloud")).toBe("gpt-oss:20b-cloud");
    expect(modelName("llama3.2", { kind: "openai-compatible" })).toBe("llama3.2");
    expect(modelName("claude-haiku-5-5", { kind: "ollama" })).toBe("claude-haiku-5-5");
  });
});

describe("shortModelName", () => {
  test.each([
    ["Claude Haiku 5.5", "Haiku 5.5"],
    ["Claude Sonnet 5.5", "Sonnet 5.5"],
    ["DeepSeek V4.1 Flash", "DeepSeek Flash"],
    ["DeepSeek V4 Pro", "DeepSeek Pro"],
    ["GPT-6 Luna", "GPT-6 Luna"],
    ["Kimi K2.6", "Kimi K2.6"],
    ["Qwen 3.5 4B", "Qwen 3.5 4B"],
    ["DeepSeek V3", "DeepSeek V3"],
    ["fake-model", "fake-model"],
    ["gpt-oss:20b-cloud", "gpt-oss:20b-cloud"],
  ])("%s is shown as %s", (name, short) => {
    expect(shortModelName(name)).toBe(short);
  });

  test("a name with neither a Claude nor a version before its tier stays whole", () => {
    for (const name of [
      "GPT-6 Luna",
      "GPT-6.1 Sol",
      "Kimi K3",
      "Gemini 3.5 Flash",
      "Qwen3.5 Plus",
    ]) {
      expect(shortModelName(name), name).toBe(name);
    }
  });

  test("takes the names the catalog gives: the default models of two providers", () => {
    expect(shortModelName(modelName("claude-haiku-5-5", { kind: "anthropic" }))).toBe("Haiku 5.5");
    expect(shortModelName(modelName("deepseek-flash", { kind: "deepseek" }))).toBe(
      "DeepSeek Flash",
    );
  });
});
