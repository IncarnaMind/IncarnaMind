import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Core, SpeakerSeparator } from "../../src/core";
import { type Cue, readVtt } from "../../src/core/documents/formats/vtt";
import { labelled } from "../../src/core/meetings/speakerPass";
import { createTempDataFolder } from "../helpers/core";
import { fakeSeparator, transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

const line = (startMs: number, speaker: string): Cue => ({
  startMs,
  endMs: startMs + 2 * SECOND,
  text: `Line at ${startMs / SECOND} s.`,
  speaker,
});

async function savedCues(core: Core, meetingId: string) {
  const saved = await until(
    core,
    meetingId,
    (transcript) => transcript.state === "saved" && !transcript.separating,
  );
  return readVtt(readFileSync(saved.savedPath as string, "utf8")).cues;
}

async function meetingOf(core: Core, meetingId: string) {
  const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
  if (!meeting) throw new Error(`No Meeting ${meetingId}`);
  return meeting;
}

async function recordedCall(
  dataDir: string,
  options: Parameters<typeof transcribingCore>[1] = {},
  sources: ("microphone" | "system")[] = ["microphone", "system"],
) {
  const { core, record } = await transcribingCore(dataDir, options);
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: sources.includes("system") });
  record(25 * SECOND, sources);
  await until(core, meeting.id, (transcript) => transcript.lines >= 8);
  await core.stopMeeting(meeting.id);
  return { core, meeting };
}

describe("The labels the speaker pass gives (#138)", () => {
  // protects=DESIGN.md › Speakers: in a call the microphone stays "Me", several voices of the other side are "Speaker 1, 2…" in the order first heard, one stays "Them", and a room's are "Speaker n"; fails_when=a line takes a voice it overlaps less, "Me" changes, one voice is numbered, or the numbers follow the engine's; no_claim=the engine's own accuracy, which eval/speakers measures.
  test('in a call, several voices of the other side are numbered as first heard, one stays "Them", and in a room every voice is numbered', () => {
    const call = [line(0, "Me"), line(2000, "Them"), line(4000, "Them"), line(6000, "Them")];
    const turns = [
      { startMs: 1900, endMs: 4200, voice: 5 },
      { startMs: 4200, endMs: 6100, voice: 2 },
      { startMs: 6100, endMs: 8000, voice: 5 },
    ];
    expect(labelled(call, turns, true)?.map((cue) => cue.speaker)).toEqual([
      "Me",
      "Speaker 1",
      "Speaker 2",
      "Speaker 1",
    ]);
    expect(
      labelled(call, [{ startMs: 0, endMs: 8000, voice: 0 }], true)?.map((cue) => cue.speaker),
    ).toEqual(["Me", "Them", "Them", "Them"]);
    const room = [line(0, "Speaker ?"), line(2000, "Speaker ?")];
    expect(
      labelled(room, [{ startMs: 0, endMs: 4000, voice: 3 }], false)?.map((cue) => cue.speaker),
    ).toEqual(["Speaker 1", "Speaker 1"]);
  });

  // protects=after the pass numbers the voices, no line keeps the label they replaced: a line no voice overlaps takes the nearest voice, in a call and in a room; fails_when=a line stays "Them" beside "Speaker 1, 2…", or "Speaker ?" after a room's pass, or takes a voice farther away; no_claim=whether the nearest voice is the right person, which eval/speakers measures.
  test("a line no voice overlaps takes the nearest voice, so none is left with the old label", () => {
    const call = [line(0, "Me"), line(2000, "Them"), line(4000, "Them"), line(9000, "Them")];
    const turns = [
      { startMs: 1900, endMs: 4100, voice: 5 },
      { startMs: 4100, endMs: 6100, voice: 2 },
      { startMs: 11_500, endMs: 12_000, voice: 5 },
    ];
    expect(labelled(call, turns, true)?.map((cue) => cue.speaker)).toEqual([
      "Me",
      "Speaker 1",
      "Speaker 2",
      "Speaker 1",
    ]);
    const room = [line(0, "Speaker ?"), line(2000, "Speaker ?"), line(7000, "Speaker ?")];
    expect(
      labelled(
        room,
        [
          { startMs: 0, endMs: 2000, voice: 1 },
          { startMs: 2000, endMs: 4000, voice: 0 },
        ],
        false,
      )?.map((cue) => cue.speaker),
    ).toEqual(["Speaker 1", "Speaker 2", "Speaker 2"]);
  });

  // protects=a pass that heard too little of the lines' speech changes nothing, so a broken or empty result never relabels a Transcript; fails_when=the lines are relabelled from a voice covering a fraction of them; no_claim=the threshold's best value, which #85's set tunes.
  test("when too little of the lines' speech has a voice, the labels stay", () => {
    const call = [line(0, "Them"), line(2000, "Them"), line(4000, "Them")];
    expect(labelled(call, [{ startMs: 0, endMs: 500, voice: 0 }], true)).toBeNull();
    expect(labelled(call, [], true)).toBeNull();
  });
});

