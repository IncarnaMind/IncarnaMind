import { writeFileSync } from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  stepCountIs,
  type ToolSet,
  tool,
} from "ai";
import type { Core } from "../../src/core";
import { costOf, inCurrency } from "../../src/core/cost/price";
import { catalogModel, modelsProviderOfKind } from "../../src/core/providers/catalog";
import { withCacheBreakpoints } from "../../src/core/providers/promptCache";
import { legacyAgentClient } from "../../tests/helpers/agentClients";
import type { ChatSettings } from "./config";

type Setup = { chat: Pick<ChatSettings, "kind" | "modelId" | "apiKey"> };
const AGENT_REQUEST_TIMEOUT_MS = 180_000;

export interface AgentCall {
  step: number;
  name: string;
  args: unknown;
  refused: string | null;
  result: unknown;
}

export interface AgentRequest {
  status: number | null;
  error: string | null;
  ms: number;
}

/** What a connected agent's requests cost, in US dollars, at the chat model's price. */
export function agentUsd(setup: Setup): (usage: LanguageModelUsage) => number {
  const price = catalogModel(modelsProviderOfKind(setup.chat.kind), setup.chat.modelId)?.price;
  if (!price) throw new Error(`No price for ${setup.chat.modelId}.`);
  return (usage) =>
    inCurrency(
      costOf(
        {
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
        price,
        new Date(),
        { cacheWrites: true },
      ),
      price.currency,
      "USD",
    );
}

/**
 * An agent connected to one Folder, on the chat model, as a terminal agent is: IncarnaMind's
 * instructions in its system prompt and its Tools over the connection. Each Tool call is kept.
 */
export async function agentSession(
  core: Core,
  setup: Setup,
  usd: (usage: LanguageModelUsage) => number,
  name: string,
  folderId: string,
  firstRequest: string | null,
) {
  const requests: AgentRequest[] = [];
  let firstWritten = firstRequest === null;
  const watchedFetch: typeof fetch = async (input, init) => {
    if (!firstWritten && firstRequest && typeof init?.body === "string") {
      firstWritten = true;
      writeFileSync(firstRequest, init.body);
    }
    const started = Date.now();
    const timeout = AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await fetch(input, { ...init, signal });
      requests.push({ status: response.status, error: null, ms: Date.now() - started });
      return response;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      requests.push({ status: null, error: message.slice(0, 200), ms: Date.now() - started });
      throw error;
    }
  };
  const model = withCacheBreakpoints(
    createAnthropic({ apiKey: setup.chat.apiKey ?? "", fetch: watchedFetch })(setup.chat.modelId),
  );
  const { pairing, launch } = await core.connectAgent({
    name,
    folderIds: [folderId],
    propose: true,
  });
  const agent = await legacyAgentClient(launch);
  const calls: AgentCall[] = [];
  let step = 0;
  /** The agent's turn after `messages`, until it ends or passes US$0.25. */
  const converse = async (messages: ModelMessage[]) => {
    const listed = await agent.listTools();
    const tools = Object.fromEntries(
      listed.tools.map((each) => [
        each.name,
        tool({
          description: each.description ?? "",
          inputSchema: jsonSchema(each.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (args: unknown) => {
            const result = await agent.callTool({
              name: each.name,
              arguments: args as Record<string, unknown>,
            });
            if (result.isError !== true) {
              calls.push({
                step,
                name: each.name,
                args,
                refused: null,
                result: result.structuredContent,
              });
              return result.structuredContent;
            }
            const why = (result.content as { text?: string }[])[0]?.text ?? "";
            calls.push({ step, name: each.name, args, refused: why, result: null });
            return { refused: why };
          },
        }),
      ]),
    );
    const overCap: StopCondition<ToolSet> = ({ steps }) =>
      steps.reduce((total, each) => total + usd(each.usage), 0) > 0.25;
    const done = await generateText({
      model,
      system: [
        "You are an assistant working for the user in a terminal. A connected app, IncarnaMind, gives you the tools below.",
        agent.getInstructions() ?? "",
      ].join("\n\n"),
      messages,
      tools,
      stopWhen: [stepCountIs(60), overCap],
      maxRetries: 0,
      onStepFinish: () => {
        step++;
      },
    });
    return {
      done,
      tools: listed.tools,
      cost: done.steps.reduce((total, each) => total + usd(each.usage), 0),
    };
  };
  return {
    agent,
    calls,
    requests,
    converse,
    refusals: () =>
      calls.filter((each) => each.refused !== null).map((each) => `${each.name}: ${each.refused}`),
    // Every step of the clean-up is tried.
    close: async () => {
      await Promise.allSettled([agent.close(), core.disconnectAgent(pairing.id)]);
    },
  };
}
