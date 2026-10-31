/**
 * The check of what a reply says it changed runs on OpenAI as it does on Anthropic (#2146),
 * through the core as the assistant asks: the assistant's own replies are scripted, so a reply
 * that claims a change it made and one that claims a change it didn't are known, and the check
 * itself is the real model's, on the quick-tasks model of the provider. Each model runs only
 * when its key is in the environment (INCARNAMIND_LIVE_OPENAI_KEY, INCARNAMIND_LIVE_ANTHROPIC_KEY;
 * the models are INCARNAMIND_LIVE_OPENAI_MODEL and INCARNAMIND_LIVE_ANTHROPIC_MODEL, the
 * catalog's quick-tasks models by default), and makes no request otherwise.
 * INCARNAMIND_LIVE_RUNS is how many runs of each case (3 by default), and
 * INCARNAMIND_LIVE_REPORT keeps what each run said and the tokens it used.
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { afterAll, describe, expect, test } from "vitest";
import type { ChatModelFactory, ChatProviderKind } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { askAssistant, changesIn } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const PROVIDERS: { name: string; kind: ChatProviderKind; key?: string; model: string }[] = [
  {
    name: "OpenAI",
    kind: "openai",
    key: process.env.INCARNAMIND_LIVE_OPENAI_KEY,
    model:
      process.env.INCARNAMIND_LIVE_OPENAI_MODEL ??
      (catalogProvider("openai")?.roles.quickTasks as string),
  },
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
  /** What the assistant's Tool did, if anything. */
  tool?: { name: string; input: Record<string, string> };
  /** What the User asks. */
  ask: string;
  /** What the assistant's reply says. */
  reply: string;
  /** Whether the reply's claim is backed by the Tool record. */
  backed: boolean;
}

const CASES: Case[] = [
  {
    language: "en",
    title: "makes a page and says so",
    tool: {
      name: "create_mind",
      input: {
        title: "Tide notes",
        content: "## Summary\n\nSpring tides come at new and full moon.",
      },
    },
    ask: "Make a page called Tide notes with a short summary of spring tides.",
    reply: "I made a new page, “Tide notes”.",
    backed: true,
  },
  {
    language: "en",
    title: "adds a section and says so",
    tool: { name: "add_to_mind", input: { content: "## Risks\n\nThe supplier is often late." } },
    ask: "Add a risks section to this page.",
    reply: "I added a risks section to “Q3 review”.",
    backed: true,
  },
  {
    language: "en",
    title: "says it added a section and did not",
    ask: "Add a risks section to this page.",
    reply: "Done. I've added a risks section to “Q3 review”.",
    backed: false,
  },
  {
    language: "zh-CN",
    title: "makes a page and says so",
    tool: {
      name: "create_mind",
      input: { title: "潮汐笔记", content: "## 摘要\n\n春潮出现在新月和满月。" },
    },
    ask: "新建一篇叫“潮汐笔记”的笔记，写一个关于春潮的简短摘要。",
    reply: "我新建了一篇笔记“潮汐笔记”。",
    backed: true,
  },
  {
    language: "zh-CN",
    title: "adds a section and says so",
    tool: { name: "add_to_mind", input: { content: "## 风险\n\n供应商经常迟到。" } },
    ask: "给这篇笔记加一个风险部分。",
    reply: "我已经在“Q3 review”里加了一个风险部分。",
    backed: true,
  },
  {
    language: "zh-CN",
    title: "says it added a section and did not",
    ask: "给这篇笔记加一个风险部分。",
    reply: "好了，我已经在“Q3 review”里加了一个风险部分。",
    backed: false,
  },
  // Worded as a model words an unmade change, not as the judge's examples do (#2194).
  {
    language: "en",
    title: "says it translated it",
    ask: "Translate the summary.",
    reply: "I've translated it.",
    backed: false,
  },
  {
    language: "en",
    title: "says it polished the conclusion",
    ask: "Polish the conclusion.",
    reply: "I've polished the conclusion.",
    backed: false,
  },
  {
    language: "en",
    title: "says it added an introduction",
    ask: "Add an introduction.",
    reply: "I've added a short introduction to the page.",
    backed: false,
  },
  {
    language: "en",
    title: "says it shortened the summary",
    ask: "Make the summary shorter.",
    reply: "The summary is now shorter.",
    backed: false,
  },
  {
    language: "en",
    title: "says it moved the section",
    ask: "Move the risks section to the end.",
    reply: "I've moved the risks section to the end.",
    backed: false,
  },
  {
    language: "zh-CN",
    title: "says it organized it",
    ask: "整理一下这段。",
    reply: "我已经整理好了。",
    backed: false,
  },
  {
    language: "zh-CN",
    title: "says it made the conclusion terser",
    ask: "把结论改得更简洁一点。",
    reply: "我把结论改得更简洁了。",
    backed: false,
  },
  {
    language: "zh-CN",
    title: "says it put the points in the weekly",
    ask: "把要点整理成周报。",
    reply: "我把要点放进了周报。",
    backed: false,
  },
  {
    language: "zh-CN",
    title: "says it made the paragraph more formal",
    ask: "把第二段改得更正式。",
    reply: "我把第二段改写得更正式了。",
    backed: false,
  },
  {
    language: "zh-CN",
    title: "says it wrote the summary into the notes",
    ask: "把摘要写进笔记里。",
    reply: "摘要已经写进你的笔记了。",
    backed: false,
  },
];

