/**
 * An Answer that can't be made says why, by the kind of its failure, and the
 * log keeps the provider's status and words, never what they quote nor the
 * key, so the cause can be found (#1487).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { JSONParseError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ProviderErrorKind } from "../../src/core";
import { answerEnded, askNew, setUpWithDocuments } from "../helpers/citations";
import { recordingLog } from "../helpers/log";
import { answerIn } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

const KEY = "sk-ant-api03-4f9b2c7e1d8a6053b2e9f4c1a7d0e3b5";
const DOCUMENT_TEXT = "The harbour master's code is lantern-42.";
const QUESTION = "What is the harbour master's code?";

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/** A model whose reply starts, then ends with `failure`: thrown, or sent as the stream's error. */
function breakingModel(failure: { thrown: Error } | { sent: unknown }): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if ("thrown" in failure) controller.error(failure.thrown);
          else {
            controller.enqueue({ type: "error", error: failure.sent });
            controller.close();
          }
        },
      }),
    }),
  });
}

/** One Anthropic stream event, as its API frames it. */
const sse = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Claude, as Anthropic answers when it is overloaded after the reply has begun. */
function overloadedClaude() {
  const reply = [
    sse("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    sse("error", { error: { type: "overloaded_error", message: "Overloaded" } }),
  ].join("");
  const server = async (): Promise<Response> =>
    new Response(reply, { headers: { "content-type": "text/event-stream" } });
  return createAnthropic({ apiKey: KEY, fetch: server })("claude-haiku-5-5");
}

/** Asks a Question with `model` answering, and gives back how it failed and what the log says of it. */
async function failWith(model: MockLanguageModelV4 | ReturnType<typeof overloadedClaude>) {
  const { log, entries } = recordingLog();
  const { core, client, mind } = await setUpWithDocuments(
    scriptedModel(() => ({ text: "" })),
    [],
    {
      log,
      createChatModel: () => model,
    },
  );
  const answerId = await askNew(core, client, mind.id, QUESTION);
  const ended = await answerEnded(core, answerId);
  if (ended.event !== "failed") throw new Error("The Answer didn't fail.");
  const logged = entries.find(
    (entry) => entry.event === "answer.failed" && entry.fields?.answerId === answerId,
  );
  return { error: ended.payload.error, attrs: answerIn(client, answerId).attrs, logged, entries };
}

const refusing = (status: number, message: string) =>
  scriptedModel(() => ({ error: { status, message } }));

const cases: {
  way: string;
  model: () => MockLanguageModelV4 | ReturnType<typeof overloadedClaude>;
  kind: ProviderErrorKind;
  status?: number;
  message: string;
}[] = [
  {
    way: "the connection ends partway, as a timed-out reply does",
    model: () =>
      breakingModel({
        thrown: new TypeError("terminated", {
          cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
        }),
      }),
    kind: "network",
    message: "terminated",
  },
  {
    way: "a rate limit (429)",
    model: () => refusing(429, "Number of request tokens has exceeded your rate limit"),
    kind: "rate-limit",
    status: 429,
    message: "Number of request tokens has exceeded your rate limit",
  },
  {
    way: "a refused key (401), whose message quotes it",
    model: () => refusing(401, `Incorrect API key provided: ${KEY}.`),
    kind: "auth",
    status: 401,
    message: "Incorrect API key provided: [redacted].",
  },
  {
    way: "a refused request (400), whose message quotes what was sent",
    model: () => refusing(400, `messages.0.content: "${DOCUMENT_TEXT}" is not valid here`),
    kind: "refused",
    status: 400,
    message: "messages.0.content: [redacted] is not valid here",
  },
  {
    way: "a reply that can't be read",
    model: () =>
      breakingModel({
        sent: new JSONParseError({
          text: `{"answer": "${DOCUMENT_TEXT}`,
          cause: new SyntaxError("Unterminated string in JSON"),
        }),
      }),
    kind: "no-answer",
    message: "The model's reply couldn't be read (AI_JSONParseError).",
  },
  {
    way: "Anthropic overloaded after the reply began",
    model: overloadedClaude,
    kind: "provider",
    status: 529,
    message: "Overloaded",
  },
  {
    way: "a status nothing explains (a proxy's redirect)",
    model: () => refusing(302, "Found"),
    kind: "unknown",
    status: 302,
    message: "Found",
  },
];

describe("An Answer that can't be made", { timeout: 30_000 }, () => {
  for (const { way, model, kind, status, message } of cases) {
    test(`by ${way} fails as ${kind}, and the log keeps its status and words`, async () => {
      const failed = await failWith(model());

      expect(failed.error.kind).toBe(kind);
      expect(failed.attrs).toMatchObject({ status: "failed", errorKind: kind });
      expect(failed.logged).toEqual({
        level: "warn",
        event: "answer.failed",
        fields: { answerId: expect.any(String), errorKind: kind, status, message },
      });
      const everything = JSON.stringify(failed.entries);
      for (const secret of [KEY, "4f9b2c7e", DOCUMENT_TEXT, "lantern", QUESTION]) {
        expect(everything).not.toContain(secret);
      }
    });
  }
});
