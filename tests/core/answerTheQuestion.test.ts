import { resolve } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { answerInstructions } from "../../src/core/answers/prompt";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import type { Language } from "../../src/core/language";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { type ModelCall, promptOf, type ScriptedReply, scriptedModel } from "../helpers/models";
import { paragraph, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

/**
 * An Answer is about the Question asked, through the core's public
 * interface: the example's Answer, written in advance, isn't the model's own
 * earlier turn, so a Question about the User's own Documents is answered
 * without a word about it. What the model is sent, and what the User sees.
 */

const EXAMPLES = resolve(__dirname, "../../resources/examples");

interface Walk {
  system: string;
  own: { name: string; text: string }[];
  ownQuestion: string;
  bothQuestion: string;
  wordQuestion: string;
  contract: string[];
  reconciled: string;
  plain: string;
}

const WALKS: Record<Language, Walk> = {
  en: {
    system: "en-US",
    own: [
      {
        name: "Harbour lease.md",
        text: "The lease for the Harbour Road flat ends on 30 June 2027. Rent is 1,450 pounds a month.",
      },
      {
        name: "Contents insurance.md",
        text: "The flat's contents insurance renews on 1 March each year and covers 20,000 pounds.",
      },
    ],
    ownQuestion: "When does my lease end?",
    bothQuestion: "Summarise the two main documents.",
    wordQuestion: "What is the liability cap?",
    contract: [
      "Supply agreement",
      "Each party's total liability is capped at the fees paid in the twelve months before the claim.",
    ],
    reconciled: "Please disregard my first answer: it was about a different agreement.",
    plain: "It is in your own file.",
  },
  "zh-CN": {
    system: "zh-CN",
    own: [
      {
        name: "海港租约.md",
        text: "海港路公寓的租约于 2027 年 6 月 30 日到期。月租为 1,450 英镑。",
      },
      { name: "家财保险.md", text: "公寓的家财保险每年 3 月 1 日续保，保额为 20,000 英镑。" },
    ],
    ownQuestion: "我的租约什么时候到期？",
    bothQuestion: "总结一下两份主要文档。",
    wordQuestion: "赔偿责任的上限是多少？",
    contract: ["供货协议", "每一方的赔偿责任以索赔前十二个月内已付的费用为限。"],
    reconciled: "请忽略我之前的回答：它讲的是另一份协议。",
    plain: "答案就在你自己的文件里。",
  },
};

function sentSince(model: MockLanguageModelV4, seen: number) {
  const requests = model.doStreamCalls.slice(seen).map((_, index) => promptOf(model, seen + index));
  return {
    instructions: requests.map((prompt) =>
      prompt
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .join("\n"),
    ),
    history: requests.map((prompt) => prompt.filter((message) => message.role !== "system")),
  };
}

async function setUp(language: Language, script?: (call: ModelCall, walk: Walk) => ScriptedReply) {
  const walk = WALKS[language];
  const ready = EXAMPLE_SETS.credit[language].ready;
  if (!ready) throw new Error("The credit example has no ready Question.");
  // Reads the example's Question in what it is sent, and goes back to it.
  const model = scriptedModel(
    (call) =>
      script?.(call, walk) ?? {
        text: call.prompt.includes(ready.question) ? walk.reconciled : walk.plain,
      },
  );
  const core = startCore(await createTempDataFolder(), {
    paths: { dataDir: await createTempDataFolder(), examples: EXAMPLES },
    systemLanguages: () => [walk.system],
    createChatModel: () => model,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const made = await core.offerExamples();
  const asked = await vi.waitFor(() => core.askReadyQuestion(), { timeout: 20_000, interval: 100 });
  return { walk, ready, core, model, made, conversationId: asked.conversationId };
}

async function askFrom(
  core: Core,
  model: MockLanguageModelV4,
  conversationId: string,
  mindId: string,
  text: string,
) {
  const seen = model.doStreamCalls.length;
  const answer = await askAssistant(core, { conversationId, mindId, text });
  return { answer, ...sentSince(model, seen) };
}

function expectOnlyTheQuestionAsked(
  sent: ReturnType<typeof sentSince>,
  ready: { question: string; answer: string },
) {
  expect(sent.history.length).toBeGreaterThan(0);
  for (const messages of sent.history) {
    const text = messages.map((message) => message.text).join("\n");
    expect(text).not.toContain(ready.question);
    expect(text).not.toContain(ready.answer.slice(0, 16));
  }
  for (const instructions of sent.instructions) {
    expect(instructions).toContain(answerInstructions());
    expect(instructions).toContain("Answer the Question asked.");
    expect(instructions).toContain("never tell the User to disregard an earlier Answer");
  }
}

for (const language of ["en", "zh-CN"] as const) {
  describe(`After the example's Answer, in ${language === "en" ? "English" : "Chinese"}`, {
    timeout: 60_000,
  }, () => {
    // protects=the example's written-in-advance Question and Answer stay on the User's screen but never reach the model, so nothing in an Answer to their own Question, a two-document summary or a Question about an imported Word file reconciles with them; fails_when=the model is sent the example's turn, or the instructions lack the line; no_claim=how a real model follows the line, which the hand test and the everyday-requests eval cover.
    test("a Question about the User's own Documents, a summary of two and a Word import read no earlier Answer", async () => {
      const { walk, ready, core, model, conversationId } = await setUp(language);
      const sources = await createSourceFolder();
      await addAndProcess(
        core,
        await Promise.all(walk.own.map((file) => writeSourceFile(sources, file.name, file.text))),
      );
      const ownMind = await core.createMind({ title: "My flat" });

      const own = await askFrom(core, model, conversationId, ownMind.id, walk.ownQuestion);
      expectOnlyTheQuestionAsked(own, ready);
      expect(own.history.map((messages) => messages.map((message) => message.role))).toEqual(
        own.history.map(() => ["user"]),
      );
      expect(own.answer.text).toBe(walk.plain);

      const both = await askFrom(core, model, conversationId, ownMind.id, walk.bothQuestion);
      expectOnlyTheQuestionAsked(both, ready);
      expect(both.history.at(-1)?.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      expect(both.answer.text).toBe(walk.plain);

      const [title = "", ...body] = walk.contract;
      const word = await importWordBytes(
        core,
        await createSourceFolder(),
        wordFile({
          body: [paragraph(title, { style: "Title" }), ...body.map((each) => paragraph(each))].join(
            "",
          ),
        }),
        { origin: "own", addOriginal: true },
      );
      const imported = await askFrom(core, model, conversationId, word.mindId, walk.wordQuestion);
      expectOnlyTheQuestionAsked(imported, ready);
      expect(imported.answer.text).toBe(walk.plain);

      const { messages } = await core.getConversation(conversationId);
      expect(messages.map((message) => message.kind)).toEqual([
        "question",
        "answer",
        "question",
        "answer",
        "question",
        "answer",
        "question",
        "answer",
      ]);
      expect(messages[0]).toMatchObject({ kind: "question", text: ready.question });
      expect(messages[1]).toMatchObject({
        kind: "answer",
        text: ready.answer,
        steps: expect.objectContaining({ example: true }),
      });
    });

    // protects=asked from the example's own Mind about the User's own Document, the model is told the page and its Documents are the example's, so a model that would contrast them says nothing of the example; from another Mind it isn't told; fails_when=the note is missing, names other Documents, or goes with a Question from another Mind; no_claim=how a real model follows it (eval/everyday).
    test("asked from the example's own Mind about the User's own file, the Answer says nothing of the example", async () => {
      const contrasted =
        language === "en" ? "It has nothing to do with Northwind." : "这与 Northwind 无关。";
      const { walk, core, model, made, conversationId } = await setUp(language, (call, walk) => ({
        text: call.system.includes("is an example IncarnaMind made") ? walk.plain : contrasted,
      }));
      if (!made?.mindId) throw new Error("The example Mind wasn't made.");
      const sources = await createSourceFolder();
      await addAndProcess(
        core,
        await Promise.all(walk.own.map((file) => writeSourceFile(sources, file.name, file.text))),
      );

      const inExample = await askFrom(core, model, conversationId, made.mindId, walk.ownQuestion);

      expect(inExample.answer.text).toBe(walk.plain);
      const exampleDocuments = [
        ...new Set(EXAMPLE_SETS.credit[language].quotes.map((quote) => quote.document)),
      ];
      for (const instructions of inExample.instructions) {
        for (const name of exampleDocuments) expect(instructions).toContain(`"${name}"`);
        for (const file of walk.own) {
          expect(instructions).not.toContain(`"${file.name.replace(/\.md$/, "")}"`);
        }
      }
      const ownMind = await core.createMind({ title: "My flat" });
      const elsewhere = await askFrom(core, model, conversationId, ownMind.id, walk.ownQuestion);
      for (const instructions of elsewhere.instructions) {
        expect(instructions).not.toContain("is an example IncarnaMind made");
      }
    });

    // protects=asked from the example's own Mind, a Question still follows the example's Question and Answer, so "where is that?" can be answered; fails_when=the example's turn is left out where it was asked; no_claim=none beyond protects.
    test("asked from the example's own Mind, it follows the example's Question and Answer", async () => {
      const { ready, core, model, made, conversationId } = await setUp(language);

      if (!made?.mindId) throw new Error("The example Mind wasn't made.");
      const sent = await askFrom(core, model, conversationId, made.mindId, "Which page?");

      const [messages = []] = sent.history;
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(messages[0]?.text).toContain(ready.question);
      expect(messages[1]?.text).toContain(ready.answer.slice(0, 16));
    });
  });
}
