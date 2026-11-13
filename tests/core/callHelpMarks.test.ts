/**
 * In call help, a Citation's ✓ means the sentence check passed its sentence, never only that its
 * quote was found (#2847): the reply shows at once with its Citations plain, the check an Answer's
 * sentences get runs once it ends, and only a sentence it passed shows ✓. Through the core's public
 * interface, as the floating panel asks and reads; `sentencePassed` is the panel's own rule.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { keptHelpReading } from "../../eval/speed/callHelp";
import {
  CLAIM_CHECK_MARK,
  type ConversationAnswer,
  type Core,
  type Meeting,
  type MeetingHelpKind,
} from "../../src/core";
import { helpParts, helpToKeep, sentencePassed } from "../../src/renderer/src/helpReply";
import { answerBlocks, pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { helpLayout, helpReplyRead, readHelpReply } from "../../src/shared/helpReplyRead";
import { isTranscriptLocation } from "../../src/shared/locations";
import { answerHelpForm, type CallHelpForm } from "../../src/shared/meetingHelp";
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
  /** The reply, or the reply given the call's newest line, which a "call" record quotes. */
  reply: string | ((heard: string) => string);
  /** What each marker quotes: the price line found ahead, or the call's newest line. */
  records?: readonly { marker: number; from: "sheet" | "call" }[];
  verdicts?: readonly [string, Verdict][];
  /** The batch's reply instead of `verdicts`', given theirs: an error, or one held. */
  judge?(call: GenerateCall, judged: { text: string }): GeneratedReply;
  /** The reply's text stops after this many characters until `until` resolves. */
  pause?: { after: number; until: Promise<void>; reached?: () => void };
}

