/**
 * Playing a saved Meeting's audio from a word of its Transcript, and splitting a line to say who
 * spoke the rest (#138), through the core's public interface as the Transcript view uses it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { clockTime } from "../../src/shared/clock";
import { partsOf, withLineSplit, withSpeakerChosen } from "../../src/shared/speakers";
import { timeAt } from "../../src/shared/wordTimes";
import { askAndFinish, citingModel, onlyCitation, type ShownPassage } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import {
  fakeSeparator,
  recordedCall,
  savedCues,
  transcribingCore,
  transcriptRead,
  until,
} from "../helpers/transcription";

const RATE = 16_000;
const WAV_HEADER = 44;

/** A source's samples in its first part, -1 to 1, as the file keeps them. */
function partSamples(dataDir: string, meetingId: string, source: "microphone" | "system") {
  const bytes = readFileSync(join(dataDir, "meetings", meetingId, `${source}-0000000000.wav`));
  return (index: number) => bytes.readInt16LE(WAV_HEADER + index * 2) / 32768;
}

async function transcriptOf(core: Core, meetingId: string): Promise<Document> {
  const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
  const document = (await core.listDocuments()).find(
    (each) => each.id === meeting?.transcript?.documentId,
  );
  if (!document) throw new Error("No Transcript.");
  return document;
}

const fileLine = (cue: Cue) => ({
  startMs: cue.startMs,
  endMs: cue.endMs,
  text: cue.text,
  label: cue.speaker as string,
});

const exported = async (core: Core, mindId: string) =>
  new TextDecoder().decode((await core.exportMind(mindId, { format: "markdown" })).data);

describe("Playing a Meeting's audio from a word (#138)", { timeout: 60_000 }, () => {
  // protects=a stopped Meeting's audio is read a stretch at a time, both sources mixed, from the time asked; once deleted, and while recording, there is none, said in plain words; a stretch is at most 30 seconds and runs forwards; fails_when=a stretch is read from the wrong time, one source only, after Delete now, or while recording; no_claim=the window's playing, which the window spec covers.
  test("a stopped Meeting's audio is read from the time asked, both sources mixed, until it is deleted", async () => {
    const dataDir = await createTempDataFolder();
    const { core, meeting } = await recordedCall(dataDir);
    await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const stretch = await core.readMeetingAudio({
      meetingId: meeting.id,
      fromMs: 1000,
      toMs: 3000,
    });
    expect(stretch).toMatchObject({ fromMs: 1000, toMs: 3000, sampleRate: RATE });
    expect(stretch.samples).toHaveLength(2 * RATE);
    const microphone = partSamples(dataDir, meeting.id, "microphone");
    const system = partSamples(dataDir, meeting.id, "system");
    for (const index of [0, 137, 8000, 2 * RATE - 1]) {
      const mixed = microphone(RATE + index) + system(RATE + index);
      expect(stretch.samples[index]).toBeCloseTo(Math.max(-1, Math.min(1, mixed)), 5);
    }
    // Both tones are there, louder together than the microphone's alone.
    const loudest = Math.max(...stretch.samples.map(Math.abs));
    expect(loudest).toBeGreaterThan(Math.abs(microphone(RATE + 9)) + 0.01);
    const long = await core.readMeetingAudio({ meetingId: meeting.id, fromMs: 0, toMs: 600_000 });
    expect(long.toMs).toBe(30_000);
    await expect(
      core.readMeetingAudio({ meetingId: meeting.id, fromMs: 3000, toMs: 1000 }),
    ).rejects.toMatchObject({ wording: { key: "error.meeting.audioStretch" } });

    await core.deleteMeetingAudio(meeting.id);
    await expect(
      core.readMeetingAudio({ meetingId: meeting.id, fromMs: 1000, toMs: 3000 }),
    ).rejects.toMatchObject({ wording: { key: "error.meeting.audioGone" } });
    core.close();
  });

  // protects=no playing while a Meeting records: its audio isn't read until it stops; fails_when=a recording Meeting's audio is read; no_claim=a paused Meeting, which is not a saved Transcript either.
  test("a Meeting that records has no audio to play yet", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder());
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(4000);
    await expect(
      core.readMeetingAudio({ meetingId: meeting.id, fromMs: 0, toMs: 2000 }),
    ).rejects.toMatchObject({ wording: { key: "error.meeting.audioGone" } });
    core.close();
  });
});

