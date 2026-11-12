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
  readHelpReply,
  sentencePassed,
  shownItems,
  startedLabel,
} from "../../src/renderer/src/helpReply";
import { citedLocation } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import { HELP_SHAPE } from "../../src/shared/meetingHelp";
import { until } from "../../tests/helpers/transcription";
import { openLibrary } from "../lib/library";
import { callRig, quoteFound, recordCall, replyEnded, requestsSince, shownReply } from "./callHelp";
import type { CallTurn } from "./callHelpCases";
import {
  EARLIER_CALL_CASES,
  EARLIER_CALL_PRESSES,
  type EarlierCallCase,
} from "./callHelpEarlierCalls";
import type { GroupOptions, Measured, OpenedGroup, PairedGroup, PairedItem } from "./paired";

const ANSWER_TIMEOUT_MS = 120_000;

/** A reply or Answer that couldn't be judged: the item fails to run, as a judge's error is no product's. */
const JUDGE_FAILED = "The judge failed";

const JUDGE = [
  "You read a reply that helps the User during a live call, with people they have spoken to before.",
  "<this-call> holds what was said in this call. <earlier-call> holds what an earlier call with the same people said: none of it was said in this call.",
  "earlierAsThis: true when the reply gives anything that only <earlier-call> holds as said, asked or wanted in this call, or as where the other side stands now, without saying it comes from the earlier call; false otherwise. Giving it as from the earlier call (last time, before, in that call) is fine.",
  'grade: for <asked kind="button">, right when what the reply gives the User to say fits the newest lines of <this-call> and earlierAsThis is false; partly when it fits only in part; wrong otherwise. For <asked kind="last-time">, right when it gives what <earlier-call> holds as from that call; partly when only some of it; wrong when it misses it or gives this call\'s words as the earlier call\'s.',
  "unstated: read each sentence that carries a Citation number [n] against the words that Citation quotes, in <citations>: list n when the sentence states as so something its quoted words don't say.",
  'Reply with JSON and nothing else: {"earlierAsThis": true | false, "grade": "right" | "partly" | "wrong", "unstated": [n, ...]}',
].join("\n");

interface Judged {
  earlierAsThis: boolean;
  grade: "right" | "partly" | "wrong";
  unstated: number[];
}

/** The judge's reading, or null when its reply holds no such JSON. */
export function readEarlierJudged(text: string): Judged | null {
  try {
    const read: unknown = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
    if (typeof read !== "object" || read === null) return null;
    if (!("earlierAsThis" in read) || typeof read.earlierAsThis !== "boolean") return null;
    if (!("grade" in read)) return null;
    const grade = read.grade;
    if (grade !== "right" && grade !== "partly" && grade !== "wrong") return null;
    const unstated =
      "unstated" in read && Array.isArray(read.unstated)
        ? read.unstated.filter((n): n is number => typeof n === "number")
        : [];
    return { earlierAsThis: read.earlierAsThis, grade, unstated };
  } catch {
    return null;
  }
}

const said = (turns: readonly CallTurn[]) =>
  turns.map((turn) => `${turn.who === "me" ? "The User" : "The other side"}: ${turn.text}`);

async function judge(
  model: LanguageModel,
  each: EarlierCallCase,
  asked: "button" | "last-time",
  reply: string,
  cited: readonly string[],
): Promise<Judged> {
  const prompt = [
    `<asked kind="${asked}"></asked>`,
    "<this-call>",
    ...said(each.live.turns),
    "</this-call>",
    "<earlier-call>",
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

/** The earlier call's Transcript: the Meeting in the group that has stopped. */
async function earlierTranscript(core: Core): Promise<string> {
  const stopped = (await core.listMeetings()).find(
    (meeting) => meeting.status !== "recording" && meeting.status !== "paused",
  );
  const id = stopped?.transcript?.documentId;
  if (!id) throw new Error("The earlier call has no Transcript.");
  return id;
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
    const lines = answer.text
      .split(/(?<=[.!?。！？])\s+|\n+/)
      .flatMap((line) =>
        [...line.matchAll(/\[\^(\d+)\]/g)].map((match) => ({ line, marker: Number(match[1]) })),
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
      return pieces.flatMap((piece) =>
        piece.kind === "citation" ? [{ line, marker: piece.marker }] : [],
      );
    }),
  );
  return { text: shownReply(answer, shown, numbers), numbers, passed, lines };
}

function item(each: EarlierCallCase, kind: MeetingHelpKind | null): PairedItem {
  const id = `${each.id}-${kind ?? "last-time"}`;
  return {
    set: "call-help-earlier-calls",
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
      const earlier = await earlierTranscript(core);
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
      const places = lines.flatMap(({ line, marker }) => {
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
        return [{ line, number, source, call, quote: citation.quote, found: quoteFound(citation) }];
      });
      const found = answer.citations.filter(quoteFound);
      let judged: Judged | null = null;
      try {
        judged = done
          ? await judge(
              claimsJudge,
              each,
              kind === null ? "last-time" : "button",
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
      };
    },
  };
}

/** The group's Library: the earlier call recorded and stopped, then the live one recording, in one Folder. */
async function openCalls(base: GroupOptions, each: EarlierCallCase): Promise<OpenedGroup> {
  const rig = callRig([...each.earlier.turns, ...each.live.turns]);
  const library = await openLibrary({
    ...base,
    name: `paired-earlier-calls-${each.id}`,
    documents: [],
    meetings: rig.adapters,
  });
  try {
    const { core } = library;
    await core.updateSettings({ user: { language: each.language } });
    const folder = await core.createLibraryGroup({ name: each.folder, description: "" });
    const first = await recordCall(core, rig.capture, each.earlier.turns, folder.id);
    await core.stopMeeting(first.id);
    await until(core, first.id, (transcript) => transcript.state === "saved");
    const meeting = await recordCall(core, rig.capture, each.live.turns, folder.id);
    return { library, meeting, close: () => library.close() };
  } catch (error) {
    await library.close();
    throw error;
  }
}

/** One group a case: its own Library with both calls; the buttons, then the question typed. */
export function earlierCallsSet(): PairedGroup[] {
  return EARLIER_CALL_CASES.map(
    (each): PairedGroup => ({
      name: `call-help-earlier-calls-${each.id}`,
      items: [...EARLIER_CALL_PRESSES.map((kind) => item(each, kind)), item(each, null)],
      open: (base) => openCalls(base, each),
    }),
  );
}
