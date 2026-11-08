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
import { translate } from "../../src/shared/i18n";
import { formatLocation } from "../../src/shared/locations";
import { partsOf, withLineSplit, withSpeakerChosen } from "../../src/shared/speakers";
import { timeAt } from "../../src/shared/wordTimes";
import {
  askAndFinish,
  citingModel,
  onlyCitation,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import {
  fakeSeparator,
  recordedCall,
  savedCues,
  toldCues,
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
    const told = await toldCues(core, meeting.id);
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptOf(core, meeting.id);
    const file = readFileSync(transcript.path);
    const cue = cues.find(
      (each, at) => told[at]?.speaker === "Speaker 1" && each.text.split(" ").length > 4,
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
    const sam = withSpeakerChosen(
      split,
      lines,
      { startMs: rest.startMs, label: line.label },
      { name: "Sam" },
      false,
    );
    await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: split });
    await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: sam });

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
    const spoken = await toldCues(core, meeting.id);
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptRead(
      core,
      dataDir,
      meeting.id,
      (await transcriptOf(core, meeting.id)).id,
    );
    const cue = cues.find(
      (each, at) => spoken[at]?.speaker === "Speaker 1" && each.text.split(" ").length > 4,
    );
    if (!cue) throw new Error("No long line by Speaker 1.");
    const line = fileLine(cue);
    const at = cue.text.indexOf(" ", cue.text.indexOf(" ") + 1) + 1;
    const split = withLineSplit(transcript.speakers, line, at, timeAt(cue, at));
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
      location: { kind: "time", from: cue.startMs, speaker: "Them" },
      quote: rest.text,
      check: "found",
    });
    core.close();
  });
});

/** A call in English or Chinese: Dana's line, which the User splits, then a line of hers that starts 1 ms before it ends. */
const CALLS = {
  en: {
    label: "Dana",
    rest: "Sam",
    line: "We sign on Friday. No, I need the budget first.",
    next: "Then the board reads it on Monday.",
    head: "We sign on Friday",
    tail: "No, I need the budget first",
    across: "Friday. No, I need",
    at: "No,",
  },
  zh: {
    label: "王丽",
    rest: "李明",
    line: "我们周五签约。不，我需要先看预算。",
    next: "然后董事会周一再看。",
    head: "我们周五签约",
    tail: "我需要先看预算",
    across: "签约。不，我需要",
    at: "不，",
  },
} as const;

describe("A split line's quotes, by who said them (#138)", { timeout: 60_000 }, () => {
  // protects=of a split line a model's record finds its quote only in the parts the named Speaker said: "0:02 Sam" quoting Dana's words, "0:04 Dana" quoting Sam's, and a quote across the split under either name aren't found, while each quote under its own Speaker is, and with both parts Dana's a quote across the split is found again; the Citation found keeps its line and shows the rest's Speaker, and checks found again; the core refuses a split outside its line or where another of her lines starts; in English and Chinese; fails_when=a quote is found under someone who didn't say it, a crossing quote is found under one name, a right one isn't, or a split that doesn't hold is kept; no_claim=a real model's records.
  test.each(["en", "zh"] as const)(
    "only the named Speaker's parts hold their quote (%s)",
    async (language) => {
      const call = CALLS[language];
      let cite = { location: "", quote: "" };
      const plan = {
        query: call.line,
        records: (passages: ShownPassage[]) => [
          { marker: 1, passage: passages[0]?.id, location: cite.location, quote: cite.quote },
        ],
        answer: "So [^1].",
      };
      const file = `WEBVTT\n\n00:00:02.000 --> 00:00:06.000\n<v ${call.label}>${call.line}\n\n00:00:05.999 --> 00:00:09.000\n<v ${call.label}>${call.next}\n`;
      const { core, documents, mind, client } = await setUpWithDocuments(citingModel(plan), [
        { name: `${language}.vtt`, contents: file },
      ]);
      const transcript = documents[0] as Document;
      const line = { startMs: 2000, endMs: 6000, text: call.line, label: call.label };
      const lines = [
        { startMs: 2000, label: call.label },
        { startMs: 5999, label: call.label },
      ];
      const at = call.line.indexOf(call.at);

      // A split that doesn't hold is refused: a part outside the line, or where her next line starts.
      for (const ms of [6500, 5999]) {
        await expect(
          core.setTranscriptSpeakers({
            documentId: transcript.id,
            speakers: {
              labels: {},
              lines: {},
              splits: { [`2000 ${call.label}`]: { text: call.line, parts: [{ at, ms }] } },
            },
          }),
        ).rejects.toMatchObject({ wording: { key: "error.transcript.speakersUnheld" } });
      }

      const split = withLineSplit(null, line, at, 4100, lines);
      const told = withSpeakerChosen(
        split,
        [...lines, { startMs: 4100, label: call.label }],
        { startMs: 4100, label: call.label },
        { name: call.rest },
        false,
      );
      await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: told });
      const asked = async (location: string, quote: string) => {
        cite = { location, quote };
        const { answerId } = await askAndFinish(core, client, mind.id, `${location}: ${quote}?`);
        return onlyCitation(client, answerId);
      };

      const right = await asked(`0:04 ${call.rest}`, call.tail);
      expect(right).toMatchObject({
        check: "found",
        location: { kind: "time", from: 2000, speaker: call.label },
      });
      expect((await asked(`0:02 ${call.label}`, call.head)).check).toBe("found");
      for (const [location, quote] of [
        [`0:02 ${call.rest}`, call.head],
        [`0:04 ${call.label}`, call.tail],
        [`0:02 ${call.label}`, call.tail],
        [`0:02 ${call.label}`, call.across],
        [`0:04 ${call.rest}`, call.across],
      ] as const) {
        expect((await asked(location, quote)).check, `${location} ${quote}`).not.toBe("found");
      }

      // The Citation found checks found again, and shows the rest's Speaker and time.
      const again = await core.recheckCitation({
        mindId: mind.id,
        documentId: transcript.id,
        pageFrom: right.pageFrom ?? null,
        pageTo: right.pageTo ?? null,
        quote: call.tail,
        location: right.location ?? null,
      });
      if ("keptInside" in again) throw new Error("The check was kept inside a wall.");
      expect(again.check).toBe("found");
      const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
        translate(language === "en" ? "en" : "zh-CN", key, params);
      if (!again.location) throw new Error("The check found no Location.");
      expect(formatLocation(again.location, t, { speakers: told, quote: call.tail })).toBe(
        `${call.rest} · 0:04`,
      );

      // With both parts Dana's again, a quote across the split is hers.
      const hers = withSpeakerChosen(
        told,
        [...lines, { startMs: 4100, label: call.label }],
        { startMs: 4100, label: call.label },
        { label: call.label },
        false,
      );
      expect(hers.splits).toEqual(told.splits);
      await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: hers });
      expect((await asked(`0:02 ${call.label}`, call.across)).check).toBe("found");
      core.close();
    },
  );
});
