/**
 * A sentence an Answer in the assistant leaves uncited is judged with its cited ones, against the
 * Passages the Answer read (#3410): one they don't back is marked where it stands, and one a
 * Passage states gets that Passage's Citation, found by the check, only where the model names the
 * words and the check finds them. Code never cites one by its words, and in a Note nothing is
 * added: the Note's own check reads it there.
 */
import { describe, expect, test, vi } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { askAndFinish, citationsIn, setUpWithDocuments } from "../helpers/citations";
import { type GenerateCall, judgesNothing, scriptedModel } from "../helpers/models";

const TEXTS = {
  en: {
    name: "Pellow Street Lease.md",
    repair:
      "The Landlord must repair the roof and the external walls within 30 days of written notice from the Tenant.",
    deposit: "The deposit of £4,800 is returned to the Tenant within 14 days after the lease ends.",
    wrong: "The Tenant must repair the roof and the external walls within 30 days.",
    backed: "The deposit is paid back to the Tenant within two weeks of the lease ending.",
    opinion: "Here is the note for the client.",
    query: "repairs deposit",
    question: "What does the lease say about repairs and the deposit?",
    says: "The Landlord, not the Tenant, must repair the roof and external walls.",
  },
  zh: {
    name: "青禾路商铺租赁合同.md",
    repair: "出租人应在收到承租人书面通知后30日内修复屋顶和外墙。",
    deposit: "租赁期满后14日内，出租人应将押金4800元退还承租人。",
    wrong: "承租人应在30日内修复屋顶和外墙。",
    backed: "租期结束两周内押金会退给承租人。",
    opinion: "以下是给客户的说明。",
    query: "修复 押金",
    question: "合同关于维修和押金怎么规定？",
    says: "修复屋顶和外墙的是出租人，不是承租人。",
  },
} as const;

type Language = keyof typeof TEXTS;

/**
 * The batch's verdicts: the wrong sentence contradicted, the backed one supported by the deposit
 * clause's words, the framing an opinion; a cited sentence supported, as its quote says.
 */
function judging(language: Language) {
  const text = TEXTS[language];
  return (call: GenerateCall) => {
    if (call.question !== "sentence-batch") return judgesNothing(call);
    const entries = [
      ...call.prompt.matchAll(
        /<sentence number="(\d+)"( uncited="true")?>\n([\s\S]*?)\n<\/sentence>/g,
      ),
    ].map(([, number, uncited, sentence = ""]) => {
      const base = { number: Number(number), roles: "same", time: "same", quoted: "states" };
      if (!uncited) return { ...base, kind: "fact", verdict: "supported", says: null };
      if (sentence === text.wrong) {
        return { ...base, kind: "fact", verdict: "contradicted", says: text.says };
      }
      if (sentence === text.backed) {
        return {
          ...base,
          kind: "fact",
          verdict: "supported",
          says: null,
          passage: 1,
          quote: text.deposit,
        };
      }
      return { ...base, kind: "opinion", verdict: "supported", says: null };
    });
    return { text: JSON.stringify({ sentences: entries }) };
  };
}

/** A model that searches once, then writes `answer` and cites nothing. */
function writingModel(language: Language, answer: string) {
  const text = TEXTS[language];
  return scriptedModel(
    (call) => {
      if (call.json) return { text: JSON.stringify({ citations: [] }) };
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: text.query } }] };
      }
      return { text: answer };
    },
    { generate: judging(language) },
  );
}

/** The Answer once its uncited sentences are judged. */
async function judgedUncited(core: Core, conversationId: string, answerId: string) {
  return vi.waitFor(
    async () => {
      const { messages } = await core.getConversation(conversationId);
      const answer = messages.find((message) => message.id === answerId);
      if (answer?.kind !== "answer" || answer.steps?.uncitedChecks === undefined) {
        throw new Error("Its uncited sentences aren't judged yet.");
      }
      return answer;
    },
    { timeout: 20_000, interval: 20 },
  );
}

const answerOf = (language: Language) => {
  const text = TEXTS[language];
  const space = language === "en" ? " " : "";
  return `${text.opinion}${space}${text.wrong}${space}${text.backed}`;
};

describe.each(Object.keys(TEXTS) as Language[])(
  "%s: an uncited sentence in the assistant",
  (language) => {
    const text = TEXTS[language];
    const document = { name: text.name, contents: `${text.repair}\n\n${text.deposit}\n` };

    // protects=in the assistant, an uncited sentence the Passages the Answer read don't back is marked with the judgement's verdict and what the Documents say, a backed one gets the Passage's Citation the check found, after its words and before its stop, and the framing sentence takes neither, in English and Chinese; fails_when=the wrong sentence shows nothing, code cites it by its words, the backed one stays uncited or is cited somewhere else, or the opinion is marked; no_claim=how a real model judges them (eval/uncited).
    test("one the Passages don't back is marked, one they state is cited by the check", {
      timeout: 30_000,
    }, async () => {
      const { core } = await setUpWithDocuments(writingModel(language, answerOf(language)), [
        document,
      ]);
      const asked = await askAssistant(core, { text: text.question });
      const answer: ConversationAnswer = await judgedUncited(core, asked.conversationId, asked.id);

      expect(answer.steps?.readPassages?.length).toBeGreaterThan(0);
      expect(answer.steps?.uncitedChecks).toEqual([
        {
          sentence: text.wrong,
          check: "contradicted",
          verdict: text.says,
          judgedAt: expect.any(String),
        },
      ]);
      expect(answer.citations).toEqual([
        expect.objectContaining({ quote: text.deposit, check: "found", foundByCheck: true }),
      ]);
      const stop = language === "en" ? "." : "。";
      expect(answer.text).toContain(`${text.backed.slice(0, -1)}[^1]${stop}`);
      expect(answer.text).toContain(text.wrong);
      expect(answer.text).not.toContain(`${text.wrong.slice(0, -1)}[^`);
    });

    // protects=asked in a Note, the same uncited sentences get no Citation and no verdict when the Answer ends: the Note's own check reads them; fails_when=code cites one there by its words, or the Answer's judgement runs in a Note; no_claim=Check this Note itself (eval/uncited).
    test("in a Note, nothing is added to them", { timeout: 30_000 }, async () => {
      const { core, client, mind } = await setUpWithDocuments(
        writingModel(language, answerOf(language)),
        [document],
      );
      const { answerId } = await askAndFinish(core, client, mind.id, text.question);
      expect(citationsIn(client, answerId)).toEqual([]);
    });
  },
);
