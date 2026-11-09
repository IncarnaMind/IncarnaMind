import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { Core, SpeakerSeparator } from "../../src/core";
import { type Cue, readVtt } from "../../src/core/documents/formats/vtt";
import { labelled } from "../../src/core/meetings/speakerPass";
import { createTempDataFolder } from "../helpers/core";
import {
  fakeSeparator,
  recordedCall,
  savedCues,
  toldCues,
  transcribingCore,
  until,
} from "../helpers/transcription";

const SECOND = 1000;

const line = (startMs: number, speaker: string): Cue => ({
  startMs,
  endMs: startMs + 2 * SECOND,
  text: `Line at ${startMs / SECOND} s.`,
  speaker,
});

async function meetingOf(core: Core, meetingId: string) {
  const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
  if (!meeting) throw new Error(`No Meeting ${meetingId}`);
  return meeting;
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
  // protects=after Stop the Transcript is saved with the labels of where lines came from at once, then the pass gives the other side's lines their voices in its who's who, its file and version untouched (#2839), and the Meeting says it is separating until then; fails_when=the save waits for the pass, "Me" lines change, the file is rewritten, a version is made, or separating never ends; no_claim=the real engine, which the eval and the native import test cover.
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
    const file = readFileSync(saved.savedPath as string, "utf8");
    const before = readVtt(file).cues;
    expect(new Set(before.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    // The pass starts once the finished text is indexed.
    await vi.waitFor(() => expect(requests[0]?.parts.length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    const version = (await core.listDocuments()).find(
      (each) => each.id === saved.documentId,
    )?.contentHash;

    release();
    const cues = await toldCues(core, meeting.id);
    expect(cues.map((cue) => cue.text)).toEqual(before.map((cue) => cue.text));
    expect(readFileSync(saved.savedPath as string, "utf8")).toBe(file);
    expect(
      (await core.listDocuments()).find((each) => each.id === saved.documentId)?.contentHash,
    ).toBe(version);
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

  // protects=a call's Note deleted while its speakers are told apart gets who spoke each line when it is back, and a who's who the User set before then is kept, never written over by the pass (#2839, #1253); fails_when=the pass's result is lost while the Note is in Recently deleted, or replaces the User's names; no_claim=a pass that fails, which the tests below cover.
  test("a Note deleted during the pass gets its speakers back with it, and the User's own who's who stays", async () => {
    for (const named of [false, true]) {
      let release = () => {};
      const holds = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { separator: told } = fakeSeparator({ holds });
      let answered = false;
      const separator: SpeakerSeparator = {
        async cluster(request) {
          const clustered = await told.cluster(request);
          answered = true;
          return clustered;
        },
      };
      const { core, meeting } = await recordedCall(await createTempDataFolder(), {
        speakerSeparator: separator,
      });
      const saved = await until(
        core,
        meeting.id,
        (transcript) => transcript.state === "saved" && transcript.separating,
      );
      const theirs = { labels: { Them: "Dana" }, lines: {} };
      if (named) {
        await core.setTranscriptSpeakers({
          documentId: saved.documentId as string,
          speakers: theirs,
        });
      }
      await core.deleteMind(meeting.mindId);
      release();
      await vi.waitFor(() => expect(answered).toBe(true));
      // The pass ends in the promise turns after its answer: the next task sees it ended.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
      const cues = await toldCues(core, meeting.id);
      const document = (await core.listDocuments()).find((each) => each.id === saved.documentId);
      if (named) {
        expect(document?.speakers).toEqual(theirs);
        expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
      } else {
        expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
          new Set(["Me", "Speaker 1", "Speaker 2"]),
        );
      }
      core.close();
    }
  });

  // protects=the pass says who's who changed only when it wrote it: once for a pass that gives lines to Speakers, never for one that renames no one, and never when the User's own who's who, set while the Note was in Recently deleted, kept the pass's result out (#2839); fails_when=an event says who's who changed when nothing was written, or none comes after a write; no_claim=the event's listeners in the window.
  test.each([
    ["gives lines to Speakers", undefined, false, 1],
    ["renames no one", () => 0, false, 0],
    ["meets the User's own who's who", undefined, true, 0],
  ] as const)(
    "a pass that %s says who's who changed only when it wrote it",
    async (_, voiceOf, named, events) => {
      let release = () => {};
      const holds = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { separator: told } = fakeSeparator({ holds, ...(voiceOf && { voiceOf }) });
      let answered = false;
      const separator: SpeakerSeparator = {
        async cluster(request) {
          const clustered = await told.cluster(request);
          answered = true;
          return clustered;
        },
      };
      const { core, meeting } = await recordedCall(await createTempDataFolder(), {
        speakerSeparator: separator,
      });
      const saved = await until(
        core,
        meeting.id,
        (transcript) => transcript.state === "saved" && transcript.separating,
      );
      const theirs = { labels: { Them: "Dana" }, lines: {} };
      if (named) {
        await core.setTranscriptSpeakers({
          documentId: saved.documentId as string,
          speakers: theirs,
        });
        await core.deleteMind(meeting.mindId);
      }
      const changed: string[] = [];
      core.on("documents.speakersChanged", (documents) => {
        for (const document of documents) changed.push(document.id);
      });
      release();
      await vi.waitFor(() => expect(answered).toBe(true));
      // The pass ends in the promise turns after its answer: the next task sees it ended.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (named) await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
      await toldCues(core, meeting.id);
      expect(changed).toEqual(Array.from({ length: events }, () => saved.documentId));
      const document = (await core.listDocuments()).find((each) => each.id === saved.documentId);
      if (named) expect(document?.speakers).toEqual(theirs);
      core.close();
    },
  );

  // protects=one voice on the other side keeps "Them", in a call; fails_when=it becomes "Speaker 1"; no_claim=a real recording's one voice, which the eval covers.
  test('with one voice on the other side, its lines stay "Them"', async () => {
    const dataDir = await createTempDataFolder();
    const { separator } = fakeSeparator({ voiceOf: () => 0 });
    const { core, meeting } = await recordedCall(dataDir, { speakerSeparator: separator });
    const cues = await toldCues(core, meeting.id);
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
    const cues = await toldCues(told.core, told.meeting.id);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Speaker 1", "Speaker 2"]));
    expect(room.requests[0]?.parts.every((part) => part.path.includes("microphone"))).toBe(true);
    told.core.close();

    const failing = fakeSeparator({ fails: "The model couldn't load." });
    const kept = await recordedCall(
      await createTempDataFolder(),
      { speakerSeparator: failing.separator, capture: { system: "denied" } },
      ["microphone"],
    );
    const unchanged = await toldCues(kept.core, kept.meeting.id);
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
      cluster: (request) =>
        failed++ === 0
          ? Promise.reject(new Error("The speaker process stopped."))
          : working.separator.cluster(request),
    };
    const { core, meeting } = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: separator,
    });
    await until(core, meeting.id, (transcript) => transcript.problem?.kind === "speakers");
    await core.retryTranscript(meeting.id);
    const cues = await toldCues(core, meeting.id);
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
    const cues = await toldCues(missing.core, meeting.id);
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
    const cues = await toldCues(second.core, first.meeting.id);
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
    const kept = await toldCues(third.core, cut.meeting.id);
    expect(later.requests).toHaveLength(0);
    expect(new Set(kept.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    third.core.close();
  });
});

/** A fake separator whose requests answer only when the test lets each go, by its place. */
function heldSeparator(voiceOf: (index: number) => number) {
  const lets: (() => void)[] = [];
  const answered: number[] = [];
  const fake = fakeSeparator({
    voiceOf,
    holdOf: () =>
      new Promise<void>((resolve) => {
        lets.push(resolve);
      }),
  });
  const separator: SpeakerSeparator = {
    async cluster(request) {
      const clustered = await fake.separator.cluster(request);
      answered.push(fake.requests.indexOf(request));
      return clustered;
    },
  };
  return { separator, requests: fake.requests, answered, letGo: (at: number) => lets[at]?.() };
}

const offsets = (request: { parts: readonly { offsetMs: number }[] } | undefined) =>
  request?.parts.map((part) => part.offsetMs) ?? [];

/** Each line of the other side's with the Speaker of its part's voice, numbered as first heard. */
function expectedSpeakers(cues: readonly Cue[], voiceOf: (index: number) => number) {
  const names = new Map<number, string>();
  return cues.map((cue) => {
    if (cue.speaker === "Me") return "Me";
    const voice = voiceOf(Math.floor((cue.startMs + cue.endMs) / 2 / (10 * SECOND)));
    const name = names.get(voice) ?? `Speaker ${names.size + 1}`;
    names.set(voice, name);
    return name;
  });
}

describe("The speaker pass during the call (#2839)", { timeout: 60_000 }, () => {
  // protects=what is recorded of the other side is clustered during the call, again once max(60 s, a quarter of what was clustered) more is saved, so at Stop the tail left is short; fails_when=no run during the call, a run before 60 s more, a run before a quarter more once that is more, or a run given the microphone; no_claim=how long a run takes, which the gate in eval/speed/gates/speakers-during-call.md measures in the app.
  test("is clustered again as the call grows: after 60 s more, then a quarter more", async () => {
    const { separator, requests } = fakeSeparator();
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      speakerSeparator: separator,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    for (let at = 0; at < 400; at += 10) {
      record(10 * SECOND);
      // A turn of the event loop: each run answers before the next ten seconds come, as on an
      // idle computer.
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(requests.map((request) => request.parts.length)).toEqual([6, 12, 18, 24, 30, 38]);
    expect(
      requests.every((request) => request.parts.every((part) => part.path.includes("system"))),
    ).toBe(true);
    core.close();
  });

  // protects=Stop stops a run under way, and only what was saved after the last finished run is clustered then, its voices joined to the earlier ones by voiceprint: a voice heard before keeps its Speaker, a new one gets the next, across a pause; Stop pressed again clusters nothing more; fails_when=the run under way goes on, the tail starts before the finished run's end, a voice heard before gets a new Speaker, a new voice takes an old one's, or a second Stop runs another pass; no_claim=the engine's own voiceprints, which the gate's label runs measure.
  test("Stop stops a run under way and clusters only the tail, its voices joined to the earlier ones", async () => {
    const voices = [0, 1, 0, 1, 0, 1, 1, 0, 2, 2, 0, 1, 2];
    const voiceOf = (index: number) => voices[index] ?? 0;
    const pass = heldSeparator(voiceOf);
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      speakerSeparator: pass.separator,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(70 * SECOND);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(1));
    expect(offsets(pass.requests[0])).toEqual([0, 10, 20, 30, 40, 50].map((s) => s * SECOND));
    pass.letGo(0);
    await vi.waitFor(() => expect(pass.answered).toEqual([0]));
    await core.pauseMeeting(meeting.id);
    await core.resumeMeeting(meeting.id);
    record(60 * SECOND);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(2));
    expect(offsets(pass.requests[1]).at(-1)).toBe(110 * SECOND);

    await core.stopMeeting(meeting.id);
    expect(pass.requests[1]?.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(3));
    expect(offsets(pass.requests[2])).toEqual(
      [60, 70, 80, 90, 100, 110, 120].map((s) => s * SECOND),
    );
    await expect(core.stopMeeting(meeting.id)).rejects.toThrow();
    pass.letGo(2);
    const cues = await toldCues(core, meeting.id);
    expect(pass.requests).toHaveLength(3);
    const said = await savedCues(core, meeting.id);
    expect(cues.map((cue) => cue.speaker)).toEqual(expectedSpeakers(said, voiceOf));
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2", "Speaker 3"]),
    );
    core.close();
  });

  // protects=a call whose only run during it was stopped by Stop is told apart whole at Stop, as before #2839; fails_when=the pass clusters only part of it, or waits for the stopped run; no_claim=a run that finished, which the test above covers.
  test("with no run finished by Stop, the whole call is clustered then", async () => {
    const pass = heldSeparator((index) => index % 2);
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      speakerSeparator: pass.separator,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(65 * SECOND);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(1));
    await core.stopMeeting(meeting.id);
    expect(pass.requests[0]?.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(2));
    expect(offsets(pass.requests[1])[0]).toBe(0);
    expect(offsets(pass.requests[1]).at(-1)).toBe(60 * SECOND);
    pass.letGo(1);
    const cues = await toldCues(core, meeting.id);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2"]),
    );
    core.close();
  });

  // protects=in a room the room's voices are what is clustered during the recording and its tail at Stop; fails_when=a room's run is given the computer's sound, or none runs; no_claim=a call, which the tests above cover.
  test("in a room, the room's voices are clustered during the recording", async () => {
    const voiceOf = (index: number) => [0, 1, 1, 0, 0, 1, 0, 2][index] ?? 0;
    const pass = heldSeparator(voiceOf);
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      speakerSeparator: pass.separator,
      capture: { system: "denied" },
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(75 * SECOND, ["microphone"]);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(1));
    pass.letGo(0);
    await vi.waitFor(() => expect(pass.answered).toEqual([0]));
    await core.stopMeeting(meeting.id);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(2));
    expect(offsets(pass.requests[1])).toEqual([60, 70].map((s) => s * SECOND));
    expect(
      pass.requests.every((request) =>
        request.parts.every((part) => part.path.includes("microphone")),
      ),
    ).toBe(true);
    pass.letGo(1);
    const cues = await toldCues(core, meeting.id);
    expect(cues.map((cue) => cue.speaker)).toEqual(
      expectedSpeakers(await savedCues(core, meeting.id), voiceOf),
    );
    core.close();
  });

  // protects=a recording that turns out to be a call, its computer's sound heard only later, drops what was clustered of the microphone and clusters the other side from then on; fails_when=a run of the microphone goes on, or the microphone's stretches are joined to the other side's; no_claim=a call heard from the start, which the tests above cover.
  test("once the call's sound is heard, what was clustered of the microphone is dropped", async () => {
    const pass = heldSeparator((index) => index % 2);
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      speakerSeparator: pass.separator,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(65 * SECOND, ["microphone"]);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(1));
    expect(pass.requests[0]?.parts.every((part) => part.path.includes("microphone"))).toBe(true);
    record(70 * SECOND);
    expect(pass.requests[0]?.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(2));
    expect(pass.requests[1]?.parts.every((part) => part.path.includes("system"))).toBe(true);
    pass.letGo(1);
    await vi.waitFor(() => expect(pass.answered).toEqual([1]));
    await core.stopMeeting(meeting.id);
    await vi.waitFor(() => expect(pass.requests).toHaveLength(3));
    expect(pass.requests[2]?.parts.every((part) => part.path.includes("system"))).toBe(true);
    pass.letGo(2);
    const cues = await toldCues(core, meeting.id);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2"]),
    );
    core.close();
  });

  // protects=what was clustered during a call is in memory only: a quit mid-call leaves nothing half written, and the whole call is clustered at its Stop after the next start; fails_when=the restart uses a result from before the quit, clusters only part of the call, or the quit leaves a label in the file; no_claim=a quit during the pass after Stop, which the test above covers.
  test("a quit mid-call keeps nothing of what was clustered, so the whole call is clustered at Stop", async () => {
    const dataDir = await createTempDataFolder();
    const first = heldSeparator((index) => index % 2);
    const before = await transcribingCore(dataDir, { speakerSeparator: first.separator });
    const meeting = await before.core.createMeeting();
    await before.core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    before.record(65 * SECOND);
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    first.letGo(0);
    await vi.waitFor(() => expect(first.answered).toEqual([0]));
    before.core.close();

    const again = fakeSeparator();
    const after = await transcribingCore(dataDir, { speakerSeparator: again.separator });
    await after.core.stopMeeting(meeting.id);
    const cues = await toldCues(after.core, meeting.id);
    expect(again.requests).toHaveLength(1);
    expect(offsets(again.requests[0])[0]).toBe(0);
    expect(offsets(again.requests[0]).at(-1)).toBe(60 * SECOND);
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2"]),
    );
    after.core.close();
  });

  // protects=one pass at a time: a run during a call waits while a pass after Stop is under way, and starts once it ends; fails_when=the two run at once, or the call's runs never start again; no_claim=two Meetings recording at once, which can't happen.
  test("a run during a call waits for another Meeting's pass after Stop", async () => {
    let letGo = () => {};
    const holds = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const { separator, requests } = fakeSeparator({ holds });
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      speakerSeparator: separator,
    });
    const earlier = await core.createMeeting();
    await core.startMeeting({ meetingId: earlier.id, systemAudio: true });
    record(25 * SECOND);
    await until(core, earlier.id, (transcript) => transcript.lines >= 8);
    await core.stopMeeting(earlier.id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    const later = await core.createMeeting();
    await core.startMeeting({ meetingId: later.id, systemAudio: true });
    record(65 * SECOND);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
    letGo();
    await toldCues(core, earlier.id);
    record(1 * SECOND);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.parts.every((part) => part.path.includes(later.id))).toBe(true);
    core.close();
  });
});
