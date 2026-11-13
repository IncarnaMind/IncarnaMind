/**
 * Answers at a small context window (#3045): the app's own first pick of local model, Qwen 3.5 9B,
 * at the window the app chooses for this computer's memory (16,384 tokens on 32 GB, 8,192 on
 * 16 GB), against a stub of Ollama's API with the app's own model factory and lookups; and the
 * same rule for a hosted model with a small window. One Document and one Question, asked in a Note
 * and in its assistant.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { Core, ProviderError } from "../../src/core";
import { failureOf } from "../../src/core/answers/checks/checkResults";
import { cellProblemMessage } from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import {
  askAndEnd,
  GIB,
  isAnswer,
  messagesOf,
  QWEN35,
  QWEN35_9B,
  setUpLocalModel,
  TIDES,
} from "../helpers/localModels";
import { connectToMind } from "../helpers/mindClient";
import { note, question, readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { type OllamaChatReply, type OllamaModelStub, startOllamaServer } from "../helpers/ollama";

const QUESTION = "When are spring tides?";
const QUOTE = "Spring tides happen at new moon and at full moon";

/** What the model was told each Tool call came to, in order. */
const toolResults = (body: Record<string, unknown>) =>
  messagesOf(body)
    .filter((message) => message.role === "tool")
    .map((message) => message.content);

/** A request that writes an Answer in the Tool loop, rather than one that tags a Document. */
const answers = (body: Record<string, unknown>) =>
  ((body.tools as { function: { name: string } }[] | undefined) ?? []).some(
    (tool) => tool.function.name === "search_documents",
  );

const optionsOf = (body: Record<string, unknown>) =>
  (body.options ?? {}) as { num_ctx?: number; num_predict?: number };

/**
 * A model in the Tool loop: it searches, cites the first Passage the search gave, then writes its
 * Answer, `last` shaping that last reply. A Document's tagging gets no Tags.
 */
function searchingThenCiting(
  last: (text: string) => OllamaChatReply = (text) => ({ content: text }),
) {
  return (body: Record<string, unknown>): OllamaChatReply => {
    if (!answers(body)) return { content: JSON.stringify({ tags: [] }) };
    const results = toolResults(body);
    if (results.length === 0) {
      return { toolCalls: [{ name: "search_documents", arguments: { query: "spring tides" } }] };
    }
    const passage = /<passage id="([^"]+)"/.exec(results.at(-1) ?? "")?.[1];
    if (passage && !results.at(-1)?.startsWith("Recorded")) {
      return {
        toolCalls: [
          { name: "cite", arguments: { citations: [{ marker: 1, passage, quote: QUOTE }] } },
        ],
      };
    }
    return last(`${QUOTE} [^1].`);
  };
}

async function asked(core: Core, where: "note" | "assistant", mindId: string) {
  if (where === "note") {
    const client = await connectToMind(core, mindId);
    const asking = question(QUESTION);
    writeMind(client, [asking]);
    return (await askAndEnd(core, client, mindId, asking.attrs.id)).ended;
  }
  const result = await core.askInConversation({ text: QUESTION, mindId });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  return answerEnded(core, result.answerId);
}

/** How an Answer of `model` on a computer with `memoryGb` ended, and what it sent. */
async function askedAt(
  memoryGb: number,
  where: "note" | "assistant",
  { model = QWEN35_9B, reply = searchingThenCiting() } = {},
) {
  const ollama = await startOllamaServer({ models: [model], reply });
  const { core, mind } = await setUpLocalModel(ollama, model.name, {
    memory: memoryGb * GIB,
    documents: [{ name: "Tides.md", contents: TIDES }],
  });
  const ended = await asked(core, where, mind.id);
  const sent = ollama.chats.filter((chat) => answers(chat.body));
  const firstSearch = sent
    .map((chat) => toolResults(chat.body)[0])
    .find((result) => result !== undefined);
  return {
    ended,
    sent,
    summary: {
      event: ended.event,
      error: ended.event === "failed" ? ended.payload.error.kind : null,
      citations: ended.event === "finished" ? ended.payload.citations.length : 0,
      readPassages: firstSearch?.includes("<passage") ?? false,
      toldLastStep: firstSearch?.includes("No more calls are allowed") ?? false,
      cap: sent[0] ? (optionsOf(sent[0].body).num_predict ?? null) : null,
    },
  };
}

