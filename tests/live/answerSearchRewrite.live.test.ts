/**
 * The Answer's small calls (#1586) against the real models whose catalog gives
 * them both the Answers and the quick-tasks job: a model that takes no Tools
 * searches for its Question rewritten, and translated into the other
 * Documents' language, by the model that writes the Answer. Twenty follow-up
 * Questions, ten in English and ten in Chinese, are asked through the core as
 * the app does, and none may come back with an empty rewrite or translation.
 *
 * Only the small calls and the search are real: the model refuses Tools, as
 * the models that take none do, and writes a canned Answer, so no Document
 * text is sent and a run costs a few cents. Each model runs only with its key
 * in the environment (INCARNAMIND_LIVE_KIMI_KEY, International endpoint;
 * INCARNAMIND_LIVE_ANTHROPIC_KEY) and makes no request without one.
 * INCARNAMIND_LIVE_REPORT keeps each call's outcome.
 */
import { appendFile } from "node:fs/promises";
import { APICallError, wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { ChatModelFactory, ChatProviderKind } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core";
import {
  SEARCH_QUERY_INSTRUCTIONS,
  TRANSLATE_QUERY_INSTRUCTIONS,
} from "../../src/core/answers/prompt";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, question, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

interface SmallCall {
  thinking: unknown;
  length: number;
  finish: string;
  input: number;
  output: number;
}

const LIVE: {
  name: string;
  kind: ChatProviderKind;
  endpoint?: string;
  apiKey: string | undefined;
}[] = [
  {
    name: "Kimi K2.6",
    kind: "kimi",
    endpoint: "intl",
    apiKey: process.env.INCARNAMIND_LIVE_KIMI_KEY,
  },
  {
    name: "Claude Haiku 5.5",
    kind: "anthropic",
    apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
  },
];

/** Where a follow-up Question stands, and the Question that leans on it. */
const FOLLOW_UPS = [
  [
    "Urban heat islands are cities that stay warmer than the land around them.",
    "How do they change at night?",
  ],
  ["Spring tides come near the new and the full Moon.", "Why does that happen?"],
  ["The courier contract renews in February.", "What would it cost to leave it?"],
  ["Subscribers rose to 9,420 in September, up from 8,100 in August.", "Is that growth steady?"],
  ["Neap tides come at the quarter Moons.", "How big is the difference?"],
  ["The decaf launch waits on a cash-flow forecast.", "Who has to approve it?"],
  ["Parks lower the air temperature of the streets around them.", "By how many degrees?"],
  [
    "The lease ends in March and the landlord has asked for a longer term.",
    "What did the board say about it?",
  ],
  ["Customers asked for a decaf option more than any other change.", "And the second most?"],
  ["Roasting dates are printed on every bag.", "Does that explain why they subscribe?"],
  ["城市热岛效应在夜间最强，公园可以降低周边的气温。", "它们为什么会这样？"],
  ["春潮出现在朔望前后，小潮出现在上下弦。", "两者的潮差差多少？"],
  ["快递合同二月到期，目前的快递公司有百分之十二的订单延误。", "续约要多少钱？"],
  ["九月订阅用户增加到九千四百二十人。", "这个增长稳定吗？"],
  ["无咖啡因产品的上市要等首席财务官的现金流预测。", "谁来批准？"],
  ["董事会在三月讨论了租约，房东要求更长的租期。", "他们最后怎么决定的？"],
  ["多数客户说烘焙日期是他们订阅的原因。", "还有别的原因吗？"],
  ["有三位客户在八月因配送延误取消了订阅。", "他们后来回来了吗？"],
  ["公园和树木能让街区降温。", "对老年人有什么影响？"],
  ["供应风险包括原料涨价、运输延误和供应商破产三项。", "其中最大的一项是什么？"],
] as const;

const DOCUMENTS = {
  "Harbour notes.md":
    "# Harbour notes\n\nSpring tides come twice a month, near the new and the full Moon.\nNeap tides come at the quarter Moons, when the range is smallest.",
  "港口笔记.md": "# 港口笔记\n\n春潮每月出现两次，在朔望前后。\n小潮出现在上下弦，潮差最小。",
};

/** The real model for the small calls, recorded; with no Tools, and a canned Answer. */
function liveModels(small: SmallCall[]): ChatModelFactory {
  return (spec) => {
    const canned = scriptedModel(() => ({
      text: JSON.stringify({ answer: "Noted.", citations: [] }),
    }));
    return wrapLanguageModel({
      model: createAiSdkChatModel(spec),
      middleware: {
        specificationVersion: "v4",
        wrapStream: async ({ params }) => {
          if (params.tools?.length) {
            throw new APICallError({
              message: "this model does not support tools",
              url: "https://example.invalid",
              requestBodyValues: {},
              statusCode: 400,
              isRetryable: false,
            });
          }
          return canned.doStream(params);
        },
        wrapGenerate: async ({ doGenerate, params }) => {
          const result = await doGenerate();
          const system = params.prompt.find((each) => each.role === "system")?.content;
          if (system !== SEARCH_QUERY_INSTRUCTIONS && system !== TRANSLATE_QUERY_INSTRUCTIONS) {
            return result;
          }
          const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
          small.push({
            thinking: spec.thinking,
            length: text.join("").trim().length,
            finish: result.finishReason.unified,
            input: result.usage.inputTokens.total ?? 0,
            output: result.usage.outputTokens.total ?? 0,
          });
          return result;
        },
      },
    });
  };
}

describe.each(LIVE)("$name, live", ({ name, kind, endpoint, apiKey }) => {
  test.skipIf(apiKey === undefined)(
    "gives a rewrite and a translation for every one of 20 Questions, with thinking off",
    { timeout: 1_800_000 },
    async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const small: SmallCall[] = [];
      const core = startCore(await createTempDataFolder(), { createChatModel: liveModels(small) });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      const catalog = catalogProvider(kind);
      const modelId = catalog?.roles.answers ?? "";
      expect(catalog?.roles.quickTasks).toBe(modelId);
      const saved = await core.saveChatProvider({
        kind,
        apiKey: apiKey ?? "",
        modelId,
        ...(endpoint && { endpoint }),
      });
      if (saved.service) await core.allowDataFlow("chat", saved.service.id);
      const sources = await createTempDataFolder();
      await addAndProcess(
        core,
        await Promise.all(
          Object.entries(DOCUMENTS).map(([file, text]) => writeSourceFile(sources, file, text)),
        ),
      );
      const searched = new Map<string, string[]>();
      core.on("answer.toolCallStarted", ({ answerId, call }) => {
        searched.set(answerId, [...(searched.get(answerId) ?? []), String(call.input.query)]);
      });

      const outcomes: string[] = [];
      const searchedFor: [string, string[]][] = [];
      for (const [context, asked] of FOLLOW_UPS) {
        const mind = await core.createMind({ title: "Follow-up" });
        const client = await connectToMind(core, mind.id);
        const block = question(asked);
        writeMind(client, [note(context), block]);
        await client.settled();
        const result = await core.askQuestion({ mindId: mind.id, questionId: block.attrs.id });
        if (!result.asked) throw new Error("Not asked.");
        const ended = await answerEnded(core, result.answerId);
        if (ended.event !== "finished") throw new Error("The Answer failed.");
        const queries = searched.get(result.answerId) ?? [];
        outcomes.push(`${asked} -> ${queries.join(" | ")}`);
        searchedFor.push([asked, queries]);
      }

      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(
          process.env.INCARNAMIND_LIVE_REPORT,
          `## ${name}\n${JSON.stringify(small)}\n${outcomes.join("\n")}\n\n`,
        );
      }
      const logged = errors.mock.calls.map((each) => String(each[0]));
      errors.mockRestore();
      expect(logged).toEqual([]);
      expect(searchedFor.filter(([, queries]) => queries.length !== 2)).toEqual([]);
      expect(small).toHaveLength(2 * FOLLOW_UPS.length);
      for (const each of small) {
        expect(each.thinking).toBe("off");
        expect(each.finish).not.toBe("length");
        expect(each.length).toBeGreaterThan(0);
      }
    },
  );
});
