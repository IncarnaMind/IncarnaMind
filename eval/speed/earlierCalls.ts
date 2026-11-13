/**
 * The earlier-call set of a paired run (#3005, `gates/call-help-earlier-calls.md`): two calls with
 * one buyer, each in a Note of its own in one Folder, the earlier recorded and stopped, the live one
 * recording. On the live call two buttons are pressed and a question about the earlier call is
 * typed in the assistant. A judge reads each reply for what only the earlier call holds given as
 * said in this call (the failure "earlier-as-this"); the typed question's reply must give the
 * earlier call's words as from it, with a found Citation of that call's Transcript (`cited`).
 */
import { generateText, type LanguageModel } from "ai";
import type {
  ConversationAnswer,
  ConversationAskResult,
  Core,
  MeetingHelpKind,
} from "../../src/core";
import {
  callStarts,
  citationNumbers,
  sentencePassed,
  startedLabel,
} from "../../src/renderer/src/helpReply";
import { citedLocation } from "../../src/shared/citations";
import { formatFullDateTime } from "../../src/shared/dates";
import { readHelpReply, shownItems } from "../../src/shared/helpReplyRead";
import { translate } from "../../src/shared/i18n";
import { HELP_SHAPE } from "../../src/shared/meetingHelp";
import { until } from "../../tests/helpers/transcription";
import { openLibrary } from "../lib/library";
import { callRig, quoteFound, recordCall, replyEnded, requestsSince, shownReply } from "./callHelp";
import type { CallTurn } from "./callHelpCases";
import { EARLIER_CALL_PRESSES, type EarlierCallCase } from "./callHelpEarlierCalls";
import { JUDGE_FAILED } from "./callHelpMarksReport";
import { type Dating, type EarlierCallSet, earlierBy, roundCases } from "./earlierCallsRounds";
import { NO_JUDGE } from "./judge";
import type { GroupOptions, Measured, OpenedGroup, PairedGroup, PairedItem } from "./paired";

const ANSWER_TIMEOUT_MS = 120_000;

const JUDGE = [
  "You read a reply that helps the User during a live call, with people they have spoken to before.",
  "<this-call> holds what was said in this call. <earlier-call> holds what an earlier call with the same people said, and when that call started: none of it was said in this call.",
  "earlierAsThis: true when the reply gives anything that only <earlier-call> holds as said, asked or wanted in this call, or as a settled fact, a requirement or where the other side stands, in anyone's voice, the User's included, unless the reply's own words say it comes from the earlier call (last time, before, in that call, on its date). A Citation, or the call its quote is from in <citations>, doesn't say that: only the reply's words do. False otherwise.",
  'thenWithWhen: for <asked kind="last-time">, true when the reply gives at least one thing <earlier-call> holds as said in that call and says when that call was, by its date, its day or its time; false otherwise, and always false for <asked kind="button">.',
  'grade: for <asked kind="button">, right when what the reply gives the User to say fits the newest lines of <this-call> and earlierAsThis is false; partly when it fits only in part; wrong otherwise. For <asked kind="last-time">, right when it gives what <earlier-call> holds as from that call, saying when; partly when only some of it, or without when; wrong when it misses it or gives this call\'s words as the earlier call\'s.',
  "asThisCall: the number n of each sentence carrying a Citation [n] that says the other side said, asked or wants something in this call.",
  "unstated: read each sentence that carries a Citation number [n] against the words that Citation quotes, in <citations>: list n when the sentence states as so something its quoted words don't say.",
  'Reply with JSON and nothing else: {"earlierAsThis": true | false, "thenWithWhen": true | false, "grade": "right" | "partly" | "wrong", "asThisCall": [n, ...], "unstated": [n, ...]}',
].join("\n");

export interface Judged {
  earlierAsThis: boolean;
  thenWithWhen: boolean;
  grade: "right" | "partly" | "wrong";
  asThisCall: number[];
  unstated: number[];
}

const numbersIn = (read: object, key: string): number[] => {
  const value: unknown = key in read ? (read as Record<string, unknown>)[key] : [];
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === "number") : [];
};

