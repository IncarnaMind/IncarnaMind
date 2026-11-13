/**
 * In call help, a Citation's ✓ means the sentence check passed its sentence, never only that its
 * quote was found (#2847): the reply shows at once with its Citations plain, the check an Answer's
 * sentences get runs once it ends, and only a sentence it passed shows ✓. Through the core's public
 * interface, as the floating panel asks and reads; `sentencePassed` is the panel's own rule.
 */
import { describe, expect, test, vi } from "vitest";
import {
  CLAIM_CHECK_MARK,
  type ConversationAnswer,
  type ConversationAskResult,
  type Core,
  type Meeting,
  type MeetingHelpKind,
} from "../../src/core";
import { sentencePassed } from "../../src/renderer/src/helpReply";
import { pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readHelpReply } from "../../src/shared/helpReplyRead";
import { isTranscriptLocation } from "../../src/shared/locations";
import { answerJudged, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  scriptedModel,
  scriptedModels,
  unscripted,
} from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const PRICE = "Enterprise plan: $45 per seat a month, single sign-on included.";
/** Its last line is what the call's newest lines are about, so the sheet is found ahead for them. */
const SHEET = `Price sheet 2026\n\nTeam plan: $25 per seat a month.\n${PRICE}\nThe launch moves to the eighteenth of November for every plan.`;

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

interface Verdict {
  verdict: "supported" | "unsupported" | "contradicted";
  kind?: "fact" | "opinion";
  quoted?: "states" | "other";
}

/** A batch's reply: each sentence as the first of `verdicts` whose words it holds says, else supported. */
function batchOf(call: GenerateCall, verdicts: readonly [string, Verdict][]): { text: string } {
  const sentences = [
    ...call.prompt.matchAll(/<sentence number="(\d+)">\n([\s\S]*?)\n<\/sentence>/g),
  ];
  return {
    text: JSON.stringify({
      sentences: sentences.map(([, number, sentence = ""]) => {
        const plan = verdicts.find(([words]) => sentence.includes(words))?.[1] ?? {
          verdict: "supported",
        };
        return {
          number: Number(number),
          kind: plan.kind ?? "fact",
          verdict: plan.verdict,
          roles: "same",
          time: "same",
          quoted: plan.quoted ?? "states",
          says: plan.verdict === "supported" ? null : "The price sheet says something else.",
        };
      }),
    }),
  };
}

interface Marking {
  reply: string;
  /** What each marker quotes: the price line found ahead, or the call's newest line. */
  records?: readonly { marker: number; from: "sheet" | "call" }[];
  verdicts?: readonly [string, Verdict][];
  /** The batch's reply instead of `verdicts`', given theirs: an error, or one held. */
  judge?(call: GenerateCall, judged: { text: string }): GeneratedReply;
  /** The reply's text stops after this many characters until `until` resolves. */
  pause?: { after: number; until: Promise<void> };
}

/** A model that records its Citations, writes `reply`, and judges its sentences as `given` says. */
function markingModel(given: Marking, calls: ModelCall[], batches: GenerateCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (call.results.some((result) => result.tool === "cite")) {
        return { text: given.reply, ...(given.pause && { pause: given.pause }) };
      }
      const [sheet] = shownPassages(block(call.prompt, "found-in-documents"));
      const heard = shownPassages(block(call.prompt, "live-transcript")).at(-1);
      const citations = (given.records ?? [{ marker: 1, from: "sheet" }]).flatMap((record) => {
        const passage = record.from === "sheet" ? sheet : heard;
        if (!passage) return [];
        const quote =
          record.from === "sheet"
            ? PRICE
            : (passage.text.split("\n").at(-1) ?? "").replace(/^\[[^\]]*\]\s*/, "");
        return [{ marker: record.marker, passage: passage.id, quote }];
      });
      return citations.length > 0
        ? { calls: [{ tool: "cite", input: { citations } }] }
        : { text: given.reply };
    },
    {
      generate: (call) => {
        // Stop starts the Transcript's own work (its tags, the notes filled in), none of it this test's.
        if (call.question === undefined) return { error: { status: 500, message: "Not here." } };
        if (call.question !== "sentence-batch") return unscripted(call.question, call.system);
        batches.push(call);
        const judged = batchOf(call, given.verdicts ?? []);
        return given.judge?.(call, judged) ?? judged;
      },
    },
  );
}

/**
 * A meeting recording, with the price sheet in its Library, its help answered by `given`, on a
 * model in Ollama unless `cloud` names an Anthropic one.
 */
