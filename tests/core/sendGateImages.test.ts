/**
 * The last check before a request leaves (ADR-0022), for the page images of a
 * scan (#1613): Organize's request may carry a picture only while the "scan-images" flow is
 * allowed for the service, whatever else was decided, even if the picture was added before.
 */
import { join } from "node:path";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ExternalService } from "../../src/core/api";
import { createConsent } from "../../src/core/consent";
import { ConsentNeededError } from "../../src/core/errors";
import { createEventHub } from "../../src/core/events";
import { createSendGate } from "../../src/core/sendGate";
import { migrate, openDatabase } from "../../src/core/storage";
import { createTempDataFolder } from "../helpers/core";

const SERVICE: ExternalService = { id: "https://api.example.com", name: "Example" };

async function gated() {
  const db = openDatabase(join(await createTempDataFolder(), "gate.db"));
  migrate(db);
  const consent = createConsent(db, createEventHub(), () => new Date().toISOString());
  for (const [id, sends] of [
    ["classification", ["groups", "tags", "document-excerpts"]],
    ["scan-images", ["page-images"]],
  ] as const) {
    consent.registry.register({ id, sends, background: true, services: async () => [SERVICE] });
  }
  const inner = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: undefined },
      warnings: [],
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    }),
  });
  const model = createSendGate(consent, () => false).model(inner, "classification", SERVICE);
  const ask = (images: number) =>
    generateText({
      model,
      maxRetries: 0,
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "Sort this." },
            ...Array.from({ length: images }, () => ({
              type: "file" as const,
              data: new Uint8Array([255, 216, 255]),
              mediaType: "image/jpeg",
            })),
          ],
        },
      ],
    });
  return { consent, inner, ask };
}

describe("The send gate and page images", () => {
  test("a request with a picture stops until the page images are allowed; text still goes", async () => {
    const { consent, inner, ask } = await gated();
    consent.choose(["classification"], SERVICE);

    await ask(0);
    expect(inner.doGenerateCalls).toHaveLength(1);

    await expect(ask(2)).rejects.toBeInstanceOf(ConsentNeededError);
    expect(inner.doGenerateCalls).toHaveLength(1);

    await consent.allow("scan-images", SERVICE.id);
    await ask(2);
    expect(inner.doGenerateCalls).toHaveLength(2);

    consent.revoke("scan-images", SERVICE.id);
    await expect(ask(1)).rejects.toBeInstanceOf(ConsentNeededError);
    await ask(0);
    expect(inner.doGenerateCalls).toHaveLength(3);
  });
});
