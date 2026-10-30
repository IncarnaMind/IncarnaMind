import { describe, expect, test } from "vitest";
import { modelName } from "../../src/shared/modelName";

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
