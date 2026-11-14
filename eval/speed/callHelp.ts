/**
 * The call-help set of a paired run (README.md › Paired runs › The call-help set): a help button
 * pressed during a call (#2526), as the floating panel presses it. Each case is a Meeting of its
 * own, recording, in a Library of only the case's Documents. Its live Transcript is heard through
 * the fake capture and engine the tests use, one line a turn, the User's on the microphone and the
 * other side's on the computer's sound, so the press reads it as the app does. From the press:
 * the first sign, the first words the panel shows, its first whole option and the end; each
 * request the press made, with its reasoning; whether the reply gives what the case expects and
 * cites the line it rests on; and every sentence a found Citation backs whose quote doesn't say it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, type LanguageModel } from "ai";
import type {
  ConversationAnswer,
  ConversationAskResult,
  Core,
  CoreAdapters,
  MeetingHelpKind,
} from "../../src/core";
import { toolTextIn } from "../../src/core/answers/toolText";
import { createFakeCapture, type FakeCapture } from "../../src/core/meetings/fakeCapture";
import type { TimingOutcome } from "../../src/core/timing/timings";
import { citationNumbers } from "../../src/renderer/src/helpReply";
import { quoteState } from "../../src/shared/helpQuotes";
import { type ReplyItem, readHelpReply, shownItems } from "../../src/shared/helpReplyRead";
import { isTranscriptLocation } from "../../src/shared/locations";
import { HELP_SHAPE, type HelpShape } from "../../src/shared/meetingHelp";
import { normaliseText } from "../../src/shared/text";
import { queryDatabase } from "../../tests/helpers/core";
import {
  inProcessTranscriber,
  NO_TRANSCRIPTION_FILES,
  until,
} from "../../tests/helpers/transcription";
import type { EvalDocument } from "../lib/evaluationSet";
import { openLibrary } from "../lib/library";
import { citationsAsked } from "./arms";
import {
  CALL_HELP_CASES,
  type CallHelpCase,
  type CallTurn,
  callOf,
  TRANSCRIPT,
} from "./callHelpCases";
import { CALL_HELP_CHECKS } from "./callHelpChecks";
import { CALL_HELP_DOCUMENTS } from "./callHelpDocuments";
import { CALL_HELP_FRESH } from "./callHelpFresh";
import { CALL_HELP_HELD_OUT } from "./callHelpHeldOut";
import { CALL_HELP_MARKS } from "./callHelpMarks";
import { CALL_HELP_MARKS_3 } from "./callHelpMarks3";
import { JUDGE_FAILED } from "./callHelpMarksReport";
import { CALL_HELP_TYPED } from "./callHelpTyped";
import { CALL_HELP_TYPED_FRESH } from "./callHelpTypedFresh";
import { CALL_HELP_TYPED_FRESH2 } from "./callHelpTypedFresh2";
import {
  type GroupOptions,
  type Measured,
  NOTHING,
  type OpenedGroup,
  type PairedGroup,
  type RequestTiming,
} from "./paired";

const STEP_MS = 500;
/**
 * Quiet after a turn: the fake engine ends a line after half a second of it, and the Meeting lets
 * its tracks out 0.3 s behind the newest audio (src/core/meetings/tracks.ts).
 */
const PAUSE_MS = 1200;
/** The longest a turn is heard: under the 30 s the live text may fall behind the audio. */
const LONGEST_TURN_MS = 20_000;
const ANSWER_TIMEOUT_MS = 3 * 60_000;
/** The longest a press waits after its reply's end for every mark to settle (#2847). */
const MARKS_MS = 60_000;

/**
 * The reply's end, then every mark settled, read on the stored reply; rejects when they haven't
 * settled `MARKS_MS` after the end, so the press fails to run.
 */