describe("The app's first local pick at the window it chooses (#3045)", { timeout: 60_000 }, () => {
  // protects=on a 32 GB computer the 9B model's 16k window leaves an Answer room to read its first search's Passages and cite them, in a Note and in its assistant; in the assistant the output cap gives way to 1,024 for it, in a Note it keeps 4,096; each request with its cap stays within the window; fails_when=the assistant fails as too long, the first search is told it was the last step, the cap isn't lowered in what is sent, or a request is refused or cut; no_claim=what a real model writes, which the pull request measures.
  test.each([
    ["note", 4_096],
    ["assistant", 1_024],
  ] as const)("32 GB, asked in the %s: reads and cites", async (where, cap) => {
    const { summary, sent } = await askedAt(32, where);
    expect(summary).toEqual({
      event: "finished",
      error: null,
      citations: 1,
      readPassages: true,
      toldLastStep: false,
      cap,
    });
    for (const chat of sent) {
      const { num_ctx = 0, num_predict = 0 } = optionsOf(chat.body);
      expect(num_ctx).toBe(16_384);
      expect(chat.refused || chat.cut).toBe(false);
      expect(chat.tokens + num_predict).toBeLessThanOrEqual(num_ctx);
    }
  });

  // protects=on a 16 GB computer the 9B model's 8k window answers from a Passage in a Note with main's own cap of 2,048 (Ask's instructions and Tools leave about 50 tokens above the five Passages' room today; past that, and with a longer Question, the cap eases down token for token, as the rule means), and in the assistant, whose instructions and Tools alone don't fit with room to read, fails as a window too small before anything is sent, never as a Question too long; fails_when=Ask's cap moves today, the assistant fails as too long or sends a request; no_claim=the line's words, which the renderer's test reads.
  test("16 GB: a Note's Question reads and cites; the assistant's window is too small", async () => {
    expect((await askedAt(16, "note")).summary).toMatchObject({
      event: "finished",
      citations: 1,
      readPassages: true,
      cap: 2_048,
    });
    const assistant = await askedAt(16, "assistant");
    expect(assistant.summary).toMatchObject({ event: "failed", error: "window-too-small" });
    expect(assistant.sent).toEqual([]);
  });

  // protects=a second Question asked below an answered one in a Note is sent and reads: at 8k, where main still counted the earlier messages it would drop and refused "And neap tides?" as a Question too long ("Shorten it"), it now carries the turn just before beside the first search's room; at 16k, where the earlier Question and Answer fit, it sends them with the whole cap, as main does; fails_when=it fails as too long, or the 16k request changes; no_claim=a turn too long to keep, which the assistant's rows pin.
  test.each([
    [16, 1_990, 2_048],
    [32, 4_096, 4_096],
  ] as const)(
    "%i GB: a second Question below an answered one is sent with the turn before",
    async (memoryGb, least, most) => {
      const ollama = await startOllamaServer({ models: [QWEN35_9B], reply: searchingThenCiting() });
      const { core, mind, client } = await setUpLocalModel(ollama, QWEN35_9B.name, {
        memory: memoryGb * GIB,
        documents: [{ name: "Tides.md", contents: TIDES }],
      });
      const first = question(QUESTION);
      writeMind(client, [first]);
      expect((await askAndEnd(core, client, mind.id, first.attrs.id)).ended.event).toBe("finished");
      const second = question("And neap tides?");
      const written = readMind(client).toJSON() as { content: JSONContent[] };
      writeMind(client, [...written.content, second]);
      const from = ollama.chats.length;

      const { ended } = await askAndEnd(core, client, mind.id, second.attrs.id);

      expect(ended.event).toBe("finished");
      const [request] = ollama.chats.slice(from).filter((chat) => answers(chat.body));
      const carried = messagesOf(request?.body ?? {}).some(
        (message) => message.role !== "system" && message.content.includes(QUESTION),
      );
      expect(carried).toBe(true);
      const cap = optionsOf(request?.body ?? {}).num_predict ?? 0;
      expect(cap).toBeGreaterThanOrEqual(least);
      expect(cap).toBeLessThanOrEqual(most);
    },
  );

  // protects=on a 16 GB computer the default model the app offers there, Qwen 3.5 4B, which cites with structured output, answers in the assistant: the window line's "choose another model" isn't a circle there; fails_when=it fails too; no_claim=the 4B's Answers on a real model.
  test("16 GB: the default model the app offers there answers in the assistant", async () => {
    const { summary } = await askedAt(16, "assistant", {
      model: QWEN35,
      reply: (body) =>
        JSON.stringify(body.format ?? "").includes("citations")
          ? {
              content: JSON.stringify({
                answer: `${QUOTE} [^1].`,
                citations: [{ marker: 1, passage: "P1", quote: QUOTE }],
              }),
            }
          : { content: JSON.stringify({ tags: [] }) },
    });
    expect(summary).toMatchObject({ event: "finished", citations: 1 });
  });

  // protects=a model that can only think keeps its whole output cap, which its reasoning fills before the first word, so at 16k the assistant fails as a window too small at once rather than sending a reply that would be cut mid-thought; fails_when=its cap gives way, or a request is sent; no_claim=thinking models' Answers in a Note.
  test("32 GB, a model that can only think: its cap stays whole, and the assistant's window is too small", async () => {
    const thinking: OllamaModelStub = {
      ...QWEN35_9B,
      name: "thinker:9b",
      thinking: { values: [true], default: true },
    };
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { summary, sent } = await askedAt(32, "assistant", { model: thinking });
    const logged = warned.mock.calls.map(([line]) => String(line));
    warned.mockRestore();
    expect(summary).toMatchObject({ event: "failed", error: "window-too-small" });
    expect(sent).toEqual([]);
    expect(logged.some((line) => line.includes("output at least 8192"))).toBe(true);
  });
});