/** The judge's reading, or null when its reply holds no such JSON. */
export function readEarlierJudged(text: string): Judged | null {
  try {
    const read: unknown = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
    if (typeof read !== "object" || read === null) return null;
    if (!("earlierAsThis" in read) || typeof read.earlierAsThis !== "boolean") return null;
    if (!("thenWithWhen" in read) || typeof read.thenWithWhen !== "boolean") return null;
    if (!("grade" in read)) return null;
    const grade = read.grade;
    if (grade !== "right" && grade !== "partly" && grade !== "wrong") return null;
    return {
      earlierAsThis: read.earlierAsThis,
      thenWithWhen: read.thenWithWhen,
      grade,
      asThisCall: numbersIn(read, "asThisCall"),
      unstated: numbersIn(read, "unstated"),
    };
  } catch {
    return null;
  }
}

const said = (turns: readonly CallTurn[]) =>
  turns.map((turn) => `${turn.who === "me" ? "The User" : "The other side"}: ${turn.text}`);

export async function judge(
  model: LanguageModel,
  each: EarlierCallCase,
  asked: "button" | "last-time",
  earlierStarted: string,
  reply: string,
  cited: readonly string[],
): Promise<Judged> {
  const prompt = [
    `<asked kind="${asked}"></asked>`,
    "<this-call>",
    ...said(each.live.turns),
    "</this-call>",
    `<earlier-call started="${earlierStarted}">`,
    ...said(each.earlier.turns),
    "</earlier-call>",
    "<reply>",
    reply,
    "</reply>",
    "<citations>",
    ...cited,
    "</citations>",
  ].join("\n");
  for (const room of [400, 1_200]) {
    const { text } = await generateText({
      model,
      instructions: JUDGE,
      prompt,
      maxOutputTokens: room,
      maxRetries: 1,
    });
    const judged = readEarlierJudged(text);
    if (judged) return judged;
  }
  throw new Error("its reply couldn't be read twice");
}

/** Asks, waits for the reply's end and its marks, and gives the Answer as it then stands. */
async function asked(core: Core, ask: () => Promise<ConversationAskResult>) {
  const result = await ask();
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ANSWER_TIMEOUT_MS);
  });
  const end = await Promise.race([
    replyEnded(core, result.conversation.id, result.answerId),
    late,
  ]).finally(() => clearTimeout(timer));
  if (end === "late") {
    await core.stopConversationAnswer({
      conversationId: result.conversation.id,
      answerId: result.answerId,
    });
    throw new Error("The reply took too long.");
  }
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No reply.");
  return answer;
}

/** The earlier call: the Meeting in the group that has stopped, its Transcript and its start. */
async function earlierCall(core: Core): Promise<{ transcript: string; startedAt: string }> {
  const stopped = (await core.listMeetings()).find(
    (meeting) => meeting.status !== "recording" && meeting.status !== "paused",
  );
  const transcript = stopped?.transcript?.documentId;
  if (!transcript || !stopped?.startedAt) throw new Error("The earlier call has no Transcript.");
  return { transcript, startedAt: stopped.startedAt };
}