export function replyEnded(
  core: Core,
  conversationId: string,
  answerId: string,
): Promise<"finished" | "failed"> {
  const settled = async () => {
    const deadline = performance.now() + MARKS_MS;
    for (;;) {
      const { messages } = await core.getConversation(conversationId);
      const answer = messages.find((message) => message.id === answerId);
      if (answer?.kind === "answer" && !answer.citations.some((each) => each.check === "checking"))
        return;
      if (performance.now() > deadline)
        throw new Error(`Its marks hadn't settled ${MARKS_MS / 1000} s after the reply ended.`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return new Promise((resolve, reject) => {
    const stops = [
      core.on("answer.finished", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        settled().then(() => resolve("finished"), reject);
      }),
      core.on("answer.failed", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve("failed");
      }),
    ];
  });
}

/** How long a turn takes to say: about 2.5 English words or 4.5 Chinese characters a second. */
function spokenMs(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text
    .replace(/\p{Script=Han}/gu, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.min(LONGEST_TURN_MS, Math.max(1500, Math.round((words / 2.5 + han / 4.5) * 1000)));
}

/** The fake capture and engine of one call: the engine says the case's lines in turn on each side. */
export function callRig(turns: readonly CallTurn[]) {
  const capture = createFakeCapture();
  const host = inProcessTranscriber({
    lines: turns.filter((turn) => turn.who === "me").map((turn) => turn.text),
    theirLines: turns.filter((turn) => turn.who === "them").map((turn) => turn.text),
    maxSpeechMs: LONGEST_TURN_MS + 1000,
    // Partial words come from the streaming model: otherwise a turn longer than a partial's 2.5 s
    // is decoded again for each partial, each decode says the next line, and the call is heard
    // out of order, some lines twice and others never.
    live: true,
  });
  return {
    capture,
    adapters: {
      audioCapture: capture,
      transcriber: host.transcriber,
      transcriptionModelSource: NO_TRANSCRIPTION_FILES,
      transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    },
  };
}

/** Both sides heard for `ms`: `speaking` says something, the other is quiet; none: both quiet. */
function hear(capture: FakeCapture, ms: number, speaking: "microphone" | "system" | null) {
  for (let at = 0; at < ms; at += STEP_MS) {
    const step = Math.min(STEP_MS, ms - at);
    capture.push("microphone", step, speaking !== "microphone");
    capture.push("system", step, speaking !== "system");
  }
}

/** Starts the case's Meeting and says its call, waiting for each line to be written. */
export async function recordCall(
  core: Core,
  capture: FakeCapture,
  turns: readonly CallTurn[],
  folderId?: string,
) {
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  const meeting = await core.createMeeting(folderId === undefined ? undefined : { folderId });
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  for (const [index, turn] of turns.entries()) {
    hear(capture, spokenMs(turn.text), turn.who === "me" ? "microphone" : "system");
    hear(capture, PAUSE_MS, null);
    await until(core, meeting.id, (transcript) => transcript.lines >= index + 1);
  }
  return meeting;
}

const comparable = (text: string) =>
  normaliseText(text)
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");

/**
 * Its quote was found where it points: on main's path its check says so, and where its sentence is
 * then judged (#2847), that judgement's result stands in its place.
 */
export const quoteFound = (citation: Pick<ConversationAnswer["citations"][number], "check">) =>
  citation.check !== "not-found" && citation.check !== "cant-check";

/** A found Citation quotes this line: its quote is in the line, or holds it. */
export function quotes(
  citation: Pick<
    ConversationAnswer["citations"][number],
    "check" | "location" | "documentName" | "quote"
  >,
  rest: { in: string; line: string },
) {
  if (!quoteFound(citation)) return false;
  const where =
    rest.in === TRANSCRIPT
      ? isTranscriptLocation(citation.location)
      : citation.documentName === rest.in.replace(/\.md$/, "");
  const quote = comparable(citation.quote);
  const wanted = comparable(rest.line);
  return where && quote.length >= 6 && (wanted.includes(quote) || quote.includes(wanted));
}

type CitationPiece = Extract<ReplyItem["lead"][number], { kind: "citation" }>;

/** The reply as the panel shows it: each item's lines, each Citation as `label` writes it. */
function labelledReply(
  answer: Pick<ConversationAnswer, "figures">,
  items: readonly ReplyItem[],
  label: (piece: CitationPiece) => string,
) {
  const text = (pieces: ReplyItem["lead"]) =>
    pieces
      .map((piece) =>
        piece.kind === "text"
          ? piece.text
          : piece.kind === "figure"
            ? (answer.figures.find((each) => each.marker === piece.marker)?.shown ?? "")
            : label(piece),
      )
      .join("")
      .trim();
  return items
    .map((item) =>
      [
        `${item.recommended ? "★ " : ""}${text(item.lead)}`,
        ...item.notes.map(text),
        ...(item.effect ? [`→ ${text(item.effect)}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}

/** The reply as the panel shows it: each item's lines, its Citations by the numbers they show with. */
export const shownReply = (
  answer: Pick<ConversationAnswer, "figures">,
  items: readonly ReplyItem[],
  numbers: ReadonlyMap<number, number>,
) =>
  labelledReply(answer, items, (piece) =>
    numbers.has(piece.marker) ? `[${numbers.get(piece.marker)}]` : "",
  );

/** Where a Citation shows in a reply: its marker, and its place among the reply's (`at`). */
export type CitedPlace = Pick<CitationPiece, "marker" | "at">;

/**
 * The reply as a typed question's judge reads it (#2925): each place a Citation shows, of those
 * `shows`, numbered on its own in reading order, so the sentence the judge lists is the one whose
 * ✓ is counted. Numbered by Citation, a ✓ beside one sentence counted for another that carries the
 * same Citation.
 */
export function placedReply(
  answer: Pick<ConversationAnswer, "figures">,
  items: readonly ReplyItem[],
  shows: (marker: number) => boolean,
): { text: string; places: CitedPlace[] } {
  const places: CitedPlace[] = [];
  const text = labelledReply(answer, items, (piece) => {
    if (!shows(piece.marker)) return "";
    places.push({ marker: piece.marker, at: piece.at });
    return `[${places.length}]`;
  });
  return { text, places };
}

/** The places the judge listed (by `placedReply`'s numbers) that show ✓ (`checked`). */
export const unstatedChecked = (
  places: readonly CitedPlace[],
  listed: readonly number[],
  checked: (place: CitedPlace) => boolean,
): CitedPlace[] =>
  [...new Set(listed)].flatMap((number) => places[number - 1] ?? []).filter(checked);

const JUDGE_LINES = [
  "<expected> says what a right reply gives; <avoid>, when there is one, what it must not give as so. <call> holds the newest lines of the call.",
  "Grade it: right when it gives what <expected> says, in any wording or language (an option to say counts when what it would have the User say carries it); partly when it gives only some of it, or adds something the Documents or the call contradict; wrong when it gives something else, misses it, or gives what <avoid> names.",
  "Then read each sentence that carries a Citation number [n] against the words that Citation quotes, in <citations>: list n when the sentence states as so something its quoted words don't say, such as a figure, a term, a yes, or a claim it calls supported.",
  'Reply with JSON and nothing else: {"grade": "right" | "partly" | "wrong", "unstated": [n, ...]}',
];
const JUDGE = [
  "You grade a reply that helps the User during a live call: they pressed a button and read the reply in a second or two while the call goes on.",
  ...JUDGE_LINES,
].join("\n");
/** For a question the User typed during the call (#2925), which <question> holds. */
const JUDGE_TYPED = [
  "You grade a reply that helps the User during a live call: they typed the question in <question> and read the reply in a second or two while the call goes on.",
  "<typed-before>, when there is one, is the question they typed just before it, which <question> follows up.",
  ...JUDGE_LINES,
].join("\n");

export interface Judged {
  grade: "right" | "partly" | "wrong" | "unread";
  unstated: number[];
}

/** The judge's grade and the numbers it lists, or null when its reply holds no such JSON. */
export function readJudged(text: string): Judged | null {
  try {
    const read: unknown = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
    if (typeof read !== "object" || read === null || !("grade" in read)) return null;
    const grade =
      read.grade === "right" || read.grade === "partly" || read.grade === "wrong"
        ? read.grade
        : "unread";
    const unstated =
      "unstated" in read && Array.isArray(read.unstated)
        ? read.unstated.filter((n): n is number => typeof n === "number")
        : [];
    return { grade, unstated };
  } catch {
    return null;
  }
}

async function judge(
  model: LanguageModel,
  each: CallHelpCase,
  newest: readonly CallTurn[],
  reply: string,
  cited: readonly string[],
): Promise<Judged> {
  const instructions = each.typed ? JUDGE_TYPED : JUDGE;
  const prompt = [
    ...(each.typed?.follows ? [`<typed-before>${each.typed.follows}</typed-before>`] : []),
    each.typed ? `<question>${each.typed.question}</question>` : `<button>${each.kind}</button>`,
    "<call>",
    ...newest.map((turn) => `${turn.who === "me" ? "The User" : "The other side"}: ${turn.text}`),
    "</call>",
    `<expected>${each.answer}</expected>`,
    ...(each.avoid ? [`<avoid>${each.avoid}</avoid>`] : []),
    "<reply>",
    reply,
    "</reply>",
    "<citations>",
    ...cited,
    "</citations>",
  ].join("\n");
  const first = await generateText({
    model,
    instructions,
    prompt,
    maxOutputTokens: 400,
    maxRetries: 1,
  });
  const judged = readJudged(first.text);
  if (judged) return judged;
  // A judge that answered in prose is asked once more for the JSON alone, its reasons kept. Claude
  // Opus 5.5 can't stop thinking, and its thinking can take all of a 400-token reply: asked again,
  // it needs the room to think and still answer (#2701).
  const again =
    first.text.trim() === ""
      ? await generateText({
          model,
          instructions,
          prompt,
          maxOutputTokens: 1_200,
          maxRetries: 1,
        })
      : await generateText({
          model,
          instructions,
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: first.text },
            { role: "user", content: "Now give only the JSON object, as the instructions say." },
          ],
          maxOutputTokens: 200,
          maxRetries: 1,
        });
  const read = readJudged(again.text);
  if (read) return read;
  console.error(
    again.text.trim() === ""
      ? `The judge's reply was empty twice (${again.finishReason}).`
      : `The judge's reply couldn't be read: ${again.text.slice(0, 200)}`,
  );
  return { grade: "unread", unstated: [] };
}

interface TimingRow {
  kind: "model" | "local";
  step: string | null;
  model_id: string;
  reasoning: string | null;
  started_at: string;
  first_byte_ms: number | null;
  first_reasoning_ms: number | null;
  first_text_ms: number | null;
  first_tool_ms: number | null;
  end_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  outcome: TimingOutcome;
}

/** What the press asked of models and did on this computer, from the core's own timing records. */
export function requestsSince(dataDir: string, since: string): RequestTiming[] {
  const from = Date.parse(since);
  return queryDatabase<TimingRow>(
    dataDir,
    "SELECT * FROM ai_timings WHERE started_at >= ? ORDER BY started_at, rowid",
    [since],
  ).map((row) => ({
    kind: row.kind,
    step: row.step,
    model: row.model_id,
    reasoning: row.reasoning,
    startMs: Date.parse(row.started_at) - from,
    firstByteMs: row.first_byte_ms,
    firstReasoningMs: row.first_reasoning_ms,
    firstTextMs: row.first_text_ms,
    firstToolMs: row.first_tool_ms,
    endMs: row.end_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    outcome: row.outcome,
  }));
}

/** How the panel lays a case's measured reply out: its button's, or a typed question's (#2925). */
const shapeOf = (each: CallHelpCase) => HELP_SHAPE[each.typed ? "question" : each.kind];

/**
 * Whether the panel shows a whole item of the reply yet: an option or reading with its "→" line,
 * or a short line or sentence once another follows it or the reply ends.
 */
function wholeShown(shape: HelpShape, shown: readonly ReplyItem[], streaming: boolean): boolean {
  const [first] = shown;
  if (first === undefined) return false;
  const lines = shape === "lines" || (shape === "answer" && !shown.some((item) => item.effect));
  return lines ? shown.length > 1 || !streaming : first.effect !== null;
}

/**
 * Presses the case's button and reads what the panel showed, and when. For a typed question, the
 * button's reply is waited for to its marks first, as in a call, its first words and end kept to
 * set beside the question's; then the question it follows up, if any, and the question's reply is
 * the one read.
 */
async function press(
  core: Core,
  each: CallHelpCase,
  meetingId: string,
  begin: () => void,
): Promise<{
  answer: ConversationAnswer;
  firstWordsMs: number | null;
  firstOptionMs: number | null;
  pressedFirst?: NonNullable<Measured["pressedFirst"]>;
  /** What the reply showed before it was written again, oldest first: its text as it last stood. */
  drafts: string[];
  /** The conversation's Answers before the reply, oldest first, as they stand: what it could repeat. */
  earlier: string[];
  /** What each one request for Citations made while the reply was written replied. */
  citationsReplies: string[];
}> {
  let stopPhase: () => void = () => undefined;
  const drafts: string[] = [];
  let answerId: string | null = null;
  let buttonId: string | null = null;
  let buttonAt = 0;
  let buttonEndAt: number | null = null;
  const stopFinished = core.on("answer.finished", (event) => {
    if (event.answerId === buttonId) buttonEndAt ??= performance.now();
  });
  let snapshotting = false;
  let beforeCheck: string | null = null;
  const shape = shapeOf(each);
  /** When each reply first showed words and a whole item, on this computer's clock. */
  const seen = new Map<string, { wordsAt: number | null; optionAt: number | null }>();
  let start = 0;
  let latestText = "";
  const stop = core.on("conversation.message", (message) => {
    if (message.kind !== "answer") return;
    if (message.id === answerId) {
      // Written again, a reply starts over: what it showed before is kept, to tell which step
      // wrote what the User saw.
      if (latestText.trim() !== "" && message.text.length < latestText.length / 2)
        drafts.push(latestText);
      latestText = message.text;
      if (snapshotting) beforeCheck = message.text;
    }
    const at = performance.now();
    const streaming = message.status === "streaming";
    const itsShape = message.id === buttonId ? HELP_SHAPE[each.kind] : shape;
    const shown = shownItems(readHelpReply(message.text), {
      shape: itsShape,
      leadIn: false,
      streaming,
    });
    const times = seen.get(message.id) ?? { wordsAt: null, optionAt: null };
    if (shown.some((item) => item.lead.some((piece) => piece.kind === "text" && piece.text.trim())))
      times.wordsAt ??= at;
    if (wholeShown(itsShape, shown, streaming)) times.optionAt ??= at;
    seen.set(message.id, times);
  });
  const waited = async (asked: ConversationAskResult, what: string) => {
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), ANSWER_TIMEOUT_MS);
    });
    const ended = await Promise.race([
      replyEnded(core, asked.conversation.id, asked.answerId),
      late,
    ]).finally(() => clearTimeout(timer));
    // A reply left running would go on asking the arm's model while the next item runs.
    if (ended === "late") {
      await core.stopConversationAnswer({
        conversationId: asked.conversation.id,
        answerId: asked.answerId,
      });
    }
    if (ended !== "finished") throw new Error(`${what} before the question: ${ended}.`);
  };
  try {
    if (each.typed) {
      buttonAt = performance.now();
      const button = await core.askMeetingHelp({ meetingId, kind: each.kind as MeetingHelpKind });
      if (button.asked) buttonId = button.answerId;
      await waited(button, "The button's reply");
      if (each.typed.follows) {
        await waited(
          await core.askMeetingQuestion({ meetingId, text: each.typed.follows }),
          "The question it follows up",
        );
      }
    }
    begin();
    const askedFrom = citationsAsked.length;
    start = performance.now();
    const asked = each.typed
      ? await core.askMeetingQuestion({ meetingId, text: each.typed.question })
      : await core.askMeetingHelp({ meetingId, kind: each.kind as MeetingHelpKind });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    answerId = asked.answerId;
    // The check of the changes a reply claims runs once it is written: what it shows as it runs
    // is the text before the check, and what the Answer then holds is the text after it.
    stopPhase = core.on("answer.phase", (event) => {
      if (event.answerId !== asked.answerId) return;
      // The check ends when the Answer writes again; what the panel showed until then is the
      // text before the check, and a later check (of the rewritten reply) never replaces it.
      if (event.phase === "checking-claims") {
        if (beforeCheck !== null) return;
        // The panel's text is written in batches of up to 50 ms: taken when the check starts, it
        // can miss the reply's last words, so it follows those batches until the check ends.
        beforeCheck = latestText;
        snapshotting = true;
        return;
      }
      snapshotting = false;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), ANSWER_TIMEOUT_MS);
    });
    const end = await Promise.race([
      replyEnded(core, asked.conversation.id, asked.answerId),
      late,
    ]).finally(() => clearTimeout(timer));
    if (end === "late") {
      await core.stopConversationAnswer({
        conversationId: asked.conversation.id,
        answerId: asked.answerId,
      });
      throw new Error("The reply took too long.");
    }
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    if (answer?.kind !== "answer") throw new Error("No reply.");
    const since = (at: number | null | undefined, from: number) =>
      at === null || at === undefined ? null : at - from;
    const times = seen.get(answer.id);
    const button = buttonId === null ? undefined : seen.get(buttonId);
    if (beforeCheck !== null && answer.text !== beforeCheck)
      rewrittenReplies.push({ item: each.id, before: beforeCheck, after: answer.text });
    return {
      answer,
      firstWordsMs: since(times?.wordsAt, start),
      firstOptionMs: since(times?.optionAt, start),
      drafts,
      earlier: messages.flatMap((message) =>
        message.kind === "answer" && message.id !== answer.id ? [message.text] : [],
      ),
      citationsReplies: citationsAsked.slice(askedFrom),
      ...(buttonId !== null && {
        pressedFirst: {
          firstWordsMs: since(button?.wordsAt, buttonAt),
          doneMs: since(buttonEndAt, buttonAt),
        },
      }),
    };
  } finally {
    stop();
    stopPhase();
    stopFinished();
  }
}