describe("What a lower output cap costs (#3045)", { timeout: 60_000 }, () => {
  // protects=a reply cut at the output cap the app lowered for the window fails as its own kind, whose line offers another model, and one cut at the model's whole cap keeps the kind whose line offers Retry; fails_when=either ends as an Answer, or the two can't be told apart; no_claim=how often a real model reaches the cap, which the pull request measures.
  test.each([
    ["assistant", "cut-short-small-window"],
    ["note", "cut-short"],
  ] as const)("a reply cut at its cap, asked in the %s, fails as %s", async (where, kind) => {
    const { summary } = await askedAt(32, where, {
      reply: searchingThenCiting((text) => ({ content: text, cutOff: true })),
    });
    expect(summary).toMatchObject({ event: "failed", error: kind });
  });

  // protects=a Tool call cut at the lowered cap (a summary written into the Note, longer than the room left) fails the same way, and nothing of it reaches the Note; fails_when=the Answer ends as answered, or part of the edit is applied; no_claim=what Ollama sends for a call it cut, beyond its unfinished text.
  test("a Tool call cut at the lowered cap changes nothing in the Note", async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35_9B],
      reply: (body) => {
        if (!answers(body)) return { content: JSON.stringify({ tags: [] }) };
        return {
          content: '{"name": "add_to_mind", "arguments": {"text": "Tides: spring tides come at new',
          cutOff: true,
        };
      },
    });
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35_9B.name, {
      memory: 32 * GIB,
      documents: [{ name: "Tides.md", contents: TIDES }],
    });
    writeMind(client, [note("My notes on tides.")]);
    await client.settled();
    const before = readMind(client).textContent;

    const result = await core.askInConversation({
      text: "Write a summary of the tides Document into this Note.",
      mindId: mind.id,
    });
    if (!result.asked) throw new Error("Not asked.");
    const ended = await answerEnded(core, result.answerId);

    expect(ended.event === "failed" && ended.payload.error.kind).toBe("cut-short-small-window");
    await client.settled();
    expect(readMind(client).textContent).toBe(before);
  });
});

