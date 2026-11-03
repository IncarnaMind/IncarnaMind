/**
 * Every reply schema the app sends goes out in OpenAI's strict form (#2146): each object closed
 * and all of its properties required, an optional one nullable. The schemas are collected from
 * the requests the real OpenAI provider makes, against a stand-in for `fetch`, so the test
 * checks what is sent rather than what is written, and a call that sends a new schema fails it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { generateText, jsonSchema, Output } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { isRecord } from "../../src/core/errors";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { strictSchema } from "../../src/core/providers/strictSchema";
import {
  answerByStructuredOutput,
  callEverySchema,
  documents,
  FIGURE,
  QUOTE,
  SCHEMA_CALLS,
} from "../helpers/schemaCalls";
import { type Reply, stubOpenAI } from "../helpers/stubOpenAI";

afterEach(() => vi.unstubAllGlobals());

/** What OpenAI's strict mode refuses in a schema, found independently of the code that makes it strict. */
function violations(schema: unknown, at = "#"): string[] {
  if (!isRecord(schema)) return [];
  const found: string[] = [];
  if (at === "#" && schema.type !== "object") found.push("# is not an object");
  if (schema.type === "object" || isRecord(schema.properties)) {
    if (!isRecord(schema.properties)) {
      found.push(`${at} is an object with no properties`);
    } else {
      if (schema.additionalProperties !== false) {
        found.push(`${at} does not set additionalProperties to false`);
      }
      const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
      for (const [name, property] of Object.entries(schema.properties)) {
        if (!required.includes(name)) found.push(`${at}/${name} is not required`);
        found.push(...violations(property, `${at}/${name}`));
      }
    }
  }
  found.push(...violations(schema.items, `${at}[]`));
  if (Array.isArray(schema.anyOf)) {
    for (const [index, each] of schema.anyOf.entries()) {
      found.push(...violations(each, `${at}|${index}`));
    }
  }
  return found;
}

describe("A reply schema in strict form", () => {
  test("closes every object, requires every property and makes an optional one nullable", () => {
    const strict = strictSchema({
      type: "object",
      properties: {
        answer: { type: "string" },
        kind: { type: "string", enum: ["a", "b"] },
        count: { type: "integer" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, note: { type: "string" } },
            required: ["name"],
          },
        },
        extra: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      required: ["answer"],
    });

    expect(violations(strict)).toEqual([]);
    expect(strict.required).toEqual(["answer", "kind", "count", "items", "extra"]);
    expect(strict.properties).toMatchObject({
      answer: { type: "string" },
      kind: { type: ["string", "null"], enum: ["a", "b", null] },
      count: { type: ["integer", "null"] },
      items: {
        anyOf: [
          {
            type: "array",
            items: {
              required: ["name", "note"],
              properties: { note: { type: ["string", "null"] } },
            },
          },
          { type: "null" },
        ],
      },
      extra: { anyOf: [{ type: "object", additionalProperties: false }, { type: "null" }] },
    });
  });

  test("is the same when made strict again, and leaves the original alone", () => {
    const original = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    } as const;
    const strict = strictSchema(original);

    expect(strictSchema(strict)).toEqual(strict);
    expect(original).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });
  });

  test.each([
    ["an object with no properties", { type: "object", properties: { a: { type: "object" } } }],
    [
      "an object of free-form properties",
      { type: "object", properties: {}, additionalProperties: { type: "string" } },
    ],
    ["a root that is not an object", { type: "array", items: { type: "string" } }],
  ] as const)("refuses what strict mode cannot say: %s", (_name, schema) => {
    expect(() => strictSchema(schema)).toThrow();
  });
});

const formatOf = (body: Record<string, unknown>) => {
  const { text } = body;
  const format = isRecord(text) ? text.format : undefined;
  return isRecord(format) && typeof format.name === "string" ? format : null;
};

/** What the stand-in answers to each schema, by its name: enough for the call to go on. */
function replyTo(body: Record<string, unknown>): Reply {
  switch (formatOf(body)?.name) {
    case "answer":
      return {
        text: JSON.stringify({
          answer: `${QUOTE} [^1]. Gross margin rose [=1].`,
          citations: [{ marker: 1, passage: "P1", quote: QUOTE }],
          calculations: [FIGURE],
        }),
      };
    case "change-claims":
      return { text: JSON.stringify({ claims: [] }) };
    case "calculations":
      return { text: JSON.stringify({ calculations: [] }) };
    case "quotes":
      return { text: JSON.stringify({ quotes: [] }) };
    case "citations":
      return { text: JSON.stringify({ citations: [] }) };
    case "document_group":
      return { text: JSON.stringify({ groupId: "g-reports", tags: ["t-report"], newTags: [] }) };
    case "document_tags":
      return { text: JSON.stringify({ tags: ["Report"], newTags: [] }) };
    case "folder_proposals":
      return { text: JSON.stringify({ folders: [{ name: "Reports", description: "Reports." }] }) };
    case "suggestion":
      return { text: JSON.stringify({ text: "", passage: "", quote: "" }) };
    default:
      return { text: "OK" };
  }
}

