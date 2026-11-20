import { expect, test, vi } from "vitest";
import type { Meeting, MeetingSummaryItem, MeetingTranscript } from "../../src/core/api";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import {
  createLiveSummaries,
  type StoredMeetingSummary,
} from "../../src/core/meetings/liveSummary";
import { createTempDataFolder, startCore } from "../helpers/core";

async function newMeeting(): Promise<Meeting> {
  const core = startCore(await createTempDataFolder(), { audioCapture: createFakeCapture() });
  try {
    return await core.createMeeting();
  } finally {
    core.close();
  }
}

const decision: MeetingSummaryItem = {
  id: 1,
  kind: "decision",
  status: "active",
  text: "Project Beacon audit on Tuesday.",
};
const action: MeetingSummaryItem = {
  id: 2,
  kind: "action",
  status: "active",
  text: "Nora to send the agenda.",
};
const overview = "The audit was scheduled and the agenda was assigned.";
const finished = "The meeting ended.";

type ChangeCase = {
  name: string;
  edit(cues: Cue[], transcript: MeetingTranscript): void;
  keep: MeetingSummaryItem[];
  sameTranscript?: false;
};

const cases: ChangeCase[] = [
  {
    name: "unrelated earlier line arrives late",
    edit: (cues) => {
      cues.unshift({ startMs: 0, endMs: 300, speaker: "Me", text: "Can you hear me?" });
    },
    keep: [decision, action],
  },
  {
    name: "the opening speaker is relabelled",
    edit: (cues) => {
      const [first] = cues;
      if (first) first.speaker = "Speaker 1";
    },
    keep: [decision, action],
  },
  {
    name: "the decision's source line is removed",
    edit: (cues) => {
      cues.shift();
    },
    keep: [action],
  },
  {
    name: "the action's source line is replaced",
    edit: (cues) => {
      cues[1] = { startMs: 2_100, endMs: 2_700, speaker: "Them", text: "Let's wrap up." };
    },
    keep: [decision],
  },
  {
    name: "the Transcript Document is replaced",
    edit: (_cues, transcript) => {
      transcript.documentId = "other-transcript";
    },
    keep: [],
    sameTranscript: false,
  },
];

test.each(cases)("the stopped summary uses the right items after $name", async (fixture) => {
  const appointment = "The Project Beacon audit is scheduled for Tuesday.";
  const assignment = "Nora will send the agenda.";
  const cues: Cue[] = [
    { startMs: 1_000, endMs: 1_800, speaker: "Them", text: appointment },
    { startMs: 2_100, endMs: 2_700, speaker: "Them", text: assignment },
  ];
  const transcript: MeetingTranscript = {
    documentId: "transcript",
    state: "live",
    lines: cues.length,
    partials: [],
    cloud: null,
    fellBack: null,
    model: null,
    savedPath: null,
    separating: false,
    problem: null,
  };
  const meeting: Meeting = { ...(await newMeeting()), status: "recording", transcript };
  let stored: StoredMeetingSummary | null = null;
  const generate = vi.fn<Parameters<typeof createLiveSummaries>[0]["generate"]>();
  generate
    .mockResolvedValueOnce(
      JSON.stringify({
        summary: overview,
        changes: [
          { ...decision, id: null, quote: appointment },
          { ...action, id: null, quote: assignment },
        ],
      }),
    )
    .mockResolvedValueOnce(JSON.stringify({ summary: finished, changes: [] }));
  const failed = vi.fn();
  const scheduler = createLiveSummaries({
    selected: () => "model",
    allowed: () => true,
    cues: () => cues,
    saved: () => stored,
    save: (_id, value) => {
      stored = value;
      meeting.summary = value.summary;
      scheduler.changed([meeting]);
    },
    generate,
    failed,
  });
  try {
    scheduler.changed([meeting]);
    await vi.waitFor(() => expect(meeting.summary?.items).toEqual([decision, action]));
    fixture.edit(cues, transcript);
    transcript.lines = cues.length;
    transcript.state = "saved";
    meeting.status = "stopped";
    scheduler.changed([meeting]);
    await vi.waitFor(() =>
      expect(meeting.summary).toEqual({
        state: "ready",
        text: finished,
        items: fixture.keep,
        throughMs: Math.max(...cues.map((cue) => cue.endMs)),
      }),
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.lastCall?.[2]).toEqual({
      previous: null,
      ...(fixture.sameTranscript !== false && { items: fixture.keep }),
      utterances: cues.map(({ text, speaker }) => ({ text, speaker })),
    });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    scheduler.close();
  }
});
