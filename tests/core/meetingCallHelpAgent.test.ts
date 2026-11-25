import { expect, test, vi } from "vitest";
import type { CoreAdapters } from "../../src/core/adapters";
import { prepareCallHelp } from "../../src/core/meetings/agentHelp";
import { startLiveAgentMeeting } from "../helpers/liveAgentMeeting";
import { until } from "../helpers/transcription";

const monday = "The launch is on Monday.";
const corrections = "We changed it to Friday.";
type Run = NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>;
const response = JSON.stringify({
  lines: [
    { text: "Friday.", source: 2 },
    { text: "Invented.", source: 99 },
  ],
});

test.each(["claude-code", "codex"] as const)(
  "a panel press uses only the selected %s and opens its verified speech",
  async (client) => {
    const run = vi.fn<Run>(async () => response);
    const { core, pairing, meeting, push } = await startLiveAgentMeeting(
      run,
      false,
      [monday, corrections],
      client,
    );
    try {
      expect(await core.listChatProviders()).toHaveLength(0);
      await core.updateSettings({
        device: { meetingNotesAgentId: null, meetingCallHelpAgentId: pairing.id },
      });
      push(4500);
      await until(core, meeting.id, (state) => state.lines >= 2);
      expect(run).not.toHaveBeenCalled();
      const press = await core.askMeetingQuestion({
        meetingId: meeting.id,
        text: "What was decided?",
      });
      expect(press.asked).toBe(true);
      if (!press.asked) throw Error("missing answer");
      expect(run).toHaveBeenCalledTimes(1);
      const request = run.mock.calls[0]?.[0];
      expect(request).toMatchObject({ client, purpose: "call-help" });
      expect(JSON.parse(request?.prompt ?? "{}")).toEqual({
        question: "What was decided?",
        speech: [
          { source: 1, speaker: expect.any(String), text: monday },
          { source: 2, speaker: expect.any(String), text: corrections },
        ],
      });
      const { messages } = await core.getConversation(press.conversation.id);
      expect(messages.find((each) => each.id === press.answerId)).toMatchObject({
        status: "done",
        text: "Friday. [^1]",
        steps: { meetingHelpAgent: { pairingId: pairing.id, meetingId: meeting.id } },
        citations: [{ marker: 1, check: "found", quote: corrections, location: { kind: "time" } }],
      });
      await expect(
        core.regenerateConversationAnswer({
          conversationId: press.conversation.id,
          answerId: press.answerId,
        }),
      ).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      core.close();
    }
  },
);