describe("Later Questions in the same conversation at 16k (#3045)", { timeout: 90_000 }, () => {
  // protects=a second and a third Question in one assistant conversation at 16k are sent and still read their first search's Passages; each carries the turn just before it, and the older turns and the Note's text give way; the cap is lowered no further than each request needs, the first Answer's from the 1.25 estimate and later ones from Ollama's own count; fails_when=a later Question fails (as on main, where the earlier messages it drops still counted), its first search is told it was the last step, the turn before is left out, or an older turn takes the room; no_claim=a real model's tokenizer.
  test("three Questions: each is sent, reads Passages and carries the turn just before", async () => {
    const ollama = await startOllamaServer({ models: [QWEN35_9B], reply: searchingThenCiting() });
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35_9B.name, {
      memory: 32 * GIB,
      documents: [{ name: "Tides.md", contents: TIDES }],
    });
    writeMind(client, [
      note(
        `Notes from the harbour visit. ${"The tide tables were pinned by the door. ".repeat(60)}`,
      ),
    ]);
    await client.settled();

    let conversationId: string | null = null;
    const asked = [QUESTION, "And neap tides?", "Which is higher?"];
    const ends = [];
    for (const [at, text] of asked.entries()) {
      const from = ollama.chats.length;
      const result = await core.askInConversation({ text, mindId: mind.id, conversationId });
      if (!result.asked) throw new Error("Not asked.");
      conversationId = result.conversation.id;
      const ended = await answerEnded(core, result.answerId);
      const sent = ollama.chats.slice(from).filter((chat) => answers(chat.body));
      const first = sent[0];
      const held = (words: string | undefined) =>
        words !== undefined &&
        messagesOf(first?.body ?? {}).some(
          (message) => message.role !== "system" && message.content.includes(words),
        );
      ends.push({
        event: ended.event,
        readPassages: sent.some((chat) => toolResults(chat.body)[0]?.includes("<passage")),
        cap: first ? optionsOf(first.body).num_predict : null,
        turnBefore: held(asked[at - 1]),
        olderTurn: at >= 2 && held(asked[0]),
        heldNote: held("tide tables"),
      });
    }

    expect(ends.map((each) => [each.event, each.readPassages])).toEqual([
      ["finished", true],
      ["finished", true],
      ["finished", true],
    ]);
    // The turn just before is kept beside the first search's room; the older turn and the Note's
    // text give way. Once Ollama has counted the first request, the cap gives way less.
    expect(ends.map((each) => each.turnBefore)).toEqual([false, true, true]);
    expect(ends.map((each) => each.olderTurn)).toEqual([false, false, false]);
    expect(ends.map((each) => each.heldNote)).toEqual([false, false, false]);
    expect(ends[0]?.cap).toBe(1_024);
    for (const later of ends.slice(1)) expect(later.cap).toBeGreaterThan(1_024);
  });
});

/** A handbook of eight sections, each about one Passage, in `language`, and what its Answers say. */
const HANDBOOK = {
  en: {
    quote: QUOTE,
    first: "When are spring tides?",
    next: "And neap tides?",
    section: (at: number) =>
      `## Tides ${at + 1}\n\n${QUOTE}. ${"Harbour pilots watch the tide tables before each crossing. ".repeat(40)}`,
    answer: (words: number) =>
      `${QUOTE} [^1]. ${Array.from({ length: words }, (_, at) => `pilot${at % 7}`).join(" ")}.`,
    marker: "pilot3",
  },
  "zh-CN": {
    quote: "大潮发生在新月和满月的时候",
    first: "大潮在什么时候？",
    next: "那小潮呢？",
    section: (at: number) =>
      `## 潮汐 ${at + 1}\n\n大潮发生在新月和满月的时候。${"领航员每次出港前都会查看潮汐表。".repeat(28)}`,
    answer: (words: number) =>
      `大潮发生在新月和满月的时候 [^1]。${"领航员记录每一次涨潮。".repeat(Math.round(words / 7))}`,
    marker: "领航员记录",
  },
} as const;