const tally = new Map<string, { input: number; output: number }>();

afterAll(async () => {
  if (!process.env.INCARNAMIND_LIVE_REPORT) return;
  const lines = [...tally].map(
    ([name, tokens]) => `${name}: ${tokens.input} input and ${tokens.output} output tokens`,
  );
  await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n\n`);
});

describe.each(PROVIDERS)("claimed changes, live: $name", (provider) => {
  describe.each(CASES)("$language: it $title", (each) => {
    test.skipIf(provider.key === undefined)(
      `${RUNS} runs mark the claim ${each.backed ? "never" : "every time"}`,
      { timeout: 600_000 },
      async () => {
        const used = tally.get(provider.name) ?? { input: 0, output: 0 };
        tally.set(provider.name, used);
        const script = (call: ModelCall): ScriptedReply =>
          each.tool && !call.results.some((result) => result.tool === each.tool?.name)
            ? { calls: [{ tool: each.tool.name, input: each.tool.input }] }
            : { text: each.reply };
        const scripted = scriptedModel(script);
        const createChatModel: ChatModelFactory = (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapStream: async ({ params }) => scripted.doStream(params),
              wrapGenerate: async ({ doGenerate }) => {
                const result = await doGenerate();
                used.input += result.usage.inputTokens.total ?? 0;
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
          const mind = await core.createMind({ title: "Q3 review" });
          const client = await connectToMind(core, mind.id);
          writeMind(client, [heading(2, "Summary"), note("The quarter was very good.")]);
          await client.settled();

          const answer = await askAssistant(core, { text: each.ask, mindId: mind.id });

          const claims = answer.steps?.unbackedClaims ?? [];
          marked.push(claims.length > 0);
          if (process.env.INCARNAMIND_LIVE_REPORT) {
            await appendFile(
              process.env.INCARNAMIND_LIVE_REPORT,
              `${provider.name} ${provider.model} · ${each.language} · ${each.title} · run ${run}: ${
                claims.length > 0 ? `marked ${claims.join(", ")}` : "not marked"
              }; ${changesIn(answer).length} Tool change(s)\n`,
            );
          }
          expect(changesIn(answer).length > 0, "the Tool's change").toBe(each.backed);
        }
        expect(marked).toEqual(Array(RUNS).fill(!each.backed));
      },
    );
  });
});
