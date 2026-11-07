/**
 * The meeting-notes set of a paired run (README.md › Paired runs › The meeting-notes set): a long
 * call heard live, as the call-help set hears it, then Stop, and the notes filled in from its
 * Transcript (#142) on the User's Answers model. From Stop: the first sign the meeting bar shows
 * (the notes waiting or being filled in), when the notes go into the page, and the end; whether
 * they cite each line the case rests on; whether they give what the case expects; and every
 * sentence a found Citation backs whose quote doesn't say it.
 */
import { generateText, type LanguageModel } from "ai";
import type { Core, MeetingFill } from "../../src/core";
import { toolTextIn } from "../../src/core/answers/toolText";
import { connectToMind } from "../../tests/helpers/mindClient";
import { readMind } from "../../tests/helpers/minds";
import { type Judged, openCall, quotes, readJudged } from "./callHelp";
import { MEETING_NOTES_CASES, type MeetingNotesCase } from "./meetingNotesCases";
import type { Measured, PairedGroup, PairedItem } from "./paired";
import { citedText } from "./unstated";

/** The longest the notes may take after Stop. */
const NOTES_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 100;
const SETTLED = new Set<MeetingFill["state"]>(["filled", "failed", "off", "undone"]);

const JUDGE = [
  "You grade the notes IncarnaMind filled in from a call's transcript after the User pressed Stop.",
  "<expected> says what right notes give. Grade them: right when they give all of it, in any wording or language; partly when they give only some of it, or state something the call contradicts; wrong when they give none of it.",
  "Then read each sentence that carries a Citation number [n] against the words that Citation quotes, in <citations>: list n when the sentence states as so something its quoted words don't say, such as a figure, a date, a name or a commitment.",
  'Reply with JSON and nothing else: {"grade": "right" | "partly" | "wrong", "unstated": [n, ...]}',
].join("\n");

async function judge(model: LanguageModel, each: MeetingNotesCase, notes: string, cited: string[]) {
  const prompt = [
    `<expected>${each.facts}</expected>`,
    "<notes>",
    notes,
    "</notes>",
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
  const again = await generateText({
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
  console.error(`The judge's reply couldn't be read: ${again.text.slice(0, 200)}`);
  return { grade: "unread", unstated: [] } satisfies Judged;
}

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
      const judged = filled
        ? await judge(
            claimsJudge,
            each,
            notes.text,
            notes.citations.map(
              (citation, index) =>
                `[${index + 1}] ${citation.documentName ?? "?"}: “${citation.quote ?? ""}” (${citation.check ?? "unchecked"})`,
            ),
          )
        : null;
      const unstatedFound = (judged?.unstated ?? []).filter(
        (number) => notes.citations[number - 1]?.check === "found",
      );
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
        falseSupported: unstatedFound.length,
        duplicate: false,
        failures: [
          ...(toolTextIn(notes.text).length > 0 ? ["tool-text"] : []),
          ...(filled && fill.problem ? [`fill-${fill.problem.kind}`] : []),
          ...(filled && notes.text === "" ? ["nothing-written"] : []),
        ],
        firstSignMs,
        firstWordsMs,
        text: [
          notes.text,
          ...notes.citations.map(
            (citation, index) =>
              `[${index + 1}] [${citation.check ?? "unchecked"}] ${citation.documentName ?? "?"}: “${citation.quote ?? ""}”`,
          ),
          ...(unstatedFound.length > 0 ? [`[unstated] ${unstatedFound.join(", ")}`] : []),
        ].join("\n"),
      } satisfies Measured;
    },
  };
}

/** One group a case: its own Library and Meeting, the call heard before Stop. */
export function meetingNotesSet(): PairedGroup[] {
  return MEETING_NOTES_CASES.map(
    (each): PairedGroup => ({
      name: `meeting-notes-${each.call.id}`,
      items: [item(each)],
      open: (base) => openCall(base, each.call, `paired-meeting-notes-${each.call.id}`),
    }),
  );
}