/** A model that searches, cites the first Passage, and answers `answer` the first time and briefly after. */
function handbookModel(language: keyof typeof HANDBOOK, answerWords: number) {
  const said = HANDBOOK[language];
  let answered = 0;
  return (body: Record<string, unknown>): OllamaChatReply => {
    if (!answers(body)) return { content: JSON.stringify({ tags: [] }) };
    const results = toolResults(body);
    if (results.length === 0) {
      return { toolCalls: [{ name: "search_documents", arguments: { query: said.first } }] };
    }
    const passage = /<passage id="([^"]+)"/.exec(results.at(-1) ?? "")?.[1];
    if (passage && !results.at(-1)?.startsWith("Recorded")) {
      return {
        toolCalls: [
          { name: "cite", arguments: { citations: [{ marker: 1, passage, quote: said.quote }] } },
        ],
      };
    }
    return { content: answered++ === 0 ? said.answer(answerWords) : `${said.quote} [^1].` };
  };
}

/** A conversation of two Questions about the handbook on a computer with `memoryGb`: what the second sent. */
async function followUp(memoryGb: number, language: keyof typeof HANDBOOK, answerWords: number) {
  const said = HANDBOOK[language];
  const ollama = await startOllamaServer({
    models: [QWEN35_9B],
    reply: handbookModel(language, answerWords),
  });
  const { core, mind, client } = await setUpLocalModel(ollama, QWEN35_9B.name, {
    memory: memoryGb * GIB,
    documents: [
      {
        name: "Handbook.md",
        contents: Array.from({ length: 8 }, (_, at) => said.section(at)).join("\n\n"),
      },
    ],
  });
  writeMind(client, [note(`Notes from the harbour visit. ${said.quote}.`)]);
  await client.settled();
  const first = await core.askInConversation({ text: said.first, mindId: mind.id });
  if (!first.asked) throw new Error("Not asked.");
  expect((await answerEnded(core, first.answerId)).event).toBe("finished");
  const from = ollama.chats.length;
  const second = await core.askInConversation({
    text: said.next,
    mindId: mind.id,
    conversationId: first.conversation.id,
  });
  if (!second.asked) throw new Error("Not asked.");
  const ended = await answerEnded(core, second.answerId);
  const sent = ollama.chats.slice(from).filter((chat) => answers(chat.body));
  const [request] = sent;
  const held = (text: string) =>
    messagesOf(request?.body ?? {}).some(
      (message) => message.role !== "system" && message.content.includes(text),
    );
  return {
    event: ended.event,
    turn: held(said.first) && held(said.marker),
    anyOfTurn: held(said.first) || held(said.marker),
    note: held("harbour visit"),
    passages: (toolResults(sent[1]?.body ?? {})[0]?.match(/<passage /g) ?? []).length,
    cap: optionsOf(request?.body ?? {}).num_predict ?? 0,
  };
}

