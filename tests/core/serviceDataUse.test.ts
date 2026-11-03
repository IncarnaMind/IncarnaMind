import { describe, expect, test } from "vitest";
import { dataUseForService, type ExternalService } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";

const service = (id: string, catalogId?: string): ExternalService => ({ id, name: id, catalogId });

describe("Data use for an external service", () => {
  test("uses the catalog entry for each hosted API origin", () => {
    const services = [
      ["anthropic", "https://api.anthropic.com"],
      ["google", "https://generativelanguage.googleapis.com"],
      ["deepseek", "https://api.deepseek.com"],
      ["kimi", "https://api.moonshot.cn"],
      ["kimi", "https://api.moonshot.ai"],
      ["glm", "https://open.bigmodel.cn"],
      ["glm", "https://api.z.ai"],
      ["cohere", "https://api.cohere.ai"],
    ] as const;
    for (const [providerId, serviceId] of services) {
      expect(dataUseForService(service(serviceId)), serviceId).toBe(
        catalogProvider(providerId)?.dataUse,
      );
    }
  });

  test("uses the rerank service's catalog id, including a historical service with only its origin and name", () => {
    for (const cohere of [
      service("https://api.cohere.com", "cohere"),
      service("https://api.cohere.com"),
    ]) {
      expect(dataUseForService(cohere)).toBe(catalogProvider("cohere")?.dataUse);
    }
  });

  test("does not infer data use for plan sign-ins or a custom server", () => {
    for (const serviceId of [
      "chatgpt-plan",
      "claude-account",
      "copilot",
      "https://llm.example.com",
    ]) {
      expect(dataUseForService(service(serviceId)), serviceId).toBeUndefined();
    }
  });
});
