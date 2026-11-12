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
import type { ConversationAnswer, Core, CoreAdapters, MeetingHelpKind } from "../../src/core";
import { toolTextIn } from "../../src/core/answers/toolText";
import { createFakeCapture, type FakeCapture } from "../../src/core/meetings/fakeCapture";
import type { TimingOutcome } from "../../src/core/timing/timings";
import {
  citationNumbers,
  type ReplyItem,
  readHelpReply,
  sentencePassed,
  shownItems,
} from "../../src/renderer/src/helpReply";
import { isTranscriptLocation } from "../../src/shared/locations";
import { HELP_SHAPE } from "../../src/shared/meetingHelp";
import { normaliseText } from "../../src/shared/text";
import { queryDatabase } from "../../tests/helpers/core";
import {
  inProcessTranscriber,
  NO_TRANSCRIPTION_FILES,
  until,
} from "../../tests/helpers/transcription";
import type { EvalDocument } from "../lib/evaluationSet";
import { openLibrary } from "../lib/library";
import { armNamed } from "./arms";
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
function replyEnded(
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
export async function recordCall(core: Core, capture: FakeCapture, turns: readonly CallTurn[]) {
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  const meeting = await core.createMeeting();
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

/** The reply as the panel shows it: each item's lines, its Citations by the numbers they show with. */
function shownReply(
  answer: ConversationAnswer,
  items: readonly ReplyItem[],
  numbers: ReadonlyMap<number, number>,
) {
  const text = (pieces: ReplyItem["lead"]) =>
    pieces
      .map((piece) =>
        piece.kind === "text"
          ? piece.text
          : piece.kind === "figure"
            ? (answer.figures.find((each) => each.marker === piece.marker)?.shown ?? "")
            : numbers.has(piece.marker)
              ? `[${numbers.get(piece.marker)}]`
              : "",
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

const JUDGE = [
  "You grade a reply that helps the User during a live call: they pressed a button and read the reply in a second or two while the call goes on.",
  "<expected> says what a right reply gives; <avoid>, when there is one, what it must not give as so. <call> holds the newest lines of the call.",
  "Grade it: right when it gives what <expected> says, in any wording or language (an option to say counts when what it would have the User say carries it); partly when it gives only some of it, or adds something the Documents or the call contradict; wrong when it gives something else, misses it, or gives what <avoid> names.",
  "Then read each sentence that carries a Citation number [n] against the words that Citation quotes, in <citations>: list n when the sentence states as so something its quoted words don't say, such as a figure, a term, a yes, or a claim it calls supported.",
  'Reply with JSON and nothing else: {"grade": "right" | "partly" | "wrong", "unstated": [n, ...]}',
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
  const prompt = [
    `<button>${each.kind}</button>`,
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
    instructions: JUDGE,
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
          instructions: JUDGE,
          prompt,
          maxOutputTokens: 1_200,
          maxRetries: 1,
        })
      : await generateText({
          model,
          instructions: JUDGE,
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
function requestsSince(dataDir: string, since: string): RequestTiming[] {
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

/** Presses the case's button and reads what the panel showed, and when. */
async function press(
  core: Core,
  each: CallHelpCase,
  meetingId: string,
  begin: () => void,
): Promise<{
  answer: ConversationAnswer;
  firstWordsMs: number | null;
  firstOptionMs: number | null;
  settledMs: number | null;
}> {
  let stopPhase: () => void = () => undefined;
  let answerId: string | null = null;
  let finishedAt: number | null = null;
  let settledAt: number | null = null;
  const stopFinished = core.on("answer.finished", (event) => {
    if (event.answerId === answerId) finishedAt ??= performance.now();
  });
  let snapshotting = false;
  let beforeCheck: string | null = null;
  const shape = HELP_SHAPE[each.kind];
  const seen = new Map<string, { firstWordsMs: number | null; firstOptionMs: number | null }>();
  let start = 0;
  let latestText = "";
  const stop = core.on("conversation.message", (message) => {
    if (message.kind !== "answer") return;
    latestText = message.text;
    if (snapshotting) beforeCheck = message.text;
    const at = performance.now() - start;
    const shown = shownItems(readHelpReply(message.text), {
      shape,
      leadIn: false,
      streaming: message.status === "streaming",
    });
    const times = seen.get(message.id) ?? { firstWordsMs: null, firstOptionMs: null };
    if (shown.some((item) => item.lead.some((piece) => piece.kind === "text" && piece.text.trim())))
      times.firstWordsMs ??= at;
    const [first] = shown;
    const whole =
      first !== undefined &&
      (shape === "lines"
        ? shown.length > 1 || message.status !== "streaming"
        : first.effect !== null);
    if (whole) times.firstOptionMs ??= at;
    seen.set(message.id, times);
    // Its marks have settled once it has ended and no Citation still waits for its check.
    if (
      message.id === answerId &&
      finishedAt !== null &&
      message.status !== "streaming" &&
      !message.citations.some((citation) => citation.check === "checking")
    ) {
      settledAt ??= performance.now();
    }
  });
  try {
    begin();
    start = performance.now();
    const asked = await core.askMeetingHelp({ meetingId, kind: each.kind as MeetingHelpKind });
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
    const times = seen.get(answer.id) ?? { firstWordsMs: null, firstOptionMs: null };
    if (beforeCheck !== null && answer.text !== beforeCheck)
      rewrittenReplies.push({ item: each.id, before: beforeCheck, after: answer.text });
    // `replyEnded` waits for the marks: none waited when they had settled as the reply ended.
    const settledMs =
      finishedAt === null ? null : settledAt === null ? 0 : Math.max(0, settledAt - finishedAt);
    return { answer, ...times, settledMs };
  } finally {
    stop();
    stopPhase();
    stopFinished();
  }
}

/**
 * What a reply's held Citations show: those with ✓, those the check gave a verdict, and why each
 * of the others shows none: its check, a not-checked one's reason, or "found" for a line the check
 * didn't judge though the Citation's other sentence passed.
 */
function marksOf(
  held: readonly ConversationAnswer["citations"][number][],
  listed: readonly ConversationAnswer["citations"][number][],
  showsCheck: (citation: ConversationAnswer["citations"][number]) => boolean,
  settledMs: number | null,
): Omit<NonNullable<Measured["marks"]>, "judge" | "numbers"> {
  const missed: Record<string, number> = {};
  let checked = 0;
  let judged = 0;
  for (const citation of held) {
    const shows = showsCheck(citation);
    if (shows) checked++;
    if (shows || citation.check === "unsupported" || citation.check === "contradicted") judged++;
    if (shows) continue;
    const why =
      citation.check === "not-checked"
        ? `not-checked:${citation.checkReason ?? "no reason"}`
        : citation.check;
    missed[why] = (missed[why] ?? 0) + 1;
  }
  return {
    held: held.length,
    checked,
    judged,
    missed,
    listed: listed.length,
    listedChecked: listed.filter(showsCheck).length,
    settledMs,
  };
}

/** Every reply the change-claim check rewrote, with the text before the check and after it. */
export const rewrittenReplies: { item: string; before: string; after: string }[] = [];

function item(each: CallHelpCase, set: CallHelpSet): PairedGroup["items"][number] {
  return {
    set,
    id: each.id,
    kind: `${each.kind}-${each.needs}`,
    language: each.language,
    words: "item",
    async run({ library, claimsJudge, meeting, choice, arm }) {
      if (!meeting) throw new Error("The call-help set needs its Meeting.");
      const quoteOnly = armNamed(arm).helpMarksQuoteOnly === true;
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
      const { answer, firstWordsMs, firstOptionMs, settledMs } = pressed;
      const requests = requestsSince(library.dataDir, since);
      const done = answer.status === "done";
      const shown = shownItems(readHelpReply(answer.text), {
        shape: HELP_SHAPE[each.kind],
        leadIn: answer.steps?.textBehind === true,
        streaming: false,
      });
      const numbers = citationNumbers(shown, (marker) =>
        answer.citations.some((citation) => citation.marker === marker),
      );
      const citations = [...numbers.keys()].flatMap(
        (marker) => answer.citations.find((citation) => citation.marker === marker) ?? [],
      );
      const places = shown.flatMap((each) =>
        [each.lead, ...each.notes, each.effect ?? []]
          .flat()
          .flatMap((piece) => (piece.kind === "citation" ? [piece] : [])),
      );
      // A Citation shows ✓ as each arm's panel draws it, on any line it is shown on: main's beside a
      // found quote, the branch's only where the sentence check passed that line's sentence (#2847).
      const showsCheck = (citation: ConversationAnswer["citations"][number]) =>
        quoteOnly
          ? citation.check === "found"
          : places.some(
              (place) => place.marker === citation.marker && sentencePassed(citation, place.at),
            );
      const found = citations.filter(quoteFound);
      const reply = shownReply(answer, shown, numbers);
      let judged: Judged | null = null;
      try {
        judged = done
          ? await judge(
              claimsJudge,
              each,
              [...(each.before ?? []), ...each.turns],
              reply,
              [...numbers].flatMap(([marker, number]) => {
                const citation = answer.citations.find((each) => each.marker === marker);
                return citation
                  ? [
                      `[${number}] ${citation.documentName}: “${citation.quote}” (${quoteFound(citation) ? "found" : citation.check})`,
                    ]
                  : [];
              }),
            )
          : null;
      } catch (error) {
        return failed(`${JUDGE_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const shownAs = (number: number) => {
        const marker = [...numbers].find(([, shown]) => shown === number)?.[0];
        return answer.citations.find((citation) => citation.marker === marker);
      };
      const unstatedFound = (judged?.unstated ?? []).filter((number) => {
        const citation = shownAs(number);
        return citation !== undefined && showsCheck(citation);
      });
      // A judge reply that couldn't be read says nothing of which quotes hold.
      const read = judged !== null && judged.grade !== "unread";
      const foundShown = (listed: boolean) =>
        read
          ? [...numbers.values()].flatMap((number) => {
              const citation = shownAs(number);
              return citation &&
                quoteFound(citation) &&
                judged?.unstated.includes(number) === listed
                ? [citation]
                : [];
            })
          : [];
      const held = foundShown(false);
      const listed = foundShown(true);
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
        ],
        firstWordsMs,
        firstOptionMs,
        requests,
        ...(read &&
          judged && {
            marks: {
              ...marksOf(held, listed, showsCheck, settledMs),
              judge: { grade: judged.grade, unstated: judged.unstated },
              numbers: [...numbers].flatMap(([marker, number]) => {
                const citation = answer.citations.find((each) => each.marker === marker);
                return citation
                  ? [
                      {
                        number,
                        check: citation.check,
                        found: quoteFound(citation),
                        listed: judged.unstated.includes(number),
                        passed: showsCheck(citation),
                      },
                    ]
                  : [];
              }),
            },
          }),
        // What each Citation rests on, so a reply citing another line than the case's shows as one.
        text: [
          reply,
          ...citations.map(
            (citation) =>
              `[${citation.check}${showsCheck(citation) ? " ✓" : ""}] ${citation.documentName}: “${citation.quote}”`,
          ),
          ...(unstatedFound.length > 0 ? [`[unstated] ${unstatedFound.join(", ")}`] : []),
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
  | "call-help-marks-3";

const CASES: Readonly<Record<CallHelpSet, readonly CallHelpCase[]>> = {
  "call-help": CALL_HELP_CASES,
  "call-help-held-out": CALL_HELP_HELD_OUT,
  "call-help-fresh": CALL_HELP_FRESH,
  "call-help-documents": CALL_HELP_DOCUMENTS,
  "call-help-checks": CALL_HELP_CHECKS,
  "call-help-marks": CALL_HELP_MARKS,
  "call-help-marks-3": CALL_HELP_MARKS_3,
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
