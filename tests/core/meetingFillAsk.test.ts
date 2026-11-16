/**
 * A fill's reply that wrote its Citation markers and never called cite (#3099): the app asks once
 * more for those markers' records, in the one request for an Answer's Citations, and reads the reply
 * with them. Through the core's public interface, with the scripted model.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type {
  ChatModelFactory,
  ChatModelSpec,
  Core,
  CoreAdapters,
  MeetingFill,
} from "../../src/core";
import {
  CITE_RETRY_INSTRUCTIONS,
  FILL_CITE_RETRY_INSTRUCTIONS,
  SEARCH_QUERY_INSTRUCTIONS,
  TRANSLATE_QUERY_INSTRUCTIONS,
} from "../../src/core/answers/prompt";
import { CITATION_NODE } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { outputTokens } from "../../src/core/providers/outputLimits";
import { isPartialMeetingFill } from "../../src/shared/meetingFill";
import { askAndFinish, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { exactly, heading, note, readMind, writeMind } from "../helpers/minds";
import { questionOf, scriptedModel } from "../helpers/models";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const WORDS = {
  en: {
    heading: "Review",
    line: "review date and assignments",
    purpose: "We are settling the review date and sharing the work",
    decision: "The review is on Tuesday",
    action: "Dana will send the draft on Monday",
    closing: "That is all for today",
  },
  "zh-CN": {
    heading: "评审",
    line: "评审日期与分工",
    purpose: "今天定评审日期，再分一下工",
    decision: "评审定在周二",
    action: "王芳周一发草稿",
    closing: "今天就到这里",
  },
} as const;

type Words = (typeof WORDS)[Language];

/** A fact's frame around `body`, its sentences as the reply writes them, markers and all. */
const frame = (id: string, body: string, markers: number[], section: string) =>
  [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({
      topic: section,
      citations: markers,
      lines: ["L1"],
      sections: [section],
      claim: false,
    }),
    "```",
    body,
    `### END ${id}`,
  ].join("\n");

const fact = (id: string, text: string, marker: number, section: string) =>
  frame(id, `${text} [^${marker}].`, [marker], section);

const overview = (text: string, marker: number) =>
  [
    "### OVERVIEW",
    "```json",
    JSON.stringify({ citations: [marker] }),
    "```",
    `${text} [^${marker}].`,
    "### END OVERVIEW",
  ].join("\n");

/** The reply's ledger: the decision [^1], the action [^2] and the overview [^3]. */
const ledger = (words: Words) =>
  [
    "HEADINGS: H1=NONE",
    fact("F1", words.decision, 1, "decisions"),
    fact("F2", words.action, 2, "actions"),
    overview(words.purpose, 3),
  ].join("\n\n");

/** What the model quotes for each marker: the Transcript line that says it. */
const quotesOf = (words: Words): Record<number, string> => ({
  1: words.decision,
  2: words.action,
  3: words.purpose,
});

interface Asked {
  sentence: string;
  passage: string;
  quote: string;
}

/** A `cite` call's records for `cites` (marker → quote), each at its quote's timed cue in `shown`. */
const citeRecords = (shown: { id: string; text: string }[], cites: Record<number, string>) =>
  Object.entries(cites).map(([marker, quote]) => {
    const passage = shown.find((each) => each.text.includes(quote));
    const cue = passage?.text.split("\n").find((line) => line.includes(quote));
    const location = /^\[([^\]]+)\]/.exec(cue ?? "")?.[1];
    if (!passage || !location) throw new Error("The Transcript quote has no timed cue");
    return { marker: Number(marker), passage: passage.id, quote, location };
  });

/**
 * The model: the fill's request gets `reply` (after a `cite` call with `cites`' records, when
 * given); the ask for records gets what `ask` makes of its Answer and Passages.
 */
