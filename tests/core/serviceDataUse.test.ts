import { describe, expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { dataUseForService } from "../../src/core/providers/serviceDataUse";

describe("Data use for an external service", () => {
  test("uses the catalog entry for each hosted API origin", () => {
    const services = [
      ["anthropic", "https://api.anthropic.com"],
      ["google", "https://generativelanguage.googleapis.com"],
      ["deepseek", "https://api.deepseek.com"],
      ["kimi", "https://api.moonshot.cn"],
      ["kimi", "https://api.moonshot.ai"],
      ["cohere", "https://api.cohere.ai"],
    ] as const;
    for (const [providerId, serviceId] of services) {
      expect(dataUseForService(serviceId), serviceId).toBe(catalogProvider(providerId)?.dataUse);
    }
  });

  test("uses Cohere's entry for its rerank API origin", () => {
    expect(dataUseForService("https://api.cohere.com")).toBe(catalogProvider("cohere")?.dataUse);
  });

  test("does not infer data use for plan sign-ins or a custom server", () => {
    for (const serviceId of [
      "chatgpt-plan",
      "claude-account",
      "copilot",
      "https://llm.example.com",
    ]) {
      expect(dataUseForService(serviceId), serviceId).toBeUndefined();
    }
  });
});