/** A model that records its Citations, writes `reply`, and judges its sentences as `given` says. */
function markingModel(given: Marking, calls: ModelCall[], batches: GenerateCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      const [sheet] = shownPassages(block(call.prompt, "found-in-documents"));
      const heard = shownPassages(block(call.prompt, "live-transcript")).at(-1);
      const newest = (heard?.text.split("\n").at(-1) ?? "").replace(/^\[[^\]]*\]\s*/, "");
      const text = typeof given.reply === "function" ? given.reply(newest) : given.reply;
      if (call.results.some((result) => result.tool === "cite")) {
        return { text, ...(given.pause && { pause: given.pause }) };
      }
      const citations = (given.records ?? [{ marker: 1, from: "sheet" }]).flatMap((record) => {
        const passage = record.from === "sheet" ? sheet : heard;
        if (!passage) return [];
        return [
          {
            marker: record.marker,
            passage: passage.id,
            quote: record.from === "sheet" ? PRICE : newest,
          },
        ];
      });
      return citations.length > 0 ? { calls: [{ tool: "cite", input: { citations } }] } : { text };
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
async function setUp(
  given: Marking,
  quoteOnly?: () => boolean,
  cloud?: string,
  /** The form presses are asked in; a function for a test that changes it between presses. */
  form?: CallHelpForm | (() => CallHelpForm | undefined),
  sheet = SHEET,
) {
  const calls: ModelCall[] = [];
  const batches: GenerateCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(markingModel(given, calls, batches));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    ...(quoteOnly && { helpMarksQuoteOnly: quoteOnly }),
    ...(form && { callHelpForm: typeof form === "function" ? form : () => form }),
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
  const added = await core.addDocuments([await writeSourceFile(sources, "Price sheet.txt", sheet)]);
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
async function pressed(core: Core, meeting: Meeting, kind: MeetingHelpKind) {
  const ended = new Set<string>();
  const stop = core.on("answer.finished", ({ answerId }) => ended.add(answerId));
  const asked = await core.askMeetingHelp({ meetingId: meeting.id, kind });
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

  // protects=a reply's sentence giving a currency its quote gives otherwise is Unsupported with the line Check against Documents gives, so it shows its number alone though the model called it supported (#2997); fails_when="£45" or "45 英镑" citing the sheet's "$45" shows ✓; no_claim=what a real model replies.
  test.each([
    {
      language: "English",
      reply: "★ Yes, Enterprise is £45 a seat with single sign-on [^1]\n→ answers at once",
      line: "The Document gives $45, not £45.",
    },
    {
      language: "Chinese",
      reply: "★ 是的，企业版每个席位每月 45 英镑，含单点登录 [^1]\n→ 直接回答，推进通话",
      line: "The Document gives $45, not 45 英镑.",
    },
  ])(
    "in $language, a sentence whose quote gives another currency shows its number alone",
    async ({ reply, line }) => {
      const { core, meeting } = await setUp({ reply });
      const after = await (await pressed(core, meeting, "answer")).judged();

      expect(marks(after)).toEqual([{ marker: 1, check: "unsupported", passed: false }]);
      expect(after.citations[0]?.verdict).toBe(line);
    },
  );

  // protects=a reply naming the dollar the sheet's bare "$" doesn't ("45 美元") keeps the ✓ its check passes, as before #2997: an Answer leaves that reading out until its replies write the Document's own sign (#3030); fails_when="45 美元" citing "$45" shows its number alone; no_claim=Check against Documents, which reads it Unsupported.
  test("a reply naming the dollar the sheet's bare $ doesn't keeps its ✓ for now", async () => {
    const { core, meeting } = await setUp({ reply: CHINESE });
    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
  });

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

  // protects=a marker on a "→" line, the reply's own line, is taken off where the reply is kept: not drawn, not sent to the check, its Citation not kept, while a promise under a marker is judged as any sentence and every other place counts in the text kept (#2847); fails_when=the "→" line's sentence goes to the check, its chip shows, or a ✓ lands on another place; no_claim=what the check decides about the promise.
  test("a → line's marker is taken off, and a promise under one is judged as any sentence; only what passes shows ✓", async () => {
    const reply =
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once [^2]\n\nI'll confirm the price in writing today [^3]\n→ buys time";
    const { core, meeting, batches } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "sheet" },
        { marker: 3, from: "sheet" },
      ],
      verdicts: [["in writing", { verdict: "unsupported" }]],
    });

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(after.text).toBe(
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once\n\nI'll confirm the price in writing today [^3]\n→ buys time",
    );
    const judgedSentences = batches.flatMap((batch) =>
      [...batch.prompt.matchAll(/<sentence number="\d+">\n([\s\S]*?)\n<\/sentence>/g)].map(
        ([, sentence]) => sentence,
      ),
    );
    expect(judgedSentences).toHaveLength(2);
    expect(judgedSentences.join("\n")).not.toContain("answers at once");
    expect(marks(after)).toEqual([
      { marker: 1, check: "found", passed: true },
      { marker: 3, check: "unsupported", passed: false },
    ]);
    expect(after.citations[0]?.passedAt).toEqual([0]);
  });

  // protects=a short-lines reply's "→" line is kept as written: a Check reply as main writes one keeps the marker on its "→" line, its Citation and its chip at its place, in English and Chinese, since short lines are asked for no "→" line; fails_when=the core's kept text loses that marker, its Citation goes, or the chip's place moves; no_claim=what the check decides about that line.
  test.each([
    "- They said the panels are cleaned once a year [^1]\n- Supported: the sheet says once a year [^2]\n→ You can confirm it; Enterprise is $45 a seat [^3]",
    "- 对方说组件每年清洗一次 [^1]\n- 文档支持：每年清洗一次 [^2]\n→ 可以直接确认；企业版每个席位 45 美元 [^3]",
  ])(
    "a Check reply's → line keeps its marker, its Citation and its chip's place: %s",
    async (reply) => {
      const { core, meeting } = await setUp({
        reply,
        records: [
          { marker: 1, from: "call" },
          { marker: 2, from: "sheet" },
          { marker: 3, from: "sheet" },
        ],
      });

      const after = await (await pressed(core, meeting, "check")).judged();

      expect(after.text).toBe(reply);
      expect(after.citations.map((citation) => citation.marker).sort()).toEqual([1, 2, 3]);
      const arrow = readHelpReply(after.text)
        .flatMap((item) => item.effect ?? [])
        .flatMap((piece) => (piece.kind === "citation" ? [[piece.marker, piece.at]] : []));
      expect(arrow).toEqual([[3, 2]]);
    },
  );

  test("a sentence with a calculated figure's marker is the figure check's, not the sentence check's: its Citation stays plain", async () => {
    const reply = "★ Enterprise is [=1] a seat a month [^1]\n→ answers at once";
    const { core, meeting, batches } = await setUp({ reply });

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(batches).toHaveLength(0);
    expect(after.citations).toHaveLength(1);
    expect(chips(after)).toEqual([{ marker: 1, passed: false }]);
  });

  test("a line too short to be judged shows no ✓, whatever its marker earned in the sentence before it", async () => {
    const reply =
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once\n\nSame price [^1]\n→ buys time";
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
        "★ Yes, Enterprise is $45 a seat with single sign-on [^1][^2]\n→ answers at once\n\nIt answers at once [^2]\n→ buys time";
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
        "★ Yes, Enterprise is $45 a seat with single sign-on [^1][^2]\n→ answers at once\n\nIt answers at once [^2]\n→ buys time";
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
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1][^2]\n→ answers at once\n\nIt answers at once [^2]\n→ ties it up\n\nI'll confirm the price in writing today [^1]\n→ buys time";
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

/** The text of a note's Blocks, in order. */
const textIn = (nodes: readonly NodeJSON[]): string =>
  nodes.map((node) => `${node.text ?? ""}${textIn(node.content ?? [])}`).join("");

/** A Block's words, a line break as a new line, its chips left out. */
const linesIn = (node: NodeJSON): string =>
  node.type === "hardBreak"
    ? "\n"
    : `${node.text ?? ""}${(node.content ?? []).map(linesIn).join("")}`;

/** The paragraphs of the Note an Answer is added to, each line without the space before a chip. */
const paragraphsOf = (answer: ConversationAnswer) =>
  pageBlocks(answer, "Answer their question").map((block) =>
    linesIn(block)
      .split("\n")
      .map((line) => line.trim())
      .join("\n"),
  );

/** The words of a line the panel shows, without its chips. */
const words = (pieces: readonly { kind: string; text?: string }[] = []) =>
  pieces
    .flatMap((piece) => (piece.kind === "text" ? [piece.text] : []))
    .join("")
    .trim();

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
    // The reading's first line is the reply's own and loses its marker; its moment keeps its own.
    expect(after.text).toBe(
      '★ They want a lower price for the whole team\n\n"We cannot go above forty dollars this year" [^1]\n→ offer the two-year term',
    );
    expect(after.citations.map((citation) => citation.check)).toEqual(["not-found"]);
  });

  // protects=a reading's first line or an option's "→" line that puts words in quotation marks keeps its marker, so the quote check reads those words as on main: words the call never had leave the Citation not found, and a reply's own line quoting them never shows them with nothing beside it; fails_when=the marker comes off such a line, so its Citation goes and its words stay in quotation marks unchecked; no_claim=how a model quotes.
  test.each([
    {
      kind: "want",
      reply:
        '★ They want a lower price: "We cannot go above forty dollars this year" [^1]\n→ offer the two-year term',
      records: [{ marker: 1, from: "call" }],
      not: 1,
    },
    {
      kind: "want",
      reply: '★ They call the price "far too steep for a pilot" [^1]\n→ offer the two-year term',
      records: [{ marker: 1, from: "call" }],
      not: 1,
    },
    {
      kind: "answer",
      reply:
        '★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ they said "we must sign by Friday", so this answers it [^2]',
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "call" },
      ],
      not: 2,
    },
  ] as const)(
    "a line that quotes words the call never had keeps its marker, its Citation not found: $reply",
    async ({ kind, reply, records, not }) => {
      const { core, meeting } = await setUp({ reply, records });
      const after = await (await pressed(core, meeting, kind)).judged();
      expect(after.text).toBe(reply);
      expect(after.citations.find((citation) => citation.marker === not)?.check).toBe("not-found");
    },
  );

  // protects=a Chinese reading's first line quoting the other side keeps its marker, so the quote check reads the words and, on an English call, takes their marks off as a translation, as on main; fails_when=the marker comes off and the words stay in quotation marks with no Citation beside them; no_claim=how a model translates.
  test("a Chinese reading that quotes the other side keeps its marker, and the quote check reads it", async () => {
    const reply = "★ 对方想压价：“今年我们最多只能出四十美元” [^1]\n→ 先给阶梯价";
    const { core, meeting } = await setUp({ reply, records: [{ marker: 1, from: "call" }] });
    const after = await (await pressed(core, meeting, "want")).judged();
    expect(after.text).toBe("★ 对方想压价：今年我们最多只能出四十美元 [^1]\n→ 先给阶梯价");
    expect(after.citations.map((citation) => citation.marker)).toEqual([1]);
  });

  // protects=a reading's first line or an option's "→" line that quotes words the call did have keeps its marker and its Citation, found by the quote check; fails_when=the marker comes off such a line or the words aren't looked for on the call; no_claim=how a model quotes.
  test.each([
    {
      kind: "want",
      reply: (heard: string) => `★ They asked: "${heard}" [^1]\n→ answer it first`,
      records: [{ marker: 1, from: "call" }],
      marker: 1,
    },
    {
      kind: "want",
      reply: (heard: string) => `★ They put it as "${heard}" [^1]\n→ answer it first`,
      records: [{ marker: 1, from: "call" }],
      marker: 1,
    },
    {
      kind: "answer",
      reply: (heard: string) =>
        `★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ they asked "${heard}", so this answers it [^2]`,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "call" },
      ],
      marker: 2,
    },
  ] as const)(
    "a line that quotes words the call did have keeps its Citation, found ($kind, [^$marker])",
    async ({ kind, reply, records, marker }) => {
      const { core, meeting } = await setUp({ reply, records });
      const after = await (await pressed(core, meeting, kind)).judged();
      expect(after.text).toContain(`[^${marker}]`);
      expect(after.citations.find((citation) => citation.marker === marker)?.check).toBe("found");
    },
  );

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

