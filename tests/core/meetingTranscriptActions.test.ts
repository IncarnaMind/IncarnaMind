import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import type { MeetingSummarySource } from "../../src/core/api";
import { readVtt, writeVtt } from "../../src/core/documents/formats/vtt";
import { targetHash } from "../../src/shared/proposals";
import { withLineSplit } from "../../src/shared/speakers";
import {
  recordedMeeting,
  savedCues,
  stoppedMeeting,
  transcribingCore,
  transcriptRead,
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
    const excerpt = { start: second.indexOf("酒店"), end: second.indexOf("酒店") + "酒店".length };
    const cropped = await core.addMeetingTranscriptAction(
      meeting.id,
      document.id,
      selected,
      excerpt,
    );
    expect((await core.getMeetingSummaryItemSources(meeting.id, cropped.itemId))?.sources).toEqual([
      {
        ...selected,
        text: "酒店",
        part: true,
        excerpt: { ...excerpt, cueHash: targetHash(cue.text) },
      },
    ]);

    await core.setTranscriptSpeakers({
      documentId: document.id,
      speakers: document.speakers ?? { labels: {}, lines: {} },
    });
    await expect(add(selected)).rejects.toMatchObject(unavailable);
    expect((await core.getMeetingSummaryItemSources(meeting.id, cropped.itemId))?.sources).toEqual([
      {
        ...selected,
        text: "酒店",
        excerpt: {
          start: first.length + excerpt.start,
          end: first.length + excerpt.end,
          cueHash: targetHash(cue.text),
        },
        parentCue: { startMs: cue.startMs, endMs: cue.endMs },
      },
    ]);

    expect((await core.getMeetingSummaryItemSources(meeting.id, itemId))?.sources).toEqual([
      { ...selected, parentCue: { startMs: cue.startMs, endMs: cue.endMs } },
    ]);
  } finally {
    core.close();
  }
});

test("two selected assignments in one utterance keep separate actions, original time and Undo", async () => {
  const first =
    "as the industrial designer , you're gonna be working on you know the actual working design of it";
  const second = "for user interface , technical functions";
  const text = `Right , well um so just to wrap up , um ${first} so y you know what you're doing there . Um ${second} , I guess that's you know like what we've been talking about , what it'll actually do .`;
  const { core, meeting, dataDir } = await recordedMeeting("en", { lines: [text] });
  try {
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const cue = (await savedCues(core, meeting.id)).find((row) => row.text === text);
    if (!cue) throw new Error("The test needs the original single cue.");
    const add = (value: string) => {
      const start = text.indexOf(value);
      return core.addMeetingTranscriptAction(meeting.id, document.id, cue, {
        start,
        end: start + value.length,
      });
    };
    const a = await add(first);
    const b = await add(second);
    expect((await core.listMeetings())[0]?.summary?.items?.map((item) => item.text)).toEqual([
      first,
      second,
    ]);
    expect(a.itemId).not.toBe(b.itemId);
    expect(await add(first)).toEqual({ ...a, added: false });
    const { startMs, endMs } = cue;
    for (const [id, words] of [
      [a.itemId, first],
      [b.itemId, second],
    ] as const) {
      expect((await core.getMeetingSummaryItemSources(meeting.id, id))?.sources).toMatchObject([
        { startMs, endMs, text: words },
      ]);
    }
    for (const range of [
      { start: -1, end: 2 },
      { start: 3, end: 3 },
      { start: 0, end: text.length + 1 },
      { start: 0.2, end: 4 },
    ]) {
      await expect(
        core.addMeetingTranscriptAction(meeting.id, document.id, cue, range),
      ).rejects.toMatchObject(unavailable);
    }
    await core.undoAddMeetingTranscriptAction(meeting.id, b.itemId);
    expect((await core.listMeetings())[0]?.summary?.items?.map((item) => item.text)).toEqual([
      first,
    ]);
  } finally {
    core.close();
  }
});

test("two occurrences of the same words on one line survive reopening with distinct offsets until the source changes", async () => {
  const text = "I will send it after the review. I will send it before the call.";
  const selected = "I will send it";
  const { core, meeting, dataDir } = await recordedMeeting("en", { lines: [text] });
  let id = "";
  let sourcePath = "";
  const saved: { itemId: number; start: number; end: number }[] = [];
  try {
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const cue = (await savedCues(core, meeting.id)).find((row) => row.text === text);
    if (!cue || !document.path) throw new Error("The test needs the original saved cue.");
    id = document.id;
    sourcePath = document.path;
    for (const start of [text.indexOf(selected), text.lastIndexOf(selected)]) {
      const end = start + selected.length;
      const { itemId } = await core.addMeetingTranscriptAction(meeting.id, id, cue, { start, end });
      saved.push({ itemId, start, end });
    }
    expect(new Set(saved.map((row) => row.itemId)).size).toBe(2);
  } finally {
    core.close();
  }
  const { core: reopened } = await transcribingCore(dataDir);
  try {
    for (const { itemId, start, end } of saved) {
      expect(
        (await reopened.getMeetingSummaryItemSources(meeting.id, itemId))?.sources,
      ).toMatchObject([{ text: selected, excerpt: { start, end } }]);
    }
    await writeFile(sourcePath, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nI will send it.\n");
    for (const { itemId } of saved)
      expect(
        (await reopened.getMeetingSummaryItemSources(meeting.id, itemId))?.sources ?? [],
      ).toEqual([]);
  } finally {
    reopened.close();
  }
});

test("an excerpt in simultaneous speakers' different lines opens only its original cue", async () => {
  const words = "Send the report";
  const spoken = `${words} to Finance.`;
  const other = `${words} to Legal.`;
  const { core, meeting, dataDir } = await recordedMeeting("en", { lines: [spoken] });
  try {
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    if (!document.path) throw new Error("Missing temporary transcript.");
    const transcript = readVtt(await readFile(document.path, "utf8"));
    const first = transcript.cues.find((row) => row.text === spoken);
    if (!first) throw new Error("Missing original test cue.");
    const left = { ...first, text: other, speaker: "Morgan" };
    const right = { ...first, speaker: "Riley" };
    await writeFile(document.path, writeVtt({ ...transcript, cues: [left, right] }));
    await core.reconcileDocuments();
    await transcriptRead(core, dataDir, meeting.id, document.id);
    const excerpt = { start: 0, end: words.length };
    const add = () => core.addMeetingTranscriptAction(meeting.id, document.id, right, excerpt);
    const { itemId } = await add();
    expect((await core.getMeetingSummaryItemSources(meeting.id, itemId))?.sources).toEqual([
      {
        startMs: right.startMs,
        endMs: right.endMs,
        text: words,
        excerpt: { ...excerpt, cueHash: targetHash(right.text) },
      },
    ]);
    await writeFile(
      document.path,
      writeVtt({ ...transcript, cues: [{ ...left, text: spoken }, right] }),
    );
    await core.reconcileDocuments();
    await transcriptRead(core, dataDir, meeting.id, document.id);
    expect((await core.getMeetingSummaryItemSources(meeting.id, itemId))?.sources).toEqual([]);
    await expect(add()).rejects.toMatchObject(unavailable);
  } finally {
    core.close();
  }
});