async function setUp(given: Marking, quoteOnly?: () => boolean, cloud?: string) {
  const calls: ModelCall[] = [];
  const batches: GenerateCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(markingModel(given, calls, batches));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    ...(quoteOnly && { helpMarksQuoteOnly: quoteOnly }),
  });
  const saved = await core.saveChatProvider(
    cloud
      ? { kind: "anthropic", apiKey: "sk-ant-test", modelId: cloud }
      : { kind: "ollama", modelId: "local-model" },
  );
  if (saved.service) {
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.allowDataFlow("chat", saved.service.id);
  }
  const sources = await createSourceFolder();
  const added = await core.addDocuments([await writeSourceFile(sources, "Price sheet.txt", SHEET)]);
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9 * SECOND);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  return { core, meeting, calls, batches, dataDir, models };
}

async function answerOf(core: Core, conversationId: string, answerId: string) {
  const { messages } = await core.getConversation(conversationId);
  const answer = messages.find((message) => message.id === answerId);
  if (answer?.kind !== "answer") throw new Error("No reply.");
  return answer;
}

/**
 * Presses a button: the reply as it ends, before its sentences are judged, and as it is once they
 * are (or once its check ends).
 */
const pressed = (core: Core, meeting: Meeting, kind: MeetingHelpKind) =>
  repliedTo(core, () => core.askMeetingHelp({ meetingId: meeting.id, kind }));

/** A question typed in the panel's field (#2925), as `pressed` presses a button. */
const questioned = (core: Core, meeting: Meeting, text: string) =>
  repliedTo(core, () => core.askMeetingQuestion({ meetingId: meeting.id, text }));

async function repliedTo(core: Core, ask: () => Promise<ConversationAskResult>) {
  const ended = new Set<string>();
  const stop = core.on("answer.finished", ({ answerId }) => ended.add(answerId));
  const asked = await ask();
  if (!asked.asked) throw new Error("Not asked.");
  await vi.waitFor(
    () => {
      if (!ended.has(asked.answerId)) throw new Error("The reply hasn't ended.");
    },
    { timeout: 20_000, interval: 5 },
  );
  stop();
  const ids = { conversationId: asked.conversation.id, answerId: asked.answerId };
  return {
    ids,
    atEnd: await answerOf(core, ids.conversationId, ids.answerId),
    judged: () => answerJudged(core, ids.conversationId, ids.answerId),
  };
}

/** Each chip the reply's lines show, in order, by marker, and whether it shows ✓ as the panel draws it. */
const chips = (answer: ConversationAnswer) =>
  readHelpReply(answer.text).flatMap((item) =>
    [item.lead, ...item.notes, item.effect ?? []].flat().flatMap((piece) => {
      if (piece.kind !== "citation") return [];
      const citation = answer.citations.find((each) => each.marker === piece.marker);
      return [{ marker: piece.marker, passed: !!citation && sentencePassed(citation, piece.at) }];
    }),
  );

/** Each Citation's check, and whether any of its chips shows ✓. */
const marks = (answer: ConversationAnswer) =>
  answer.citations.map((citation) => ({
    marker: citation.marker,
    check: citation.check,
    passed: chips(answer).some((chip) => chip.marker === citation.marker && chip.passed),
  }));

/** A batch held until `release`, the first one only, so a later press's isn't. */
function holdingFirst() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent = 0;
  return {
    release,
    judge: (_call: GenerateCall, judged: { text: string }): GeneratedReply =>
      ++sent === 1 ? { ...judged, until: held } : judged,
  };
}

const ENGLISH = "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once";
const CHINESE = "★ 是的，企业版每个席位每月 45 美元，含单点登录 [^1]\n→ 直接回答，推进通话";

