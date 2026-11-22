import { expect, test, vi } from "vitest";
import type { CoreAdapters } from "../../src/core/adapters";
import type { MeetingSummaryContent } from "../../src/core/api";
import { startCore } from "../helpers/core";
import { startLiveAgentMeeting } from "../helpers/liveAgentMeeting";
import { until } from "../helpers/transcription";

const opening = "The review will be on Tuesday.";
const correction = "Move the review to Thursday.";
const written: MeetingSummaryContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "我的记录", marks: [{ type: "bold" }] }] },
    { type: "paragraph", content: [{ type: "text", text: "Review with Dana." }] },
  ],
};
const cleared: MeetingSummaryContent = { type: "doc", content: [{ type: "paragraph" }] };

function reply(quote: string, id: number | null) {
  return JSON.stringify({
    summary: quote,
    changes: [{ id, kind: "decision", status: "active", text: quote, quote }],
    ...(id !== null && { unchanged: [] }),
  });
}

test("editing the prepared summary keeps the User's formatted words through completion and restart", async () => {
  const final = Promise.withResolvers<string>();
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async ({ prompt }) =>
    prompt.includes(correction) ? final.promise : reply(opening, null),
  );
  const { core, meeting, dir, adapters, push, summary } = await startLiveAgentMeeting(run, true, [
    opening,
    correction,
  ]);
  try {
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.text).toBe(opening));
    await expect(core.updateMeetingSummaryContent(meeting.id, null, written)).rejects.toThrow();
    push(2000);
    await until(core, meeting.id, (state) => state.lines >= 2);
    await core.stopMeeting(meeting.id);
    const saved = await core.updateMeetingSummaryContent(meeting.id, null, written);
    expect(saved.summary).toMatchObject({
      text: "我的记录\nReview with Dana.",
      editedContent: written,
    });
    final.resolve(reply(correction, 1));
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({
        state: "ready",
        text: "我的记录\nReview with Dana.",
        editedContent: written,
        items: [{ text: correction, status: "active" }],
      }),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([input]) => !input.prompt.includes("我的记录"))).toBe(true);
  } finally {
    final.resolve(reply(correction, 1));
    core.close();
  }
  const reopened = startCore(dir, adapters);
  try {
    const saved = (await reopened.listMeetings()).find((m) => m.id === meeting.id);
    expect(saved?.summary?.editedContent).toEqual(written);
    expect((await reopened.getMeetingSummaryItemSources(meeting.id, 1))?.sources.at(-1)?.text).toBe(
      correction,
    );
  } finally {
    reopened.close();
  }
});

test("two editors cannot overwrite each other, retrying a saved edit is harmless, and empty edits persist", async () => {
  const run = vi.fn(async () => reply(opening, null));
  const { core, meeting, push, summary, dir, adapters } = await startLiveAgentMeeting(run, true, [
    opening,
  ]);
  try {
    push(2500);
    await until(core, meeting.id, (state) => state.lines > 0);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    await core.updateMeetingSummaryContent(meeting.id, null, written);
    await expect(core.updateMeetingSummaryContent(meeting.id, null, cleared)).rejects.toThrow();
    await core.updateMeetingSummaryContent(meeting.id, null, written);
    await expect(
      core.updateMeetingSummaryContent(meeting.id, written, {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "picture" }] }],
      }),
    ).rejects.toThrow();
    expect((await summary())?.editedContent).toEqual(written);
    await core.updateMeetingSummaryContent(meeting.id, written, cleared);
    expect(await summary()).toMatchObject({ text: "", editedContent: cleared });
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    core.close();
  }
  const reopened = startCore(dir, adapters);
  try {
    expect((await reopened.listMeetings()).find((m) => m.id === meeting.id)?.summary).toMatchObject(
      { text: "", editedContent: cleared },
    );
  } finally {
    reopened.close();
  }
});
