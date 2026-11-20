import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, vi } from "vitest";
import type { MeetingSummary } from "../../src/core/api";
import type { ChatModelFactory } from "../../src/core/providers/models";
import { meetingSummaryModelRoute } from "../../src/shared/meetingSummary";
import { createTempDataFolder } from "../../tests/helpers/core";
import { transcribingCore } from "../../tests/helpers/transcription";

const overview = [
  "A compact, standalone overview in about 80 words or fewer, with material outcomes. It should not be a restatement of every list item.",
  "If it mentions the warehouse extension, it stays in force through 18 October at £47,300. It must not claim that Zoe Bell was assigned the insurance quotes.",
];
const retainedItems = [
  "Active decision coverage: the warehouse stays open through 18 October with a £47,300 operating budget. One combined decision or separate entries for the duration and budget are fine.",
  "An active action for Vera Chen to send the signed extension to Finance by 8 October.",
  "Zoe Bell gathering competing insurance quotes was conditional and never assigned. Treat any entry recording the proposal as an agreed action as a contradiction.",
];

export const summaryRetention = {
  utterances: [
    "Approved. The warehouse stays open through 18 October, with a £47,300 operating budget. Vera Chen will send Finance the signed extension by 8 October. Those items are settled. Casey Park will lead the supplier handover on 7 October. Avery Ross will send the invitations for a 9 October kiosk demo.",
    "Moving on to office access. The lobby readers are seeing duplicate scans when visitors follow staff through the turnstiles. The maintenance window is usually early morning. We discussed keeping printed passes at reception during the switch and adding a sign at the deliveries entrance.",
    "On the support handoff, the French and German installation guides have out-of-date screenshots. A printable guide might help users who are offline at customer sites. We looked at whether the help page should link straight to the version in the app. No agreement about a date for publishing.",
    "For the dashboard, the counter on the returns page includes replacement shipments and can spike after a large order. We considered a weekly chart and a separate series for warranty exchanges. The service team will bring sample returns to the next review.",
    "On the insurance renewal, Zoe Bell could gather competing quotes if the broker can't submit a revised bid. The broker still has time, so we haven't assigned that work. Some offices want replacement coverage for borrowed tools, but we'll decide after seeing the quotes.",
    "Before we stop, a correction to the supplier handover. We are moving it from 7 October to 14 October. Jonah Reed owns it now. Casey Park is off the handover. We are also cancelling the kiosk demo outright. Avery Ross should not send any invitations, and there is no replacement demo date. The service team has already sent the sample returns, so that task is complete.",
  ],
  expectedWarmOverview: [
    ...overview,
    "Convey at least one concrete settled direction from the meeting, such as keeping the warehouse open or going ahead with the supplier handover or kiosk demo. Merely saying earlier commitments remain active, without describing any choice or next step, is insufficient. Names and dates can stay in the list. If included, the handover is still on 7 October with Casey Park and the kiosk demo has not been cancelled.",
  ].join("\n"),
  expectedFinalOverview: [
    ...overview,
    "Lead with the latest material outcome: the supplier handover moved or the kiosk demo was cancelled. Do not state either superseded plan as current. If it includes the revised date or owner, use 14 October and Jonah Reed.",
  ].join("\n"),
  expectedWarmItems: [
    ...retainedItems,
    "The supplier handover is scheduled for 7 October and Casey Park owns it. It must be active.",
    "Avery Ross will send invitations for the 9 October kiosk demo. The invitation action must be active.",
    "The service team will bring sample returns to the next review. The action must be active.",
  ].join("\n"),
  expectedFinalItems: [
    ...retainedItems,
    "The current supplier handover is on 14 October and Jonah Reed owns it. There must be one active handover with the revised terms, and no active handover on 7 October or owned by Casey Park.",
    "The kiosk demo invitation action for Avery Ross must remain visible with status cancelled. The list must not represent the demo, invitations or a replacement date as active.",
    "The sample returns action must remain visible with status done.",
  ].join("\n"),
};

export async function replaySummaryRetention({
  createChatModel,
  apiKey,
  modelId,
}: {
  createChatModel: ChatModelFactory;
  apiKey: string;
  modelId: string;
}) {
  const { core, capture, clock, record } = await transcribingCore(await createTempDataFolder(), {
    engine: { lines: summaryRetention.utterances, maxSpeechMs: 3000 },
    createChatModel,
  });
  try {
    const provider = await core.saveChatProvider({ kind: "anthropic", apiKey, modelId });
    const choice = { providerId: provider.id, modelId };
    const readiness = await core.getChatReadiness();
    if (!readiness.ready) throw new Error("The retention eval model is unavailable.");
    await core.updateSettings({
      user: { chatModel: choice, language: "en" },
      device: {
        meetingSummaryRoute: meetingSummaryModelRoute(
          choice,
          readiness.provider.service?.id ?? null,
        ),
      },
    });
    const { id } = await core.createMeeting();
    const readMeeting = async () =>
      (await core.listMeetings()).find((meeting) => meeting.id === id);

    await core.startMeeting({ meetingId: id, systemAudio: false });
    const checkpoints: MeetingSummary[] = [];
    for (let index = 0; index < summaryRetention.utterances.length - 1; index++) {
      if (index > 0) {
        // Give the in-process transcriber's push and progress messages a turn each.
        for (let gap = 0; gap < 60_000; gap += 5000) {
          clock.advance(5000);
          capture.push("microphone", 5000, true);
          await nextTurn();
          await nextTurn();
        }
      }
      record(2000, ["microphone"]);
      clock.advance(1000);
      capture.push("microphone", 1000, true);
      const checkpoint = await vi.waitFor(
        async () => {
          const meeting = await readMeeting();
          expect(meeting?.transcript?.lines).toBe(index + 1);
          const draft = meeting?.summary;
          if (!draft?.text || draft.throughMs <= (checkpoints.at(-1)?.throughMs ?? 0))
            throw new Error(`Live summary has yet to cover utterance ${index + 1}.`);
          return draft;
        },
        { timeout: 25_000, interval: 50 },
      );
      checkpoints.push(checkpoint);
    }

    record(2000, ["microphone"]);
    const warm = (await readMeeting())?.summary;
    if (!warm?.text) throw new Error("The meeting has no warm summary before Stop.");
    await core.stopMeeting(id);
    const final = await vi.waitFor(
      async () => {
        const meeting = await readMeeting();
        expect(meeting?.transcript).toMatchObject({
          state: "saved",
          lines: summaryRetention.utterances.length,
        });
        const current = meeting?.summary;
        if (current?.state !== "ready" || !current.text)
          throw new Error("The stopped summary is still pending.");
        return current;
      },
      { timeout: 25_000, interval: 50 },
    );
    return { checkpoints, warm, final };
  } finally {
    core.close();
  }
}
