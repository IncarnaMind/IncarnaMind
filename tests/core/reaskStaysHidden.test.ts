import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * When the app asks the model again inside one turn, the User never reads the
 * first try (#1226): the model is told so, and what the User reads is the
 * reply to the ask alone, whatever it says of the try before it. The model's
 * choices are scripted.
 */

const UNSEEN = "The User will not read your earlier reply";
const AS_NEW = "Write your reply as if for the first time";

const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

async function setUp(model: MockLanguageModelV4, title: string) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(2, "Summary"), note("The quarter was very good.")]);
  await client.settled();
  return { core, mind };
}

const LANGUAGES = [
  {
    language: "English",
    title: "Q3 review",
    request: "write a summary page",
    panel: "Summary: the paper is about tides.",
    claim: "I've added a Summary section to “Q3 review”.",
    sorry: "Sorry, my previous reply didn't actually write the page.",
    done: "It covers the paper.",
    risks: "what are the risks?",
    tea: {
      question: "Where was tea first drunk?",
      answer: "Tea was first drunk in southwest China [^1].",
    },
  },
  {
    language: "Chinese",
    title: "周报",
    request: "写一个总结页面",
    panel: "总结：这篇论文讲的是潮汐。",
    claim: "我已经在“周报”里添加了总结部分。",
    sorry: "抱歉，上一条回复没有实际写入笔记。",
    done: "页面写好了，讲的是这篇论文。",
    risks: "风险是什么？",
    tea: { question: "茶最早是在哪里喝的？", answer: "茶最早在中国西南地区被当作药饮[^1]。" },
  },
] as const;

describe("The ask for a reply that claims a change", { timeout: 30_000 }, () => {
  // protects=a reply claiming a change no Tool made is asked again with the instruction that the User never reads that reply and the new one is to be written as for the first time, in English and Chinese, and the User reads only the second; fails_when=the instruction is missing from the ask, or the claim shows; no_claim=that a real model heeds it, which the everyday-requests evaluation checks.
  test.each(LANGUAGES)("$language: the model is told the first try is never read", async (each) => {
    let told = "";
    const reply = "No section was added. Say if you'd like one.";
    const model = scriptedModel((call): ScriptedReply => {
      if (!asked(call).includes("but no Tool did that")) return { text: each.claim };
      told = asked(call);
      return { text: reply };
    });
    const { core, mind } = await setUp(model, each.title);
    const shown: string[] = [];
    core.on("answer.delta", (event) => shown.push(event.text));

    const answer = await askAssistant(core, { text: each.risks, mindId: mind.id });

    expect(told).toContain(UNSEEN);
    expect(told).toContain(AS_NEW);
    expect(shown.join("")).not.toContain(each.claim);
    expect(answer.text).toBe(reply);
  });
});

describe("The one request for Citations", { timeout: 30_000 }, () => {
  const TEA = {
    name: "Tea history.md",
    contents:
      "# Tea history\n\nTea drinking began in southwest China, where it was first used as a medicinal drink.\n",
  };
  // protects=the request for Citations is made on its own, holding no earlier reply of the model's, so what it says to it never reaches the Answer, even an apology; fails_when=the ask holds an assistant message, or the apology shows; no_claim=none beyond protects.
  test.each(LANGUAGES)(
    "$language: it holds no earlier reply, and a reply that apologises never reaches the Answer",
    async ({ tea, sorry }) => {
      const asks: ModelCall[] = [];
      const model = scriptedModel((call): ScriptedReply => {
        if (call.json) {
          asks.push(call);
          return { text: sorry };
        }
        if (!call.results.some((result) => result.tool === "search_documents")) {
          return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
        }
        return { text: tea.answer };
      });
      const { core } = await setUpWithDocuments(model, [TEA]);

      const answer = await askAssistant(core, { text: tea.question });

      expect(asks).toHaveLength(1);
      expect(asks[0]?.options.prompt.some((message) => message.role === "assistant")).toBe(false);
      expect(answer.text).toBe(tea.answer.replace(/ ?\[\^1\]/, ""));
      expect(answer.text).not.toContain(sorry);
    },
  );
});