function fillModel({
  reply,
  cites,
  ask = () => [],
}: {
  reply: string;
  cites?: Record<number, string>;
  ask?: (answer: string, passages: { id: string; text: string }[]) => Asked[];
}) {
  const asked: string[] = [];
  const instructions: string[] = [];
  let fills = 0;
  const model = scriptedModel((call) => {
    if (call.question === "unmarked-quotes") {
      asked.push(call.prompt);
      instructions.push(call.system);
      const answer = /<answer>\n([\s\S]*?)\n<\/answer>/.exec(call.prompt)?.[1] ?? "";
      const passages = [
        ...call.prompt.matchAll(/<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g),
      ].map((match) => ({ id: match[1] as string, text: match[2] as string }));
      return { text: JSON.stringify({ citations: ask(answer, passages) }) };
    }
    if (call.question !== undefined) throw new Error(`Unexpected question: ${call.question}`);
    const shown = shownPassages(call.prompt);
    if (shown.length === 0) return { text: "OK" };
    fills++;
    if (cites && !call.results.some((each) => each.tool === "cite")) {
      return { calls: [{ tool: "cite", input: { citations: citeRecords(shown, cites) } }] };
    }
    return { text: reply };
  });
  return {
    model,
    asked,
    instructions,
    get fills() {
      return fills;
    },
  };
}

/** The ask's records: each sentence of `answer` that holds a quote's marker, with that quote. */
const recordsFor =
  (quotes: Record<number, string>, sentenceOf: (text: string) => string = (text) => text) =>
  (answer: string, passages: { id: string; text: string }[]): Asked[] =>
    Object.entries(quotes).flatMap(([marker, quote]) => {
      const sentence = answer.split("\n").find((line) => line.includes(`[^${marker}]`));
      const passage = passages.find((each) => each.text.includes(quote));
      return sentence && passage
        ? [
            {
              sentence: sentenceOf(sentence.replace(/\s*\[\^\d+\]/g, "")),
              passage: passage.id,
              quote,
            },
          ]
        : [];
    });

/**
 * The ask's records as a model gives them: each of `copies` (a sentence as the Answer has it, its
 * markers in it, and the quote for one of them), at the Passage that holds the quote.
 */
const copied =
  (copies: readonly (readonly [sentence: string, quote: string])[]) =>
  (answer: string, passages: { id: string; text: string }[]): Asked[] =>
    copies.map(([sentence, quote]) => {
      const passage = passages.find((each) => each.text.includes(quote));
      if (!answer.includes(sentence) || !passage)
        throw new Error(`The ask doesn't hold the sentence or its quote: ${sentence}`);
      return { sentence, passage: passage.id, quote };
    });

/** A small call's name: its judge question, or the search's rewrite or translation. */
function smallCallOf(options: Parameters<MockLanguageModelV4["doStream"]>[0]): string | undefined {
  const system = options.prompt.find((message) => message.role === "system")?.content;
  return (
    questionOf(options) ??
    (system === SEARCH_QUERY_INSTRUCTIONS
      ? "search-rewrite"
      : system === TRANSLATE_QUERY_INSTRUCTIONS
        ? "search-translation"
        : undefined)
  );
}

/**
 * A factory of `model` that hears which model each small call went to: `asks` for the ask for
 * Citation records, `small` for every small call, by its name.
 */
function hearingModels(model: MockLanguageModelV4) {
  const asks: ChatModelSpec[] = [];
  const small: { question: string; spec: ChatModelSpec }[] = [];
  const heard = (spec: ChatModelSpec, options: Parameters<MockLanguageModelV4["doStream"]>[0]) => {
    const question = smallCallOf(options);
    if (question === undefined) return;
    small.push({ question, spec });
    if (question === "unmarked-quotes") asks.push(spec);
  };
  const createChatModel: ChatModelFactory = (spec) => ({
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => {
      heard(spec, options);
      return model.doGenerate(options);
    },
    doStream: (options) => {
      heard(spec, options);
      return model.doStream(options);
    },
  });
  return { createChatModel, asks, small };
}