const sourcesOf = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => file.split(path.sep).join("/"));

describe("Every reply schema the app sends to an API that enforces strict mode", () => {
  test.each(["openai", "xai"] as const)(
    "%s: is strict, and every call that sends one is covered",
    async (kind) => {
      const requests = stubOpenAI(replyTo);
      const model = createAiSdkChatModel({
        kind,
        baseUrl: null,
        apiKey: "sk-test",
        modelId: "gpt-6-luna",
      });

      const events = await callEverySchema(model);

      expect(events.at(-1)).toEqual({ type: "finished" });
      const sent = new Map<string, unknown>();
      for (const { body } of requests) {
        const format = formatOf(body);
        if (!format) continue;
        expect(format.type).toBe("json_schema");
        expect(format.strict).toBe(true);
        sent.set(String(format.name), format.schema);
      }
      expect([...sent.keys()].sort()).toEqual(Object.values(SCHEMA_CALLS).flat().sort());
      for (const [name, schema] of sent) expect(violations(schema), name).toEqual([]);
    },
  );

  test("a call that makes a model reply to a schema is one of those the test sends", () => {
    const folder = path.join(__dirname, "../../src/core");
    const found: Record<string, number> = {};
    for (const file of sourcesOf(folder)) {
      const count =
        readFileSync(path.join(folder, file), "utf8").split("Output.object(").length - 1;
      if (count > 0) found[file] = count;
    }

    expect(
      found,
      "a call that sends a schema is added to SCHEMA_CALLS and sent from callEverySchema (tests/helpers/schemaCalls.ts)",
    ).toEqual(
      Object.fromEntries(Object.entries(SCHEMA_CALLS).map(([file, names]) => [file, names.length])),
    );
  });
});

describe("An Answer by structured output, in the strict form OpenAI replies in", () => {
  test("reads null where a property was optional as absent", async () => {
    const [input] = FIGURE.inputs;
    const reply = {
      answer: `${QUOTE} [^1]. Gross margin rose [=1].`,
      citations: [
        { marker: 1, passage: "P1", location: null, pageFrom: null, pageTo: null, quote: QUOTE },
      ],
      calculations: [
        {
          ...FIGURE,
          as: null,
          decimals: null,
          scale: null,
          inputs: [
            {
              ...input,
              passage: null,
              location: null,
              quote: null,
              position: null,
              unitQuote: null,
              reading: null,
              rate: null,
            },
          ],
        },
      ],
    };
    stubOpenAI(() => ({ text: JSON.stringify(reply) }));
    const cited: unknown[] = [];
    const calculated: unknown[] = [];
    const model = createAiSdkChatModel({
      kind: "openai",
      baseUrl: null,
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
    });

    const events = await answerByStructuredOutput(model, {
      ...documents,
      cite: (records) => {
        cited.push(...records);
        return "Recorded.";
      },
      calculate: (figures) => {
        calculated.push(...figures);
        return "";
      },
    });

    expect(events.at(-1)).toEqual({ type: "finished" });
    expect(cited[0]).toEqual({
      marker: 1,
      passage: "P1",
      pageFrom: null,
      pageTo: null,
      quote: QUOTE,
    });
    expect(calculated[0]).toEqual(reply.calculations[0]);
  });
});

describe("A reply schema goes to the APIs that don't enforce OpenAI's rules as written", () => {
  test("a local model", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(
          JSON.stringify({
            model: "qwen",
            created_at: "2026-10-28T00:00:00Z",
            message: { role: "assistant", content: '{"a":"x"}' },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const local = createAiSdkChatModel({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: null,
      modelId: "qwen",
    });
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    } as const;

    await generateText({
      model: local,
      prompt: "x",
      output: Output.object({ schema: jsonSchema(schema) }),
      maxRetries: 0,
    });

    expect(sent[0]).toMatchObject({ format: schema });
  });
});