describe("The turn just before, at a small window (#3045)", { timeout: 90_000 }, () => {
  // protects=at 16k in the assistant a follow-up carries the turn just before, whole, after a short Answer and a long one, in English and Chinese: the room to write gives way for it first, then Passages beyond three, never below three Passages and never below the floor; fails_when=the turn is left out, part of it is sent, fewer than three Passages are read, or the cap goes below 1,024; no_claim=the Note's text, which gives way before it, and larger windows, where nothing moves.
  test.each([
    ["en", 150],
    ["en", 600],
    ["zh-CN", 225],
    ["zh-CN", 900],
  ] as const)(
    "%s, an earlier Answer of about %i words: the follow-up carries it",
    async (language, words) => {
      const sent = await followUp(32, language, words);
      expect(sent).toMatchObject({ event: "finished", turn: true });
      expect(sent.passages).toBeGreaterThanOrEqual(3);
      expect(sent.cap).toBeGreaterThanOrEqual(1_024);
    },
  );

  // protects=a turn before too long to keep beside three Passages with the cap at its floor is left out as on main, never sent in part, and the follow-up still reads; fails_when=part of it is sent, or the follow-up fails; no_claim=telling the User, which #3077 holds.
  test.each(["en", "zh-CN"] as const)(
    "%s, an earlier Answer too long to keep: left out as on main (#3077)",
    async (language) => {
      const sent = await followUp(32, language, language === "en" ? 3_000 : 4_500);
      expect(sent).toMatchObject({ event: "finished", turn: false });
      expect(sent.passages).toBeGreaterThanOrEqual(3);
      expect(sent.anyOfTurn).toBe(false);
    },
  );

  // protects=at a window where everything fits (64 GB, 32k) the follow-up sends what main sends: every earlier turn, the Note's text, and the whole cap; fails_when=anything gives way; no_claim=byte equality, which the pull request shows against main.
  test.each(["en", "zh-CN"] as const)("%s, at 32k: nothing gives way", async (language) => {
    const sent = await followUp(64, language, 600);
    expect(sent).toMatchObject({ event: "finished", turn: true, note: true, cap: 4_096 });
  });
});

/** Text selected in a Note, in `language`, about `words` words long (Chinese: twice as many characters). */
function selectedText(language: keyof typeof HANDBOOK, words: number): string {
  if (language === "en") {
    return Array.from({ length: words }, (_, at) => `berth${at % 9}`).join(" ");
  }
  return "引航员把吃水深的船安排在高潮前后通过。"
    .repeat(Math.ceil((words * 2) / 19))
    .slice(0, words * 2);
}

const ASK_ABOUT_SELECTION = { en: "Make this shorter.", "zh-CN": "把这段改短一点。" } as const;

/**
 * Asks the assistant about `selection`, selected in a Note, on a computer with `memoryGb`: on a
 * follow-up, after a first Question about the handbook. What its first request held.
 */
async function askedAboutSelection(
  memoryGb: number,
  language: keyof typeof HANDBOOK,
  selection: string,
  { followUp = false, question = ASK_ABOUT_SELECTION[language] as string, model = QWEN35_9B } = {},
) {
  const said = HANDBOOK[language];
  const ollama = await startOllamaServer({
    models: [model],
    reply:
      model === QWEN35_9B
        ? handbookModel(language, 150)
        : (body) =>
            JSON.stringify(body.format ?? "").includes("citations")
              ? {
                  content: JSON.stringify({
                    answer: `${said.quote} [^1].`,
                    citations: [{ marker: 1, passage: "P1", quote: said.quote }],
                  }),
                }
              : { content: JSON.stringify({ tags: [] }) },
  });
  const { core, mind, client } = await setUpLocalModel(ollama, model.name, {
    memory: memoryGb * GIB,
    documents: [
      {
        name: "Handbook.md",
        contents: Array.from({ length: 8 }, (_, at) => said.section(at)).join("\n\n"),
      },
    ],
  });
  const selected = note(selection);
  writeMind(client, [note(`Notes from the harbour visit. ${said.quote}.`), selected]);
  await client.settled();
  let conversationId: string | undefined;
  if (followUp) {
    const first = await core.askInConversation({ text: said.first, mindId: mind.id });
    if (!first.asked) throw new Error("Not asked.");
    expect((await answerEnded(core, first.answerId)).event).toBe("finished");
    conversationId = first.conversation.id;
  }
  const from = ollama.chats.length;
  const asked = await core.askInConversation({
    text: question,
    mindId: mind.id,
    focus: { selection, blockIds: [String(selected.attrs?.id)] },
    ...(conversationId && { conversationId }),
  });
  if (!asked.asked) throw new Error("Not asked.");
  const ended = await answerEnded(core, asked.answerId);
  // The Answer's own requests, a last step without Tools among them.
  const sent = ollama.chats.slice(from).filter((chat) => isAnswer(chat.body));
  const last = messagesOf(sent[0]?.body ?? {}).at(-1)?.content ?? "";
  const held = (text: string) =>
    messagesOf(sent[0]?.body ?? {}).some(
      (message) => message.role !== "system" && message.content.includes(text),
    );
  return {
    ended,
    sent,
    last,
    selection: last.includes(`<selection>\n${selection}\n</selection>`),
    turn: held(said.first) && held(said.marker),
    passages: (toolResults(sent[1]?.body ?? {})[0]?.match(/<passage /g) ?? []).length,
    cap: optionsOf(sent[0]?.body ?? {}).num_predict ?? 0,
  };
}