describe("call help's ✓ comes only from the sentence check", { timeout: 60_000 }, () => {
  test.each([
    { language: "English", reply: ENGLISH },
    { language: "Chinese", reply: CHINESE },
  ])(
    "in $language, a reply ends with its Citation plain, and takes ✓ once the check passes its sentence",
    async ({ reply }) => {
      const hold = holdingFirst();
      const { core, meeting, batches } = await setUp({ reply, judge: hold.judge });

      const { atEnd, judged } = await pressed(core, meeting, "answer");
      await vi.waitFor(() => expect(batches).toHaveLength(1));
      const waiting = await answerOf(core, atEnd.conversationId, atEnd.id);
      hold.release();
      const after = await judged();

      expect(atEnd).toMatchObject({ status: "done", text: reply });
      expect(marks(atEnd)).toEqual([{ marker: 1, check: "checking", passed: false }]);
      expect(marks(waiting)).toEqual([{ marker: 1, check: "checking", passed: false }]);
      expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
      expect(after.citations[0]?.judgedAt).toEqual(expect.any(String));
      // The check reads the sentence the User would say, with what it quotes.
      expect(batches[0]?.prompt).toContain(PRICE);
    },
  );

  test.each([
    { language: "English", reply: ENGLISH, words: "Enterprise is $45" },
    { language: "Chinese", reply: CHINESE, words: "企业版每个席位" },
  ])(
    "in $language, a sentence the check doesn't pass keeps its Citation plain, whatever the reason",
    async ({ reply, words }) => {
      const cases: [Verdict, string][] = [
        [{ verdict: "unsupported" }, "unsupported"],
        [{ verdict: "contradicted" }, "contradicted"],
        [{ verdict: "supported", kind: "opinion" }, "not-checked"],
        [{ verdict: "supported", quoted: "other" }, "not-checked"],
      ];
      for (const [verdict, check] of cases) {
        const { core, meeting } = await setUp({ reply, verdicts: [[words, verdict]] });
        const after = await (await pressed(core, meeting, "answer")).judged();
        expect(marks(after)).toEqual([{ marker: 1, check, passed: false }]);
      }
    },
  );

  test.each([
    { language: "English", reply: ENGLISH },
    { language: "Chinese", reply: CHINESE },
  ])(
    "in $language, a check that fails, is offline, can't be read or leaves a field out gives no ✓",
    async ({ reply }) => {
      const replies: GeneratedReply[] = [
        { error: { status: 500, message: "The provider failed." } },
        { error: { status: 503, message: "Service unavailable." } },
        { text: "Every sentence is supported." },
        {
          text: '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","says":"So."}]}',
        },
      ];
      for (const given of replies) {
        const { core, meeting } = await setUp({ reply, judge: () => given });
        const after = await (await pressed(core, meeting, "answer")).judged();
        expect(marks(after)).toEqual([{ marker: 1, check: "not-checked", passed: false }]);
      }
    },
  );

  test.each([
    { model: "a model in Ollama, with no price", cloud: undefined },
    { model: "Claude Haiku 5.5", cloud: "claude-haiku-5-5" },
    { model: "Claude Sonnet 5.5", cloud: "claude-sonnet-5-5" },
  ])(
    "on $model, a reply's sentence goes to the check with room for thinking: 5,300 tokens (#2951)",
    async ({ cloud }) => {
      const { core, meeting, batches } = await setUp({ reply: ENGLISH }, undefined, cloud);

      const after = await (await pressed(core, meeting, "answer")).judged();

      expect(batches.map((batch) => batch.options.maxOutputTokens)).toEqual([5_300]);
      expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
    },
  );

  test("a Citation of the call's Transcript and one of a Document are each judged against what they quote", async () => {
    const reply =
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once\n\nYou asked about the seat price, and that's the Enterprise line [^2]\n→ ties it to their question";
    const { core, meeting, batches } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "call" },
      ],
      verdicts: [["You asked", { verdict: "unsupported" }]],
    });

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(marks(after)).toEqual([
      { marker: 1, check: "found", passed: true },
      { marker: 2, check: "unsupported", passed: false },
    ]);
    const [batch] = batches;
    expect(batch?.prompt.match(/<passage /g)).toHaveLength(2);
    expect(batch?.prompt).toContain('document="Price sheet"');
  });

  test("a → line given a marker and a promise under one are judged as any sentence; only what passes shows ✓", async () => {
    const reply =
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once [^2]\n\nI'll confirm the price in writing today [^3]\n→ buys time";
    const { core, meeting } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "sheet" },
        { marker: 3, from: "sheet" },
      ],
      verdicts: [
        ["answers at once", { verdict: "supported", kind: "opinion" }],
        ["in writing", { verdict: "unsupported" }],
      ],
    });

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(marks(after)).toEqual([
      { marker: 1, check: "found", passed: true },
      { marker: 2, check: "not-checked", passed: false },
      { marker: 3, check: "unsupported", passed: false },
    ]);
  });

  test("a sentence with a calculated figure's marker is the figure check's, not the sentence check's: its Citation stays plain", async () => {
    const reply = "★ Enterprise is [=1] a seat a month [^1]\n→ answers at once";
    const { core, meeting, batches } = await setUp({ reply });

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(batches).toHaveLength(0);
    expect(after.citations).toHaveLength(1);
    expect(chips(after)).toEqual([{ marker: 1, passed: false }]);
  });

  test("a line too short to be judged shows no ✓, whatever its marker earned in the sentence before it", async () => {
    const reply = "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ Same price [^1]";
    const { core, meeting } = await setUp({ reply });

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(after.citations).toMatchObject([{ marker: 1, check: "found" }]);
    expect(chips(after)).toEqual([
      { marker: 1, passed: true },
      { marker: 1, passed: false },
    ]);
  });

  test.each([
    {
      name: "doesn't pass",
      verdict: { verdict: "unsupported" } satisfies Verdict,
      check: "unsupported",
    },
    {
      name: "isn't judged",
      verdict: { verdict: "supported", kind: "opinion" } satisfies Verdict,
      check: "not-checked",
    },
  ])(
    "a marker reused by a sentence that $name keeps its ✓ where its own sentence passed; the Citation's check is unchanged",
    async ({ verdict, check }) => {
      const reply = `${ENGLISH}\n\nI'll confirm the price in writing today [^1]\n→ buys time`;
      const { core, meeting } = await setUp({ reply, verdicts: [["in writing", verdict]] });

      const after = await (await pressed(core, meeting, "answer")).judged();

      expect(after.citations).toMatchObject([{ marker: 1, check }]);
      expect(chips(after)).toEqual([
        { marker: 1, passed: true },
        { marker: 1, passed: false },
      ]);
    },
  );

  test("while Check again judges, a ✓ the first check gave shows no more, and it doesn't come back", async () => {
    let round = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reply = `${ENGLISH}\n\nI'll confirm the price in writing today [^1]\n→ buys time`;
    const { core, meeting, batches } = await setUp({
      reply,
      judge: (call) =>
        ++round === 1
          ? batchOf(call, [["in writing", { verdict: "supported", kind: "opinion" }]])
          : { ...batchOf(call, [["", { verdict: "unsupported" }]]), until: held },
    });
    const first = await (await pressed(core, meeting, "answer")).judged();

    const again = core.checkAnswerAgain({
      conversationId: first.conversationId,
      answerId: first.id,
    });
    await vi.waitFor(() => expect(batches).toHaveLength(2));
    const checking = await answerOf(core, first.conversationId, first.id);
    release();
    await again;
    const after = await answerJudged(core, first.conversationId, first.id);

    expect(chips(first)).toEqual([
      { marker: 1, passed: true },
      { marker: 1, passed: false },
    ]);
    expect(checking.citations).toMatchObject([{ marker: 1, check: "checking" }]);
    expect(chips(checking)).toEqual([
      { marker: 1, passed: false },
      { marker: 1, passed: false },
    ]);
    expect(after.citations).toMatchObject([{ marker: 1, check: "unsupported" }]);
    expect(chips(after)).toEqual([
      { marker: 1, passed: false },
      { marker: 1, passed: false },
    ]);
  });

  test.each([
    {
      name: "doesn't pass it again",
      verdict: "unsupported" as const,
      after: [false, false, false],
    },
    { name: "passes it again", verdict: "supported" as const, after: [true, true, false] },
  ])(
    "Check again on a marker the found one shares a sentence with: its ✓ goes while that sentence is judged, and comes back only if it $name",
    async ({ verdict, after: shown }) => {
      let round = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reply =
        "★ Yes, Enterprise is $45 a seat with single sign-on [^1][^2]\n→ answers at once [^2]";
      const { core, meeting, batches } = await setUp({
        reply,
        records: [
          { marker: 1, from: "sheet" },
          { marker: 2, from: "sheet" },
        ],
        judge: (call) =>
          ++round === 1
            ? batchOf(call, [["answers at once", { verdict: "supported", kind: "opinion" }]])
            : {
                ...batchOf(call, [
                  ["Enterprise", { verdict }],
                  ["answers at once", { verdict: "supported", kind: "opinion" }],
                ]),
                until: held,
              },
      });
      const first = await (await pressed(core, meeting, "answer")).judged();

      const checking = core.checkAnswerAgain({
        conversationId: first.conversationId,
        answerId: first.id,
      });
      await vi.waitFor(() => expect(batches).toHaveLength(2));
      const during = await answerOf(core, first.conversationId, first.id);
      release();
      await checking;
      const after = await answerJudged(core, first.conversationId, first.id);

      expect(first.citations).toMatchObject([
        { marker: 1, check: "found" },
        { marker: 2, check: "not-checked" },
      ]);
      expect(chips(first).map((chip) => chip.passed)).toEqual([true, true, false]);
      expect(chips(during).map((chip) => chip.passed)).toEqual([false, false, false]);
      expect(after.citations[0]).toMatchObject({ marker: 1, check: "found" });
      expect(chips(after).map((chip) => chip.passed)).toEqual(shown);
    },
  );

  test.each([
    { how: "fails at the provider", second: "fails" },
    { how: "is stopped", second: "stopped" },
    { how: "gets a reply with no record for it", second: "no record" },
  ] as const)(
    "a sentence that had passed keeps its ✓ when Check again $how",
    async ({ second }) => {
      const stop = second === "stopped";
      let round = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reply =
        "★ Yes, Enterprise is $45 a seat with single sign-on [^1][^2]\n→ answers at once [^2]";
      const { core, meeting, batches } = await setUp({
        reply,
        records: [
          { marker: 1, from: "sheet" },
          { marker: 2, from: "sheet" },
        ],
        judge: (call) =>
          ++round === 1
            ? batchOf(call, [["answers at once", { verdict: "supported", kind: "opinion" }]])
            : stop
              ? { ...batchOf(call, []), until: held }
              : second === "no record"
                ? { text: JSON.stringify({ sentences: [] }) }
                : { error: { status: 503, message: "Service unavailable." } },
      });
      const first = await (await pressed(core, meeting, "answer")).judged();

      const again = core.checkAnswerAgain({
        conversationId: first.conversationId,
        answerId: first.id,
      });
      await vi.waitFor(() => expect(batches).toHaveLength(2));
      if (stop) {
        await core.stopConversationAnswer({
          conversationId: first.conversationId,
          answerId: first.id,
        });
        release();
      }
      await again;
      const after = await answerJudged(core, first.conversationId, first.id);

      expect(chips(first).map((chip) => chip.passed)).toEqual([true, true, false]);
      expect(after.citations).toMatchObject([
        { marker: 1, check: "found" },
        { marker: 2, check: "not-checked" },
      ]);
      expect(chips(after).map((chip) => chip.passed)).toEqual([true, true, false]);
    },
  );

  test("Check again passing a sentence again gives its ✓ back to a Citation another sentence left unsupported", async () => {
    let round = 0;
    const reply =
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1][^2]\n→ answers at once [^2]\n\nI'll confirm the price in writing today [^1]\n→ buys time";
    const { core, meeting, batches } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "sheet" },
      ],
      judge: (call) => {
        const verdicts: [string, Verdict][] = [
          ["answers at once", { verdict: "supported", kind: "opinion" }],
        ];
        if (++round === 1) verdicts.push(["in writing", { verdict: "unsupported" }]);
        return batchOf(call, verdicts);
      },
    });
    const first = await (await pressed(core, meeting, "answer")).judged();

    await core.checkAnswerAgain({ conversationId: first.conversationId, answerId: first.id });
    const after = await answerJudged(core, first.conversationId, first.id);

    expect(first.citations).toMatchObject([
      { marker: 1, check: "unsupported" },
      { marker: 2, check: "not-checked" },
    ]);
    expect(chips(first).map((chip) => chip.passed)).toEqual([true, true, false, false]);
    expect(batches).toHaveLength(2);
    expect(batches[1]?.prompt).not.toContain("in writing");
    expect(after.citations[0]).toMatchObject({ marker: 1, check: "unsupported" });
    expect(chips(after).map((chip) => chip.passed)).toEqual([true, true, false, false]);
  });

  test.each([
    { answer: "unsupported", verdict: { verdict: "unsupported" }, check: "unsupported" },
    {
      answer: "supported, its quoted words not stating it",
      verdict: { verdict: "supported", quoted: "other" },
      check: "not-checked",
    },
    {
      answer: "sorted as opinion",
      verdict: { verdict: "supported", kind: "opinion" },
      check: "not-checked",
    },
  ] satisfies { answer: string; verdict: Verdict; check: string }[])(
    "Check again judges anew: a ✓ its first check gave a sentence goes once the second reads it and doesn't pass it ($answer)",
    async ({ verdict, check }) => {
      let round = 0;
      const reply = `${ENGLISH}\n\nI'll confirm the price in writing today [^1]\n→ buys time`;
      const { core, meeting } = await setUp({
        reply,
        judge: (call) =>
          ++round === 1
            ? batchOf(call, [["in writing", { verdict: "supported", kind: "opinion" }]])
            : batchOf(call, [["", verdict]]),
      });
      const first = await (await pressed(core, meeting, "answer")).judged();

      await core.checkAnswerAgain({ conversationId: first.conversationId, answerId: first.id });
      const again = await answerJudged(core, first.conversationId, first.id);

      expect(first.citations).toMatchObject([{ marker: 1, check: "not-checked" }]);
      expect(chips(first)).toEqual([
        { marker: 1, passed: true },
        { marker: 1, passed: false },
      ]);
      expect(again.citations).toMatchObject([{ marker: 1, check }]);
      expect(chips(again)).toEqual([
        { marker: 1, passed: false },
        { marker: 1, passed: false },
      ]);
    },
  );

  test("a Citation of the call's own line takes ✓ once the check passes the sentence it is cited in", async () => {
    const reply =
      "★ They want a firm launch date\n0:04 the launch date, said last [^1]\n→ give the date you can commit to";
    const { core, meeting } = await setUp({ reply, records: [{ marker: 1, from: "call" }] });

    const after = await (await pressed(core, meeting, "want")).judged();

    expect(isTranscriptLocation(after.citations[0]?.location ?? null)).toBe(true);
    expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
  });

  test("the next press and Stop on the Meeting leave a reply and its check alone: its ✓ arrives", async () => {
    const hold = holdingFirst();
    const { core, meeting, batches } = await setUp({ reply: ENGLISH, judge: hold.judge });

    const first = await pressed(core, meeting, "answer");
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    const second = await pressed(core, meeting, "say");
    await core.stopMeeting(meeting.id);
    hold.release();

    expect(marks(await first.judged())).toEqual([{ marker: 1, check: "found", passed: true }]);
    expect(marks(await second.judged())).toEqual([{ marker: 1, check: "found", passed: true }]);
  });

  test("Stop on the reply stops it and its check: no ✓", async () => {
    const hold = holdingFirst();
    const { core, meeting, batches } = await setUp({ reply: ENGLISH, judge: hold.judge });
    const { ids, judged } = await pressed(core, meeting, "answer");
    await vi.waitFor(() => expect(batches).toHaveLength(1));

    await core.stopConversationAnswer(ids);
    const after = await judged();
    hold.release();
    // The next press's ✓ arrives once its own check ends: by then the held one has had its turn.
    const next = await (await pressed(core, meeting, "say")).judged();

    expect(marks(next)).toEqual([{ marker: 1, check: "found", passed: true }]);
    expect(marks(after)).toEqual([{ marker: 1, check: "not-checked", passed: false }]);
    expect(marks(await answerOf(core, ids.conversationId, ids.answerId))).toEqual([
      { marker: 1, check: "not-checked", passed: false },
    ]);
  });

  test("quit while its sentence is checked: the next start finds its Citation not checked, never ✓", async () => {
    const hold = holdingFirst();
    const { core, meeting, batches, dataDir, models } = await setUp({
      reply: ENGLISH,
      judge: hold.judge,
    });
    const { ids } = await pressed(core, meeting, "answer");
    await vi.waitFor(() => expect(batches).toHaveLength(1));

    core.close();
    hold.release();
    const later = startCore(dataDir, { createChatModel: models.createChatModel });
    const reopened = await answerOf(later, ids.conversationId, ids.answerId);
    // Check again then gives its ✓: Not checked came from the quit, not from the sentence.
    await later.checkAnswerAgain(ids);
    const again = await answerJudged(later, ids.conversationId, ids.answerId);

    expect(marks(reopened)).toEqual([{ marker: 1, check: "not-checked", passed: false }]);
    expect(marks(again)).toEqual([{ marker: 1, check: "found", passed: true }]);
  });

  test("kept into the Note, a reply carries what its check settled, as an Answer added from the assistant does", async () => {
    const reply = `${ENGLISH}\n\nI'll confirm the price in writing today [^2]\n→ buys time`;
    const { core, meeting } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "sheet" },
      ],
      verdicts: [["in writing", { verdict: "unsupported" }]],
    });
    const after = await (await pressed(core, meeting, "answer")).judged();

    const question = "Answer their question";
    const states: unknown[] = [];
    const collect = (nodes: readonly NodeJSON[]) => {
      for (const node of nodes) {
        for (const mark of node.marks ?? []) {
          if (mark.type === CLAIM_CHECK_MARK) states.push((mark.attrs as { state: string }).state);
        }
        collect(node.content ?? []);
      }
    };
    collect(withAnswerChecks(pageBlocks(after, question), after, question, null));

    expect([...new Set(states)].sort()).toEqual(["supported", "unsupported"]);
  });

  // protects=the evaluation's quote-only switch keeps call help's ✓ on a found quote alone and sends no check, so a paired run compares the two paths and nothing else; fails_when=the switch judges the sentences or leaves the Citation checking; no_claim=which path is right (#2847).
  test("with the evaluation's quote-only switch, a found quote is marked found at the end and nothing is judged", async () => {
    let quoteOnly = true;
    const { core, meeting, batches } = await setUp({ reply: ENGLISH }, () => quoteOnly);

    const { atEnd } = await pressed(core, meeting, "answer");
    // Without the switch, a press after it in the same core is checked: a batch is seen when sent.
    quoteOnly = false;
    const judgedPress = await (await pressed(core, meeting, "answer")).judged();

    expect(atEnd.citations).toMatchObject([{ marker: 1, check: "found" }]);
    expect(atEnd.citations[0]?.judgedAt).toBeUndefined();
    expect(batches).toHaveLength(1);
    expect(marks(judgedPress)).toEqual([{ marker: 1, check: "found", passed: true }]);
  });

  // protects=the paired gate reads the reply's end on both arms from the same event, and the check's request comes after it, so the check can't move the reply's measured end (#2847); fails_when=a check request starts before the reply's end is announced; no_claim=how long the check takes.
  test("the reply's end is announced before any request of its check starts", async () => {
    const order: string[] = [];
    const { core, meeting } = await setUp({
      reply: ENGLISH,
      judge: (_call, judged) => {
        order.push("check");
        return judged;
      },
    });
    core.on("answer.finished", () => order.push("end"));

    await (await pressed(core, meeting, "answer")).judged();

    expect(order).toEqual(["end", "check"]);
  });

  test("the reply's requests and its text are the same, byte for byte, whether or not its sentences are checked", async () => {
    let quoteOnly = true;
    const { core, meeting, calls } = await setUp({ reply: ENGLISH }, () => quoteOnly);
    const deltas = new Map<string, string[]>();
    core.on("answer.delta", ({ answerId, text }) =>
      deltas.set(answerId, [...(deltas.get(answerId) ?? []), text]),
    );

    const before = await pressed(core, meeting, "answer");
    const sentBefore = calls.splice(0);
    quoteOnly = false;
    const after = await pressed(core, meeting, "answer");
    const sentAfter = calls.splice(0);
    await after.judged();

    const asSent = (each: ModelCall) => ({
      system: each.system,
      prompt: each.prompt,
      tools: each.tools,
      results: each.results,
      json: each.json,
    });
    expect(sentAfter.length).toBeGreaterThan(0);
    expect(sentAfter.map(asSent)).toEqual(sentBefore.map(asSent));
    expect(deltas.get(after.ids.answerId)).toEqual(deltas.get(before.ids.answerId));
    expect(after.atEnd.text).toBe(before.atEnd.text);
  });
});