/** A reply as shown and judged: a button's as the panel lays it out, a typed one's as written. */
function readable(answer: ConversationAnswer, kind: MeetingHelpKind | null) {
  if (kind === null) {
    const numbers = new Map(
      answer.citations.map((citation, index) => [citation.marker, index + 1]),
    );
    const text = answer.text.replace(/\[\^(\d+)\]/g, (_, marker: string) => {
      const number = numbers.get(Number(marker));
      return number === undefined ? "" : `[${number}]`;
    });
    const passed = (marker: number) =>
      answer.citations.some(
        (citation) => citation.marker === marker && (citation.passedAt?.length ?? 0) > 0,
      );
    const lines = answer.text.split(/(?<=[.!?。！？])\s+|\n+/).flatMap((line) =>
      [...line.matchAll(/\[\^(\d+)\]/g)].map((match) => {
        const marker = Number(match[1]);
        return { line, marker, passed: passed(marker) };
      }),
    );
    return { text, numbers, passed, lines };
  }
  const shown = shownItems(readHelpReply(answer.text), {
    shape: HELP_SHAPE[kind],
    leadIn: answer.steps?.textBehind === true,
    streaming: false,
  });
  const numbers = citationNumbers(shown, (marker) =>
    answer.citations.some((citation) => citation.marker === marker),
  );
  const places = shown.flatMap((item) =>
    [item.lead, ...item.notes, item.effect ?? []]
      .flat()
      .flatMap((piece) => (piece.kind === "citation" ? [piece] : [])),
  );
  const passed = (marker: number) =>
    places.some((place) => {
      const citation = answer.citations.find((each) => each.marker === marker);
      return (
        place.marker === marker && citation !== undefined && sentencePassed(citation, place.at)
      );
    });
  const lines = shown.flatMap((item) =>
    [item.lead, ...item.notes, item.effect ?? []].flatMap((pieces) => {
      const line = shownReply(
        answer,
        [{ ...item, lead: pieces, notes: [], effect: null }],
        numbers,
      );
      return pieces.flatMap((piece) => {
        if (piece.kind !== "citation") return [];
        const citation = answer.citations.find((each) => each.marker === piece.marker);
        const passed = citation !== undefined && sentencePassed(citation, piece.at);
        return [{ line, marker: piece.marker, passed }];
      });
    }),
  );
  return { text: shownReply(answer, shown, numbers), numbers, passed, lines };
}