/** Saves `cloud`, an Anthropic model, allowed, as the model for Answers, and `quick` as the quick-tasks model. */
async function onAnthropic(core: Core, cloud: string, quick?: string) {
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: cloud,
  });
  for (const flow of ["chat", "checks"] as const) {
    if (saved.service) await core.allowDataFlow(flow, saved.service.id);
  }
  await core.updateSettings({
    user: {
      chatModel: { providerId: saved.id, modelId: cloud },
      ...(quick && { quickTasksModel: { providerId: saved.id, modelId: quick } }),
      monthlyCap: { amount: 50, currency: "USD" },
    },
  });
}

/**
 * A call recorded and stopped, its notes filled by `scripted`: on a model on this computer, or with
 * `cloud`, that Anthropic model, allowed, and `quick` its quick-tasks model. `asks` are the specs of
 * the models each ask went to; `small`, of every small call's.
 */
async function recordedFill(
  language: Language,
  scripted: { model: MockLanguageModelV4 },
  {
    cloud,
    quick,
    modelFacts,
  }: { cloud?: string; quick?: string; modelFacts?: CoreAdapters["modelFacts"] } = {},
) {
  const words = WORDS[language];
  const { createChatModel, asks, small } = hearingModels(scripted.model);
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  // Four lines for the four cues recorded, none said twice: the ask's records carry no time, so a
  // line said twice can't be told apart.
  const { transcriber } = inProcessTranscriber({
    lines: [words.purpose, words.decision, words.action, words.closing],
  });
  const core = startCore(await createTempDataFolder(), {
    audioCapture: capture,
    transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    createChatModel,
    now: clock.now,
    ...(modelFacts && { modelFacts }),
  });
  await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
  await core.updateSettings({ user: { language }, device: { meetingNoticeAccepted: true } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (cloud) await onAnthropic(core, cloud, quick);
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, [heading(1, words.heading), note(words.line)]);
  await client.settled();
  const before = exactly(client);
  await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
  for (let at = 0; at < 8_000; at += 500) {
    clock.advance(500);
    capture.push("microphone", 500);
  }
  await until(core, meeting.id, (transcript) => transcript.lines >= 3);
  await core.stopMeeting(meeting.id);
  const fill = await vi.waitFor(
    async (): Promise<MeetingFill> => {
      const current = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!current || current.state === "waiting" || current.state === "filling") {
        throw new Error(`Not settled: ${JSON.stringify(current ?? null)}`);
      }
      return current;
    },
    { timeout: 20_000 },
  );
  return { core, meeting, client, before, fill, words, asks, small };
}

/** Each written paragraph or bullet holding `text`: its Citations' checks and quotes. */
function citationsBeside(client: Parameters<typeof readMind>[0], text: string) {
  const found: { check: unknown; quote: unknown }[][] = [];
  readMind(client).descendants((node) => {
    if (node.type.name !== "paragraph" || !node.textContent.includes(text)) return true;
    const citations: { check: unknown; quote: unknown }[] = [];
    node.descendants((child) => {
      if (child.type.name === CITATION_NODE)
        citations.push({ check: child.attrs.check, quote: child.attrs.quote });
    });
    found.push(citations);
    return false;
  });
  return found;
}

