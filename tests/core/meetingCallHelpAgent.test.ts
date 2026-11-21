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
  );
  expect(JSON.parse(request.prompt).speech.map((row: { text: string }) => row.text)).toEqual([
    "We need a new launch date.",
    "Friday works.",
  ]);
});