function item(
  set: EarlierCallSet,
  each: EarlierCallCase,
  kind: MeetingHelpKind | null,
): PairedItem {
  const id = `${each.id}-${kind ?? "last-time"}`;
  return {
    set,
    id,
    kind: kind ?? "last-time",
    language: each.language,
    words: "answer",
    async run({ library, claimsJudge, meeting, choice }): Promise<Measured> {
      if (!meeting) throw new Error("The earlier-call set needs its live Meeting.");
      const { core } = library;
      await core.updateSettings({ user: { chatModel: choice } });
      const since = new Date().toISOString();
      const failed = (error: string): Measured => ({
        status: "failed",
        error,
        searches: null,
        citations: 0,
        found: 0,
        cited: null,
        grade: null,
        falseSupported: 0,
        duplicate: false,
        failures: [],
        text: "",
        requests: requestsSince(library.dataDir, since),
      });
      let answer: ConversationAnswer;
      try {
        library.timings?.begin();
        if (kind === null) {
          const live = (await core.listMeetings()).find((each) => each.id === meeting.id);
          if (!live) throw new Error("The live call is gone.");
          answer = await asked(core, () =>
            core.askInConversation({ mindId: live.mindId, text: each.lastTime }),
          );
        } else {
          answer = await asked(core, () => core.askMeetingHelp({ meetingId: meeting.id, kind }));
        }
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
      const requests = requestsSince(library.dataDir, since);
      const done = answer.status === "done";
      const { text, numbers, passed, lines } = readable(answer, kind);
      const { transcript: earlier, startedAt: earlierStarted } = await earlierCall(core);
      const meetings = await core.listMeetings();
      const live = meetings.find((each) => each.id === meeting.id);
      const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
        translate(each.language, key, params);
      // The start each cited Transcript shows beside its name, as the panel's sources show it.
      const starts = callStarts(
        [...numbers.keys()].flatMap(
          (marker) => answer.citations.find((each) => each.marker === marker) ?? [],
        ),
        meetings,
        live?.transcript?.documentId ?? null,
      );
      const places = lines.flatMap(({ line, marker, passed: checked }) => {
        const citation = answer.citations.find((each) => each.marker === marker);
        const number = numbers.get(marker);
        if (!citation || number === undefined) return [];
        const call: "this" | "earlier" | "other" =
          citation.documentId === earlier
            ? "earlier"
            : citation.documentId === live?.transcript?.documentId
              ? "this"
              : "other";
        const startedAt = starts.get(citation.documentId);
        const source = [
          String(number),
          citation.documentName,
          citedLocation(citation, t),
          startedAt ? startedLabel(startedAt, t, each.language) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return [
          {
            line,
            number,
            source,
            call,
            quote: citation.quote,
            found: quoteFound(citation),
            passed: checked,
          },
        ];
      });
      const found = answer.citations.filter(quoteFound);
      let judged: Judged | null = null;
      try {
        judged =
          done && claimsJudge !== NO_JUDGE
            ? await judge(
                claimsJudge,
                each,
                kind === null ? "last-time" : "button",
                formatFullDateTime(earlierStarted, each.language),
                text,
                [...numbers].flatMap(([marker, number]) => {
                  const citation = answer.citations.find((each) => each.marker === marker);
                  if (!citation) return [];
                  const call = citation.documentId === earlier ? "the earlier call" : "this call";
                  return [
                    `[${number}] ${citation.documentName} (${call}): “${citation.quote}” (${quoteFound(citation) ? "found" : citation.check})`,
                  ];
                }),
              )
            : null;
      } catch (error) {
        return failed(`${JUDGE_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const markerOf = (number: number) => [...numbers].find(([, shown]) => shown === number)?.[0];
      return {
        status: done ? "done" : "failed",
        error: done ? null : `${answer.errorKind ?? answer.status}: ${answer.errorMessage ?? ""}`,
        searches: answer.toolCalls.filter((call) => call.tool === "search_documents").length,
        citations: answer.citations.length,
        found: found.length,
        cited:
          done && kind === null ? found.some((citation) => citation.documentId === earlier) : null,
        grade: judged?.grade ?? null,
        falseSupported: (judged?.unstated ?? []).filter((number) => {
          const marker = markerOf(number);
          return marker !== undefined && passed(marker);
        }).length,
        duplicate: false,
        failures: judged?.earlierAsThis ? ["earlier-as-this"] : [],
        text,
        requests,
        places,
        ...(judged && {
          callReading: {
            earlierAsThis: judged.earlierAsThis,
            thenWithWhen: judged.thenWithWhen,
            asThisCall: judged.asThisCall,
            earlierStarted: formatFullDateTime(earlierStarted, each.language),
          },
        }),
      };
    },
  };
}

/**
 * The group's Library: the earlier call recorded and stopped, then the live one recording, in one
 * Folder. The earlier call is recorded on the core's clock set back as its case is dated, the live
 * one on today's, or from `at` on, for a test that needs the live call at a time of day.
 */
export async function openEarlierCalls(
  base: GroupOptions,
  each: EarlierCallCase,
  dating: Dating,
  at?: Date,
): Promise<OpenedGroup> {
  const rig = callRig([...each.earlier.turns, ...each.live.turns]);
  const shift = at ? at.getTime() - Date.now() : 0;
  let back = earlierBy(dating);
  const library = await openLibrary({
    ...base,
    name: `paired-earlier-calls-${each.id}`,
    documents: [],
    meetings: rig.adapters,
    now: () => new Date(Date.now() + shift - back),
  });
  try {
    const { core } = library;
    await core.updateSettings({ user: { language: each.language } });
    const folder = await core.createLibraryGroup({ name: each.folder, description: "" });
    const first = await recordCall(core, rig.capture, each.earlier.turns, folder.id);
    await core.stopMeeting(first.id);
    await until(core, first.id, (transcript) => transcript.state === "saved");
    back = 0;
    const meeting = await recordCall(core, rig.capture, each.live.turns, folder.id);
    return { library, meeting, close: () => library.close() };
  } catch (error) {
    await library.close();
    throw error;
  }
}

/** One group a case of the round's set: its own Library with both calls; the buttons, then the question typed. */
export function earlierCallsSet(set: EarlierCallSet = "call-help-earlier-calls"): PairedGroup[] {
  return roundCases(set, new Date()).map(
    ({ each, dating }): PairedGroup => ({
      name: `${set}-${each.id}`,
      items: [...EARLIER_CALL_PRESSES.map((kind) => item(set, each, kind)), item(set, each, null)],
      open: (base) => openEarlierCalls(base, each, dating),
    }),
  );
}
