/**
 * OpenAI takes every reply schema the app sends (#2146): one request of each call that makes a
 * model reply to a schema, against the real API, and none is refused. Runs only with the key in
 * the environment (INCARNAMIND_LIVE_OPENAI_KEY; the model is INCARNAMIND_LIVE_OPENAI_MODEL, the
 * catalog's quick-tasks model by default), and makes no request without one.
 * INCARNAMIND_LIVE_REPORT keeps what each request got.
 */
import { appendFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { isRecord } from "../../src/core/errors";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { callEverySchema, SCHEMA_CALLS } from "../helpers/schemaCalls";

const KEY = process.env.INCARNAMIND_LIVE_OPENAI_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_OPENAI_MODEL ??
  (catalogProvider("openai")?.roles.quickTasks as string);

afterEach(() => vi.unstubAllGlobals());

describe("reply schemas, live: OpenAI", () => {
  test.skipIf(KEY === undefined)(
    "every call that sends a schema is answered, none refused",
    { timeout: 600_000 },
    async () => {
      const real = globalThis.fetch;
      const got: { name: string; status: number; refusal: string }[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await real(input, init);
        const body: unknown = JSON.parse(String(init?.body ?? "{}"));
        const format = isRecord(body) && isRecord(body.text) ? body.text.format : undefined;
        if (isRecord(format) && typeof format.name === "string") {
          const refusal = response.ok
            ? ""
            : (await response.clone().text()).replace(/sk-[\w-]+/g, "sk-…").slice(0, 400);
          got.push({ name: format.name, status: response.status, refusal });
        }
        return response;
      });
      const model = createAiSdkChatModel({
        kind: "openai",
        baseUrl: null,
        apiKey: KEY ?? "",
        modelId: MODEL,
      });

      await callEverySchema(model);

      if (process.env.INCARNAMIND_LIVE_REPORT) {
        const lines = got.map(({ name, status, refusal }) =>
          `- ${MODEL} ${name}: HTTP ${status} ${refusal}`.trim(),
        );
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n\n`);
      }
      expect(got.filter(({ status }) => status !== 200)).toEqual([]);
      expect(new Set(got.map(({ name }) => name))).toEqual(
        new Set(Object.values(SCHEMA_CALLS).flat()),
      );
    },
  );
});