/** The longest a typed question's short reply's item may be and still be read in a second or two. */
const LONGEST_WORDS = 40;
const LONGEST_HAN = 80;

/**
 * Where a typed question's reply left the form its case asks for (#2925), as the panel shows it:
 * more than two items, or an item too long to read in a second or two, for a short reply or
 * options; options without their "→" lines or with no recommended one first; a list with an item
 * missing; its words not in the question's language. Empty for a button's reply.
 */
export function formFailures(each: CallHelpCase, shown: readonly ReplyItem[]): string[] {
  const { typed } = each;
  if (!typed) return [];
  // All the panel shows of an item: its sentence, its notes and its "→" line.
  const words = (item: ReplyItem) =>
    [item.lead, ...item.notes, item.effect ?? []]
      .flat()
      .flatMap((piece) => (piece.kind === "text" ? [piece.text] : []))
      .join(" ");
  const tooLong = shown.some((item) => {
    const text = words(item);
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    const latin = text
      .replace(/\p{Script=Han}/gu, " ")
      .split(/\s+/)
      .filter(Boolean).length;
    return han > LONGEST_HAN || latin > LONGEST_WORDS;
  });
  const all = shown.map(words).join(" ");
  const han = all.match(/\p{Script=Han}/gu)?.length ?? 0;
  const letters = all.match(/[A-Za-z]/g)?.length ?? 0;
  const hanShare = han + letters === 0 ? 0 : han / (han + letters);
  const options =
    shown.length > 0 && shown.every((item) => item.effect !== null) && shown[0]?.recommended;
  return [
    ...(typed.form !== "list" && shown.length > 2 ? ["form-too-many"] : []),
    ...(typed.form !== "list" && tooLong ? ["form-too-long"] : []),
    ...(typed.form === "options" && !options ? ["form-not-options"] : []),
    ...(typed.form === "list" && shown.length < each.rests.length ? ["form-list-short"] : []),
    ...((each.language === "zh-CN" ? hanShare < 0.5 : hanShare > 0.1) ? ["language"] : []),
  ];
}