test("revoking access during an external answer cancels it before it reaches the thread", async () => {
  const delayed = Promise.withResolvers<string>();
  const run = vi.fn<Run>(() => delayed.promise);
  const { core, pairing, meeting, push } = await startLiveAgentMeeting(run, false, [monday]);
  try {
    await core.updateSettings({ device: { meetingCallHelpAgentId: pairing.id } });
    push(2500);
    await until(core, meeting.id, (state) => state.lines > 0);
    const answer = core.askMeetingHelp({ meetingId: meeting.id, kind: "sum" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const queued = core.askMeetingQuestion({ meetingId: meeting.id, text: "What was decided?" });
    await core.updateSettings({ device: { meetingCallHelpAgentId: null } });
    await core.updateSettings({ device: { meetingCallHelpAgentId: pairing.id } });
    expect(run.mock.calls[0]?.[0].signal.aborted).toBe(true);
    delayed.resolve(response);
    await expect(answer).rejects.toThrow();
    await expect(queued).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await core.listConversations()).toHaveLength(0);
  } finally {
    delayed.resolve(response);
    core.close();
  }
});

test("summary consent does not enable Call Help, and an explicit press with no speech uses no AI", async () => {
  const run = vi.fn<Run>(async () => response);
  const { core, pairing, meeting } = await startLiveAgentMeeting(run, true, [monday]);
  try {
    expect(
      await core.askMeetingQuestion({ meetingId: meeting.id, text: "What did we decide?" }),
    ).toMatchObject({ asked: false });
    await core.updateSettings({ device: { meetingCallHelpAgentId: pairing.id } });
    const press = await core.askMeetingQuestion({
      meetingId: meeting.id,
      text: "What did we decide?",
    });
    if (!press.asked) throw Error("missing answer");
    expect((await core.getConversation(press.conversation.id)).messages.at(-1)).toMatchObject({
      text: expect.stringContaining("not contain enough information"),
      steps: { sentAt: null },
      citations: [],
    });
    expect(run).not.toHaveBeenCalled();
  } finally {
    core.close();
  }
});

test("a document-only button never invents a library check and excluding the transcript prevents further use", async () => {
  const run = vi.fn<Run>(async () => response);
  const { core, pairing, meeting, push } = await startLiveAgentMeeting(run, false, [monday]);
  try {
    await core.updateSettings({ device: { meetingCallHelpAgentId: pairing.id } });
    push(2500);
    await until(core, meeting.id, (state) => state.lines > 0 && !!state.documentId);
    const press = await core.askMeetingHelp({ meetingId: meeting.id, kind: "check" });
    if (!press.asked) throw Error("missing answer");
    expect((await core.getConversation(press.conversation.id)).messages.at(-1)).toMatchObject({
      citations: [],
      steps: { sentAt: null },
    });
    const transcript = (await core.listMeetings())[0]?.transcript?.documentId;
    if (!transcript) throw Error("missing transcript");
    await core.setNotCited(transcript, true);
    await expect(
      core.askMeetingQuestion({ meetingId: meeting.id, text: "When is the launch?" }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  } finally {
    core.close();
  }
});

test("a press excludes older transcript matches and unrelated speech outside the matching exchange", () => {
  const cues = [
    [1000, "Original launch was Sunday."],
    [700000, "We need a new launch date."],
    [702000, "Friday works."],
    [704000, "The meeting room is available."],
    [706000, "My personal email changed."],
  ] as const;
  const request = prepareCallHelp(
    cues.map(([startMs, text]) => ({ startMs, endMs: startMs + 1000, text, speaker: null })),
    "launch",
    "question",
    [],
  );
  expect(JSON.parse(request.prompt).speech.map((row: { text: string }) => row.text)).toEqual([
    "We need a new launch date.",
    "Friday works.",
  ]);
  expect(request.notFinal).toBe(false);
});

// protects=call help through the User's own AI gets the words on screen not yet final, after the confirmed speech, each with no source number, and a line can only cite confirmed speech; the newest of them come first into the room left, never more than half of it (#3762); fails_when=the AI sees only confirmed lines, a word not yet final gets a source number, or they crowd out the speech lines cite
test("the words not yet final go with the speech, unnumbered, in at most half the room", () => {
  const cues = [{ startMs: 0, endMs: 2000, text: monday, speaker: "Them" }];
  const request = prepareCallHelp(cues, "What did they just say?", "question", [
    { startMs: 2000, text: "  ", speaker: "Me" },
    { startMs: 2100, text: "We changed it ", speaker: "Them" },
  ]);
  expect(JSON.parse(request.prompt)).toEqual({
    question: "What did they just say?",
    speech: [{ source: 1, speaker: "Them", text: monday }],
    notFinal: [{ speaker: "Them", text: "We changed it" }],
  });
  expect(request.sources).toEqual(cues);
  expect(request.notFinal).toBe(true);

  const long = { startMs: 2000, text: "word ".repeat(400), speaker: "Them" };
  const crowded = prepareCallHelp(cues, "What now?", "question", [
    long,
    { startMs: 9000, text: "Friday then.", speaker: "Me" },
  ]);
  expect(JSON.parse(crowded.prompt)).toMatchObject({
    speech: [{ source: 1, text: monday }],
    notFinal: [{ speaker: "Me", text: "Friday then." }],
  });
  expect(new TextEncoder().encode(crowded.prompt).length).toBeLessThanOrEqual(3960);
});

// protects=a press during a call sends the User's own AI the words on screen not yet final and tells it never to give one as a line's source; a line that names a number past the confirmed speech is dropped, so nothing not final is cited (#3762); fails_when=the AI isn't given what is being said, isn't told the words can't be cited, or a line resting on them reaches the answer
test("a press sends the words not yet final, and a line can't rest on them", async () => {
  const friday = "We changed it to Friday after the review.";
  const run = vi.fn<Run>(async () => JSON.stringify({ lines: [{ text: "Friday.", source: 2 }] }));
  const { core, pairing, meeting, push } = await startLiveAgentMeeting(run, false, [
    monday,
    friday,
  ]);
  try {
    await core.updateSettings({ device: { meetingCallHelpAgentId: pairing.id } });
    push(3200);
    const live = await until(
      core,
      meeting.id,
      (state) => state.lines >= 1 && state.partials.some((each) => each.text.trim() !== ""),
    );
    const press = await core.askMeetingQuestion({
      meetingId: meeting.id,
      text: "What did they just say?",
    });
    if (!press.asked) throw Error("missing answer");
    const request = run.mock.calls[0]?.[0];
    const sent = JSON.parse(request?.prompt ?? "{}");
    expect(sent).toEqual({
      question: "What did they just say?",
      speech: [{ source: 1, speaker: expect.any(String), text: monday }],
      notFinal: live.partials
        .filter((each) => each.text.trim() !== "")
        .map((each) => ({ speaker: each.speaker, text: each.text.trim() })),
    });
    expect(friday.startsWith(sent.notFinal.at(-1)?.text)).toBe(true);
    expect(request?.instructions).toContain(
      "not final and with no source number: read them for what is being said now, never give one as a line's source",
    );
    const { messages } = await core.getConversation(press.conversation.id);
    expect(messages.find((each) => each.id === press.answerId)).toMatchObject({
      status: "done",
      text: expect.stringContaining("not contain enough information"),
      citations: [],
    });
  } finally {
    core.close();
  }
});
