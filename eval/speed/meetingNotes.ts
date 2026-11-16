/**
 * The meeting-notes set of a paired run (README.md › Paired runs › The meeting-notes set): a long
 * call heard live, as the call-help set hears it, then Stop, and the notes filled in from its
 * Transcript (#142) on the User's Answers model. From Stop: the first sign the meeting bar shows
 * (the notes waiting or being filled in), when the notes go into the page, and the end; whether
 * they cite each line the case rests on; whether they give what the case expects; and every
 * sentence with a found Citation that states something its lines of the call don't say. Notes only
 * partly filled in fail.
 */

import { statSync } from "node:fs";
import type { Core, MeetingFill, SpeakerSeparator } from "../../src/core";
import { toolTextIn } from "../../src/core/answers/toolText";
import { isPartialMeetingFill } from "../../src/shared/meetingFill";
import { connectToMind } from "../../tests/helpers/mindClient";
import { readMind } from "../../tests/helpers/minds";
import { NO_SPEAKER_FILES } from "../../tests/helpers/transcription";
import { openCall, quotes } from "./callHelp";
import { callOf } from "./callHelpCases";
import { MEETING_NOTES_CASES, type MeetingNotesCase } from "./meetingNotesCases";
import { judgeNotes, type NotesCitation, savedLines } from "./meetingNotesJudge";
import type { Measured, PairedGroup, PairedItem } from "./paired";
import { citedText } from "./unstated";

/** The longest the notes may take after Stop. */
const NOTES_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 100;
const SETTLED = new Set<MeetingFill["state"]>(["filled", "failed", "off", "undone"]);

const fillOf = async (core: Core, meetingId: string) =>
  (await core.listMeetings()).find((each) => each.id === meetingId) ?? null;

/** What Stop starts sends only where the User allowed it: the Answers model's service, as an Answer's ask allows it. */
async function allowNotes(core: Core, providerId: string): Promise<void> {
  const service = (await core.listChatProviders()).find((each) => each.id === providerId)?.service;
  if (!service) return;
  for (const flow of ["chat", "checks"] as const) await core.allowDataFlow(flow, service.id);
}

function item(each: MeetingNotesCase): PairedItem {
  return {
    set: "meeting-notes",
    id: each.id,
    kind: each.language,
    language: each.language,
    words: "item",
    async run({ library, claimsJudge, meeting, choice, ended }) {
      if (!meeting) throw new Error("The meeting-notes set needs its Meeting.");
      const { core } = library;
      // The notes are filled in on the Answers model the User chose, as Stop fills them.
      await core.updateSettings({ user: { chatModel: choice } });
      await allowNotes(core, choice.providerId);
      let start = 0;
      let firstSignMs: number | null = null;
      let firstWordsMs: number | null = null;
      const stop = core.on("meetings.changed", (meetings) => {
        const fill = meetings.find((one) => one.id === meeting.id)?.fill;
        if (!fill || start === 0) return;
        if (fill.state === "waiting" || fill.state === "filling") {
          firstSignMs ??= performance.now() - start;
        }
        if (fill.state === "filled") firstWordsMs ??= performance.now() - start;
      });
      let fill: MeetingFill | null = null;
      try {
        library.timings?.begin();
        start = performance.now();
        await core.stopMeeting(meeting.id);
        while (!fill || !SETTLED.has(fill.state)) {
          if (performance.now() - start > NOTES_TIMEOUT_MS) {
            throw new Error(`The notes took too long: ${JSON.stringify(fill)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          fill = (await fillOf(core, meeting.id))?.fill ?? null;
        }
        ended?.();
      } finally {
        stop();
      }
      const stopped = await fillOf(core, meeting.id);
      if (!stopped) throw new Error("The Meeting is gone.");
      const client = await connectToMind(core, stopped.mindId);
      await client.settled();
      const notes = citedText(readMind(client));
      const found = notes.citations.filter((citation) => citation.check === "found");
      const filled = fill.state === "filled";
      const cited: NotesCitation[] = notes.citations.map((citation) => ({
        documentName: citation.documentName ?? "?",
        quote: citation.quote ?? "",
        check: citation.check ?? "unchecked",
      }));
      const judged = filled
        ? await judgeNotes(claimsJudge, {
            expected: each.facts,
            notes: notes.text,
            citations: cited,
            turns: callOf(each.call),
          })
        : null;
      const unstated = judged?.unstated ?? [];
      return {
        status: filled ? "done" : "failed",
        error: filled
          ? null
          : `${fill.state}: ${fill.problem?.kind ?? ""} ${fill.problem?.message ?? ""}`,
        searches: null,
        citations: notes.citations.length,
        found: found.length,
        cited: filled
          ? each.rests.every((group) =>
              group.some((rest) =>
                found.some((citation) =>
                  quotes(
                    {
                      check: "found",
                      location: citation.location ?? null,
                      documentName: citation.documentName ?? "",
                      quote: citation.quote ?? "",
                    },
                    rest,
                  ),
                ),
              ),
            )
          : null,
        grade: judged?.grade === "unread" ? null : (judged?.grade ?? null),
        falseSupported: unstated.length,
        duplicate: false,
        failures: [
          ...(toolTextIn(notes.text).length > 0 ? ["tool-text"] : []),
          ...(filled && fill.problem ? [`fill-${fill.problem.kind}`] : []),
          ...(filled && !fill.problem && isPartialMeetingFill(fill) ? ["fill-partial"] : []),
          ...(filled && notes.text === "" ? ["nothing-written"] : []),
        ],
        firstSignMs,
        firstWordsMs,
        text: [notes.text, ...savedLines(cited, unstated)].join("\n"),
      } satisfies Measured;
    },
  };
}

/** The app's speaker pass took 5.9–6.8 s for calls of 53–62 s on this Mac (#2773). */
const PASS_PER_AUDIO_SECOND = 0.11;

/** A recorded part's seconds of 16 kHz, 16-bit mono audio, after its 44-byte header. */
const partSeconds = (path: string) => Math.max(0, statSync(path).size - 44) / 2 / 16_000;

/**
 * A stand-in for the speaker pass after Stop: it takes as long as the app's on the call's audio
 * and hears one voice on the other side, as in a call with one other person, so it renames no
 * line. The notes wait for it unless they start before it ends (#2773).
 */
function standInSpeakerPass(perAudioSecond: number): SpeakerSeparator {
  return {
    async separate({ parts }) {
      const seconds = parts.reduce((sum, part) => sum + partSeconds(part.path), 0);
      await new Promise((resolve) => setTimeout(resolve, seconds * perAudioSecond * 1000));
      const endMs = Math.max(
        0,
        ...parts.map((part) => part.offsetMs + partSeconds(part.path) * 1000),
      );
      return [{ startMs: 0, endMs, voice: 0 }];
    },
  };
}

/** One group a case: its own Library and Meeting, the call heard before Stop. */
export function meetingNotesSet({
  passPerAudioSecond = PASS_PER_AUDIO_SECOND,
}: {
  /** The stand-in speaker pass's seconds for each second of the call's audio. */
  passPerAudioSecond?: number;
} = {}): PairedGroup[] {
  return MEETING_NOTES_CASES.map(
    (each): PairedGroup => ({
      name: `meeting-notes-${each.call.id}`,
      items: [item(each)],
      open: (base) =>
        openCall(base, each.call, `paired-meeting-notes-${each.call.id}`, {
          speakerSeparator: standInSpeakerPass(passPerAudioSecond),
          speakerModelSource: NO_SPEAKER_FILES,
        }),
    }),
  );
}