describe.each(["en", "zh-CN"] as const)(
  "a fill's reply that never called cite, in %s",
  (language) => {
    // protects=a reply that wrote its markers and called no cite is asked once for their records and fills, every fact with its found Citation (#3099); fails_when=no ask, more than one, or a fact without its Citation; no_claim=a real model's records.
    test("is asked once for its records, and the note fills with each fact's Citation", async () => {
      const words = WORDS[language];
      const scripted = fillModel({ reply: ledger(words), ask: recordsFor(quotesOf(words)) });
      const { core, client, fill } = await recordedFill(language, scripted);
      try {
        expect(fill).toMatchObject({
          state: "filled",
          omitted: 0,
          unfinishedParts: 0,
          problem: null,
        });
        expect(scripted.fills).toBe(1);
        expect(scripted.asked).toHaveLength(1);
        expect(scripted.instructions).toEqual([FILL_CITE_RETRY_INSTRUCTIONS]);
        expect(scripted.model.doStreamCalls).toHaveLength(2);
        for (const [marker, text] of Object.entries(quotesOf(words))) {
          const beside = citationsBeside(client, text);
          expect(beside.length, `paragraphs holding [^${marker}]'s fact`).toBe(1);
          expect(beside[0]).toEqual([{ check: "found", quote: text }]);
        }
      } finally {
        core.close();
      }
    });

    // protects=a reply that writes each marker after its sentence's full stop, as the replies that called no cite did, still has each record taken by its marker (#3099); fails_when=the records of that form are dropped; no_claim=a marker in the middle of a sentence.
    test("takes the records of markers written after a full stop", async () => {
      const words = WORDS[language];
      const stop = language === "en" ? "." : "。";
      const reply = ledger(words).replace(/ \[\^(\d)\]\.$/gm, `${stop} [^$1]`);
      expect(reply.match(new RegExp(`\\${stop} \\[\\^\\d\\]$`, "gm"))).toHaveLength(3);
      const scripted = fillModel({ reply, ask: recordsFor(quotesOf(words)) });
      const { core, client, fill } = await recordedFill(language, scripted);
      try {
        expect(fill).toMatchObject({
          state: "filled",
          omitted: 0,
          unfinishedParts: 0,
          problem: null,
        });
        expect(scripted.asked).toHaveLength(1);
        for (const text of Object.values(quotesOf(words))) {
          expect(citationsBeside(client, text)[0]).toEqual([{ check: "found", quote: text }]);
        }
      } finally {
        core.close();
      }
    });

    // protects=a fact of two sentences, a marker after each one's full stop or after the quotation mark that closes the first, keeps both records: the ask shows the two sentences apart, each with its marker, and each copy takes the marker it holds (#3145); fails_when=the sentences reach the ask joined, a marker is left to no sentence, or the fact is left out; no_claim=a real model's copies.
    test.each([
      ["a full stop", false],
      ["a closing quotation mark", true],
    ] as const)("keeps a fact of two sentences, a marker after %s", async (_, quoted) => {
      const words = WORDS[language];
      const [stop, said, open, close] =
        language === "en" ? [".", "They said: ", '"', '"'] : ["。", "对方说：", "“", "”"];
      const first = quoted ? `${said}${open}${words.action}` : words.action;
      const end = quoted ? `${stop}${close}` : stop;
      const reply = [
        "HEADINGS: H1=NONE",
        fact("F1", words.decision, 1, "decisions"),
        frame("F2", `${first}${end} [^2] ${words.closing}${stop} [^5]`, [2, 5], "actions"),
        overview(words.purpose, 3),
      ].join("\n\n");
      const sentences = [`${first} [^2]${end}`, `${words.closing} [^5]${stop}`] as const;
      const scripted = fillModel({
        reply,
        ask: copied([
          [`${words.decision} [^1].`, words.decision],
          [sentences[0], words.action],
          [sentences[1], words.closing],
          [`${words.purpose} [^3].`, words.purpose],
        ]),
      });
      const { core, client, fill } = await recordedFill(language, scripted);
      try {
        expect(scripted.asked[0]).toContain(sentences.join(" "));
        expect(fill).toMatchObject({ state: "filled", omitted: 0, unfinishedParts: 0 });
        expect(citationsBeside(client, words.closing)).toEqual([
          [
            { check: "found", quote: words.action },
            { check: "found", quote: words.closing },
          ],
        ]);
      } finally {
        core.close();
      }
    });

    // protects=a fact whose sentence holds two markers side by side is kept when the ask gives the sentence one record (the second marker takes it too) and when it gives one for each marker, each with its own quote, and the ask's reply has room for an item for each marker (#3145); fails_when=the fact is left out for its second marker, the second record's quote is lost, or the reply's limit counts sentences only; no_claim=markers apart in a sentence, which share nothing.
    test.each([
      ["one record", false],
      ["a record for each", true],
    ] as const)("keeps a fact with two markers side by side, given %s", async (_, each) => {
      const words = WORDS[language];
      const stop = language === "en" ? "." : "。";
      const sentence = `${words.action} [^2][^5]${stop}`;
      const reply = [
        "HEADINGS: H1=NONE",
        fact("F1", words.decision, 1, "decisions"),
        frame("F2", sentence, [2, 5], "actions"),
        overview(words.purpose, 3),
      ].join("\n\n");
      const scripted = fillModel({
        reply,
        ask: copied([
          [`${words.decision} [^1].`, words.decision],
          [sentence, words.action],
          ...(each ? [[sentence, words.closing] as const] : []),
          [`${words.purpose} [^3].`, words.purpose],
        ]),
      });
      const { core, client, fill } = await recordedFill(language, scripted);
      try {
        expect(fill).toMatchObject({ state: "filled", omitted: 0, unfinishedParts: 0 });
        // Three sentences hold four markers: the reply has room for an item for each marker.
        expect(scripted.model.doStreamCalls.at(-1)?.maxOutputTokens).toBe(
          outputTokens("unmarked-quotes", 4),
        );
        expect(citationsBeside(client, words.action)).toEqual([
          [
            { check: "found", quote: words.action },
            { check: "found", quote: each ? words.closing : words.action },
          ],
        ]);
      } finally {
        core.close();
      }
    });

    // protects=asked once and given no records, the fill ends as it does today: not filled, for the reason that nothing could be checked, with no third request (#3099); fails_when=another request is sent or the reason changes; no_claim=the line's words, which tests/renderer/meetingFillLine.test.ts covers.
    test("given no records, ends as today with exactly two requests", async () => {
      const words = WORDS[language];
      const scripted = fillModel({ reply: ledger(words) });
      const { core, client, before, fill } = await recordedFill(language, scripted);
      try {
        expect(fill).toMatchObject({ state: "failed", omitted: 3, problem: { kind: "unchecked" } });
        expect(scripted.asked).toHaveLength(1);
        expect(scripted.model.doStreamCalls).toHaveLength(2);
        expect(exactly(client)).toEqual(before);
      } finally {
        core.close();
      }
    });
  },
);