describe("A selection at a small window (#3045)", { timeout: 90_000 }, () => {
  // protects=at 16k in the assistant, text selected in the Note goes with the Question, whole and marked as the selection, on a first Question and on a follow-up, where the turn just before is kept too, with at least three Passages read and the cap not below its floor; the room to write gives way for it first; fails_when=the selection is left out or sent in part, the turn is left out, fewer than three Passages are read, or the cap goes below 1,024; no_claim=a selection too long to fit, pinned next.
  test.each([
    ["en", "a first Question", false],
    ["en", "a follow-up", true],
    ["zh-CN", "a first Question", false],
    ["zh-CN", "a follow-up", true],
  ] as const)(
    "%s, %s: a selection of about 60 words is sent whole",
    async (language, _, followUp) => {
      const sent = await askedAboutSelection(32, language, selectedText(language, 60), {
        followUp,
      });
      expect(sent.ended.event).toBe("finished");
      expect(sent.selection).toBe(true);
      if (followUp) expect(sent.turn).toBe(true);
      expect(sent.passages).toBeGreaterThanOrEqual(3);
      expect(sent.cap).toBeGreaterThanOrEqual(1_024);
    },
  );

  // protects=a selection too long to go whole beside three Passages at the floor fails as too long before anything is sent, saying the selection is what is too long, where the Question alone would fit; fails_when=a request is sent, the selection is sent in part, or the problem isn't the selection's; no_claim=the line's words, which the renderer's test reads.
  test.each(["en", "zh-CN"] as const)(
    "%s: a selection too long fails before anything is sent",
    async (language) => {
      const sent = await askedAboutSelection(32, language, selectedText(language, 1_500));
      expect(sent.ended.event === "failed" && sent.ended.payload.error).toMatchObject({
        kind: "too-long",
        tooLong: "selection",
      });
      expect(sent.sent).toEqual([]);
    },
  );

  // protects=a Question too long on its own keeps today's too-long line, a selection or not: the selection's line is only for a Question that alone would fit; fails_when=it is said to be the selection's; no_claim=the window line, which an empty Question's test decides.
  test("a Question too long on its own keeps today's line", async () => {
    const sent = await askedAboutSelection(32, "en", selectedText("en", 60), {
      question: `${"Why do the harbour pilots wait for the tide? ".repeat(250)}Make this shorter.`,
    });
    expect(sent.ended.event === "failed" && sent.ended.payload.error.kind).toBe("too-long");
    expect(sent.ended.event === "failed" && sent.ended.payload.error.tooLong).toBeUndefined();
    expect(sent.sent).toEqual([]);
  });

  // protects=where everything fits, the selection goes as it does on main: at 32k whole, marked, just before the Search scope and the Question; at 8k with the 4B, which reads in one pass, whole too; fails_when=it is moved, cut or left out; no_claim=byte equality with main, which the pull request shows.
  test.each([
    ["en", 64, QWEN35_9B],
    ["zh-CN", 64, QWEN35_9B],
    ["en", 16, QWEN35],
    ["zh-CN", 16, QWEN35],
  ] as const)(
    "%s at %i GB: the selection goes whole, as on main",
    async (language, memoryGb, model) => {
      const selection = selectedText(language, 60);
      const sent = await askedAboutSelection(memoryGb, language, selection, { model });
      expect(sent.ended.event).toBe("finished");
      expect(sent.last).toContain(`<selection>\n${selection}\n</selection>\n\nSearch scope:`);
      expect(sent.last.endsWith(ASK_ABOUT_SELECTION[language])).toBe(true);
    },
  );
});

