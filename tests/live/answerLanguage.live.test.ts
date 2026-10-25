/**
 * The language of Answers and their quotes against real models (#892). A model
 * runs only when its key is in the environment, so `npx vitest run` makes no
 * request without one.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_OPENAI_KEY      OpenAI (INCARNAMIND_LIVE_OPENAI_MODEL, its quick-tasks model by default)
 *   INCARNAMIND_LIVE_REPORT          a file to keep what each model wrote
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test } from "vitest";
import { type ChatProviderKind, CITATION_NODE, type Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const PRICING = {
  name: "定价说明.md",
  contents: [
    "# 定价说明",
    "",
    "标准版每位用户每月收费 20 美元，按年付费可享受八折优惠。企业版需要联系销售人员报价。",
    "",
    "所有套餐都包含无限量的文档存储，但每月的模型调用次数有上限。",
  ].join("\n"),
};
const PAPER = {
  name: "Attention.md",
  contents: [
    "# Attention Is All You Need",
    "",
    "On the WMT 2014 English-to-German translation task, the big transformer model outperforms the best previously reported models by more than 2.0 BLEU, establishing a new state-of-the-art BLEU score of 28.4.",
    "",
    "We trained the base models for a total of 100,000 steps or 12 hours, on one machine with 8 NVIDIA P100 GPUs.",
  ].join("\n"),
};
const GRADIENT = {
  name: "梯度下降.md",
  contents:
    "# 梯度下降\n\n梯度下降法是一种一阶迭代优化算法，用于寻找可微函数的局部最小值。每一步都沿着当前点梯度的反方向移动。",
};

const QUOTE = /[“"「]([^”"」]{12,})[”"」]/gu;

/** Which language an Answer is written in, by what most of its words outside quotation marks are in. */
const languageOf = (text: string) => {
  const own = text.replace(QUOTE, " ").replace(/\[\^\d+\]/g, " ");
  const han = own.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = own.match(/\p{Script=Latin}{2,}/gu)?.length ?? 0;
  return han > words ? "zh-CN" : "en";
};

const quotedIn = (text: string) => [...text.matchAll(QUOTE)].map((match) => match[1] as string);

interface Case {
  name: string;
  documents: { name: string; contents: string }[];
  question: string;
  interfaceLanguage: "en" | "zh-CN";
  expected: "en" | "zh-CN";
  quotesFound?: boolean;
}

const CASES: Case[] = [
  {
    name: "a short English Question over one Chinese Document",
    documents: [PRICING],
    question: "Summarise our pricing tiers",
    interfaceLanguage: "en",
    expected: "en",
  },
  {
    name: "a short English Question over Chinese and English Documents, with the interface in Chinese",
    documents: [PRICING, PAPER],
    question: "Compare the plans",
    interfaceLanguage: "zh-CN",
    expected: "en",
  },
  {
    name: "an English Question over one Chinese Document",
    documents: [PRICING],
    question: "Which of my documents mention pricing?",
    interfaceLanguage: "en",
    expected: "en",
  },
  {
    name: "an English Question over Chinese and English Documents",
    documents: [PRICING, PAPER],
    question: "What did the big transformer score on the English-to-German task?",
    interfaceLanguage: "en",
    expected: "en",
  },
  {
    name: "a Chinese Question over English Documents, quoting the paper",
    documents: [PAPER],
    question: "大模型在英德翻译任务上得了多少 BLEU？请引用论文的原话。",
    interfaceLanguage: "en",
    expected: "zh-CN",
    quotesFound: true,
  },
  {
    name: "a Question that is only a Chinese Document's name, with the interface in English",
    documents: [GRADIENT, PAPER],
    question: "梯度下降",
    interfaceLanguage: "en",
    expected: "en",
  },
  {
    name: "a Question that is only a figure, with the interface in Chinese",
    documents: [PAPER, PRICING],
    question: "28.4",
    interfaceLanguage: "zh-CN",
    expected: "zh-CN",
  },
];

interface Live {
  name: string;
  kind: ChatProviderKind;
  apiKey: string | undefined;
  model: string;
}

const LIVE: Live[] = [
  {
    name: "Anthropic",
    kind: "anthropic",
    apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
    model:
      process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
      (catalogProvider("anthropic")?.roles.quickTasks as string),
  },
  {
    name: "OpenAI",
    kind: "openai",
    apiKey: process.env.INCARNAMIND_LIVE_OPENAI_KEY,
    model:
      process.env.INCARNAMIND_LIVE_OPENAI_MODEL ??
      (catalogProvider("openai")?.roles.quickTasks as string),
  },
];

async function ask(core: Core, text: string, mindId: string) {
  const result = await core.askInConversation({ conversationId: null, text, mindId });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

function checksIn(blocks: readonly { type?: string; content?: unknown[] }[]) {
  const checks: string[] = [];
  const visit = (node: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (node.type === CITATION_NODE) checks.push(String(node.attrs?.check));
    for (const child of (node.content ?? []) as (typeof node)[]) visit(child);
  };
  for (const block of blocks) visit(block);
  return checks;
}

describe.each(LIVE)("Answer language, live: $name", (live) => {
  describe.skipIf(live.apiKey === undefined)("with its key", { timeout: 300_000 }, () => {
    test.each(CASES)("$name", async (each) => {
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.updateSettings({ user: { language: each.interfaceLanguage } });
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      await addAndProcess(
        core,
        await Promise.all(
          each.documents.map((file) => writeSourceFile(sources, file.name, file.contents)),
        ),
      );
      const mind = await core.createMind({ title: "Notes" });

      const answer = await ask(core, each.question, mind.id);
      const checks = checksIn(answerBlocks(answer) as never);
      const line = `- ${live.model}: ${each.name}: ${answer.status}, Citations ${checks.join(" ") || "none"}\n  ${answer.text.replace(/\n+/g, " ")}`;
      const report = process.env.INCARNAMIND_LIVE_REPORT;
      if (report) onTestFinished(() => appendFile(report, `${line}\n`));

      expect(answer.status, answer.errorMessage ?? "").toBe("done");
      expect(languageOf(answer.text), line).toBe(each.expected);
      if (each.quotesFound) {
        // The paper is in English: a quote in Chinese is a translation.
        expect(
          quotedIn(answer.text).filter((quote) => languageOf(quote) !== "en"),
          line,
        ).toEqual([]);
        expect(
          checks.filter((check) => check !== "found"),
          line,
        ).toEqual([]);
      }
    });
  });
});
