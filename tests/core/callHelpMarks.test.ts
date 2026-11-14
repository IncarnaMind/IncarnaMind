/**
 * In call help, a ✓ means the app found a Citation's quote word for word in its Passage, never
 * that a sentence the model wrote was judged (#2847): a press is never judged, each Citation keeps
 * the check its quote got when it was recorded, from the cite on, and the panel draws that quote
 * under the line that cites it. Through the core's public interface, as the floating panel asks and
 * reads; `quoteLines` is the panel's own rule.
 */
import { describe, expect, test, vi } from "vitest";
import {
  CLAIM_CHECK_MARK,
  type ConversationAnswer,
  type Core,
  type Meeting,
  type MeetingHelpKind,
} from "../../src/core";
import { pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { markersOf, momentFound, quoteLines, quoteState } from "../../src/shared/helpQuotes";
import { readHelpReply } from "../../src/shared/helpReplyRead";
import { answerJudged, shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase } from "../helpers/core";
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
/** A quote the sheet doesn't hold. */
const NOWHERE = "Every Enterprise seat comes with free onboarding.";

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
  /** What each marker quotes: the price line found ahead, the call's newest line, or words neither holds. */
  records?: readonly { marker: number; from: "sheet" | "call" | "nowhere" }[];
  verdicts?: readonly [string, Verdict][];
  /** The batch's reply instead of `verdicts`', given theirs: an error, or one held. */
  judge?(call: GenerateCall, judged: { text: string }): GeneratedReply;
  /** The reply's text stops after this many characters, or as many as its text gives, until `until` resolves. */
  pause?: {
    after: number | ((text: string) => number);
    until: Promise<void>;
    reached?: () => void;
  };
  /** What the call says instead of the fake engine's own lines. */
  said?: { lines: readonly string[]; theirLines: readonly string[] };
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
        const { pause } = given;
        if (!pause) return { text };
        const after = typeof pause.after === "number" ? pause.after : pause.after(text);
        return { text, pause: { ...pause, after } };
      }
      const citations = (given.records ?? [{ marker: 1, from: "sheet" }]).flatMap((record) => {
        const passage = record.from === "call" ? heard : sheet;
        if (!passage) return [];
        const quote = record.from === "sheet" ? PRICE : record.from === "call" ? newest : NOWHERE;
        return [{ marker: record.marker, passage: passage.id, quote }];
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
async function setUp(given: Marking, cloud?: string) {
  const calls: ModelCall[] = [];
  const batches: GenerateCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(markingModel(given, calls, batches));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    ...(given.said && { engine: given.said }),
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
  return { core, meeting, calls, batches, dataDir, models, sheet: added.documents[0]?.id ?? "" };
}

async function answerOf(core: Core, conversationId: string, answerId: string) {
  const { messages } = await core.getConversation(conversationId);
  const answer = messages.find((message) => message.id === answerId);
  if (answer?.kind !== "answer") throw new Error("No reply.");
  return answer;
}

/** Presses a button: the reply as it ends, and as it is once nothing more settles on it. */
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

/**
 * A press whose reply's text pauses after `after` characters, once its Citations are recorded: the
 * reply as the panel reads it there, still written, then as it ends.
 */
async function pausedPress(
  given: Omit<Marking, "pause">,
  after: number | ((text: string) => number),
  kind: MeetingHelpKind = "answer",
  meanwhile?: (core: Core, sheet: string) => Promise<void>,
) {
  let release = () => {};
  let reached = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  const there = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const set = await setUp({ ...given, pause: { after, until, reached } });
  const asked = await set.core.askMeetingHelp({ meetingId: set.meeting.id, kind });
  if (!asked.asked) throw new Error("Not asked.");
  await there;
  const ids = { conversationId: asked.conversation.id, answerId: asked.answerId };
  const written = await vi.waitFor(
    async () => {
      const answer = await answerOf(set.core, ids.conversationId, ids.answerId);
      expect(answer.status).toBe("streaming");
      expect(answer.text.length).toBeGreaterThan(0);
      expect(answer.citations.length).toBeGreaterThan(0);
      return answer;
    },
    { timeout: 20_000, interval: 5 },
  );
  await meanwhile?.(set.core, set.sheet);
  release();
  // A quote's check shows from the cite, so the reply reads settled before it ends: wait for its end.
  await vi.waitFor(
    async () =>
      expect((await answerOf(set.core, ids.conversationId, ids.answerId)).status).not.toBe(
        "streaming",
      ),
    { timeout: 20_000, interval: 5 },
  );
  const ended = await answerJudged(set.core, ids.conversationId, ids.answerId);
  return { ...set, written, ended };
}

/** Each Citation's check, and whether its quote line shows ✓ as the panel draws it. */
const marks = (answer: ConversationAnswer) =>
  answer.citations.map((citation) => ({
    marker: citation.marker,
    check: citation.check,
    passed: quoteState(citation, answer.status) === "found",
  }));

/** The quote lines under each line to say, as the panel draws them: their states and markers. */
const quoteRows = (answer: ConversationAnswer) =>
  readHelpReply(answer.text).map((item) =>
    quoteLines(
      markersOf([item.lead]),
      (marker) => answer.citations.find((each) => each.marker === marker),
      answer.status,
    ).map((line) => ({ markers: line.markers, state: line.state })),
  );

const ENGLISH = "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once";
const CHINESE = "★ 是的，企业版每个席位每月 45 美元，含单点登录 [^1]\n→ 直接回答，推进通话";

describe("call help's ✓ comes only from a quote the app found (#2847)", { timeout: 60_000 }, () => {
  // protects=a press is never judged: it sends no request of the sentence check, and each Citation keeps its quote's own check, its quote line ✓ where the quote was found, in English and Chinese; fails_when=a check request goes out for a press, or a Citation waits for one; no_claim=whether the model's sentence says what its quote does.
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("in %s, a press sends no check request and keeps its quote's check", async (_, reply) => {
    const { core, meeting, batches } = await setUp({ reply });
    const { atEnd, judged } = await pressed(core, meeting, "answer");
    const settled = await judged();

    expect(batches).toEqual([]);
    expect(atEnd.citations.map((citation) => citation.check)).toEqual(["found"]);
    expect(settled.citations[0]?.judgedAt).toBeUndefined();
    expect(marks(settled)).toEqual([{ marker: 1, check: "found", passed: true }]);
    expect(quoteRows(settled)).toEqual([[{ markers: [1], state: "found" }]]);
  });

  // protects=a Citation's quote check is the one made when the cite lands, shown while the reply is still written, and the one the end keeps, for a quote found on a Document, one found on the call and one not found, so the ✓ comes with its quote and never moves at the end, in English and Chinese; fails_when=a Citation reads checking while written, or its check at the end differs from the cite's; no_claim=how soon a model cites.
  test.each([
    [
      "English",
      "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nThey asked about the price [^2] [^3]\n→ buys time",
    ],
    [
      "Chinese",
      "★ 是的，企业版每个席位 45 美元 [^1]\n→ 直接回答\n\n他们问了价格 [^2] [^3]\n→ 争取时间",
    ],
  ])("in %s, the cite's check is shown at once and kept at the end", async (_, reply) => {
    const { written, ended } = await pausedPress(
      {
        reply,
        records: [
          { marker: 1, from: "sheet" },
          { marker: 2, from: "call" },
          { marker: 3, from: "nowhere" },
        ],
      },
      reply.length - 4,
    );
    const checks = (answer: ConversationAnswer) =>
      answer.citations.map(({ marker, check, checkReason }) => ({ marker, check, checkReason }));
    expect(checks(written)).toEqual([
      { marker: 1, check: "found", checkReason: null },
      { marker: 2, check: "found", checkReason: null },
      { marker: 3, check: "not-found", checkReason: "quote-not-on-pages" },
    ]);
    expect(checks(ended)).toEqual(checks(written));
    expect(quoteRows(written)).toEqual([
      [{ markers: [1], state: "found" }],
      [
        { markers: [2], state: "found" },
        { markers: [3], state: "not-found" },
      ],
    ]);
  });

  // protects=the first of the two named cases where the end differs from the cite: words the reply puts in quotation marks that its cited place doesn't hold make the number not found at the end, with its reason, while the Citation's own quote keeps the ✓ it had from the cite beneath it, in English and Chinese; fails_when=the quote line loses its ✓, or the number keeps a found look; no_claim=how often a model misquotes.
  test.each([
    [
      "English",
      "★ Enterprise comes with “free onboarding for every single seat” at $45 [^1]\n→ answers at once",
    ],
    // The quoted words in the sheet's own language: in another they would read as a translation.
    ["Chinese", "★ 企业版包含 “free onboarding for every single seat”，45 美元 [^1]\n→ 直接回答"],
  ])(
    "in %s, quoted words the place doesn't hold: the number ends not found, the quote keeps ✓",
    async (_, reply) => {
      const { written, ended } = await pausedPress({ reply }, reply.length - 4);

      expect(written.citations.map(({ check }) => check)).toEqual(["found"]);
      expect(ended.citations.map(({ check, checkReason }) => ({ check, checkReason }))).toEqual([
        { check: "not-found", checkReason: "quoted-words-not-on-pages" },
      ]);
      expect(quoteRows(ended)).toEqual([[{ markers: [1], state: "found" }]]);
    },
  );

  // protects=the second named case: a Document deleted while the reply is written leaves its Citation can't check at the end, the end's check winning over the cite's, and its quote line says so with no ✓; fails_when=the line keeps the ✓ the cite gave a Document that is gone; no_claim=how often a Document goes during a press.
  test("a Document deleted while the reply is written: the end's check, can't check, wins", async () => {
    const { written, ended } = await pausedPress(
      { reply: ENGLISH },
      ENGLISH.length - 4,
      "answer",
      async (core, sheet) => core.deleteDocument(sheet),
    );

    expect(written.citations.map(({ check }) => check)).toEqual(["found"]);
    expect(ended.citations.map(({ check, checkReason }) => ({ check, checkReason }))).toEqual([
      { check: "cant-check", checkReason: "document-removed" },
    ]);
    expect(quoteRows(ended)).toEqual([[{ markers: [1], state: "cant-check" }]]);
  });

  // protects=a number the model writes and never cites shows while the reply is written, with the room its quote would take, and is gone when the reply ends, as on main, its room with it; fails_when=the number stays with no Citation, or its room is left empty; no_claim=how often a model leaves a number uncited.
  test("a number never cited keeps a room while written, and the end takes both away", async () => {
    const reply =
      "★ Yes, Enterprise is $45 a seat [^1], and the launch moves to November [^2]\n→ answers at once";
    const { written, ended } = await pausedPress({ reply }, reply.length - 4);

    expect(written.text).toContain("[^2]");
    expect(quoteRows(written)).toEqual([
      [
        { markers: [1], state: "found" },
        { markers: [2], state: "waiting" },
      ],
    ]);
    expect(ended.text).not.toContain("[^2]");
    expect(quoteRows(ended)).toEqual([[{ markers: [1], state: "found" }]]);
  });

  // protects=a reading's plain moment of the call is read as soon as its line is finished: words the call did say are found then, and words it never said make the number not found then, as the end will, so the ✓ or the call's own words come while the reply is still written, in English and Chinese; fails_when=the moment waits for the reply's end, or reads otherwise than the end; no_claim=how a model words a reading.
  test.each([
    [
      "English",
      "said",
      (heard: string) =>
        `★ They want a lower price\n0:02 “${heard}” [^1]\n→ offer the two-year term`,
    ],
    ["Chinese", "said", (heard: string) => `★ 对方想压价\n0:02 “${heard}” [^1]\n→ 先给阶梯价`],
    [
      "English",
      "never said",
      () =>
        "★ They want a lower price\n0:02 “We will sign this week” [^1]\n→ offer the two-year term",
    ],
    // A Chinese reply on this English call quotes the call's words as said: in Chinese they would
    // read as a translation.
    [
      "Chinese",
      "never said",
      () => "★ 对方想压价\n0:02 “We will sign this week” [^1]\n→ 先给阶梯价",
    ],
  ] as const)(
    "in %s, a moment the call %s is read once its line is finished",
    async (_, said, reply) => {
      const heardOf = (text: string) => /“([^”]*)”/u.exec(text)?.[1] ?? "";
      const { written, ended } = await pausedPress(
        {
          reply,
          records: [{ marker: 1, from: "call" }],
        },
        (text) => text.indexOf("\n→") + 2,
        "want",
      );
      const citation = written.citations[0];
      if (said === "said") {
        expect(citation?.check).toBe("found");
        expect(citation && momentFound(heardOf(written.text), citation)).toBe(true);
        expect(ended.citations[0]?.quotedWordsFound).toEqual(citation?.quotedWordsFound);
      } else {
        expect(citation?.check).toBe("not-found");
        expect(citation?.checkReason).toBe("quoted-words-not-on-pages");
        expect(ended.citations[0]?.checkReason).toBe("quoted-words-not-on-pages");
      }
    },
  );

  test("kept into the Note, a reply carries its quotes' checks, as an Answer added from the assistant does", async () => {
    const reply = `${ENGLISH}\n\nI'll confirm the price in writing today [^2]\n→ buys time`;
    const { core, meeting } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "nowhere" },
      ],
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

    expect(after.citations.map((citation) => citation.check)).toEqual(["found", "not-found"]);
    expect([...new Set(states)].sort()).toEqual([]);
  });
});