describe("a question typed during the call (#2925)", { timeout: 60_000 }, () => {
  test.each([
    {
      language: "English",
      question: "How much is the Enterprise plan per seat?",
      reply: "The Enterprise plan is $45 per seat a month, with single sign-on [^1]",
    },
    {
      language: "Chinese",
      question: "Enterprise plan 每个席位多少钱？",
      reply: "企业版每个席位每月 45 美元，含单点登录 [^1]",
    },
  ])(
    "in $language, its answer cites the Document fact found ahead for the question, and takes ✓ once the check passes its sentence",
    async ({ question, reply }) => {
      const { core, meeting, calls, batches } = await setUp({ reply });

      const { atEnd, judged } = await questioned(core, meeting, question);
      const after = await judged();

      const [first] = calls;
      expect(first?.prompt).toContain("typed a question about it");
      expect(block(first?.prompt ?? "", "found-in-documents")).toContain(PRICE);
      expect(atEnd).toMatchObject({ status: "done", text: reply });
      expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
      expect(batches[0]?.prompt).toContain(PRICE);
    },
  );

  test("a sentence the check doesn't pass keeps its Citation plain", async () => {
    const reply = "The Enterprise plan is $45 per seat a month, with single sign-on [^1]";
    const { core, meeting } = await setUp({
      reply,
      verdicts: [["Enterprise plan is $45", { verdict: "unsupported" }]],
    });
    const after = await (
      await questioned(core, meeting, "How much is the Enterprise plan per seat?")
    ).judged();
    expect(marks(after)).toEqual([{ marker: 1, check: "unsupported", passed: false }]);
  });
});

