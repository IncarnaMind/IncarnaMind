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
  type Core,
  type Meeting,
  type MeetingHelpKind,
} from "../../src/core";
import { sentencePassed } from "../../src/renderer/src/helpReply";
import { pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { answerJudged, shownPassages } from "../helpers/citations";
import { createTempDataFolder, nextTurn, startCore } from "../helpers/core";
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
}

/** A model that records its Citations, writes `reply`, and judges its sentences as `given` says. */
function markingModel(given: Marking, calls: ModelCall[], batches: GenerateCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (call.results.some((result) => result.tool === "cite")) return { text: given.reply };
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

/** A meeting recording, with the price sheet in its Library, its help answered by `given`. */
async function setUp(given: Marking, quoteOnly?: () => boolean) {
  const calls: ModelCall[] = [];
  const batches: GenerateCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(markingModel(given, calls, batches));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    ...(quoteOnly && { helpMarksQuoteOnly: quoteOnly }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
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

const marks = (answer: ConversationAnswer) =>
  answer.citations.map((citation) => ({
    marker: citation.marker,
    check: citation.check,
    passed: sentencePassed(citation),
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

  test("a sentence with a figure marker, which call help never calculates, keeps its Citation plain", async () => {
    const reply = "★ Enterprise is [=1] a seat a month [^1]\n→ answers at once";
    const { core, meeting, batches } = await setUp({ reply });

    const after = await (await pressed(core, meeting, "answer")).judged();

    expect(batches).toHaveLength(0);
    expect(after.citations).toHaveLength(1);
    expect(after.citations.every((citation) => !sentencePassed(citation))).toBe(true);
  });

  test("the next press stops the reply it replaces with its check, which ends with no ✓; its own reply is judged", async () => {
    const hold = holdingFirst();
    const { core, meeting, batches } = await setUp({ reply: ENGLISH, judge: hold.judge });

    const first = await pressed(core, meeting, "answer");
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    const second = await pressed(core, meeting, "say");
    const replaced = await first.judged();
    hold.release();
    await nextTurn();
    const own = await second.judged();

    expect(marks(replaced)).toEqual([{ marker: 1, check: "not-checked", passed: false }]);
    expect(marks(await answerOf(core, first.ids.conversationId, first.ids.answerId))).toEqual([
      { marker: 1, check: "not-checked", passed: false },
    ]);
    expect(marks(own)).toEqual([{ marker: 1, check: "found", passed: true }]);
    expect((await core.listMeetings()).find((each) => each.id === meeting.id)?.help).toMatchObject(
      second.ids,
    );
  });

  test("Stop on the Meeting stops its help reply's check, and Stop on the reply stops its own: no ✓", async () => {
    for (const stopping of ["meeting", "reply"] as const) {
      const hold = holdingFirst();
      const { core, meeting, batches } = await setUp({ reply: ENGLISH, judge: hold.judge });
      const { ids, judged } = await pressed(core, meeting, "answer");
      await vi.waitFor(() => expect(batches).toHaveLength(1));

      if (stopping === "meeting") await core.stopMeeting(meeting.id);
      else await core.stopConversationAnswer(ids);
      const after = await judged();
      hold.release();
      await nextTurn();

      expect(marks(after)).toEqual([{ marker: 1, check: "not-checked", passed: false }]);
      expect(marks(await answerOf(core, ids.conversationId, ids.answerId))).toEqual([
        { marker: 1, check: "not-checked", passed: false },
      ]);
    }
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
    await nextTurn();
    const later = startCore(dataDir, { createChatModel: models.createChatModel });

    expect(marks(await answerOf(later, ids.conversationId, ids.answerId))).toEqual([
      { marker: 1, check: "not-checked", passed: false },
    ]);
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

  // protects=the evaluation's switch to main's path keeps call help's ✓ on a found quote alone and sends no check, so a paired run compares the two paths and nothing else; fails_when=the switch judges the sentences or leaves the Citation checking; no_claim=which path is right (#2847).
  test("with main's path, the evaluation's switch, a found quote is marked found at the end and nothing is judged", async () => {
    const { core, meeting, batches } = await setUp({ reply: ENGLISH }, () => true);

    const { atEnd } = await pressed(core, meeting, "answer");
    await nextTurn();

    expect(atEnd.citations).toMatchObject([{ marker: 1, check: "found" }]);
    expect(atEnd.citations[0]?.judgedAt).toBeUndefined();
    expect(batches).toHaveLength(0);
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