/** The text of a note's Blocks, in order. */
const textIn = (nodes: readonly NodeJSON[]): string =>
  nodes.map((node) => `${node.text ?? ""}${textIn(node.content ?? [])}`).join("");

describe("a reply is kept, checked and read again as the panel shows it (#2925)", {
  timeout: 60_000,
}, () => {
  // protects=an option the model wrapped whole in its own quotation marks, its marker inside the marks or after them, in English and Chinese marks, is kept and checked as the panel shows it, so its Citation keeps its found quote's ✓ as a bare option's does; fails_when=the check reads the option's own words as the Document's and shows its Citation not found, or the reply is kept with the marks the panel doesn't show; no_claim=how often a model wraps an option.
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
    "an option wrapped in its own quotation marks, $form, is kept as shown and its quote keeps ✓",
    async ({ reply, kept }) => {
      const { core, meeting } = await setUp({ reply });
      const after = await (await pressed(core, meeting, "answer")).judged();
      expect(after.text).toBe(kept);
      expect(marks(after)).toEqual([{ marker: 1, check: "found", passed: true }]);
    },
  );

  // protects=a reply stored before #2847 whose sentences were left not checked keeps Check the rest after the call has stopped: it judges a wrapped option in the words the panel showed, every place it passes is where it was written, and the note it is then added to holds those words, while a new press is never judged; fails_when=the option goes to the judge or into the note in the model's quotation marks, a passed place moves or is lost, or the press itself sends a check; no_claim=which verdict the judge gives.
  test("after the call stops, Check the rest of a reply stored before and the note read the option as it was shown", async () => {
    const reply = [
      '★ "Yes, Enterprise is $45 a seat with single sign-on [^1]"',
      "→ answers at once",
      "",
      '"I\'ll confirm the Team plan price in writing today [^2]"',
      "→ buys time",
    ].join("\n");
    const { core, meeting, batches, dataDir } = await setUp({
      reply,
      records: [
        { marker: 1, from: "sheet" },
        { marker: 2, from: "sheet" },
      ],
    });
    const first = await (await pressed(core, meeting, "answer")).judged();
    expect(batches).toEqual([]);
    await core.stopMeeting(meeting.id);
    // As a version that judged a press stored it when its checking limit stopped the judging: no
    // operation of this version writes a press's Citation not checked.
    queryDatabase(
      dataDir,
      "UPDATE conversation_messages SET citations = ? WHERE id = ? RETURNING id",
      [
        JSON.stringify(
          first.citations.map((citation) => ({
            ...citation,
            check: "not-checked",
            checkReason: "answer-limit",
          })),
        ),
        first.id,
      ],
    );

    await core.checkAnswerAgain({ conversationId: first.conversationId, answerId: first.id });
    const after = await answerJudged(core, first.conversationId, first.id);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.prompt).toContain("I'll confirm the Team plan price in writing today");
    expect(batches[0]?.prompt).not.toContain("\"I'll confirm");
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

  // protects=words quoted inside an option, not on the cited page, still read as a quotation and make its number not found, in English and Chinese marks, while the Citation's own quote keeps its ✓ beneath; fails_when=the option's own marks taken off hide a quotation inside it; no_claim=what a model quotes.
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
      expect(marks(after)[0]?.passed).toBe(true);
    },
  );
});
