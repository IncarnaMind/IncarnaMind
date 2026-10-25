import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, test } from "vitest";
import {
  type Decision,
  decide,
  decisionInput,
  forcing,
  readDecision,
} from "../../eval/everyday/decisions";
import type { ChatModelSpec } from "../../src/core";
import { scriptedModel } from "../helpers/models";

/*
 * Arm C of the comparison for #1559, with no network: the two providers'
 * replies are read as one decision, and a confident write or edit forces the
 * chat model to call a Tool until the Answer has called the command.
 */

const decision = (choice: Decision["choice"], confidence: number): Decision => ({
  provider: "jev",
  choice,
  confidence,
  probabilities: {},
  inputTokens: null,
});

describe("A decision provider's reply", () => {
  // protects=OpenAI's answers list and Jev's answers map read as the same decision; fails_when=either shape loses its choice, confidence or probabilities; no_claim=that the providers keep these shapes.
  test("reads the same from OpenAI and Jev", () => {
    expect(
      readDecision("openai", {
        answers: [
          {
            choice: "write",
            confidence: 0.71,
            probabilities: [
              { value: "write", probability: 0.8 },
              { value: "answer", probability: 0.2 },
            ],
          },
        ],
        usage: { input_tokens: 212 },
      }),
    ).toEqual({
      provider: "openai",
      choice: "write",
      confidence: 0.71,
      probabilities: { write: 0.8, answer: 0.2 },
      inputTokens: 212,
    });
    expect(
      readDecision("jev", {
        answers: { route: { choice: "edit", confidence: 0.95, probabilities: { edit: 0.97 } } },
      }),
    ).toEqual({
      provider: "jev",
      choice: "edit",
      confidence: 0.95,
      probabilities: { edit: 0.97 },
      inputTokens: null,
    });
    expect(() => readDecision("jev", { answers: { route: { choice: "maybe" } } })).toThrow();
  });

  // protects=the request goes to the provider's endpoint with the key in the header and the three options; fails_when=it goes elsewhere or loses an option; no_claim=none beyond protects.
  test("is asked for at the provider's endpoint, with the three options", async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const fake: typeof fetch = async (url, init) => {
      sent.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ answers: { route: { choice: "answer", confidence: 0.9 } } }),
      );
    };
    const text = decisionInput({ request: "What does it say?", page: "text", earlier: [] });

    await decide("jev", "test-key", text, fake);

    expect(sent[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(sent[0]?.init?.headers).get("Authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(sent[0]?.init?.body));
    expect(Object.keys(body.questions.route.criteria)).toEqual(["write", "edit", "answer"]);
    expect(body.state).toContain("The page in front already has text.");
  });
});

describe("Forcing the command a decision chose", () => {
  const spec = { kind: "anthropic", modelId: "claude-haiku-5-5" } as ChatModelSpec;
  const offered = ["search_documents", "create_mind", "add_to_mind", "edit_mind"].map((name) => ({
    type: "function" as const,
    name,
    inputSchema: { type: "object" as const },
  }));
  const params = (prompt: LanguageModelV4CallOptions["prompt"]): LanguageModelV4CallOptions => ({
    prompt,
    tools: offered,
    providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
  });
  const user = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Write a summary" }],
  };
  const calledCreate = {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "1", toolName: "create_mind", input: {} }],
  };

  async function sentWith(next: Decision | null, prompts: LanguageModelV4CallOptions["prompt"][]) {
    const inner = scriptedModel(() => ({ text: "Done." }));
    const forced = forcing();
    const model = forced.chatModels(() => inner)(spec) as LanguageModelV4;
    forced.begin(next);
    for (const prompt of prompts) {
      const { stream } = await model.doStream(params(prompt));
      await stream.pipeTo(new WritableStream());
    }
    return { calls: inner.doStreamCalls, forced: forced.end() };
  }

  // protects=a confident write must call a Tool, thinking off on Anthropic, until the Answer called the write command, then it is free; fails_when=it isn't forced, stays forced after the write, or thinking stays on a forced call; no_claim=that a provider accepts the forced call.
  test("a confident write is forced until the command is called", async () => {
    const { calls, forced } = await sentWith(decision("write", 0.9), [
      [user],
      [user, calledCreate],
    ]);

    expect(calls[0]?.toolChoice).toEqual({ type: "required" });
    expect(calls[0]?.providerOptions?.anthropic).not.toHaveProperty("thinking");
    expect(calls[1]?.toolChoice).toBeUndefined();
    expect(forced).toBe(1);
  });

  // protects=below the confidence, for an answer, and with no decision the request goes as it came (arm B); fails_when=any of them is forced; no_claim=none beyond protects.
  test.each([
    ["a write below 0.6", decision("write", 0.59)],
    ["an answer", decision("answer", 0.99)],
    ["no decision", null],
  ])("%s isn't forced", async (_name, next) => {
    const { calls, forced } = await sentWith(next, [[user]]);

    expect(calls[0]?.toolChoice).toBeUndefined();
    expect(forced).toBe(0);
  });
});