describe("the ask for a fill's records (#3099)", () => {
  // protects=the ask goes to the model and service the fill used, with no thinking, where the User's quick-tasks model is another one (#3099); fails_when=it goes to the quick-tasks model, or thinks; no_claim=a real provider's request.
  test("goes to the model the fill used, without thinking, never the quick-tasks model", async () => {
    const words = WORDS.en;
    const scripted = fillModel({ reply: ledger(words), ask: recordsFor(quotesOf(words)) });
    const { core, fill, asks, small } = await recordedFill("en", scripted, {
      cloud: "claude-sonnet-5-5",
      quick: "claude-haiku-5-5",
    });
    try {
      expect(fill).toMatchObject({ state: "filled", omitted: 0 });
      expect(asks.map(({ kind, modelId, thinking }) => ({ kind, modelId, thinking }))).toEqual([
        { kind: "anthropic", modelId: "claude-sonnet-5-5", thinking: "off" },
      ]);
      expect(small.map((each) => each.question)).toEqual(["unmarked-quotes"]);
    } finally {
      core.close();
    }
  });

  // protects=the fill's tool set makes no check of text a reply writes beside its cite call, so such a fill makes no small call at all, as on main (#3099); fails_when=a small call goes out for that text; no_claim=where a fill's other small calls go, which the next test pins.
  test("makes no check of text the reply writes beside its cite call", async () => {
    const words = WORDS.en;
    const model = scriptedModel(
      (call) => {
        if (call.question !== undefined) throw new Error(`Unexpected question: ${call.question}`);
        const shown = shownPassages(call.prompt);
        if (shown.length === 0) return { text: "OK" };
        if (call.results.some((each) => each.tool === "cite")) return { text: "" };
        return {
          text: `${ledger(words)}\n\nNow I record each line's quote.`,
          calls: [{ tool: "cite", input: { citations: citeRecords(shown, quotesOf(words)) } }],
        };
      },
      { generate: () => ({ text: "{}" }) },
    );
    const { core, fill, small } = await recordedFill(
      "en",
      { model },
      {
        cloud: "claude-sonnet-5-5",
        quick: "claude-haiku-5-5",
      },
    );
    try {
      expect(fill).toMatchObject({ state: "filled", omitted: 0 });
      expect(small).toEqual([]);
    } finally {
      core.close();
    }
  });

  // protects=only the ask stays with the fill's model: on a model that can't call Tools, a fill's search rewrite goes to the User's quick-tasks model, as on main (#3099); fails_when=it goes to the fill's model; no_claim=whether that fill fills, or a translation, which an English call with English lines doesn't make.
  test("sends a fill's search rewrite on a model without Tools to the quick-tasks model", async () => {
    const model = scriptedModel(() => ({ text: "{}" }), {
      generate: (call) => ({ text: call.question === undefined ? "review date" : "{}" }),
    });
    const { core, small } = await recordedFill(
      "en",
      { model },
      {
        cloud: "claude-sonnet-5-5",
        quick: "claude-haiku-5-5",
        modelFacts: (_provider, modelId) =>
          modelId === "claude-sonnet-5-5"
            ? { tools: false, structuredOutput: "json_schema" }
            : undefined,
      },
    );
    try {
      expect(
        small.map(({ question, spec: { modelId, thinking } }) => ({ question, modelId, thinking })),
      ).toEqual([{ question: "search-rewrite", modelId: "claude-haiku-5-5", thinking: "off" }]);
    } finally {
      core.close();
    }
  });

  // protects=an Answer's own ask for the Citations it left out goes to the quick-tasks model, with the request it had before the fill's ask was added and changed (#3099, #3145); fails_when=it goes to the Answer's model, or carries the fill's request; no_claim=what the ask gives.
  test("leaves an Answer's own ask for its Citations with the quick-tasks model", async () => {
    const instructions: string[] = [];
    const model = scriptedModel(
      (call) => {
        if (call.question === "unmarked-quotes") {
          instructions.push(call.system);
          return { text: '{"citations":[]}' };
        }
        if (!call.results.some((result) => result.tool === "search_documents")) {
          return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
        }
        return { text: "Long ago, merchants moved bricks of it west by caravan [^1]." };
      },
      { generate: () => ({ text: '{"sentences":[]}' }) },
    );
    const { createChatModel, asks } = hearingModels(model);
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [
        {
          name: "Tea.md",
          contents: "# Tea\n\nTraders carried tea along the Tea Horse Road to Tibet.\n",
        },
      ],
      { createChatModel },
    );
    try {
      await onAnthropic(core, "claude-sonnet-5-5", "claude-haiku-5-5");
      await askAndFinish(core, client, mind.id, "How did tea reach Tibet?");
      expect(asks.map(({ kind, modelId, thinking }) => ({ kind, modelId, thinking }))).toEqual([
        { kind: "anthropic", modelId: "claude-haiku-5-5", thinking: "off" },
      ]);
      expect(instructions).toEqual([CITE_RETRY_INSTRUCTIONS]);
    } finally {
      core.close();
    }
  });

  // protects=a marker the reply used in two facts keeps its own quote in both, and the second fact's other marker gets its own, though the ask names the reused marker's quote again for the second fact (#3099); fails_when=the other marker takes the reused marker's quote; no_claim=a marker reused in one sentence.
  test.each([
    ["copied with its markers", true],
    ["given without them", false],
  ] as const)(
    "gives a marker reused in a second fact its own quote, and that fact's other marker its own: the sentence %s",
    async (_, withMarkers) => {
      const words = WORDS.en;
      const reply = [
        "HEADINGS: H1=NONE",
        fact("F1", words.decision, 1, "decisions"),
        [
          "### FACT F2",
          "```json",
          JSON.stringify({
            topic: "actions",
            citations: [1, 2],
            lines: ["L1"],
            sections: ["actions"],
            claim: false,
          }),
          "```",
          `${words.action} [^1] [^2].`,
          "### END F2",
        ].join("\n"),
        overview(words.purpose, 3),
      ].join("\n\n");
      const quotes = quotesOf(words);
      // A record for every marker where the reply wrote it, as a model names each sentence's sources.
      const perMarker = (answer: string, passages: { id: string; text: string }[]): Asked[] =>
        answer.split("\n").flatMap((line) =>
          [...line.matchAll(/\[\^(\d+)\]/g)].flatMap((match) => {
            const quote = quotes[Number(match[1])];
            const passage = passages.find((each) => quote && each.text.includes(quote));
            return quote && passage
              ? [
                  {
                    sentence: withMarkers ? line : line.replace(/\s*\[\^\d+\]/g, ""),
                    passage: passage.id,
                    quote,
                  },
                ]
              : [];
          }),
        );
      const scripted = fillModel({ reply, ask: perMarker });
      const { core, client, fill } = await recordedFill("en", scripted);
      try {
        expect(fill).toMatchObject({ state: "filled", omitted: 0 });
        expect(citationsBeside(client, words.action)[0]).toEqual([
          { check: "found", quote: words.decision },
          { check: "found", quote: words.action },
        ]);
        expect(citationsBeside(client, words.decision)[0]).toEqual([
          { check: "found", quote: words.decision },
        ]);
      } finally {
        core.close();
      }
    },
  );

  // protects=a record whose quote the Transcript doesn't hold, given outright with a real Passage, is dropped: its fact is left out and counted, neither its sentence nor the quote is in the note, and the facts whose quotes are found keep their Citations; fails_when=the wrong quote is recorded, or the good facts go with it; no_claim=which line a found quote is on.
  test("drops a record whose quote isn't found, and keeps the facts whose quotes are", async () => {
    const words = WORDS.en;
    const wrong = "Dana will send the contract on Friday";
    const { 2: _action, ...found } = quotesOf(words);
    const scripted = fillModel({
      reply: ledger(words),
      ask: (answer, passages) => {
        const sentence = answer.split("\n").find((line) => line.includes("[^2]")) ?? "";
        const passage = passages[0]?.id ?? "";
        if (sentence === "" || passage === "")
          throw new Error("The ask had no marked line or Passage.");
        return [
          ...recordsFor(found)(answer, passages),
          { sentence: sentence.replace(/\s*\[\^\d+\]/g, ""), passage, quote: wrong },
        ];
      },
    });
    const { core, client, fill } = await recordedFill("en", scripted);
    try {
      expect(scripted.asked).toHaveLength(1);
      expect(fill).toMatchObject({ state: "filled", omitted: 1, unfinishedParts: 0 });
      expect(readMind(client).textContent).not.toContain(words.action);
      expect(readMind(client).textContent).not.toContain(wrong);
      expect(citationsBeside(client, words.decision)[0]).toEqual([
        { check: "found", quote: words.decision },
      ]);
      expect(citationsBeside(client, words.purpose)[0]).toEqual([
        { check: "found", quote: words.purpose },
      ]);
    } finally {
      core.close();
    }
  });

  // protects=a code fence holding a shorter fence line closes only on its own kind of line, so the marked sentences after it are still asked for and filled (#3099); fails_when=the inner line ends the fence and the sentences after the block are left out of the ask; no_claim=a model writing code there.
  test("asks for the marked sentences after a fence that holds a shorter one", async () => {
    const words = WORDS.en;
    const reply = [
      "HEADINGS: H1=NONE",
      fact("F1", words.decision, 1, "decisions"),
      ["````text", "```", "not the end of the block", "````"].join("\n"),
      fact("F2", words.action, 2, "actions"),
      overview(words.purpose, 3),
    ].join("\n\n");
    const scripted = fillModel({ reply, ask: recordsFor(quotesOf(words)) });
    const { core, client, fill } = await recordedFill("en", scripted);
    try {
      expect(scripted.asked).toHaveLength(1);
      expect(scripted.asked[0]).toContain(words.action);
      expect(fill).toMatchObject({ state: "filled", omitted: 0, unfinishedParts: 0 });
      expect(citationsBeside(client, words.action)[0]).toEqual([
        { check: "found", quote: words.action },
      ]);
    } finally {
      core.close();
    }
  });

  // protects=a reply that called cite gets exactly today's requests: no ask (#3099); fails_when=a third request goes; no_claim=a reply with records for only some markers.
  test("never goes for a reply that called cite", async () => {
    const words = WORDS.en;
    const scripted = fillModel({ reply: ledger(words), cites: quotesOf(words) });
    const { core, client, fill } = await recordedFill("en", scripted);
    try {
      expect(fill).toMatchObject({ state: "filled", omitted: 0 });
      expect(scripted.asked).toHaveLength(0);
      expect(scripted.fills).toBe(2);
      expect(scripted.model.doStreamCalls).toHaveLength(2);
      expect(citationsBeside(client, words.action)[0]).toEqual([
        { check: "found", quote: words.action },
      ]);
    } finally {
      core.close();
    }
  });

  // protects=the ask adds records only: a record that gives a fact's sentence in other words changes nothing of the note, which keeps the first reply's sentence (#3099); fails_when=the note takes the ask's wording; no_claim=a sentence too unlike the fact's to take its marker.
  test("keeps the first reply's sentence when the ask words a fact again", async () => {
    const words = WORDS.en;
    const scripted = fillModel({
      reply: ledger(words),
      ask: recordsFor(quotesOf(words), (sentence) =>
        sentence.includes(words.decision) ? `${words.decision} afternoon, as agreed` : sentence,
      ),
    });
    const { core, client, fill } = await recordedFill("en", scripted);
    try {
      expect(fill).toMatchObject({ state: "filled", omitted: 0 });
      expect(citationsBeside(client, words.decision)[0]).toEqual([
        { check: "found", quote: words.decision },
      ]);
      expect(readMind(client).textContent).not.toContain("afternoon, as agreed");
    } finally {
      core.close();
    }
  });

  // protects=footnote lines a reply writes in place of records never land in the note, with the ask and without it, while its facts do (#3099); fails_when=a footnote line is written; no_claim=what a footnote line quotes.
  test.each([
    ["with the ask", false],
    ["without it", true],
  ] as const)("never writes the reply's footnote lines, %s", async (_, cites) => {
    const words = WORDS.en;
    const footnotes = Object.entries(quotesOf(words)).map(
      ([marker, quote]) => `[^${marker}]: Transcript · Me, 0:0${marker}, "${quote}"`,
    );
    const scripted = fillModel({
      reply: [ledger(words), ...footnotes].join("\n\n"),
      ...(cites ? { cites: quotesOf(words) } : { ask: recordsFor(quotesOf(words)) }),
    });
    const { core, client, fill } = await recordedFill("en", scripted);
    try {
      expect(fill).toMatchObject({ state: "filled", omitted: 0 });
      expect(scripted.asked).toHaveLength(cites ? 0 : 1);
      expect(readMind(client).textContent).not.toContain("Transcript · Me");
      expect(readMind(client).textContent).toContain(words.action);
    } finally {
      core.close();
    }
  });

  // protects=a reply that stops after its second frame's metadata writes the one fact it closed, with its Citation, and is partly filled in: the open frame and the missing overview are the items that couldn't be added (#3099); fails_when=the closed fact is lost, or the note reads as whole; no_claim=the line's words, which tests/renderer/meetingFillLine.test.ts covers.
  test("writes the one closed fact of a reply that stops after its second frame", async () => {
    const words = WORDS.en;
    const stopped = [
      "HEADINGS: H1=NONE",
      fact("F1", words.decision, 1, "decisions"),
      ["### FACT F2", "```json", JSON.stringify({ topic: "actions", citations: [2] })].join("\n"),
    ].join("\n\n");
    const scripted = fillModel({ reply: stopped, ask: recordsFor({ 1: words.decision }) });
    const { core, client, fill } = await recordedFill("en", scripted);
    try {
      expect(fill).toMatchObject({
        state: "filled",
        omitted: 2,
        unfinishedParts: 0,
        problem: null,
      });
      expect(isPartialMeetingFill(fill)).toBe(true);
      expect(scripted.asked).toHaveLength(1);
      expect(citationsBeside(client, words.decision)[0]).toEqual([
        { check: "found", quote: words.decision },
      ]);
      expect(readMind(client).textContent).not.toContain(words.action);
    } finally {
      core.close();
    }
  });
});
