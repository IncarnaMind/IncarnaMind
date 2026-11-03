/**
 * The claim check on replies about the assistant's own summary, made longer (#1559, #1431), through
 * the core as the window uses it: the first Answer writes the summary into the empty Note in front
 * and the window applies it, then the follow-up revises it in place. The replies are scripted and
 * known to be backed (or not), and the check itself is the real model's, on the quick-tasks model.
 * Each provider runs only when its key is in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY; the
 * model is INCARNAMIND_LIVE_ANTHROPIC_MODEL), and makes no request otherwise.
 * INCARNAMIND_LIVE_RUNS is how many runs of each case (3 by default).
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { afterAll, describe, expect, test } from "vitest";
import type { ChatModelFactory, ChatProviderKind } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { askAssistant, changesIn } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const PROVIDERS: { name: string; kind: ChatProviderKind; key?: string; model: string }[] = [
  {
    name: "Anthropic",
    kind: "anthropic",
    key: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
    model:
      process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
      (catalogProvider("anthropic")?.roles.quickTasks as string),
  },
];

const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3);

interface Case {
  language: "en" | "zh-CN";
  title: string;
  /** The summary's first line, which names the Note. */
  heading: string;
  first: string;
  second: string;
  /** Whether the second turn's edit_mind runs. */
  edit: boolean;
  /** A first edit_mind of the second turn with this section, which the Note doesn't have. */
  firstAttempt?: string;
  /** The longer text the second turn writes, when it isn't the default; a whole summary, heading first. */
  longer?: string;
  /** What the assistant says after the second turn. */
  reply: string;
  /** Whether the reply's claim is backed by the Tool record. */
  backed: boolean;
}

const CASES: Case[] = [
  {
    language: "zh-CN",
    title: "expanded to four paragraphs, one sentence marked",
    heading: "GraphST 论文简短摘要",
    first: "帮我写一份 GraphST 论文的简短摘要。",
    second: "把摘要写长一点。",
    edit: true,
    longer:
      "## GraphST 论文简短摘要\n\nGraphST 是一种用于时空图学习的模型，学习城市各区域的表示。\n\n它通过多视图对比学习与自适应增强，支持犯罪预测、交通流预测和房价预测三类实验。\n\n在犯罪预测任务上，GraphST 优于所有基线模型。\n\n在交通流预测和房价预测任务上，它也取得了最好的结果。",
    reply:
      "我已把摘要扩写为四段，并加入犯罪、交通和房价三类实验的结果。有一句没能与其引注核对，已在笔记中标出，需要你自己核实。",
    backed: true,
  },
  {
    language: "zh-CN",
    title: "nothing outside it changed, an earlier attempt failed",
    heading: "GraphST 论文简短摘要",
    first: "帮我写一份 GraphST 论文的简短摘要。",
    second: "把摘要写长一点。",
    edit: true,
    firstAttempt: "# [waiting change",
    reply:
      "这次没有改动“GraphST 论文简短摘要”之外的内容。前面一次按标题定位的修改没有生效，所以笔记中没有重复的版本。",
    backed: true,
  },
  {
    language: "zh-CN",
    title: "the rewrite applied, some old text not confirmed removed",
    heading: "GraphST 论文简短摘要",
    first: "帮我写一份 GraphST 论文的简短摘要。",
    second: "把摘要写长一点。",
    edit: true,
    reply:
      "“GraphST 论文简短摘要”的改写已应用，可以用撤销恢复。我没有确认重复的旧段落是否已全部删除，请打开笔记核对。笔记中有一句话的引用不足以支持它，我已标注，需要你自己核对或删去。",
    backed: true,
  },
  {
    language: "en",
    title: "made longer, one sentence marked",
    heading: "Summary of the GraphST paper",
    first: "Write a short summary of the GraphST paper.",
    second: "Make the summary longer.",
    edit: true,
    reply:
      "I made the summary longer, to about four paragraphs. One sentence couldn't be checked, so it's marked in the note for you to verify.",
    backed: true,
  },
  {
    language: "zh-CN",
    title: "says it expanded it and did not",
    heading: "GraphST 论文简短摘要",
    first: "帮我写一份 GraphST 论文的简短摘要。",
    second: "把摘要写长一点。",
    edit: false,
    reply: "我已把摘要扩写为四段，并加入犯罪、交通和房价三类实验的结果。",
    backed: false,
  },
];

