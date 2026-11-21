import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import type { MeetingSummarySource } from "../../src/core/api";
import { withLineSplit } from "../../src/shared/speakers";
import {
  recordedMeeting,
  savedCues,
  stoppedMeeting,
  transcribingCore,
} from "../helpers/transcription";

const unavailable = { wording: { key: "error.meeting.summaryCandidateUnavailable" } };

test("a saved line becomes an editable action with its original time, without a summary model or retained audio", async () => {
  const { core, meeting, dataDir } = await recordedMeeting("en");
  let itemId: number;
  let source: MeetingSummarySource;
  let docId: string;
  try {
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    docId = document.id;
    const [cue] = await savedCues(core, meeting.id);
    if (!cue) throw new Error("The test needs a saved line.");
    source = { startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
    await core.deleteMeetingAudio(meeting.id);
    expect((await core.listMeetings())[0]?.summary).toBeUndefined();
    const add = () => core.addMeetingTranscriptAction(meeting.id, docId, source);
    const both = await Promise.all([add(), add()]);
    expect(both.map((result) => result.added).sort()).toEqual([false, true]);
    expect(both[0].itemId).toBe(both[1].itemId);
    const firstId = both[0].itemId;
    await core.undoAddMeetingTranscriptAction(meeting.id, firstId);
    expect((await core.listMeetings())[0]?.summary).toBeUndefined();
    const redone = await add();
    expect(redone.added).toBe(true);
    expect(redone.itemId).toBeGreaterThan(firstId);
    itemId = redone.itemId;
    await core.undoAddMeetingTranscriptAction(meeting.id, firstId);
    const [item] = (await core.listMeetings())[0]?.summary?.items ?? [];
    if (!item) throw new Error("The action is missing.");
    expect(item).toEqual({
      id: itemId,
      kind: "action",
      status: "active",
      text: source.text,
      corrected: true,
    });
    await core.correctMeetingSummaryItem(meeting.id, item, {
      kind: "action",
      status: "done",
      text: "Checked with the team.",
    });
    await expect(core.undoAddMeetingTranscriptAction(meeting.id, itemId)).rejects.toMatchObject({
      wording: { key: "error.meeting.summaryItemChanged" },
    });
  } finally {
    core.close();
  }
  const { core: reopened } = await transcribingCore(dataDir);
  try {
    expect((await reopened.listMeetings())[0]?.summary?.items).toEqual([
      {
        id: itemId,
        kind: "action",
        status: "done",
        text: "Checked with the team.",
        corrected: true,
      },
    ]);
    expect(await reopened.getMeetingSummaryItemSources(meeting.id, itemId)).toEqual({
      documentId: docId,
      sources: [source],
    });
    expect(await reopened.addMeetingTranscriptAction(meeting.id, docId, source)).toEqual({
      itemId,
      added: false,
    });
  } finally {
    reopened.close();
  }
});

test("only a current, exact saved line from this Meeting can be added", async () => {
  const { core, meeting, dataDir } = await recordedMeeting("en");
  try {
    const live = (await core.listMeetings())[0]?.transcript?.documentId;
    const invalid = { startMs: 0, endMs: 1, text: "Invented words" };
    if (live)
      await expect(
        core.addMeetingTranscriptAction(meeting.id, live, invalid),
      ).rejects.toMatchObject(unavailable);
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const [cue] = await savedCues(core, meeting.id);
    if (!cue || !document.path) throw new Error("The test needs a saved Transcript.");
    const add = (source: MeetingSummarySource) =>
      core.addMeetingTranscriptAction(meeting.id, document.id, source);
    await expect(add({ ...cue, text: invalid.text })).rejects.toMatchObject(unavailable);
    await expect(add({ ...cue, startMs: cue.startMs + 0.1 })).rejects.toMatchObject(unavailable);
    const other = await core.createMeeting();
    await expect(core.addMeetingTranscriptAction(other.id, document.id, cue)).rejects.toMatchObject(
      unavailable,
    );
    await writeFile(document.path, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nReplacement.\n");
    await expect(add(cue)).rejects.toMatchObject(unavailable);
    expect(
      (await core.listMeetings()).find((entry) => entry.id === meeting.id)?.summary?.items,
    ).toBeUndefined();
  } finally {
    core.close();
  }
});

test("a split transcript line keeps only the selected speaker's words and time when the split is later undone", async () => {
  const first = "我去订票。";
  const second = "我来订酒店。";
  const { core, meeting, dataDir } = await recordedMeeting("zh-CN", { lines: [first + second] });
  try {
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const cue = (await savedCues(core, meeting.id)).find((line) => line.text === first + second);
    if (!cue?.speaker) throw new Error("The test needs the combined line.");
    const splitMs = Math.floor((cue.startMs + cue.endMs) / 2);
    const split = withLineSplit(
      document.speakers,
      { ...cue, label: cue.speaker },
      first.length,
      splitMs,
    );
    await core.setTranscriptSpeakers({ documentId: document.id, speakers: split });
    const selected = { startMs: splitMs, endMs: cue.endMs, text: second };
    const add = (source: MeetingSummarySource) =>
      core.addMeetingTranscriptAction(meeting.id, document.id, source);
    await expect(add(cue)).rejects.toMatchObject(unavailable);
    const { itemId } = await add(selected);
    expect(await core.getMeetingSummaryItemSources(meeting.id, itemId)).toEqual({
      documentId: document.id,
      sources: [{ ...selected, part: true }],
    });
    expect((await core.listMeetings())[0]?.summary?.items?.[0]?.text).toBe(second);
    await core.setTranscriptSpeakers({
      documentId: document.id,
      speakers: document.speakers ?? { labels: {}, lines: {} },
    });
    await expect(add(selected)).rejects.toMatchObject(unavailable);
    expect((await core.getMeetingSummaryItemSources(meeting.id, itemId))?.sources).toEqual([
      { ...selected, parentCue: { startMs: cue.startMs, endMs: cue.endMs } },
    ]);
  } finally {
    core.close();
  }
});