/** Every reply the change-claim check rewrote, with the text before the check and after it. */
export const rewrittenReplies: { item: string; before: string; after: string }[] = [];

function item(each: CallHelpCase, set: CallHelpSet): PairedGroup["items"][number] {
  return {
    set,
    id: each.id,
    kind: each.typed ? `question-${each.typed.form}` : `${each.kind}-${each.needs}`,
    language: each.language,
    words: "item",
    async run({ library, claimsJudge, meeting, choice }) {
      if (!meeting) throw new Error("The call-help set needs its Meeting.");
      // A press answers on the Answers model the User chose, as the panel's does.
      await library.core.updateSettings({ user: { chatModel: choice } });
      const since = new Date().toISOString();
      // A press that fails keeps its requests, so its record shows whether one of them failed.
      const failed = (message: string): Measured => ({
        ...NOTHING,
        status: "failed",
        error: message,
        requests: requestsSince(library.dataDir, since),
      });
      let pressed: Awaited<ReturnType<typeof press>>;
      try {
        pressed = await press(library.core, each, meeting.id, () => library.timings?.begin());
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
      const {
        answer,
        firstWordsMs,
        firstOptionMs,
        pressedFirst,
        drafts,
        earlier,
        citationsReplies,
      } = pressed;
      const requests = requestsSince(library.dataDir, since);
      const done = answer.status === "done";
      const shown = shownItems(readHelpReply(answer.text), {
        shape: shapeOf(each),
        leadIn: answer.steps?.textBehind === true,
        streaming: false,
      });
      const numbers = citationNumbers(shown, (marker) =>
        answer.citations.some((citation) => citation.marker === marker),
      );
      const citations = [...numbers.keys()].flatMap(
        (marker) => answer.citations.find((citation) => citation.marker === marker) ?? [],
      );
      // A Citation shows ✓ as the panel draws it: on its quote line, where the app found its quote
      // in its place (#2847).
      const showsCheck = (citation: ConversationAnswer["citations"][number]) =>
        quoteState(citation, "done") === "found";
      const found = citations.filter(quoteFound);
      const citationOf = (marker: number) =>
        answer.citations.find((citation) => citation.marker === marker);
      const cites = (number: number, citation: ConversationAnswer["citations"][number]) =>
        `[${number}] ${citation.documentName}: “${citation.quote}” (${quoteFound(citation) ? "found" : citation.check})`;
      const reply = shownReply(answer, shown, numbers);
      // A typed question's judge reads each place a Citation shows on its own (#2925).
      const placed = each.typed
        ? placedReply(answer, shown, (marker) => numbers.has(marker))
        : null;
      let judged: Judged | null = null;
      try {
        judged = done
          ? await judge(
              claimsJudge,
              each,
              [...(each.before ?? []), ...each.turns],
              placed ? placed.text : reply,
              placed
                ? placed.places.flatMap((place, index) => {
                    const citation = citationOf(place.marker);
                    return citation ? [cites(index + 1, citation)] : [];
                  })
                : [...numbers].flatMap(([marker, number]) => {
                    const citation = citationOf(marker);
                    return citation ? [cites(number, citation)] : [];
                  }),
            )
          : null;
      } catch (error) {
        return failed(`${JUDGE_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const markerShownAs = (number: number) =>
        [...numbers].find(([, shown]) => shown === number)?.[0];
      // A ✓ the judge finds unstated: beside the quote line of a place the judge listed, for a
      // typed question; of a Citation it listed, for a button.
      const placeChecked = (place: CitedPlace) => {
        const citation = citationOf(place.marker);
        return citation !== undefined && showsCheck(citation);
      };
      const unstatedFound = placed
        ? unstatedChecked(placed.places, judged?.unstated ?? [], placeChecked).flatMap(
            (place) => numbers.get(place.marker) ?? [],
          )
        : (judged?.unstated ?? []).filter((number) => {
            const marker = markerShownAs(number);
            const citation = marker === undefined ? undefined : citationOf(marker);
            return citation !== undefined && showsCheck(citation);
          });
      return {
        status: done ? "done" : "failed",
        error: done ? null : `${answer.errorKind ?? answer.status}: ${answer.errorMessage ?? ""}`,
        searches: answer.toolCalls.filter((call) => call.tool === "search_documents").length,
        citations: citations.length,
        found: found.length,
        cited: done
          ? each.rests.every((group) =>
              group.some((rest) => found.some((citation) => quotes(citation, rest))),
            )
          : null,
        grade: judged?.grade === "unread" ? null : (judged?.grade ?? null),
        falseSupported: unstatedFound.length,
        duplicate: false,
        failures: [
          ...(toolTextIn(answer.text).length > 0 ? ["tool-text"] : []),
          ...(answer.steps?.textBehind ? ["text-behind"] : []),
          ...(done && shown.length === 0 ? ["nothing-shown"] : []),
          ...(done ? formFailures(each, shown) : []),
        ],
        firstWordsMs,
        firstOptionMs,
        ...(pressedFirst && { pressedFirst }),
        requests,
        // What each Citation rests on, so a reply citing another line than the case's shows as one.
        text: [
          reply,
          ...citations.map(
            (citation) =>
              `[${citation.check}${showsCheck(citation) ? " ✓" : ""}] ${citation.documentName}: “${citation.quote}”`,
          ),
          ...(unstatedFound.length > 0 ? [`[unstated] ${unstatedFound.join(", ")}`] : []),
          // Each place a Citation shows, as the judge numbered it: the panel's number, ✓ there.
          ...(placed && placed.places.length > 0
            ? [
                `[places] ${placed.places
                  .map((place, index) => {
                    const check = placeChecked(place) ? " ✓" : "";
                    const listed = judged?.unstated.includes(index + 1) ? " listed" : "";
                    return `${index + 1}: [${numbers.get(place.marker)}]${check}${listed}`;
                  })
                  .join(", ")}`,
              ]
            : []),
          ...drafts.map((draft) => `[written before] ${draft}`),
          // A typed reply's lines with no Citation, beside the Answers before it, to count the
          // ones that repeat an earlier Answer's fact uncited (#2925).
          ...(each.typed
            ? [
                ...shown
                  .filter(
                    (shownItem) =>
                      ![shownItem.lead, ...shownItem.notes, shownItem.effect ?? []]
                        .flat()
                        .some((piece) => piece.kind === "citation"),
                  )
                  .map(
                    (shownItem) =>
                      `[uncited] ${shownReply(answer, [shownItem], new Map()).replace(/\n/g, " ")}`,
                  ),
                ...earlier.map((text) => `[earlier answer] ${text.replace(/\n+/g, " ")}`),
                ...citationsReplies.map(
                  (reply) => `[citations asked] ${reply.replace(/\n+/g, " ")}`,
                ),
              ]
            : []),
        ].join("\n"),
      } satisfies Measured;
    },
  };
}

/**
 * A call-help case's call heard in a Library of only its Documents, in the case's language: the
 * Library opened, its Meeting recording with every line of the call written.
 */
export async function openCall(
  base: GroupOptions,
  each: CallHelpCase,
  name: string,
  /** What tells the call's speakers apart after Stop; none: the labels stay where lines came from. */
  speakers?: Pick<CoreAdapters, "speakerSeparator" | "speakerModelSource">,
): Promise<OpenedGroup> {
  const turns = callOf(each);
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-paired-call-"));
  const documents: EvalDocument[] = [];
  for (const document of each.documents) {
    const path = join(folder, document.file);
    await writeFile(path, document.text);
    documents.push({ key: document.file, path });
  }
  const rig = callRig(turns);
  const library = await openLibrary({
    ...base,
    name,
    documents,
    meetings: { ...rig.adapters, ...speakers },
  });
  try {
    const { core } = library;
    await core.updateSettings({ user: { language: each.language } });
    await core.setOutputLocation(join(library.dataDir, "Documents", "IncarnaMind"));
    const meeting = await recordCall(core, rig.capture, turns);
    return {
      library,
      meeting,
      async close() {
        await library.close();
        await rm(folder, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await library.close();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

type CallHelpSet =
  | "call-help"
  | "call-help-held-out"
  | "call-help-fresh"
  | "call-help-documents"
  | "call-help-checks"
  | "call-help-marks"
  | "call-help-marks-3"
  | "call-help-typed"
  | "call-help-typed-fresh"
  | "call-help-typed-fresh-2";

const CASES: Readonly<Record<CallHelpSet, readonly CallHelpCase[]>> = {
  "call-help": CALL_HELP_CASES,
  "call-help-held-out": CALL_HELP_HELD_OUT,
  "call-help-fresh": CALL_HELP_FRESH,
  "call-help-documents": CALL_HELP_DOCUMENTS,
  "call-help-checks": CALL_HELP_CHECKS,
  "call-help-marks": CALL_HELP_MARKS,
  "call-help-marks-3": CALL_HELP_MARKS_3,
  "call-help-typed": CALL_HELP_TYPED,
  "call-help-typed-fresh": CALL_HELP_TYPED_FRESH,
  "call-help-typed-fresh-2": CALL_HELP_TYPED_FRESH2,
};

/** One group a case: its own Library, its own Meeting heard before the press. */
export function callHelpSet(set: CallHelpSet = "call-help"): PairedGroup[] {
  return CASES[set].map(
    (each): PairedGroup => ({
      name: `${set}-${each.id}`,
      items: [item(each, set)],
      open: (base) => openCall(base, each, `paired-call-help-${each.id}`),
    }),
  );
}