describe("the evaluation's switch for the form whose facts stand apart (#2847)", {
  timeout: 60_000,
}, () => {
  // protects=the evaluation's as-before arm asks and keeps a reply as main does: its instructions are today's, its Answer says nothing of the form, and it is read by main's reader, whose "→" line loses its marker (#3056); fails_when=the arm asks otherwise, its Answer says it was asked in the form, or it is read otherwise than main reads it, so the gate would compare more than the form; no_claim=what the check decides.
  test("as before, a press is asked and read as main does", async () => {
    const reply =
      "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once [^2]\n\nI'll confirm the price in writing today [^3]\n→ buys time";
    const { core, meeting, calls } = await setUp(
      {
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
      },
      undefined,
      undefined,
      "as before",
    );

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(after.steps?.askedInForm).toBeUndefined();
    expect(after.text).toBe(reply.replace(" [^2]", ""));
    expect(marks(after)).toEqual([
      { marker: 1, check: "found", passed: true },
      { marker: 3, check: "unsupported", passed: false },
    ]);
    expect(calls[0]?.prompt).toContain("- Each option is two lines:");
  });

  // protects=under the form a press is asked in the form's words, in the Question's own message as today's are; fails_when=the switch doesn't reach the instructions; no_claim=what the model writes.
  test("in the form, a press is asked in the form's words", async () => {
    const { core, meeting, calls } = await setUp(
      { reply: ENGLISH },
      undefined,
      undefined,
      "fact lines",
    );

    await (await pressed(core, meeting, "answer")).judged();

    const help = block(calls[0]?.prompt ?? "", "help");
    expect(help).toContain(
      'each one sentence of at most 20 words on a line of its own starting with "> " and ending with its Citation markers',
    );
    expect(help).not.toContain("- Each option is two lines:");
  });

  // protects=a fact line the model wrote after its option's "→" line stays where written and belongs to the option above: kept right after that "→", checked, given its ✓ on its own chip under the first option, and in the first option's paragraph of the Note it is added to, the second option left whole, and the text kept reads the same again; fails_when=the fact moves above the "→" line, starts an option of its own, joins the second option, the ✓ lands elsewhere, or a second reading moves it; no_claim=how often a model writes it so.
  test("in the form, a fact written after its → line stays there and takes its ✓ under the option it belongs to", async () => {
    const reply = [
      "★ Yes, Enterprise is $45 a seat",
      "→ answers at once",
      "> Enterprise is $45 per seat a month, with single sign-on [^1]",
      "",
      "I'll send the price sheet today",
      "→ buys time",
    ].join("\n");
    const { core, meeting, batches } = await setUp({ reply }, undefined, undefined, "fact lines");

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(after.text).toBe(
      "★ Yes, Enterprise is $45 a seat\n→ answers at once\nEnterprise is $45 per seat a month, with single sign-on [^1]\n\nI'll send the price sheet today\n→ buys time",
    );
    expect(batches).toHaveLength(1);
    expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
    const [first, second] = helpParts(after, "answer").options;
    const chip = first?.after[0]?.find((piece) => piece.kind === "citation");
    const citation = after.citations[0];
    expect(chip?.kind === "citation" && citation && sentencePassed(citation, chip.at)).toBe(true);
    expect(words(second?.lead)).toBe("I'll send the price sheet today");
    expect(words(second?.effect ?? [])).toBe("buys time");
    expect(second?.notes).toEqual([]);
    expect(second?.after).toEqual([]);
    expect(paragraphsOf(after)).toEqual([
      "★ Yes, Enterprise is $45 a seat\n→ answers at once\nEnterprise is $45 per seat a month, with single sign-on",
      "I'll send the price sheet today\n→ buys time",
    ]);
    const layout = helpLayout("answer", { status: "done", textBehind: false, form: "fact lines" });
    expect(helpReplyRead(after.text, layout).text).toBe(after.text);
  });

  // protects=a reply in the form is kept without its marks, so "> " is never a quotation block and "= " never shows: not in the panel, not in the assistant's view, not in the Note it is added to; its fact still takes ✓ and its line to say cites nothing; fails_when=a mark is kept or drawn as Markdown, or the fact loses its ✓; no_claim=how each surface lays the lines out.
  test("in the form, its marks are never drawn as Markdown: not in the panel, the assistant or the Note", async () => {
    const reply = [
      "★ Yes, Enterprise is $45 a seat [^1]",
      "> Enterprise is $45 per seat a month, with single sign-on [^1]",
      "= The Documents don't say whether the price includes customs duty",
      "→ answers at once",
    ].join("\n");
    const { core, meeting } = await setUp({ reply }, undefined, undefined, "fact lines");

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(after.text).toBe(
      "★ Yes, Enterprise is $45 a seat\nEnterprise is $45 per seat a month, with single sign-on [^1]\nThe Documents don't say whether the price includes customs duty\n→ answers at once",
    );
    const types = (nodes: readonly NodeJSON[]): string[] =>
      nodes.flatMap((node) => [node.type, ...types(node.content ?? [])]);
    expect(types(answerBlocks(after))).not.toContain("blockquote");
    expect(types(pageBlocks(after, "Answer their question"))).not.toContain("blockquote");
    expect(textIn(pageBlocks(after, "Answer their question"))).not.toMatch(/(?:^|\n)\s*[>=]/);
    const { options } = helpParts(after, "answer");
    const shown = options
      .flatMap((item) => [item.lead, ...item.notes, ...item.own, item.effect ?? []])
      .map((line) => line.flatMap((piece) => (piece.kind === "text" ? [piece.text] : [])).join(""));
    expect(shown.some((line) => /^\s*[>=＞＝]/.test(line))).toBe(false);
    expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
  });

  const CLOSING = {
    English: {
      reply: [
        "★ Yes, Enterprise is $45 a seat",
        "> Enterprise is $45 per seat a month, with single sign-on [^1]",
        "→ answers at once",
        "",
        "I'll send the price sheet today",
        "→ buys time",
        "",
        "= The Documents don't say whether the price includes customs duty",
      ].join("\n"),
      closing: "The Documents don't say whether the price includes customs duty",
      begun: "The Documents",
    },
    Chinese: {
      reply: [
        "★ 是的，企业版每个席位 45 美元",
        "＞ 企业版每个席位每月 45 美元，含单点登录 [^1]",
        "→ 直接回答",
        "",
        "我今天把价目表发给你",
        "→ 争取时间",
        "",
        "＝ 文档没有提到价格是否含关税",
      ].join("\n"),
      closing: "文档没有提到价格是否含关税",
      begun: "文档",
    },
  };

  /** The reply's closing line and its two options as the panel shows them, in the form. */
  const closingOf = (answer: ConversationAnswer) => {
    const { options, closing } = helpParts(answer, "answer");
    return {
      closing: closing.map(words),
      inOptions: options.flatMap((item) => [...item.own, ...item.after]).map(words),
    };
  };

  // protects=the reply's own line after its options, its "= " read as the core reads it, is stored as its closing line and stays one, after the options and in no option, through its check, Check again and the Note it is added to, where it is a paragraph of its own, in English and Chinese; fails_when=it goes into the last option or the last option's paragraph, Check again moves it, or the field isn't stored; no_claim=how the panel lays it out.
  test.each(["English", "Chinese"] as const)(
    "in %s, the closing line stays after the options, through Check again and into the Note",
    async (language) => {
      const { reply, closing } = CLOSING[language];
      const { core, meeting } = await setUp({ reply }, undefined, undefined, "fact lines");

      const { ids, judged } = await pressed(core, meeting, "answer");
      const after = await judged();
      await core.checkAnswerAgain(ids);
      const again = await answerJudged(core, ids.conversationId, ids.answerId);

      for (const answer of [after, again]) {
        expect(answer.steps?.closingLine).toBe(true);
        expect(answer.text.endsWith(`\n\n${closing}`)).toBe(true);
        expect(closingOf(answer)).toEqual({ closing: [closing], inOptions: [] });
        expect(marks(answer)).toEqual([{ marker: 1, check: "found", passed: true }]);
        const paragraphs = paragraphsOf(answer);
        expect(paragraphs).toHaveLength(3);
        expect(paragraphs.at(-1)).toBe(closing);
        expect(paragraphs.slice(0, 2).some((paragraph) => paragraph.includes(closing))).toBe(false);
      }
    },
  );

  // protects=a reply stopped while its closing line was written keeps what it wrote of that line as its closing line, stored as one, after the options as it showed just before Stop, and Check the rest then judges its facts, the closing line left where it was, in English and Chinese; fails_when=the line written so far goes into the last option, moves at Stop, or Check the rest moves it; no_claim=what Stop does to a reply in today's form.
  test.each(["English", "Chinese"] as const)(
    "in %s, a reply stopped in its closing line keeps it after the options, and Check the rest leaves it there",
    async (language) => {
      const { reply, closing, begun } = CLOSING[language];
      const at = reply.indexOf(begun) + begun.length;
      const { core, meeting } = await setUp(
        { reply, pause: { after: at, until: new Promise(() => {}) } },
        undefined,
        undefined,
        "fact lines",
      );

      const asked = await core.askMeetingHelp({ meetingId: meeting.id, kind: "answer" });
      if (!asked.asked) throw new Error("Not asked.");
      const ids = { conversationId: asked.conversation.id, answerId: asked.answerId };
      let before: ConversationAnswer | null = null;
      await vi.waitFor(
        async () => {
          before = await answerOf(core, ids.conversationId, ids.answerId);
          expect(before.text).toContain(begun);
        },
        { timeout: 20_000, interval: 5 },
      );
      await core.stopConversationAnswer(ids);
      const stopped = await answerJudged(core, ids.conversationId, ids.answerId);
      await core.checkAnswerAgain(ids);
      const checked = await answerJudged(core, ids.conversationId, ids.answerId);

      expect(stopped.status).toBe("stopped");
      // As far as the reply got: its words stop wherever the model's last piece ended.
      const written = stopped.text.split("\n").at(-1)?.trim() ?? "";
      expect(written.startsWith(begun) && closing.startsWith(written)).toBe(true);
      const shown = before as ConversationAnswer | null;
      if (!shown) throw new Error("Never written.");
      expect(closingOf(shown)).toEqual({ closing: [written], inOptions: [] });
      for (const answer of [stopped, checked]) {
        expect(answer.steps?.closingLine).toBe(true);
        expect(closingOf(answer)).toEqual({ closing: [written], inOptions: [] });
        expect(answer.text.trimEnd().endsWith(`\n\n${written}`)).toBe(true);
      }
      expect(marks(checked)).toEqual([{ marker: 1, check: "found", passed: true }]);
    },
  );

  // protects=Check again sends the lines the first check sent, for a reply with a closing line that ended and one stopped in it (its Check the rest the first), the closing line staying where it was, in English and Chinese; fails_when=Check again sends other lines, or the closing line moves; no_claim=what the model replies.
  test.each([
    { language: "English", stop: false },
    { language: "Chinese", stop: false },
    { language: "English", stop: true },
    { language: "Chinese", stop: true },
  ] as const)(
    "in $language, stopped $stop: Check again sends the same lines",
    async ({ language, stop }) => {
      const { reply, begun } = CLOSING[language];
      let reachable = false;
      const { core, meeting, batches } = await setUp(
        {
          reply,
          ...(stop && {
            pause: { after: reply.indexOf(begun) + begun.length, until: new Promise(() => {}) },
          }),
          judge: (_call, judged) =>
            reachable ? judged : { error: { status: 500, message: "Not reachable." } },
        },
        undefined,
        undefined,
        "fact lines",
      );
      let ids: { conversationId: string; answerId: string };
      if (stop) {
        const asked = await core.askMeetingHelp({ meetingId: meeting.id, kind: "answer" });
        if (!asked.asked) throw new Error("Not asked.");
        const pressedIds = { conversationId: asked.conversation.id, answerId: asked.answerId };
        ids = pressedIds;
        await vi.waitFor(
          async () =>
            expect(
              (await answerOf(core, pressedIds.conversationId, pressedIds.answerId)).text,
            ).toContain(begun),
          { timeout: 20_000, interval: 5 },
        );
        await core.stopConversationAnswer(ids);
        await answerJudged(core, ids.conversationId, ids.answerId);
        await core.checkAnswerAgain(ids);
      } else ids = (await pressed(core, meeting, "answer")).ids;
      const first = await answerJudged(core, ids.conversationId, ids.answerId);
      const sent = batches.length;
      reachable = true;
      await core.checkAnswerAgain(ids);
      const again = await answerJudged(core, ids.conversationId, ids.answerId);

      expect(marks(first)).toEqual([{ marker: 1, check: "not-checked", passed: false }]);
      expect(sent).toBeGreaterThan(0);
      expect(batches.length).toBeGreaterThan(sent);
      expect(batches.at(-1)?.prompt).toBe(batches[0]?.prompt);
      expect(marks(again)).toEqual([{ marker: 1, check: "found", passed: true }]);
      for (const answer of [first, again]) {
        expect(answer.steps?.closingLine).toBe(true);
        expect(closingOf(answer).inOptions).toEqual([]);
        expect(closingOf(answer).closing).toHaveLength(1);
      }
    },
  );

  const LAST_OPTION = {
    English: {
      first: [
        "★ Yes, Enterprise is $45 a seat",
        "> Enterprise is $45 per seat a month, with single sign-on [^1]",
        "→ answers at once",
        "",
        "",
      ].join("\n"),
      say: "Let me check whether the price includes customs duty and come back to you today",
      fact: "> Enterprise is $45 per seat a month, with single sign-on [^2]",
    },
    Chinese: {
      first: [
        "★ 是的，企业版每个席位 45 美元",
        "＞ 企业版每个席位每月 45 美元，含单点登录 [^1]",
        "→ 直接回答",
        "",
        "",
      ].join("\n"),
      // Its spaces let the model's text stop partway through the line, as a real reply's can. It
      // doesn't start with 我: the app holds back a line that could claim it did something.
      say: "先确认 45 美元是否含关税，今天再回复你",
      fact: "＞ 企业版每个席位每月 45 美元，含单点登录 [^2]",
    },
  };

  /** A pause in the reply's text after `after` characters, and when the model has reached it. */
  const pausedAfter = (after: number) => {
    let reached = () => {};
    const isReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    return { pause: { after, until: new Promise<void>(() => {}), reached }, isReached };
  };

  /**
   * Presses Answer; once the model has paused and the reply shows `shown`, gives what it shows then,
   * stops it, and gives it as kept.
   */
  async function stoppedAt(core: Core, meeting: Meeting, isReached: Promise<void>, shown: string) {
    const asked = await core.askMeetingHelp({ meetingId: meeting.id, kind: "answer" });
    if (!asked.asked) throw new Error("Not asked.");
    const ids = { conversationId: asked.conversation.id, answerId: asked.answerId };
    await isReached;
    let before: ConversationAnswer | null = null;
    await vi.waitFor(
      async () => {
        before = await answerOf(core, ids.conversationId, ids.answerId);
        expect(before.text).toContain(shown);
      },
      { timeout: 20_000, interval: 5 },
    );
    await core.stopConversationAnswer(ids);
    const after = await answerJudged(core, ids.conversationId, ids.answerId);
    if (!before) throw new Error("Never written.");
    return { before: before as ConversationAnswer, after };
  }

  /** The options' lines to say and the closing line, as the panel shows them. */
  const optionsAndClosing = (answer: ConversationAnswer) => {
    const { options, closing } = helpParts(answer, "answer");
    return { says: options.map((item) => words(item.lead)), closing: closing.map(words) };
  };

  // protects=a last option stopped before its "→" line stays the option it was while written, nothing moving at Stop, in English and Chinese: with nothing that cites, the line to say written so far, its words kept, and no closing line, since only a "= " makes one; with a fact line that cites, the same; fails_when=Stop turns it into the closing line or moves a line, or its words change; no_claim=how often a reply is stopped there.
  test.each(["English", "Chinese"] as const)(
    "in %s, a last option stopped before its → line",
    async (language) => {
      const { first, say, fact } = LAST_OPTION[language];
      const shownFirst = first.trim().split("\n").at(-1) ?? "";
      const bareStop = pausedAfter(first.length + say.indexOf(" "));
      const plain = await setUp(
        { reply: `${first}${say}\n→ buys time`, pause: bareStop.pause },
        undefined,
        undefined,
        "fact lines",
      );
      const bare = await stoppedAt(
        plain.core,
        plain.meeting,
        bareStop.isReached,
        say.slice(0, say.indexOf(" ")),
      );

      const factStop = pausedAfter(`${first}${say}\n${fact}`.length);
      const withFact = await setUp(
        {
          reply: `${first}${say}\n${fact}\n→ buys time`,
          records: [
            { marker: 1, from: "sheet" },
            { marker: 2, from: "sheet" },
          ],
          pause: factStop.pause,
        },
        undefined,
        undefined,
        "fact lines",
      );
      const cited = await stoppedAt(
        withFact.core,
        withFact.meeting,
        factStop.isReached,
        shownFirst,
      );

      // Nothing cites in it: the option written so far, before Stop and after it alike.
      const whileWritten = optionsAndClosing(bare.before);
      const half = whileWritten.says[1] ?? "";
      expect(half.length > 0 && say.startsWith(half) && half !== say).toBe(true);
      expect(whileWritten.closing).toEqual([]);
      expect(bare.after.status).toBe("stopped");
      expect(bare.after.steps?.closingLine).toBeUndefined();
      expect(optionsAndClosing(bare.after)).toEqual(whileWritten);
      // A fact line cites: it stays an option too.
      for (const answer of [cited.before, cited.after]) {
        expect(optionsAndClosing(answer)).toEqual({
          says: [whileWritten.says[0], say],
          closing: [],
        });
      }
      expect(cited.after.status).toBe("stopped");
    },
  );

  /** What the panel shows of a reply in the form: its opening, options' lines and closing line. */
  const panelAt = (answer: ConversationAnswer) => {
    const { opening, options, closing } = helpParts(answer, "answer");
    return {
      opening: opening.map(words),
      options: options.map((item) => [
        words(item.lead),
        ...item.notes.map(words),
        ...(item.effect ? [`→ ${words(item.effect)}`] : []),
        ...item.after.map((line) => `after: ${words(line)}`),
      ]),
      closing: closing.map(words),
    };
  };

  const STOPPED_EARLY = {
    English: {
      // Its marker mid-line, so the reply can stop just after it.
      starred: "★ Yes, Enterprise is $45 a seat [^1] with single sign-on",
      // No "★": a first line that cites is the one that could be read as a fact line before options.
      plain: "Yes, Enterprise is $45 a seat [^1] with single sign-on",
      rest: "\n→ answers at once\n\nI'll send the price sheet today\n→ buys time",
      arrow: "★ Yes, Enterprise is $45 a seat\n→ answers at once\n",
      fact: "> Enterprise is $45 per seat a month, with single sign-on [^1]",
      cut: " per seat",
    },
    Chinese: {
      starred: "★ 是的，企业版每个席位 45 美元 [^1] 含单点登录",
      plain: "是的，企业版每个席位 45 美元 [^1] 含单点登录",
      rest: "\n→ 直接回答\n\n先确认 45 美元是否含关税，今天再回复你\n→ 争取时间",
      arrow: "★ 是的，企业版每个席位 45 美元\n→ 直接回答\n",
      fact: "＞ 企业版每个席位每月 45 美元，含单点登录 [^1]",
      cut: " 45 美元",
    },
  };

  /** Presses Answer on a model writing `reply`, and stops it once it has written `shown`. */
  async function stoppedIn(reply: string, upTo: number, shown: string) {
    const stop = pausedAfter(upTo);
    const { core, meeting } = await setUp(
      { reply, records: [{ marker: 1, from: "sheet" }], pause: stop.pause },
      undefined,
      undefined,
      "fact lines",
    );
    return stoppedAt(core, meeting, stop.isReached, shown);
  }

  // protects=Stop moves nothing in three more places, in English and Chinese: a first option stopped in its first line just after its marker stays the option it was, never a fact line before the options; a first line with no "★" stopped there stays held back as the model's notes, as while written (#2526), never a fact line before the options; stopped with a fact line half-written right after an option's "→" line, that line stays the option's, under its "→", and no option or closing line comes of it; fails_when=any reads otherwise once stopped than just before, or becomes the opening or the closing line; no_claim=how often a reply is stopped there.
  test.each(["English", "Chinese"] as const)(
    "in %s, Stop in a first line with its marker, and in a fact line after a → line",
    async (language) => {
      const { starred, plain, rest, arrow, fact, cut } = STOPPED_EARLY[language];
      const markerEnd = (line: string) => line.indexOf("[^1]") + "[^1]".length;
      const lead = (line: string) => line.slice(0, line.indexOf(" [^1]")).replace(/^★ /, "");
      const inStarred = await stoppedIn(`${starred}${rest}`, markerEnd(starred), lead(starred));
      const inPlain = await stoppedIn(`${plain}${rest}`, markerEnd(plain), lead(plain));
      const half = fact.slice(0, fact.indexOf(cut));
      const inFact = await stoppedIn(
        `${arrow}${fact}`,
        `${arrow}${half}`.length,
        half.replace(/^[>＞]\s*/u, ""),
      );

      for (const { before, after } of [inStarred, inPlain, inFact]) {
        expect(after.status).toBe("stopped");
        expect(after.steps?.closingLine).toBeUndefined();
        for (const answer of [before, after]) {
          expect(panelAt(answer).opening).toEqual([]);
          expect(panelAt(answer).closing).toEqual([]);
        }
        expect(panelAt(after).options.map((lines) => lines[0])).toEqual(
          panelAt(before).options.map((lines) => lines[0]),
        );
      }
      // A line shows as it is written (#2526), so the reply stops partway through the model's
      // last piece of text, a few characters on from the pause.
      const said = (line: string) => line.replace(/^[★>＞]\s*/u, "").replace(" [^1]", "");
      const startedFrom = (shown: string | undefined, upTo: string, line: string) =>
        shown !== undefined && shown.startsWith(upTo) && line.startsWith(shown);
      const starredLeads = panelAt(inStarred.after).options.map((lines) => lines[0]);
      expect(starredLeads).toHaveLength(1);
      expect(startedFrom(starredLeads[0], lead(starred), said(starred))).toBe(true);
      expect(panelAt(inPlain.after).options).toEqual([]);
      const [option] = panelAt(inFact.after).options;
      expect(panelAt(inFact.after).options).toHaveLength(1);
      const factShown = option?.at(-1);
      expect(startedFrom(factShown, `after: ${said(half)}`, `after: ${said(fact)}`)).toBe(true);
      expect(panelAt(inFact.before).options[0]?.at(-1)).toBe(factShown);
    },
  );

  // protects=reading A of the ruling: a fact line written before the first line to say belongs to no option; it is kept first, checked, given its ✓ on its own chip, and is a paragraph of its own in the Note, the first option's facts left as written, in English and Chinese; fails_when=it goes into the first option or its paragraph, or its ✓ is lost; no_claim=how often a model writes it so.
  test.each([
    {
      language: "English",
      fact: "Enterprise is $45 per seat a month, with single sign-on",
      reply: [
        "> Enterprise is $45 per seat a month, with single sign-on [^1]",
        "★ Yes, Enterprise is $45 a seat",
        "→ answers at once",
        "",
        "I'll send the price sheet today",
        "→ buys time",
      ].join("\n"),
    },
    {
      language: "Chinese",
      fact: "企业版每个席位每月 45 美元，含单点登录",
      reply: [
        "＞ 企业版每个席位每月 45 美元，含单点登录 [^1]",
        "★ 是的，企业版每个席位 45 美元",
        "→ 直接回答",
        "",
        "我今天把价目表发给你",
        "→ 争取时间",
      ].join("\n"),
    },
  ])(
    "in $language, a fact line before the first line to say stands apart, with its ✓",
    async ({ reply, fact }) => {
      const { core, meeting } = await setUp({ reply }, undefined, undefined, "fact lines");

      const after = await (await pressed(core, meeting, "answer")).judged();

      expect(after.text.startsWith(`${fact} [^1]\n\n★`)).toBe(true);
      const { opening, options } = helpParts(after, "answer");
      expect(opening.map(words)).toEqual([fact]);
      const chip = opening[0]?.find((piece) => piece.kind === "citation");
      const citation = after.citations[0];
      expect(chip?.kind === "citation" && citation && sentencePassed(citation, chip.at)).toBe(true);
      expect(options.flatMap((item) => item.notes)).toEqual([]);
      const paragraphs = paragraphsOf(after);
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[0]).toBe(fact);
    },
  );

  /**
   * The words of the options' fact lines, each with whether its chip shows ✓: in these replies,
   * whose options write none of their own, the turned lines alone.
   */
  const turnedOf = (answer: ConversationAnswer) =>
    helpParts(answer, "answer").options.flatMap((item) =>
      item.notes.map((line) => ({
        words: words(line),
        passed: line.some(
          (piece) =>
            piece.kind === "citation" &&
            answer.citations.some(
              (citation) => citation.marker === piece.marker && sentencePassed(citation, piece.at),
            ),
        ),
      })),
    );
  const TURNED = PRICE.replace(/\.$/, "");

  // protects=a Document's Citation the model left on an option's line to say is kept as a fact line of the Document's words, after the option's facts and above its "→" line, judged by the check as its own sentence and given its ✓ on its own chip, the line to say keeping no chip, and it stays in the option's paragraph of the Note, in English and Chinese; fails_when=the Citation stays on the line to say, the turned line isn't judged or shows no ✓, or the Note loses it; no_claim=how often a model leaves a Citation there.
  test.each([
    {
      language: "English",
      say: "★ Yes, Enterprise is $45 a seat [^1]",
      effect: "→ answers at once",
    },
    { language: "Chinese", say: "★ 是的，企业版每个席位 45 美元 [^1]", effect: "→ 直接回答" },
  ])(
    "in $language, a Document's Citation on a line to say is kept as a fact line, judged and ✓",
    async ({ say, effect }) => {
      const { core, meeting, batches } = await setUp(
        { reply: `${say}\n${effect}` },
        undefined,
        undefined,
        "fact lines",
      );

      const after = await (await pressed(core, meeting, "answer")).judged();

      expect(after.text).toBe(`${say.replace(" [^1]", "")}\n${TURNED} [^1]\n${effect}`);
      expect(turnedOf(after)).toEqual([{ words: TURNED, passed: true }]);
      expect(
        helpParts(after, "answer").options[0]?.lead.some((piece) => piece.kind === "citation"),
      ).toBe(false);
      expect(batches[0]?.prompt).toContain(TURNED);
      expect(paragraphsOf(after)[0]).toContain(TURNED);
    },
  );

  // protects=the same Document Citation left on two options' lines to say gives each option its turned line, each judged at its own place and given ✓ there, in English and Chinese; fails_when=one option loses its line, or the check passes only one place for the Citation; no_claim=none beyond protects.
  test.each([
    {
      language: "English",
      reply:
        "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nIt's $45 a seat, single sign-on included [^1]\n→ confirms it",
    },
    {
      language: "Chinese",
      reply:
        "★ 是的，企业版每个席位 45 美元 [^1]\n→ 直接回答\n\n每个席位 45 美元，含单点登录 [^1]\n→ 再确认一次",
    },
  ])(
    "in $language, the same Citation on two options is judged at each place",
    async ({ reply }) => {
      const { core, meeting } = await setUp({ reply }, undefined, undefined, "fact lines");

      const after = await (await pressed(core, meeting, "answer")).judged();

      expect(turnedOf(after)).toEqual([
        { words: TURNED, passed: true },
        { words: TURNED, passed: true },
      ]);
      expect(after.citations[0]?.passedAt).toEqual([0, 1]);
    },
  );

  // protects=a line to say that states a Document's sentence with no marker and no fact line gets its Citation from the citing step, and that Citation is kept as a turned fact line, in English and Chinese; fails_when=the line to say keeps the Citation or it is lost; no_claim=how often a model writes so.
  test.each([
    {
      language: "English",
      sheet: SHEET,
      line: TURNED,
    },
    {
      language: "Chinese",
      // The sheet's English last line is what the call is about, so it is found ahead.
      sheet: `Price sheet 2026\n\n企业版：每个席位每月 45 美元，含单点登录。\nThe launch moves to the eighteenth of November for every plan.`,
      line: "企业版：每个席位每月 45 美元，含单点登录",
    },
  ])(
    "in $language, a line to say the citing step cites is turned into a fact line",
    async ({ sheet, line }) => {
      const { core, meeting } = await setUp(
        { reply: `★ ${line}\n→ answers at once`, records: [] },
        undefined,
        undefined,
        "fact lines",
        sheet,
      );

      const after = await (await pressed(core, meeting, "answer")).judged();

      expect(turnedOf(after).map((each) => each.words)).toEqual([line]);
      expect(after.text.split("\n")[0]).toBe(`★ ${line}`);
    },
  );

  /** Real replies a model wrote in today's form during a development trial (the pinned fixture). */
  const SAVED: Record<"English" | "Chinese", string> = (() => {
    const saved: { kind: string; text: string }[] = JSON.parse(
      readFileSync(join(__dirname, "../fixtures/callHelp/savedReplies.json"), "utf8"),
    );
    const first = (chinese: boolean) =>
      saved.find(
        (each) =>
          each.kind === "answer" &&
          /\p{Script=Han}/u.test(each.text) === chinese &&
          each.text.split("\n")[0]?.includes("[^1]") === true,
      )?.text ?? "";
    return { English: first(false), Chinese: first(true) };
  })();

  /** The Answer read with main's reader, or with the form's: what each place should get. */
  const readWith = (answer: ConversationAnswer, form: boolean) =>
    helpReplyRead(answer.text, {
      ...helpLayout("answer", {
        status: answer.status,
        textBehind: false,
        ...(form && { form: "fact lines" as const }),
        closingLine: form && answer.steps?.closingLine === true,
      }),
      quoteOf: (marker) => {
        const citation = answer.citations.find((each) => each.marker === marker);
        return citation && !isTranscriptLocation(citation.location) ? citation.quote : null;
      },
    });
  const shownOf = (
    read: Pick<ReturnType<typeof helpReplyRead>, "lead" | "options" | "opening" | "closing">,
  ) => ({
    lead: read.lead,
    options: read.options,
    opening: read.opening,
    closing: read.closing,
  });

  // protects=every place that reads a press's Answer reads it by what the Answer says, never by the build: an Answer saved without the value (a real reply in today's form) is kept by main's reader at the core's settle and read with main's reader by the panel, Pin, Add to note and the evaluation, and a form Answer with the form's, in English and Chinese, finished and stopped; Check again or Check the rest sends the text kept and leaves both values as the first save and the end wrote them; fails_when=any place reads an Answer in the other form, or a value is written again; no_claim=what the check decides.
  test.each(
    (["English", "Chinese"] as const).flatMap((language) =>
      ([false, true] as const).flatMap((stop) =>
        (["main", "form"] as const).map((kind) => ({ language, stop, kind })),
      ),
    ),
  )(
    "in $language, stopped $stop, a $kind Answer is read as it says",
    async ({ language, stop, kind }) => {
      const form = kind === "form";
      const reply = form ? CLOSING[language].reply : SAVED[language];
      expect(reply).not.toBe("");
      const firstOption = reply.slice(0, reply.indexOf("\n\n"));
      const pause = pausedAfter(firstOption.length);
      const { core, meeting } = await setUp(
        { reply, ...(stop && { pause: pause.pause }) },
        undefined,
        undefined,
        form ? "fact lines" : undefined,
      );
      let answer: ConversationAnswer;
      if (stop) {
        const shown = (firstOption.split("\n")[0] ?? "").replace(/^★ /, "").slice(0, 12);
        answer = (await stoppedAt(core, meeting, pause.isReached, shown)).after;
        expect(answer.status).toBe("stopped");
      } else {
        answer = await (await pressed(core, meeting, "answer")).judged();
        expect(answer.status).toBe("done");
      }

      // The value, from the first save.
      expect(answer.steps?.askedInForm).toBe(form ? true : undefined);
      expect(answerHelpForm(answer.steps, "answer")).toBe(form ? "fact lines" : undefined);
      // The core's settle kept the text its reader reads: read again, it is the same.
      expect(readWith(answer, form).text).toBe(answer.text);
      expect(/^\s*[>=＞＝]\s/mu.test(answer.text)).toBe(false);
      // The panel, Pin and Add to note, and the evaluation, each with that reader.
      const expected = shownOf(readWith(answer, form));
      expect(helpParts(answer, "answer")).toEqual(expected);
      expect(shownOf(keptHelpReading(answer, "answer"))).toEqual(expected);
      expect(helpToKeep(answer, "answer")).toBe(!stop);
      if (!stop) {
        expect(shownOf(readWith(answer, !form))).not.toEqual(expected);
        expect(paragraphsOf(answer).length).toBeGreaterThan(0);
      }
      // Check again (or Check the rest) sends the text kept and writes neither value again.
      const ids = { conversationId: answer.conversationId, answerId: answer.id };
      await core.checkAnswerAgain(ids);
      const again = await answerJudged(core, ids.conversationId, ids.answerId);
      expect(again.text).toBe(answer.text);
      expect(again.steps?.askedInForm).toBe(answer.steps?.askedInForm);
      expect(again.steps?.closingLine).toBe(answer.steps?.closingLine);
      expect(helpParts(again, "answer").options.length).toBe(expected.options.length);
    },
  );

  const OPENING = {
    English: [
      "> Enterprise is $45 per seat a month, with single sign-on [^1]",
      "★ Yes, Enterprise is $45 a seat",
      "→ answers at once",
      "",
      "I'll send the price sheet today",
      "→ buys time",
    ].join("\n"),
    Chinese: [
      "＞ 企业版每个席位每月 45 美元，含单点登录 [^1]",
      "★ 是的，企业版每个席位 45 美元",
      "→ 直接回答",
      "",
      "我今天把价目表发给你",
      "→ 争取时间",
    ].join("\n"),
  };

  // protects=what the panel draws of a form Answer opened again after a version whose save dropped both values (it reads only the steps it knows): main's reader, the text kept unchanged, two options, the ★ one first; a closing line reads as a third option the panel doesn't show, its Citations all still shown at their judged places; an opening fact line reads as an option the panel doesn't show, so its Citation and ✓ go from the panel; in English and Chinese; fails_when=what is drawn changes; no_claim=whether that is acceptable, which the product side decides.
  test.each(
    (["English", "Chinese"] as const).flatMap((language) =>
      (["closing", "opening"] as const).map((shape) => ({ language, shape })),
    ),
  )(
    "in $language, a form Answer with its $shape line that lost both values reads as a main-form Answer",
    async ({ language, shape }) => {
      const reply = shape === "closing" ? CLOSING[language].reply : OPENING[language];
      const { core, meeting } = await setUp({ reply }, undefined, undefined, "fact lines");
      const answer = await (await pressed(core, meeting, "answer")).judged();
      expect(answer.steps?.askedInForm).toBe(true);
      expect(answer.steps?.closingLine).toBe(shape === "closing" ? true : undefined);
      const { askedInForm: _form, closingLine: _closing, ...earlier } = answer.steps ?? {};
      const opened = { ...answer, steps: earlier as ConversationAnswer["steps"] };

      const asForm = helpParts(answer, "answer");
      const asMain = helpParts(opened, "answer");
      const chips = (parts: typeof asForm) =>
        [
          ...parts.opening,
          ...parts.options.flatMap((item) => [
            item.lead,
            ...item.notes,
            item.effect ?? [],
            ...item.after,
          ]),
          ...parts.closing,
        ]
          .flat()
          .flatMap((piece) =>
            piece.kind === "citation"
              ? [
                  {
                    marker: piece.marker,
                    at: piece.at,
                    passed: answer.citations.some(
                      (one) => one.marker === piece.marker && sentencePassed(one, piece.at),
                    ),
                  },
                ]
              : [],
          );
      const linesOf = (parts: typeof asForm) =>
        [
          ...parts.opening,
          ...parts.options.flatMap((item) => [
            item.lead,
            ...item.notes,
            ...item.own,
            item.effect ?? [],
            ...item.after,
          ]),
          ...parts.closing,
        ]
          .map(words)
          .filter((line) => line !== "")
          .sort();
      // The text kept is the same; main's reader shows two options, the ★ one first.
      expect(readWith(opened, false).text).toBe(answer.text);
      expect(asMain.opening).toEqual([]);
      expect(asMain.closing).toEqual([]);
      expect(asMain.options).toHaveLength(2);
      const own = shape === "closing" ? CLOSING[language].closing : null;
      const fact = linesOf(asForm).find((line) => !linesOf(asMain).includes(line));
      if (shape === "closing") {
        // The closing line reads as a third option, which the panel doesn't show; no Citation goes.
        expect(fact).toBe(own);
        expect(chips(asMain)).toEqual(chips(asForm));
      } else {
        // The opening fact line reads as an option before the ★ one, which the panel doesn't show:
        // its Citation and its ✓ go from the panel (they stay in the text kept and the Note).
        expect(fact).toBe(words(asForm.opening[0]));
        expect(chips(asForm)).toEqual([{ marker: 1, at: 0, passed: true }]);
        expect(chips(asMain)).toEqual([]);
      }
    },
  );

  /** Tries a press's Answer again and waits until it has ended and its sentences are judged. */
  async function triedAgain(core: Core, answer: ConversationAnswer) {
    const ids = { conversationId: answer.conversationId, answerId: answer.id };
    await core.regenerateConversationAnswer(ids);
    await vi.waitFor(
      async () =>
        expect((await answerOf(core, ids.conversationId, ids.answerId)).status).toBe("done"),
      { timeout: 20_000, interval: 5 },
    );
    return answerJudged(core, ids.conversationId, ids.answerId);
  }
  const FORM_WORDS = 'on a line of its own starting with "> "';

  // protects=trying a press's Answer again is a new asking: asked in the form the app asks in now and saved so in the save that empties it, in both directions; an Answer first asked as today and tried again in a form build is asked in the form's words, says so, and is read with the form's reader; a form Answer with a closing line tried again in a build that asks as today says neither value and is read as today; in English and Chinese; fails_when=a retry keeps the first asking's form, or an old closing line sits on new words; no_claim=what the model writes.
  test.each(["English", "Chinese"] as const)("in %s, trying again asks anew", async (language) => {
    const { reply, begun } = CLOSING[language];
    let asking: CallHelpForm | undefined;
    const given: Marking = { reply };
    const { core, meeting, calls } = await setUp(given, undefined, undefined, () => asking);

    const today = await (await pressed(core, meeting, "answer")).judged();
    expect(calls.at(-1)?.prompt).not.toContain(FORM_WORDS);
    expect(today.steps?.askedInForm).toBeUndefined();
    asking = "fact lines";
    const inForm = await triedAgain(core, today);
    expect(calls.at(-1)?.prompt).toContain(FORM_WORDS);
    expect(inForm.steps?.askedInForm).toBe(true);
    expect(inForm.steps?.closingLine).toBe(true);
    expect(helpParts(inForm, "answer")).toEqual(shownOf(readWith(inForm, true)));

    // The save that empties it for the new asking leaves no closing line on the new words.
    asking = undefined;
    let release = () => {};
    const held = pausedAfter(reply.indexOf(begun));
    given.pause = {
      ...held.pause,
      until: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const ids = { conversationId: inForm.conversationId, answerId: inForm.id };
    await core.regenerateConversationAnswer(ids);
    await held.isReached;
    const writing = await answerOf(core, ids.conversationId, ids.answerId);
    expect(writing.status).toBe("streaming");
    expect(writing.steps?.closingLine).toBeUndefined();
    expect(writing.steps?.askedInForm).toBeUndefined();
    release();
    await vi.waitFor(
      async () =>
        expect((await answerOf(core, ids.conversationId, ids.answerId)).status).toBe("done"),
      { timeout: 20_000, interval: 5 },
    );
    const back = await answerJudged(core, ids.conversationId, ids.answerId);
    expect(calls.at(-1)?.prompt).not.toContain(FORM_WORDS);
    expect(back.steps?.askedInForm).toBeUndefined();
    expect(back.steps?.closingLine).toBeUndefined();
    expect(helpParts(back, "answer")).toEqual(shownOf(readWith(back, false)));
  });

  // protects=the restart a press makes while it waits for its model is no new asking: while the reply is written its Answer already says it was asked in the form, as its first save set it, and has no closing line yet; in English and Chinese; fails_when=the value is lost or a closing line is there before the reply ends; no_claim=none beyond protects.
  test.each(["English", "Chinese"] as const)(
    "in %s, the restart inside one press keeps the value",
    async (language) => {
      const { reply, begun } = CLOSING[language];
      const pause = pausedAfter(reply.indexOf(begun));
      const { core, meeting } = await setUp(
        { reply, pause: pause.pause },
        undefined,
        undefined,
        "fact lines",
      );
      const { before } = await stoppedAt(
        core,
        meeting,
        pause.isReached,
        reply.split("\n")[0]?.replace(/^★ /, "").slice(0, 12) ?? "",
      );
      expect(before.status).toBe("streaming");
      expect(before.steps?.askedInForm).toBe(true);
      expect(before.steps?.closingLine).toBeUndefined();
    },
  );
});
