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

/** A model whose reply starts, then ends with `sent` as the stream's error. */
function breakingModel(sent: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "error", error: sent });
          controller.close();
        },
      }),
    }),
  });
}

/** One Anthropic stream event, as its API frames it. */
const sse = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const MESSAGE_START = sse("message_start", {
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    usage: { input_tokens: 5, output_tokens: 1 },
  },
});

const eventStream = { headers: { "content-type": "text/event-stream" } };

/** Claude, as Anthropic answers when it is overloaded after the reply has begun. */
function overloadedClaude() {
  const reply =
    MESSAGE_START + sse("error", { error: { type: "overloaded_error", message: "Overloaded" } });
  const server = async (): Promise<Response> => new Response(reply, eventStream);
  return createAnthropic({ apiKey: KEY, fetch: server })("claude-haiku-5-5");
}

const CREDIT_MESSAGE =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

/** Claude, as Anthropic answers an account with no credit left. */
function creditlessClaude() {
  const server = async (): Promise<Response> =>
    Response.json(
      { type: "error", error: { type: "invalid_request_error", message: CREDIT_MESSAGE } },
      { status: 400 },
    );
  return createAnthropic({ apiKey: KEY, fetch: server })("claude-haiku-5-5");
}

/** Claude, over a connection that ends once the reply has begun: Node's fetch fails the read with "terminated". */
function cutClaude() {
  const server = async (): Promise<Response> =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(MESSAGE_START));
          controller.error(
            new TypeError("terminated", {
              cause: Object.assign(new Error("other side closed"), {
                name: "SocketError",
                code: "UND_ERR_SOCKET",
              }),
            }),
          );
        },
      }),
      eventStream,
    );
  return createAnthropic({ apiKey: KEY, fetch: server })("claude-haiku-5-5");
}

/** Asks a Question with `model` answering, and gives back how it failed and what the log says of it. */
async function failWith(
  model: MockLanguageModelV4 | ReturnType<typeof overloadedClaude>,
  /** Keys the User has saved for other providers, which the core has handled by then. */
  savedKeys: Partial<Record<"openai" | "anthropic", string>> = {},
) {
  const { log, entries } = recordingLog();
  const { core, client, mind } = await setUpWithDocuments(
    scriptedModel(() => ({ text: "" })),
    [],
    {
      log,
      createChatModel: () => model,
    },
  );
  for (const [kind, apiKey] of Object.entries(savedKeys)) {
    await core.saveChatProvider({
      kind: kind === "openai" ? "openai" : "anthropic",
      apiKey,
      modelId: kind === "openai" ? "gpt-5.4-mini" : "claude-haiku-5-5",
      keepDefault: true,
    });
  }
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
    way: "the connection ends once the reply has begun, as the SDK wraps it",
    model: cutClaude,
    kind: "network",
    status: 200,
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
    way: "a refused request (400) that quotes a Question of two lines",
    model: () =>
      refusing(400, 'messages.0.content: "Acme plans to buy Beta Corp\nfor 40m" can\'t be taken'),
    kind: "refused",
    status: 400,
    message: "messages.0.content: [redacted]",
  },
  {
    way: "a reply that can't be read",
    model: () =>
      breakingModel(
        new JSONParseError({
          text: `{"answer": "${DOCUMENT_TEXT}`,
          cause: new SyntaxError("Unterminated string in JSON"),
        }),
      ),
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
    way: "an account with no credit, in Anthropic's own words (400)",
    model: creditlessClaude,
    kind: "out-of-credit",
    status: 400,
    message: CREDIT_MESSAGE,
  },
  {
    way: "an account in arrears, in Chinese (429)",
    model: () => refusing(429, "您的账户已欠费，请充值后重试。"),
    kind: "out-of-credit",
    status: 429,
    message: "您的账户已欠费，请充值后重试。",
  },
  {
    way: "a region the provider doesn't serve (403)",
    model: () => refusing(403, "Country, region, or territory not supported"),
    kind: "region",
    status: 403,
    message: "Country, region, or territory not supported",
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

describe("An Answer that fails with a key in the provider's words", () => {
  test("never keeps a key the core has handled, however short or plain, wherever it stands", async () => {
    const short = "sk-1234";
    const plain = "abcdefghijklmnopqrstuvwxyzabcdef";
    const failed = await failWith(
      refusing(401, `Incorrect key ${short} (and ${plain}) for this server`),
      { openai: short, anthropic: plain },
    );

    expect(failed.logged?.fields).toEqual({
      answerId: expect.any(String),
      errorKind: "auth",
      status: 401,
      message: "Incorrect key [redacted] (and [redacted]) for this server",
    });
    const everything = JSON.stringify(failed.entries);
    for (const secret of [short, plain]) expect(everything).not.toContain(secret);
  });
});