/** The text of a note's Blocks, in order. */
const textIn = (nodes: readonly NodeJSON[]): string =>
  nodes.map((node) => `${node.text ?? ""}${textIn(node.content ?? [])}`).join("");

describe("a reply is kept, checked and read again as the panel shows it (#2925)", {
  timeout: 60_000,
}, () => {
  // protects=an option the model wrapped whole in its own quotation marks, its marker inside the marks or after them, in English and Chinese marks, is kept and checked as the panel shows it, so its Citation can take ✓ as a bare option's does; fails_when=the check reads the option's own words as the Document's and shows its Citation not found, or the reply is kept with the marks the panel doesn't show; no_claim=how often a model wraps an option.
  test.each([
    {
      form: "its marker inside the marks",
      reply: '★ "Yes, Enterprise is $45 a seat with single sign-on [^1]"\n→ answers at once',
      kept: ENGLISH,
    },
    {
      form: "its marker after the marks",
      reply: '★ "Yes, Enterprise is $45 a seat with single sign-on" [^1]\n→ answers at once',
      kept: ENGLISH,
    },
    {
      form: "Chinese marks",
      reply: "★ “是的，企业版每个席位每月 45 美元，含单点登录 [^1]”\n→ 直接回答，推进通话",
      kept: CHINESE,
    },
    {
      form: "bold after its star",
      reply: '★ **"Yes, Enterprise is $45 a seat with single sign-on" [^1]**\n→ answers at once',
      kept: "★ **Yes, Enterprise is $45 a seat with single sign-on [^1]**\n→ answers at once",
    },
  ])(
    "an option wrapped in its own quotation marks, $form, is kept as shown and takes ✓",
    async ({ reply, kept }) => {
      const { core, meeting } = await setUp({ reply });
      const after = await (await pressed(core, meeting, "answer")).judged();
      expect(after.text).toBe(kept);
      expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
    },
  );

  // protects=after the call has stopped, Check the rest judges a wrapped option in the words its first check read, every place that check passed stays where it was, and the note it is then added to holds those words; fails_when=the option goes to the judge or into the note in the model's quotation marks, or a passed place moves or is lost; no_claim=which verdict the judge gives.
  test("after the call stops, Check the rest and the note read the option as it was checked, every passed place kept", async () => {
    let round = 0;
    const reply = [
      '★ "Yes, Enterprise is $45 a seat with single sign-on [^1]"',
      "→ answers at once",
      "",
      '"I\'ll confirm the Team plan price in writing today [^2]"',
      "→ buys time",
    ].join("\n");
    const { core, meeting, batches } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "sheet" },
      ],
      judge: (call) =>
        ++round === 1
          ? batchOf(call, [["in writing", { verdict: "supported", kind: "opinion" }]])
          : batchOf(call, []),
    });
    const first = await (await pressed(core, meeting, "answer")).judged();
    expect(marks(first)).toEqual([
      { marker: 1, check: "found", passed: true },
      { marker: 2, check: "not-checked", passed: false },
    ]);
    await core.stopMeeting(meeting.id);

    await core.checkAnswerAgain({ conversationId: first.conversationId, answerId: first.id });
    const after = await answerJudged(core, first.conversationId, first.id);

    expect(batches).toHaveLength(2);
    expect(batches[1]?.prompt).toContain("I'll confirm the Team plan price in writing today");
    expect(batches[1]?.prompt).not.toContain("\"I'll confirm");
    expect(marks(after)).toEqual([
      { marker: 1, check: "found", passed: true },
      { marker: 2, check: "found", passed: true },
    ]);
    expect(after.citations.map((citation) => citation.passedAt)).toEqual([[0], [1]]);
    const note = textIn(pageBlocks(after, "Answer their question"));
    expect(note).toContain("I'll confirm the Team plan price in writing today");
    expect(note).not.toMatch(/["“”]/);
  });

  // protects=a reading's moment of the call keeps its quotation marks, after a blank line too, and its words are looked for on the call it cites; fails_when=the moment is kept or checked without its marks, so words the call never had pass; no_claim=how a model words a reading.
  test("a reading's moment after a blank line keeps its marks, and words the call never had leave it not found", async () => {
    const reply =
      '★ They want a lower price for the whole team [^1]\n\n"We cannot go above forty dollars this year" [^1]\n→ offer the two-year term';
    const { core, meeting } = await setUp({ reply, records: [{ marker: 1, from: "call" }] });
    const after = await (await pressed(core, meeting, "want")).judged();
    expect(after.text).toBe(reply);
    expect(after.citations.map((citation) => citation.check)).toEqual(["not-found"]);
  });

  // protects=words quoted inside an option, not on the cited page, still read as a quotation and leave its Citation not found, in English and Chinese marks; fails_when=the option's own marks taken off hide a quotation inside it; no_claim=what a model quotes.
  test.each([
    {
      marks: "English marks inside straight ones",
      reply:
        '★ "Enterprise comes with “free onboarding for every single seat” at $45 [^1]"\n→ answers at once',
    },
    // In the page's own language: Chinese words on the English sheet read as a translation.
    {
      marks: "Chinese marks inside curly ones",
      reply:
        "★ “Enterprise comes with 「free onboarding for every single seat」 at $45 [^1]”\n→ answers at once",
    },
  ])(
    "words quoted inside an option and not on its page still read not found: $marks",
    async ({ reply }) => {
      const { core, meeting } = await setUp({ reply });
      const after = await (await pressed(core, meeting, "answer")).judged();
      expect(after.citations.map((citation) => citation.check)).toEqual(["not-found"]);
      expect(marks(after)[0]?.passed).toBe(false);
    },
  );
});