interface Used {
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const tally = new Map<string, Used>();

afterAll(async () => {
  if (!process.env.INCARNAMIND_LIVE_REPORT) return;
  const lines = [...tally].map(
    ([name, tokens]) =>
      `${name}: ${tokens.requests} requests, ${tokens.input} input tokens (${tokens.cacheRead} cache reads, ${tokens.cacheWrite} cache writes) and ${tokens.output} output tokens`,
  );
  await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n\n`);
});

const SUMMARY_ZH = "GraphST 是一种面向时空图学习的模型，用于学习城市各区域的表示。";
const LONGER_ZH =
  "GraphST 是一种面向时空图学习的模型，用于学习城市各区域的表示。它通过多视图对比学习与自适应增强，支持犯罪预测、交通流预测和房价预测。";
const SUMMARY_EN =
  "GraphST learns representations of urban regions for crime, traffic and house-price prediction.";
const LONGER_EN =
  "GraphST learns representations of urban regions for crime, traffic and house-price prediction. It uses multi-view contrastive learning and adaptive augmentation, and outperforms its baselines.";

const summaryOf = (each: Case) => (each.language === "zh-CN" ? SUMMARY_ZH : SUMMARY_EN);
const longerOf = (each: Case) => each.longer ?? (each.language === "zh-CN" ? LONGER_ZH : LONGER_EN);

describe.each(PROVIDERS)("the assistant's own summary claims, live: $name", (provider) => {
  describe.each(CASES)("$language: $title", (each) => {
    test.skipIf(provider.key === undefined)(
      `${RUNS} runs ${each.backed ? "leave the claim alone" : "mark the claim"}`,
      { timeout: 600_000 },
      async () => {
        const used = tally.get(provider.name) ?? {
          requests: 0,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
        };
        tally.set(provider.name, used);
        const script = (call: ModelCall): ScriptedReply => {
          const question = askedOf(call);
          if (call.results.length === 0 && question.endsWith(each.first)) {
            return {
              calls: [
                {
                  tool: "add_to_mind",
                  input: { content: `## ${each.heading}\n\n${summaryOf(each)}` },
                },
              ],
            };
          }
          if (call.results.length > 0 && question.endsWith(each.first))
            return { text: "Wrote it." };
          if (each.edit && question.endsWith(each.second)) {
            const edits = call.results.filter((result) => result.tool === "edit_mind");
            if (each.firstAttempt && edits.length === 0) {
              return {
                calls: [
                  {
                    tool: "edit_mind",
                    input: { part: each.firstAttempt, instruction: "Make it longer" },
                  },
                ],
              };
            }
            if (edits.length === (each.firstAttempt ? 1 : 0)) {
              return {
                calls: [
                  {
                    tool: "edit_mind",
                    input: { content: `## ${each.heading}\n\n${longerOf(each)}` },
                  },
                ],
              };
            }
          }
          return { text: each.reply };
        };
        const scripted = scriptedModel(script);
        const createChatModel: ChatModelFactory = (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapStream: async ({ params }) => scripted.doStream(params),
              wrapGenerate: async ({ doGenerate }) => {
                const result = await doGenerate();
                used.requests++;
                used.input += result.usage.inputTokens.total ?? 0;
                used.cacheRead += result.usage.inputTokens.cacheRead ?? 0;
                used.cacheWrite += result.usage.inputTokens.cacheWrite ?? 0;
                used.output += result.usage.outputTokens.total ?? 0;
                return result;
              },
            },
          });
        const marked: boolean[] = [];
        for (let run = 1; run <= RUNS; run++) {
          const core = startCore(await createTempDataFolder(), { createChatModel });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          await core.updateSettings({ user: { language: each.language } });
          await core.saveChatProvider({
            kind: provider.kind,
            apiKey: provider.key ?? "",
            modelId: provider.model,
          });
          const mind = await core.createMind({ title: "" });

          const firstAnswer = await askAssistant(core, {
            text: each.first,
            mindId: mind.id,
          });
          const [change] = changesIn(firstAnswer);
          expect(change, "the first Answer wrote the summary").toBeDefined();
          await core.applyAskedChanges({
            answerId: firstAnswer.id,
            mindId: mind.id,
            requests: change?.request ? [change.request] : [],
          });

          const answer = await askAssistant(core, {
            text: each.second,
            mindId: mind.id,
            conversationId: firstAnswer.conversationId,
          });

          const claims = answer.steps?.unbackedClaims ?? [];
          const commands = answer.steps?.unbackedCommands ?? [];
          const flagged = [...claims, ...commands];
          marked.push(each.backed ? flagged.length > 0 : claims.length > 0);
          if (process.env.INCARNAMIND_LIVE_REPORT) {
            await appendFile(
              process.env.INCARNAMIND_LIVE_REPORT,
              `${provider.name} ${provider.model} · ${each.language} · ${each.title} · run ${run}: ${
                flagged.length > 0 ? `marked ${flagged.join(", ")}` : "not marked"
              }\n`,
            );
          }
          expect(changesIn(answer).length > 0, "the second Answer's change").toBe(each.edit);
        }
        expect(marked).toEqual(Array(RUNS).fill(!each.backed));
      },
    );
  });
});

/** The last user message of a request: the Question it answers. */
function askedOf({ options }: ModelCall): string {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
}