describe("Splitting a line of a Transcript (#138)", { timeout: 60_000 }, () => {
  // protects=a split and who speaks the rest are kept beside the file, which never changes; a Citation of the rest, in a Note that isn't open, shows the rest's own time and Speaker while it stores the file's line; one Undo sets the line back whole; fails_when=the file or its version changes, the Citation shows the line's first time or Speaker for the rest, stores the part's time, or Undo leaves the split; no_claim=the window's menu and keys, which the window spec covers.
  test("a split line keeps its file, and a Citation of the rest shows the rest's time and Speaker", async () => {
    const { core, meeting } = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: fakeSeparator().separator,
    });
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptOf(core, meeting.id);
    const file = readFileSync(transcript.path);
    const cue = cues.find(
      (each) => each.speaker === "Speaker 1" && each.text.split(" ").length > 4,
    );
    if (!cue) throw new Error("No long line by Speaker 1.");
    const line = fileLine(cue);
    const at = cue.text.indexOf(" ", cue.text.indexOf(" ") + 1) + 1;
    const split = withLineSplit(transcript.speakers, line, at, timeAt(cue, at));
    const [head, rest] = partsOf(split, line);
    if (!head || !rest) throw new Error("The line wasn't split.");
    expect(rest.startMs).toBeGreaterThan(cue.startMs);
    expect(rest.startMs).toBeLessThan(cue.endMs);
    const lines = [
      ...cues.map((each) => ({ startMs: each.startMs, label: each.speaker as string })),
      { startMs: rest.startMs, label: line.label },
    ];
    const told = withSpeakerChosen(
      split,
      lines,
      { startMs: rest.startMs, label: line.label },
      { name: "Sam" },
      false,
    );
    await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: split });
    await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: told });

    const mind = await core.createMind({ title: "Follow-up" });
    const client = await connectToMind(core, mind.id);
    const citation = (quote: string): JSONContent => ({
      type: "citation",
      attrs: {
        passageId: "passage-1",
        documentId: transcript.id,
        documentName: transcript.name,
        contentHash: transcript.contentHash,
        location: { kind: "time", from: cue.startMs, to: cue.endMs, speaker: cue.speaker },
        quote,
        check: "found",
      },
    });
    writeMind(client, [
      { type: "paragraph", content: [{ type: "text", text: "Head " }, citation(head.text)] },
      { type: "paragraph", content: [{ type: "text", text: "Rest " }, citation(rest.text)] },
    ]);
    await client.settled();
    await core.closeMind(mind.id);
    let text = await exported(core, mind.id);
    expect(text).toContain(`Speaker 1 · ${clockTime(cue.startMs)}`);
    expect(text).toContain(`Sam · ${clockTime(rest.startMs)}`);

    const after = await transcriptOf(core, meeting.id);
    expect(readFileSync(after.path)).toEqual(file);
    expect(after.contentHash).toBe(transcript.contentHash);

    // One Undo: who's who as it was before the split.
    await core.setTranscriptSpeakers({
      documentId: transcript.id,
      speakers: transcript.speakers ?? { labels: {}, lines: {} },
    });
    text = await exported(core, mind.id);
    expect(text).not.toContain("Sam");
    expect(text.split(`Speaker 1 · ${clockTime(cue.startMs)}`)).toHaveLength(3);
    core.close();
  });

  // protects=a model reads each part of a split line with its own time and Speaker, and its "0:12 Sam" for the rest is found in the line and stored as the file's line and label; fails_when=the model reads the line whole under its first Speaker, or the record isn't found, or a part's time is stored; no_claim=a real model's wording.
  test('a model reads each part with its own mark, and its "0:12 Sam" is found and stored as the line', async () => {
    let shown: ShownPassage[] = [];
    let cite = { location: "", quote: "" };
    const plan = {
      query: "",
      records: (passages: ShownPassage[]) => {
        shown = passages;
        const passage = passages.find((each) => each.text.includes(cite.quote));
        return [{ marker: 1, passage: passage?.id, location: cite.location, quote: cite.quote }];
      },
      answer: "Sam said so [^1].",
    };
    const dataDir = await createTempDataFolder();
    const { core, meeting } = await recordedCall(dataDir, {
      speakerSeparator: fakeSeparator().separator,
      model: citingModel(plan),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptRead(
      core,
      dataDir,
      meeting.id,
      (await transcriptOf(core, meeting.id)).id,
    );
    const cue = cues.find(
      (each) => each.speaker === "Speaker 1" && each.text.split(" ").length > 4,
    );
    if (!cue) throw new Error("No long line by Speaker 1.");
    const line = fileLine(cue);
    const at = cue.text.indexOf(" ", cue.text.indexOf(" ") + 1) + 1;
    const split = withLineSplit(null, line, at, timeAt(cue, at));
    const rest = partsOf(split, line)[1];
    if (!rest) throw new Error("The line wasn't split.");
    const told = withSpeakerChosen(
      split,
      [{ startMs: rest.startMs, label: line.label }],
      { startMs: rest.startMs, label: line.label },
      { name: "Sam" },
      false,
    );
    await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: told });

    const mind = await core.createMind({ title: "Who said it" });
    const client = await connectToMind(core, mind.id);
    plan.query = rest.text;
    cite = { location: `${clockTime(rest.startMs)} Sam`, quote: rest.text };
    const asked = await askAndFinish(core, client, mind.id, "What did Sam say?");
    const marks = shown.map((passage) => passage.text).join("\n");
    expect(marks).toContain(`[${clockTime(rest.startMs)} Sam] ${rest.text}`);
    expect(marks).toContain(
      `[${clockTime(cue.startMs)} Speaker 1] ${partsOf(told, line)[0]?.text}`,
    );
    expect(onlyCitation(client, asked.answerId)).toMatchObject({
      location: { kind: "time", from: cue.startMs, speaker: "Speaker 1" },
      quote: rest.text,
      check: "found",
    });
    core.close();
  });
});
