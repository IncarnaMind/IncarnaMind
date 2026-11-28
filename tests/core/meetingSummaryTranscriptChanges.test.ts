import { expect, test, vi } from "vitest";
import type { Meeting, MeetingSummaryItem, MeetingTranscript } from "../../src/core/api";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import {
  createLiveSummaries,
  type StoredMeetingSummary,
} from "../../src/core/meetings/liveSummary";
import { storeSummaryQuote, summaryEvidenceCue } from "../../src/core/meetings/summaryEvidence";
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
  ambiguousDecision?: true;
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
    name: "the decision's words survive only at a different time",
    edit: (cues) => {
      const first = cues.shift();
      if (first) cues.push({ ...first, startMs: 3_000, endMs: 3_800 });
    },
    keep: [action],
  },
  {
    name: "the decision's original line remains when another repeats it",
    edit: (cues) => {
      const [first] = cues;
      if (first) cues.unshift({ ...first, startMs: 0, endMs: 800 });
    },
    keep: [decision, action],
  },
  {
    name: "an originally ambiguous decision's speaker is relabelled",
    ambiguousDecision: true,
    edit: (cues) => {
      const [first] = cues;
      if (first) first.speaker = "Speaker 1";
    },
    keep: [decision, action],
  },
  {
    name: "one of several original matches remains for the ambiguous decision",
    ambiguousDecision: true,
    edit: (cues) => {
      cues.shift();
    },
    keep: [decision, action],
  },
  {
    name: "all the ambiguous decision's original matches are removed",
    ambiguousDecision: true,
    edit: (cues) => {
      const first = cues.shift();
      cues.pop();
      if (first) cues.push({ ...first, startMs: 4_000, endMs: 4_700 });
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

async function meetingScheduler(
  cues: Cue[],
  generate: Parameters<typeof createLiveSummaries>[0]["generate"],
  initial: StoredMeetingSummary | null = null,
) {
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
  const meeting: Meeting = {
    ...(await newMeeting()),
    status: "recording",
    transcript,
    ...(initial && { summary: initial.summary }),
  };
  let stored: StoredMeetingSummary | null = initial;
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
  return { meeting, transcript, scheduler, failed, stored: () => stored };
}

test.each(cases)("the stopped summary uses the right items after $name", async (fixture) => {
  const appointment = "The Project Beacon audit is scheduled for Tuesday.";
  const assignment = "Nora will send the agenda.";
  const cues: Cue[] = [
    { startMs: 1_000, endMs: 1_800, speaker: "Them", text: appointment },
    { startMs: 2_100, endMs: 2_700, speaker: "Them", text: assignment },
    ...(fixture.ambiguousDecision
      ? [{ startMs: 3_000, endMs: 3_800, speaker: "Them", text: appointment }]
      : []),
  ];
  const generate = vi.fn<Parameters<typeof createLiveSummaries>[0]["generate"]>();
  generate
    .mockResolvedValueOnce(
      JSON.stringify({
        summary: overview,
        changes: [
          {
            ...decision,
            id: null,
            quotes: fixture.ambiguousDecision
              ? [
                  { source: 1, quote: appointment },
                  { source: 3, quote: appointment },
                ]
              : [{ source: 1, quote: appointment }],
          },
          { ...action, id: null, quotes: [{ source: 2, quote: assignment }] },
        ],
      }),
    )
    .mockImplementationOnce(async (_meeting, _route, input) =>
      JSON.stringify({
        summary: finished,
        changes: [],
        ...(input.items?.some((item) => item.status === "active") && {
          unchanged: fixture.keep.map((item) => item.id),
        }),
      }),
    );
  const { meeting, transcript, scheduler, failed } = await meetingScheduler(cues, generate);
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

test("two live turns after the update interval reach the warm summary together", async () => {
  const cues: Cue[] = [{ startMs: 0, endMs: 2000, speaker: "Me", text: "Introductions." }];
  const generate = vi
    .fn<Parameters<typeof createLiveSummaries>[0]["generate"]>()
    .mockResolvedValue(JSON.stringify({ summary: overview, changes: [] }));
  const { meeting, transcript, scheduler, failed } = await meetingScheduler(cues, generate);
  try {
    scheduler.changed([meeting]);
    await vi.waitFor(() => expect(meeting.summary?.text).toBe(overview));
    cues.push({ startMs: 63000, endMs: 65000, speaker: "Me", text: decision.text });
    transcript.lines = cues.length;
    scheduler.changed([meeting]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    cues.push({ startMs: 65000, endMs: 67000, speaker: "Them", text: action.text });
    transcript.lines = cues.length;
    scheduler.changed([meeting]);
    await vi.waitFor(() => expect(meeting.summary?.throughMs).toBe(67000));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.lastCall?.[2].utterances.map(({ text }) => text)).toEqual([
      decision.text,
      action.text,
    ]);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    scheduler.close();
  }
});

test.each([
  {
    name: "English",
    request: "Could each team report how many crates it needs?",
    confirm: "Yes, we will count them after the call.",
    item: {
      id: 1,
      kind: "action" as const,
      status: "active" as const,
      text: "Each team will count and report how many crates it needs.",
    },
    overviewText: "Each team will count required crates.",
    finishedText: "The meeting ended.",
  },
  {
    name: "Chinese",
    request: "各组能不能报一下需要多少个箱子？",
    confirm: "好的，会后我们去数一下。",
    item: {
      id: 1,
      kind: "action" as const,
      status: "active" as const,
      text: "各组会后统计并上报所需箱子数量。",
    },
    overviewText: "各组将在会后统计所需箱子数量。",
    finishedText: "会议结束。",
  },
])(
  "a two-quote $name item survives when only the second line is re-timed and drops if both lines move",
  async ({ request, confirm, item, overviewText, finishedText }) => {
    for (const retimeBoth of [false, true]) {
      const cues: Cue[] = [
        { startMs: 1_000, endMs: 1_800, speaker: "Me", text: request },
        { startMs: 2_100, endMs: 2_700, speaker: "Them", text: confirm },
      ];
      const generate = vi.fn<Parameters<typeof createLiveSummaries>[0]["generate"]>();
      generate
        .mockResolvedValueOnce(
          JSON.stringify({
            summary: overviewText,
            changes: [
              {
                ...item,
                id: null,
                quotes: [
                  { source: 1, quote: request },
                  { source: 2, quote: confirm },
                ],
              },
            ],
          }),
        )
        .mockImplementationOnce(async (_meeting, _route, input) =>
          JSON.stringify({
            summary: finishedText,
            changes: [],
            ...(input.items?.some((each) => each.status === "active") && {
              unchanged: [item.id],
            }),
          }),
        );
      const { meeting, transcript, scheduler, failed } = await meetingScheduler(cues, generate);
      try {
        scheduler.changed([meeting]);
        await vi.waitFor(() => expect(meeting.summary?.items).toEqual([item]));
        if (retimeBoth) {
          cues[0] = { startMs: 3_000, endMs: 3_800, speaker: "Me", text: request };
        }
        cues[1] = { startMs: 4_100, endMs: 4_700, speaker: "Them", text: confirm };
        transcript.state = "saved";
        meeting.status = "stopped";
        scheduler.changed([meeting]);
        await vi.waitFor(() => expect(meeting.summary?.state).toBe("ready"));
        const expected = retimeBoth ? [] : [item];
        expect(meeting.summary?.items).toEqual(expected);
        expect(generate.mock.lastCall?.[2]).toEqual({
          previous: null,
          items: expected,
          utterances: cues.map(({ text, speaker }) => ({ text, speaker })),
        });
        expect(failed).not.toHaveBeenCalled();
      } finally {
        scheduler.close();
      }
    }
  },
);

test.each([
  {
    name: "English cancelled",
    status: "cancelled" as const,
    keepLine: "The Project Beacon audit is scheduled for Tuesday.",
    keepItem: {
      id: 1,
      kind: "decision" as const,
      status: "active" as const,
      text: "Project Beacon audit on Tuesday.",
    },
    createLine: "Nora will send the agenda.",
    statusLine: "Actually, skip sending the agenda.",
    changedItem: {
      id: 2,
      kind: "action" as const,
      status: "active" as const,
      text: "Nora to send the agenda.",
    },
    firstSummary: "The audit is set and Nora will send the agenda.",
    secondSummary: "The agenda action was cancelled.",
    finishedSummary: "The meeting ended.",
  },
  {
    name: "Chinese cancelled",
    status: "cancelled" as const,
    keepLine: "灯塔项目审计定在周二。",
    keepItem: {
      id: 1,
      kind: "decision" as const,
      status: "active" as const,
      text: "灯塔项目审计定在周二。",
    },
    createLine: "小周负责发一下议程。",
    statusLine: "先取消发议程吧，不用发了。",
    changedItem: {
      id: 2,
      kind: "action" as const,
      status: "active" as const,
      text: "小周发送议程。",
    },
    firstSummary: "审计定在周二，小周将发送议程。",
    secondSummary: "发送议程的待办已取消。",
    finishedSummary: "会议结束。",
  },
  {
    name: "English done",
    status: "done" as const,
    keepLine: "The Project Beacon audit is scheduled for Tuesday.",
    keepItem: {
      id: 1,
      kind: "decision" as const,
      status: "active" as const,
      text: "Project Beacon audit on Tuesday.",
    },
    createLine: "Nora will send the agenda.",
    statusLine: "I just sent the agenda to everyone.",
    changedItem: {
      id: 2,
      kind: "action" as const,
      status: "active" as const,
      text: "Nora to send the agenda.",
    },
    firstSummary: "The audit is set and Nora will send the agenda.",
    secondSummary: "Nora sent the agenda.",
    finishedSummary: "The meeting ended.",
  },
  {
    name: "Chinese done",
    status: "done" as const,
    keepLine: "灯塔项目审计定在周二。",
    keepItem: {
      id: 1,
      kind: "decision" as const,
      status: "active" as const,
      text: "灯塔项目审计定在周二。",
    },
    createLine: "小周负责发一下议程。",
    statusLine: "我刚才已经把议程发给大家了。",
    changedItem: {
      id: 2,
      kind: "action" as const,
      status: "active" as const,
      text: "小周发送议程。",
    },
    firstSummary: "审计定在周二，小周将发送议程。",
    secondSummary: "小周已发送议程。",
    finishedSummary: "会议结束。",
  },
])(
  "a $name item drops when its status-change line is removed even while its creation line stays",
  async ({
    status,
    keepLine,
    keepItem,
    createLine,
    statusLine,
    changedItem,
    firstSummary,
    secondSummary,
    finishedSummary,
  }) => {
    const cues: Cue[] = [
      { startMs: 1_000, endMs: 1_800, speaker: "Them", text: keepLine },
      { startMs: 2_100, endMs: 2_700, speaker: "Them", text: createLine },
    ];
    const updatedItem: MeetingSummaryItem = { ...changedItem, status };
    const generate = vi.fn<Parameters<typeof createLiveSummaries>[0]["generate"]>();
    generate
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: firstSummary,
          changes: [
            { ...keepItem, id: null, quotes: [{ source: 1, quote: keepLine }] },
            { ...changedItem, id: null, quotes: [{ source: 2, quote: createLine }] },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: secondSummary,
          unchanged: [keepItem.id],
          changes: [{ ...updatedItem, quotes: [{ source: 1, quote: statusLine }] }],
        }),
      )
      .mockImplementationOnce(async (_meeting, _route, input) =>
        JSON.stringify({
          summary: finishedSummary,
          changes: [],
          ...(input.items?.some((each) => each.status === "active") && {
            unchanged: input.items
              .filter((each) => each.status === "active")
              .map((each) => each.id),
          }),
        }),
      );
    const { meeting, transcript, scheduler, failed, stored } = await meetingScheduler(
      cues,
      generate,
    );
    try {
      scheduler.changed([meeting]);
      await vi.waitFor(() => expect(meeting.summary?.items).toEqual([keepItem, changedItem]));

      cues.push({ startMs: 63_000, endMs: 64_500, speaker: "Them", text: statusLine });
      transcript.lines = cues.length;
      scheduler.changed([meeting]);
      await vi.waitFor(() => expect(meeting.summary?.items).toEqual([keepItem, updatedItem]));
      expect(stored()?.evidence?.[changedItem.id]).toHaveLength(2);
      expect(stored()?.latestEvidence?.[changedItem.id]).toHaveLength(1);
      expect(stored()?.latestEvidence?.[keepItem.id]).toHaveLength(1);

      cues.pop();
      transcript.lines = cues.length;
      transcript.state = "saved";
      meeting.status = "stopped";
      scheduler.changed([meeting]);
      await vi.waitFor(() => expect(meeting.summary?.state).toBe("ready"));

      expect(meeting.summary?.items).toEqual([keepItem]);
      expect(generate).toHaveBeenCalledTimes(3);
      expect(generate.mock.lastCall?.[2]).toEqual({
        previous: null,
        items: [keepItem],
        utterances: cues.map(({ text, speaker }) => ({ text, speaker })),
      });
      expect(stored()?.evidence?.[changedItem.id]).toBeUndefined();
      expect(stored()?.latestEvidence?.[changedItem.id]).toBeUndefined();
      expect(failed).not.toHaveBeenCalled();
    } finally {
      scheduler.close();
    }
  },
);

test.each([
  {
    name: "English",
    createLine: "Nora will send the agenda.",
    cancelPrompt: "Should we drop the agenda email?",
    cancelConfirm: "Yes, let's cancel it.",
    item: {
      id: 1,
      kind: "action" as const,
      status: "active" as const,
      text: "Nora to send the agenda.",
    },
    firstSummary: "Nora will send the agenda.",
    secondSummary: "The agenda email was cancelled.",
    finishedSummary: "The meeting ended.",
  },
  {
    name: "Chinese",
    createLine: "小周负责发一下议程。",
    cancelPrompt: "那议程邮件还要发吗？",
    cancelConfirm: "不用了，先取消吧。",
    item: {
      id: 1,
      kind: "action" as const,
      status: "active" as const,
      text: "小周发送议程。",
    },
    firstSummary: "小周将发送议程。",
    secondSummary: "议程邮件已取消。",
    finishedSummary: "会议结束。",
  },
])(
  "a $name two-quote status change survives if only its second quote is re-timed and drops if both move",
  async ({
    createLine,
    cancelPrompt,
    cancelConfirm,
    item,
    firstSummary,
    secondSummary,
    finishedSummary,
  }) => {
    const cancelled: MeetingSummaryItem = { ...item, status: "cancelled" };
    for (const retimeBoth of [false, true]) {
      const cues: Cue[] = [{ startMs: 1_000, endMs: 1_800, speaker: "Them", text: createLine }];
      const generate = vi.fn<Parameters<typeof createLiveSummaries>[0]["generate"]>();
      generate
        .mockResolvedValueOnce(
          JSON.stringify({
            summary: firstSummary,
            changes: [{ ...item, id: null, quotes: [{ source: 1, quote: createLine }] }],
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            summary: secondSummary,
            unchanged: [],
            changes: [
              {
                ...cancelled,
                quotes: [
                  { source: 1, quote: cancelPrompt },
                  { source: 2, quote: cancelConfirm },
                ],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(JSON.stringify({ summary: finishedSummary, changes: [] }));
      const { meeting, transcript, scheduler, failed, stored } = await meetingScheduler(
        cues,
        generate,
      );
      try {
        scheduler.changed([meeting]);
        await vi.waitFor(() => expect(meeting.summary?.items).toEqual([item]));

        cues.push(
          { startMs: 63_000, endMs: 64_000, speaker: "Me", text: cancelPrompt },
          { startMs: 64_100, endMs: 65_000, speaker: "Them", text: cancelConfirm },
        );
        transcript.lines = cues.length;
        scheduler.changed([meeting]);
        await vi.waitFor(() => expect(meeting.summary?.items).toEqual([cancelled]));
        expect(stored()?.evidence?.[item.id]).toHaveLength(3);
        expect(stored()?.latestEvidence?.[item.id]).toHaveLength(2);

        if (retimeBoth) {
          cues[1] = { startMs: 66_000, endMs: 67_000, speaker: "Me", text: cancelPrompt };
        }
        cues[2] = { startMs: 67_100, endMs: 68_000, speaker: "Them", text: cancelConfirm };
        transcript.state = "saved";
        meeting.status = "stopped";
        scheduler.changed([meeting]);
        await vi.waitFor(() => expect(meeting.summary?.state).toBe("ready"));

        const expected = retimeBoth ? [] : [cancelled];
        expect(meeting.summary?.items).toEqual(expected);
        expect(generate.mock.lastCall?.[2]).toEqual({
          previous: null,
          items: expected,
          utterances: cues.map(({ text, speaker }) => ({ text, speaker })),
        });
        if (retimeBoth) {
          expect(stored()?.evidence?.[item.id]).toBeUndefined();
          expect(stored()?.latestEvidence?.[item.id]).toBeUndefined();
        } else {
          expect(stored()?.evidence?.[item.id]).toHaveLength(2);
          expect(stored()?.latestEvidence?.[item.id]).toHaveLength(1);
        }
        expect(failed).not.toHaveBeenCalled();
      } finally {
        scheduler.close();
      }
    }
  },
);

test("a legacy summary without latestEvidence drops a cancelled item when its cancellation line disappears", async () => {
  const createCue: Cue = {
    startMs: 1_000,
    endMs: 1_800,
    speaker: "Them",
    text: "Nora will send the agenda.",
  };
  const cancelCue: Cue = {
    startMs: 63_000,
    endMs: 64_000,
    speaker: "Them",
    text: "Skip sending the agenda.",
  };
  const cancelled: MeetingSummaryItem = { ...action, id: 1, status: "cancelled" };
  const initial: StoredMeetingSummary = {
    route: "model",
    documentId: "transcript",
    evidence: {
      1: [
        storeSummaryQuote(createCue.text, [summaryEvidenceCue(createCue)]),
        storeSummaryQuote(cancelCue.text, [summaryEvidenceCue(cancelCue)]),
      ],
    },
    count: 2,
    digest: "stale-digest",
    summary: {
      state: "updating",
      text: "The agenda was cancelled.",
      items: [cancelled],
      throughMs: cancelCue.endMs,
    },
  };
  const cues: Cue[] = [createCue];
  const generate = vi
    .fn<Parameters<typeof createLiveSummaries>[0]["generate"]>()
    .mockResolvedValueOnce(JSON.stringify({ summary: finished, changes: [] }));
  const { meeting, transcript, scheduler, failed, stored } = await meetingScheduler(
    cues,
    generate,
    initial,
  );
  try {
    transcript.lines = cues.length;
    transcript.state = "saved";
    meeting.status = "stopped";
    scheduler.changed([meeting]);
    await vi.waitFor(() => expect(meeting.summary?.state).toBe("ready"));
    expect(meeting.summary?.items).toEqual([]);
    expect(generate.mock.lastCall?.[2]).toEqual({
      previous: null,
      items: [],
      utterances: cues.map(({ text, speaker }) => ({ text, speaker })),
    });
    expect(stored()?.evidence?.[1]).toBeUndefined();
    expect(failed).not.toHaveBeenCalled();
  } finally {
    scheduler.close();
  }
});