describe("Places that keep their own lines (#3045)", () => {
  const SMALL: ProviderError = {
    kind: "window-too-small",
    message:
      "The model's context window is too small to read a Passage beside the model's instructions.",
  };

  // protects=a comparison's cell whose Answer found the window too small, or was cut at a lowered cap, says the cell couldn't be written, with the core's plain message as its tooltip, never "too long for the model"; fails_when=it shows the too-long label; no_claim=the cell's tooltip, which is the message as kept.
  test("a comparison's cell: couldn't be written, never too long for the model", () => {
    for (const kind of ["window-too-small", "cut-short-small-window"] as const) {
      const { key } = cellProblemMessage(kind);
      expect(key).toBe("comparison.cell.failed");
      expect(translate("en", key)).toBe("couldn’t be written");
      expect(translate("zh-CN", key)).toBe("未能生成");
    }
  });

  // protects=a check's sentence whose Answer found the window too small says the check failed, with the core's plain message, no token counts in it; one cut at a lowered cap is a cut reply, as one cut at the whole cap is; fails_when=it tells the User to shorten anything, or the message holds numbers; no_claim=the run's own line above the card.
  test("a check's sentence: the check failed, with the core's plain message", () => {
    expect(failureOf(SMALL)).toEqual({ reason: "failed", detail: SMALL.message });
    expect(SMALL.message).not.toMatch(/\d/);
    expect(translate("en", "claim.reason.failed", { detail: failureOf(SMALL).detail ?? "" })).toBe(
      "The check failed: The model's context window is too small to read a Passage beside the model's instructions.",
    );
    expect(failureOf({ kind: "cut-short-small-window", message: "Cut." })).toEqual({
      reason: "cut-short",
      detail: null,
    });
  });
});

describe("Every provider is sent the cap the window allows (#3045)", { timeout: 60_000 }, () => {
  /** A core whose chat model is `modelId` of `kind`, answered by a scripted model that searches. */
  async function scripted(provider: { kind: "openrouter"; modelId: string }) {
    const model = scriptedModel(
      (call) =>
        call.results.some((result) => result.tool === "search_documents")
          ? { text: "At new moon and at full moon." }
          : { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] },
      { judgesItsAnswers: true },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ ...provider, apiKey: "sk-or-test" });
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
    const mind = await core.createMind({ title: "Tides" });
    const result = await core.askInConversation({ text: QUESTION, mindId: mind.id });
    if (!result.asked) throw new Error("Not asked.");
    return { model, ended: await answerEnded(core, result.answerId) };
  }

  // protects=a hosted model with a 16k window gets the lowered cap in the request the AI SDK builds (`maxOutputTokens`), not only in Ollama's own field; fails_when=its request is sent with its whole cap; no_claim=the provider's own count.
  test("a hosted model at 16k is asked with the lowered cap", async () => {
    const { model, ended } = await scripted({
      kind: "openrouter",
      modelId: "openai/gpt-3.5-turbo",
    });
    expect(ended.event).toBe("finished");
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(1_024);
  });

  // protects=a hosted model whose window holds less than the assistant's instructions and Tools fails as a window too small, before anything is sent: the hosted line is reachable; fails_when=it sends, or fails as too long; no_claim=the line's words.
  test("a hosted model at 8k: the assistant's window is too small", async () => {
    const { model, ended } = await scripted({ kind: "openrouter", modelId: "openai/gpt-4" });
    expect(ended.event === "failed" && ended.payload.error.kind).toBe("window-too-small");
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
