/**
 * Structured output's one request for exact quotes (src/core/answers/quoteRetry.ts):
 * a small local model whose quotes the check doesn't find is asked for them
 * once more, and a new quote counts only when the check finds it. Against a
 * stub of Ollama's API, and, for a cloud model, a scripted one.
 */
import { describe, expect, test } from "vitest";
import type { Core, CoreEvents } from "../../src/core";
import { estimateTokens } from "../../src/core/answers/context";
import { markedSentence } from "../../src/core/answers/markerPlacement";
import { nearestExcerpt, parseCorrections } from "../../src/core/answers/quoteRetry";
import { outputTokens } from "../../src/core/providers/outputLimits";
import { translate } from "../../src/shared/i18n";
import { askAndFinish, setUpWithDocuments } from "../helpers/citations";
import {
  askAndEnd,
  isAnswer,
  messagesOf,
  QWEN35,
  QWEN35_9B,
  setUpLocalModel,
  TIDES,
} from "../helpers/localModels";
import { question, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { type OllamaChatReply, type OllamaServer, startOllamaServer } from "../helpers/ollama";

const SPRING = "Spring tides happen at new moon and at full moon";
const NEAP = "Neap tides happen at the quarter moons";

/** A request for exact quotes, rather than an Answer or tagging. */
const isQuoteRetry = (body: Record<string, unknown>) =>
  messagesOf(body).some(
    (message) => message.role === "system" && message.content.startsWith("You fix the quotes"),
  );

/** The requests for exact quotes the stub got. */
const retries = (ollama: OllamaServer) => ollama.chats.filter((chat) => isQuoteRetry(chat.body));

/** The Answer requests the stub got. */
const answers = (ollama: OllamaServer) => ollama.chats.filter((chat) => isAnswer(chat.body));

/** The text of a request's user message. */
const promptOf = (body: Record<string, unknown>) =>
  messagesOf(body)
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");

/**
 * A stub of a small local model: `answer` for the Answer, `retry` for the
 * request for exact quotes (none: it replies with no JSON), no Tags for tagging.
 */
async function smallModel(answer: object, retry?: object | OllamaChatReply) {
  return startOllamaServer({
    models: [QWEN35],
    reply: (body): OllamaChatReply =>
      isAnswer(body)
        ? { content: JSON.stringify(answer) }
        : isQuoteRetry(body)
          ? retry && "cutOff" in retry
            ? retry
            : { content: retry ? JSON.stringify(retry) : "I can't." }
          : { content: JSON.stringify({ tags: [] }) },
  });
}

/** The phases Answers go through, in order. */
const phasesOf = (core: Core) => {
  const phases: CoreEvents["answer.phase"]["phase"][] = [];
  core.on("answer.phase", ({ phase }) => phases.push(phase));
  return phases;
};

async function ask(ollama: OllamaServer, text = "When are spring tides?") {
  const { core, mind, client } = await setUpLocalModel(ollama, QWEN35.name, {
    documents: [{ name: "Tides.md", contents: TIDES }],
  });
  const phases = phasesOf(core);
  const asked = question(text);
  writeMind(client, [asked]);
  const { ended } = await askAndEnd(core, client, mind.id, asked.attrs.id);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  return { finished: ended.payload, phases };
}

describe("A small local model's quotes the check doesn't find", () => {
  test("are asked for once more, and a reworded quote corrected from its Passage is found", async () => {
    const ollama = await smallModel(
      {
        answer: "Spring tides come at new and full moon [^1].",
        // Reworded: not on the page word for word.
        citations: [{ marker: 1, passage: "P1", quote: "Spring tides come at new and full moon" }],
      },
      { quotes: [{ marker: 1, quote: SPRING }] },
    );

    const { finished, phases } = await ask(ollama);

    expect(answers(ollama)).toHaveLength(1);
    expect(retries(ollama)).toHaveLength(1);
    expect(finished.citations).toMatchObject([{ quote: SPRING, check: "found" }]);
    expect(finished.quoteRetry).toEqual({
      records: 1,
      recovered: 1,
      durationMs: expect.any(Number),
    });
    // The Answer's meta line says so while it asks.
    expect(phases.at(-1)).toBe("checking-quotes");

    // The request: the marker, its sentence, its quote and its Passage's text, held to a JSON
    // schema, with a small output cap.
    const [retry] = retries(ollama);
    const prompt = promptOf(retry?.body ?? {});
    expect(prompt).toContain(
      "[^1] is on this sentence of the Answer: Spring tides come at new and full moon.",
    );
    expect(prompt).toContain(
      'Its quote, not found word for word: "Spring tides come at new and full moon"',
    );
    expect(prompt).toContain('<passage id="P1">');
    expect(prompt).toContain(SPRING);
    expect(prompt).toContain(NEAP);
    expect(retry?.body.format).toMatchObject({ type: "object" });
    expect(retry?.body.options).toMatchObject({ num_predict: outputTokens("quote-retry", 1) });
  });

  // protects=a request for exact quotes cut at its output limit reads nothing: a cut-off quote is never recorded, though its words are on the page; fails_when=the start of a cut reply is taken as a quote and found (#2275).
  test("a reply cut at its limit is read for nothing: the record keeps its own quote", async () => {
    const answer = {
      answer: "Spring tides come at new and full moon [^1].",
      citations: [{ marker: 1, passage: "P1", quote: "Spring tides come at new and full moon" }],
    };
    const cut = await smallModel(answer, {
      content: '{"quotes":[{"marker":1,"quote":"Spring tides happen at new moon',
      cutOff: true,
    });

    const { finished } = await ask(cut);

    expect(retries(cut)).toHaveLength(1);
    expect(finished.citations).toMatchObject([
      { quote: "Spring tides come at new and full moon", check: "not-found" },
    ]);
    expect(finished.quoteRetry).toMatchObject({ records: 1, recovered: 0 });
  });

  test("a new quote the check still doesn't find is dropped: the record keeps its own, not found", async () => {
    const ollama = await smallModel(
      {
        answer: "Spring tides come at new and full moon [^1].",
        citations: [{ marker: 1, passage: "P1", quote: "Spring tides come at new and full moon" }],
      },
      // Stitched from two sentences: on the page in neither order.
      { quotes: [{ marker: 1, quote: `${SPRING}. ${NEAP} too` }] },
    );

    const { finished } = await ask(ollama);

    expect(retries(ollama)).toHaveLength(1);
    expect(finished.citations).toMatchObject([
      {
        quote: "Spring tides come at new and full moon",
        check: "not-found",
        checkReason: "quote-not-on-pages",
      },
    ]);
    expect(finished.quoteRetry).toMatchObject({ records: 1, recovered: 0 });
  });

  test("nothing more is asked when every quote is found", async () => {
    const ollama = await smallModel(
      {
        answer: "Spring tides come at new and full moon [^1].",
        citations: [{ marker: 1, passage: "P1", quote: SPRING }],
      },
      { quotes: [{ marker: 1, quote: SPRING }] },
    );

    const { finished, phases } = await ask(ollama);

    expect(retries(ollama)).toHaveLength(0);
    expect(finished.citations).toMatchObject([{ check: "found" }]);
    expect(finished.quoteRetry).toBeNull();
    expect(phases).not.toContain("checking-quotes");
  });

  test("one request at most, for every record not found and no other", async () => {
    const ollama = await smallModel(
      {
        answer:
          "Spring tides come at new and full moon [^1]. Neap tides come at quarter moons [^2]. They are tides [^3].",
        citations: [
          { marker: 1, passage: "P1", quote: "Spring tides come at new and full moon" },
          { marker: 2, passage: "P1", quote: "Neap tides come at the quarter moons" },
          { marker: 3, passage: "P1", quote: SPRING },
        ],
      },
      {
        quotes: [
          // Still reworded, then right.
          { marker: 1, quote: "Spring tides come at the new moon" },
          { marker: 2, quote: NEAP },
        ],
      },
    );

    const { finished } = await ask(ollama);

    expect(answers(ollama)).toHaveLength(1);
    expect(retries(ollama)).toHaveLength(1);
    const prompt = promptOf(retries(ollama)[0]?.body ?? {});
    expect(prompt).toContain("[^1] is on this sentence");
    expect(prompt).toContain("[^2] is on this sentence");
    expect(prompt).not.toContain("[^3]");
    expect(retries(ollama)[0]?.body.options).toMatchObject({
      num_predict: outputTokens("quote-retry", 2),
    });
    expect(finished.citations).toMatchObject([
      { quote: "Spring tides come at new and full moon", check: "not-found" },
      { quote: NEAP, check: "found" },
      { quote: SPRING, check: "found" },
    ]);
    expect(finished.quoteRetry).toMatchObject({ records: 2, recovered: 1 });
  });

  test("a reply that isn't JSON changes nothing, and the Answer still finishes", async () => {
    const ollama = await smallModel({
      answer: "Spring tides come at new and full moon [^1].",
      citations: [{ marker: 1, passage: "P1", quote: "Spring tides come at new and full moon" }],
    });

    const { finished } = await ask(ollama);

    expect(retries(ollama)).toHaveLength(1);
    expect(finished.citations).toMatchObject([{ check: "not-found" }]);
    expect(finished.quoteRetry).toMatchObject({ records: 1, recovered: 0 });
  });
});

describe("Never asked again", () => {
  test("in the Tool loop: `cite` tells the model there", async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35_9B],
      reply: (body): OllamaChatReply => {
        if (!isAnswer(body)) return { content: JSON.stringify({ tags: [] }) };
        const tools = messagesOf(body).filter((message) => message.role === "tool").length;
        if (tools === 0) {
          return {
            toolCalls: [{ name: "search_documents", arguments: { query: "spring tides" } }],
          };
        }
        if (tools === 1) {
          const citations = [
            { marker: 1, passage: "P1", quote: "Spring tides come at new and full moon" },
          ];
          return { toolCalls: [{ name: "cite", arguments: { citations } }] };
        }
        return { content: "Spring tides come at new and full moon [^1]." };
      },
    });
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35_9B.name, {
      documents: [{ name: "Tides.md", contents: TIDES }],
    });
    const asked = question("When are spring tides?");
    writeMind(client, [asked]);

    const { ended } = await askAndEnd(core, client, mind.id, asked.attrs.id);

    expect(ended.payload).toMatchObject({
      citationSupport: "tools",
      citations: [{ check: "not-found" }],
      quoteRetry: null,
    });
    expect(retries(ollama)).toHaveLength(0);
  });

  test("for a cloud model in structured output", async () => {
    const model = scriptedModel((call) => {
      if (call.tools.length > 0) {
        return { error: { status: 400, message: "This model does not support tools" } };
      }
      return {
        text: JSON.stringify({
          answer: "Spring tides come at new and full moon [^1].",
          citations: [
            { marker: 1, passage: "P1", quote: "Spring tides come at new and full moon" },
          ],
        }),
      };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: TIDES },
    ]);
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, true);
    });

    const { finished } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(finished).toMatchObject({
      citationSupport: "structured-output",
      citations: [{ check: "not-found" }],
      quoteRetry: null,
    });
    // The refused Tool loop, then the one structured request: nothing more.
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe("What the request shows of an Answer and a Passage", () => {
  test("the sentence a marker is on, without markers; a marker after a full stop is the sentence before's", () => {
    const answer =
      "Spring tides come at full moon [^1]. Neap tides are smaller. [^2]\n\n潮汐每天两次[^3]。";
    expect(markedSentence(answer, 1)).toBe("Spring tides come at full moon.");
    expect(markedSentence(answer, 2)).toBe("Neap tides are smaller.");
    expect(markedSentence(answer, 3)).toBe("潮汐每天两次。");
    expect(markedSentence(answer, 4)).toBeNull();
  });

  test("a long Passage gives the part nearest the quote, grown around it while it fits", () => {
    const filler = (n: number) => `Unrelated line number ${n} about something else entirely.\n`;
    const text = [
      ...Array.from({ length: 20 }, (_, n) => filler(n)),
      `${SPRING}, when the Sun and the Moon pull in line.\n`,
      `${NEAP}.\n`,
      ...Array.from({ length: 20 }, (_, n) => filler(n + 20)),
    ].join("");
    const excerpt = nearestExcerpt(
      text,
      "Spring tides come at new and full moon",
      "",
      60,
      estimateTokens,
    );

    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(60);
    expect(excerpt).toContain(SPRING);
    expect(excerpt).not.toContain("number 0 ");
    // A Passage that fits is given whole.
    expect(nearestExcerpt(TIDES, "anything", "", 1_000, estimateTokens)).toBe(TIDES);
  });

  test("the reply's quotes are read by marker, whatever form the marker takes", () => {
    expect(
      parseCorrections({
        quotes: [
          { marker: 1, quote: " Spring tides " },
          { marker: "[^2]", quote: "" },
          { marker: 3 },
          "not a record",
        ],
      }),
    ).toEqual(
      new Map([
        [1, "Spring tides"],
        [2, ""],
      ]),
    );
    expect(parseCorrections(undefined).size).toBe(0);
  });

  test("the phase is said in English and in Chinese", () => {
    expect(translate("en", "answer.phase.checking-quotes")).toBe("Checking quotes…");
    expect(translate("zh-CN", "answer.phase.checking-quotes")).toBe("正在核对引文…");
  });
});