describe("The speaker pass after the call (#138)", { timeout: 60_000 }, () => {
  // protects=after Stop the Transcript is saved with the labels of where lines came from at once, then the pass relabels the other side in one write to the same file, and the Meeting says it is separating until then; fails_when=the save waits for the pass, "Me" lines change, the file isn't rewritten, or separating never ends; no_claim=the real engine, which the eval and the native import test cover.
  test("in a call, the other side's voices become Speaker 1 and 2 after the save, and the User's lines stay \"Me\"", async () => {
    const dataDir = await createTempDataFolder();
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { separator, requests } = fakeSeparator({ holds });
    const { core, meeting } = await recordedCall(dataDir, { speakerSeparator: separator });

    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    expect(saved.separating).toBe(true);
    const before = readVtt(readFileSync(saved.savedPath as string, "utf8")).cues;
    expect(new Set(before.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    expect(requests[0]?.parts.length).toBeGreaterThan(0);

    release();
    const cues = await savedCues(core, meeting.id);
    expect(cues.map((cue) => cue.text)).toEqual(before.map((cue) => cue.text));
    expect(
      cues
        .filter((cue) => before[cues.indexOf(cue)]?.speaker === "Me")
        .every((cue) => cue.speaker === "Me"),
    ).toBe(true);
    const theirs = cues.filter((cue) => cue.speaker !== "Me");
    expect(new Set(theirs.map((cue) => cue.speaker))).toEqual(new Set(["Speaker 1", "Speaker 2"]));
    // The fake hears voice 0 in the first ten seconds, voice 1 in the next.
    expect(theirs.find((cue) => cue.startMs < 10 * SECOND)?.speaker).toBe("Speaker 1");
    expect(
      theirs.find((cue) => cue.startMs >= 10 * SECOND && cue.endMs <= 20 * SECOND)?.speaker,
    ).toBe("Speaker 2");
    core.close();
  });

  // protects=one voice on the other side keeps "Them", in a call; fails_when=it becomes "Speaker 1"; no_claim=a real recording's one voice, which the eval covers.
  test('with one voice on the other side, its lines stay "Them"', async () => {
    const dataDir = await createTempDataFolder();
    const { separator } = fakeSeparator({ voiceOf: () => 0 });
    const { core, meeting } = await recordedCall(dataDir, { speakerSeparator: separator });
    const cues = await savedCues(core, meeting.id);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    core.close();
  });

  // protects=in a room the pass numbers every voice, and when it fails the room's lines stay "Speaker ?" and the Transcript says its speakers couldn't be told apart; fails_when=a failure leaves the Meeting separating, says nothing, changes a label, or loses a line; no_claim=why the engine failed, which only the log says.
  test('in a room the voices are numbered, and a pass that fails leaves "Speaker ?"', async () => {
    const room = fakeSeparator();
    const told = await recordedCall(
      await createTempDataFolder(),
      { speakerSeparator: room.separator, capture: { system: "denied" } },
      ["microphone"],
    );
    const cues = await savedCues(told.core, told.meeting.id);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Speaker 1", "Speaker 2"]));
    expect(room.requests[0]?.parts.every((part) => part.path.includes("microphone"))).toBe(true);
    told.core.close();

    const failing = fakeSeparator({ fails: "The model couldn't load." });
    const kept = await recordedCall(
      await createTempDataFolder(),
      { speakerSeparator: failing.separator, capture: { system: "denied" } },
      ["microphone"],
    );
    const unchanged = await savedCues(kept.core, kept.meeting.id);
    expect(unchanged.length).toBeGreaterThan(0);
    expect(new Set(unchanged.map((cue) => cue.speaker))).toEqual(new Set(["Speaker ?"]));
    expect((await meetingOf(kept.core, kept.meeting.id)).transcript?.problem?.kind).toBe(
      "speakers",
    );
    kept.core.close();
  });

  // protects=after a failed pass, Try again runs it again while the audio is kept, and its labels replace the old ones; once the audio is deleted, nothing offers it; fails_when=Try again does nothing, the problem stays after a pass that worked, or it is offered with no audio left; no_claim=why the first pass failed.
  test("Try again runs a failed pass again while the audio is kept", async () => {
    const working = fakeSeparator();
    let failed = 0;
    const separator: SpeakerSeparator = {
      separate: (request) =>
        failed++ === 0
          ? Promise.reject(new Error("The speaker process stopped."))
          : working.separator.separate(request),
    };
    const { core, meeting } = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: separator,
    });
    await until(core, meeting.id, (transcript) => transcript.problem?.kind === "speakers");
    await core.retryTranscript(meeting.id);
    const cues = await savedCues(core, meeting.id);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2"]),
    );
    expect((await meetingOf(core, meeting.id)).transcript?.problem).toBeNull();
    core.close();

    const gone = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: fakeSeparator({ fails: "The speaker process stopped." }).separator,
    });
    await until(
      gone.core,
      gone.meeting.id,
      (transcript) => transcript.problem?.kind === "speakers",
    );
    await gone.core.deleteMeetingAudio(gone.meeting.id);
    expect((await meetingOf(gone.core, gone.meeting.id)).transcript?.problem).toBeNull();
    gone.core.close();
  });

  // protects=with the speaker models missing (their download failing), the pass gives up, the labels stay, the Meeting stops separating and says its speakers couldn't be told apart; fails_when=it hangs, says nothing, or relabels with no model; no_claim=a download that comes back later, which the next Meeting's start retries.
  test("with the speaker models missing, the labels stay", async () => {
    const { separator, requests } = fakeSeparator();
    const missing = await transcribingCore(await createTempDataFolder(), {
      speakerSeparator: separator,
      speakerModelSource: {
        segmentation: {
          baseUrl: "http://127.0.0.1:9/",
          files: [{ path: "model.int8.onnx", size: 10, sha256: "0".repeat(64) }],
        },
        embedding: { baseUrl: "http://127.0.0.1:9/", files: [] },
      },
    });
    const meeting = await missing.core.createMeeting();
    await missing.core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    missing.record(25 * SECOND);
    await until(missing.core, meeting.id, (transcript) => transcript.lines >= 8);
    await missing.core.stopMeeting(meeting.id);
    const cues = await savedCues(missing.core, meeting.id);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    expect(requests).toHaveLength(0);
    expect((await meetingOf(missing.core, meeting.id)).transcript?.problem?.kind).toBe("speakers");
    missing.core.close();
  });

  // protects=a quit during the pass leaves the saved Transcript as it was, and the next start runs the pass again while the audio is kept; with the audio deleted meanwhile, the labels stay; fails_when=the restart never relabels, relabels with no audio, or the quit loses the Transcript; no_claim=a crash of the speaker process itself, which rejects like any failure.
  test("a quit during the pass runs it again at the next start, while the audio is kept", async () => {
    const dataDir = await createTempDataFolder();
    const hung = fakeSeparator({ holds: new Promise(() => {}) });
    const first = await recordedCall(dataDir, { speakerSeparator: hung.separator });
    const saved = await until(
      first.core,
      first.meeting.id,
      (transcript) => transcript.state === "saved" && transcript.separating,
    );
    first.core.close();
    expect(
      new Set(
        readVtt(readFileSync(saved.savedPath as string, "utf8")).cues.map((cue) => cue.speaker),
      ),
    ).toEqual(new Set(["Me", "Them"]));

    const again = fakeSeparator();
    const second = await transcribingCore(dataDir, { speakerSeparator: again.separator });
    const cues = await savedCues(second.core, first.meeting.id);
    expect(again.requests).toHaveLength(1);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2"]),
    );
    second.core.close();

    const gone = await createTempDataFolder();
    const cut = await recordedCall(gone, {
      speakerSeparator: fakeSeparator({ holds: new Promise(() => {}) }).separator,
    });
    await until(
      cut.core,
      cut.meeting.id,
      (transcript) => transcript.state === "saved" && transcript.separating,
    );
    await cut.core.deleteMeetingAudio(cut.meeting.id);
    cut.core.close();
    const later = fakeSeparator();
    const third = await transcribingCore(gone, { speakerSeparator: later.separator });
    const kept = await savedCues(third.core, cut.meeting.id);
    expect(later.requests).toHaveLength(0);
    expect(new Set(kept.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    third.core.close();
  });
});
