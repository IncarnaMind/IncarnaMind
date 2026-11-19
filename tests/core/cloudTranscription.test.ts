import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { hashBytes } from "../../src/core/documents/files";
import { readVtt, writeVtt } from "../../src/core/documents/formats/vtt";
import { InvalidInputError } from "../../src/core/errors";
import type { CloudConnect } from "../../src/core/transcription/cloud/socket";
import {
  createFakeSpeechEngine,
  FAKE_LINES,
  FAKE_THEIR_LINES,
} from "../../src/core/transcription/fake";
import { createFakeCloud, FAKE_CLOUD_LINES } from "../../src/core/transcription/fakeCloud";
import { askAndFinish, citingModel, onlyCitation, type ShownPassage } from "../helpers/citations";
import { createMemoryKeychain, createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import {
  fakeSeparator,
  toldCues,
  transcribingCore,
  transcriptOf,
  until,
} from "../helpers/transcription";

const SECOND = 1000;
const SONIOX_KEY = "soniox-test-key-0123456789";
const QWEN_KEY = "sk-qwen-test-key-0123456789";

async function chooseSoniox(core: Core) {
  await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
  await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
}

function scriptedSoniox() {
  const sockets: {
    close(): void;
    progress(ms: number): void;
    hear(message: object): void;
    say(text: string, start: number, end: number): void;
    audio: Buffer[];
  }[] = [];
  const cloud: CloudConnect = (_url, _key, events) => {
    const audio: Buffer[] = [];
    const hear = (message: object) => events.message(JSON.stringify(message));
    sockets.push({
      audio,
      hear,
      close: () => events.closed(1006),
      progress: (ms) => hear({ total_audio_proc_ms: ms }),
      say(text, start, end) {
        hear({
          tokens: [
            { text, start_ms: start, end_ms: end, speaker: "1", is_final: true },
            { text: "<end>", is_final: true },
          ],
        });
      },
    });
    queueMicrotask(() => events.open());
    return {
      send(data) {
        if (typeof data !== "string") audio.push(Buffer.from(data));
        if (data === "") hear({ finished: true });
      },
      close() {},
    };
  };
  return { sockets, cloud };
}

/** The Qwen key in Models, for a region ("cn": Beijing, the first; "intl": Singapore), and Qwen chosen for meetings. */
async function chooseQwen(core: Core, endpoint?: "cn" | "intl") {
  await core.saveChatProvider({
    kind: "qwen",
    ...(endpoint && { endpoint }),
    apiKey: QWEN_KEY,
    modelId: "qwen3.7-plus",
  });
  await core.updateSettings({ device: { transcriptionRoute: "qwen" } });
}

/** The Transcript's lines as its Document shows them, once the saved file's text is indexed: the first's start, and each line's speaker. */
function shownSpeakers(core: Core, documentId: string | null, savedPath: string | null) {
  if (!documentId || !savedPath) throw new Error("The saved Transcript has no Document.");
  const hash = hashBytes(readFileSync(savedPath));
  return vi.waitFor(async () => {
    const { pages, contentHash } = await core.readDocumentText(documentId);
    if (contentHash !== hash || pages.length === 0)
      throw new Error("The saved Transcript's text isn't indexed yet.");
    return {
      from: pages[0]?.label?.from ?? null,
      speakers: pages.flatMap((page) => page.label?.speakers ?? []),
    };
  });
}

/** Every file under a folder, with what it holds. */
function filesUnder(folder: string): { path: string; text: string }[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory()
      ? filesUnder(path)
      : [{ path, text: readFileSync(path).toString("latin1") }];
  });
}

describe("Cloud transcription with the User's own key", { timeout: 60_000 }, () => {
  test("a Meeting transcribed by the chosen service: its lines, and speakers it told apart", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");

    record(9 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    expect(live).toMatchObject({ state: "live", cloud: "soniox", fellBack: null });
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(cues.every((cue) => FAKE_CLOUD_LINES.includes(cue.text))).toBe(true);
    // The microphone in a call is the User's own; the other side's voices are numbered as told
    // apart, the first's lines too once the second spoke (DESIGN.md › Speakers).
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2"]),
    );
  });

  test.each([
    { language: "English", first: "We have the draft.", second: "I will send it today." },
    { language: "Chinese", first: "我们已经有初稿了。", second: "我今天发给你。" },
  ])(
    "a provisional Soniox voice does not renumber a single confirmed speaker in $language",
    async ({ first, second }) => {
      const connections: Array<{ heard: (message: object) => void }> = [];
      const cloud: CloudConnect = (_url, _key, events) => {
        const heard = (message: object) => events.message(JSON.stringify(message));
        queueMicrotask(() => events.open());
        return {
          send(data) {
            if (data === "") heard({ finished: true });
            else if (
              typeof data !== "string" &&
              !connections.some((each) => each.heard === heard) &&
              data.some((byte) => byte !== 0)
            )
              connections.push({ heard });
          },
          close() {},
        };
      };
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        cloud,
        capture: { microphone: "denied" },
      });
      await chooseSoniox(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
      record(3 * SECOND, ["system"]);
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      const socket = connections[0];
      if (!socket) throw new Error("The system audio stream did not open.");
      const end = { text: "<end>", is_final: true };
      socket.heard({
        tokens: [{ text: first, start_ms: 200, end_ms: 900, speaker: "1", is_final: true }, end],
        final_audio_proc_ms: 900,
      });
      await until(core, meeting.id, (transcript) => transcript.lines === 1);
      const draft = { text: second, start_ms: 1100, end_ms: 2200, speaker: "2", is_final: false };
      socket.heard({ tokens: [draft] });
      await until(core, meeting.id, (transcript) =>
        transcript.partials.some((line) => line.text === second),
      );
      socket.heard({
        tokens: [{ ...draft, speaker: "1", is_final: true }, end],
        final_audio_proc_ms: 3000,
      });
      await until(core, meeting.id, (transcript) => transcript.lines === 2);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      if (!saved.savedPath) throw new Error("The Transcript was not saved.");
      const { cues } = readVtt(readFileSync(saved.savedPath, "utf8"));
      expect(cues.map(({ text, speaker }) => ({ text, speaker }))).toEqual([
        { text: first, speaker: "Them" },
        { text: second, speaker: "Them" },
      ]);
    },
  );

  test("word-level AssemblyAI speakers appear in the live and saved Transcript", async () => {
    const cloud: CloudConnect = (_url, _key, events) => {
      const say = (message: object) => events.message(JSON.stringify(message));
      let audioBytes = 0;
      queueMicrotask(() => {
        events.open();
        say({ type: "Begin", id: "room" });
      });
      return {
        send(data) {
          if (typeof data === "string") {
            say({ type: "Termination", audio_duration_seconds: audioBytes / 32_000 });
            return;
          }
          const before = audioBytes;
          audioBytes += data.byteLength;
          if (before < 64_000 && audioBytes >= 64_000) {
            say({
              type: "Turn",
              turn_order: 0,
              end_of_turn: true,
              speaker_label: "A",
              transcript: "Let's confirm. 周三吗？",
              words: [
                { text: "Let's", start: 300, end: 550, speaker: "A", word_is_final: true },
                { text: "confirm.", start: 550, end: 990, speaker: "A", word_is_final: true },
                { text: "周三吗？", start: 940, end: 1650, speaker: "B", word_is_final: true },
              ],
            });
          }
        },
        close() {},
      };
    };
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, { cloud });
    await core.setTranscriptionKey({ route: "assemblyai", apiKey: "assemblyai-test-key" });
    await core.updateSettings({ device: { transcriptionRoute: "assemblyai" } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "assemblyai");

    record(3 * SECOND, ["microphone"]);
    await until(core, meeting.id, (transcript) => transcript.lines === 2);
    const expected = [
      { speaker: "Speaker 1", text: "Let's confirm.", startMs: 300, endMs: 990 },
      {
        speaker: "Speaker 2",
        text: "周三吗？",
        startMs: 940,
        endMs: 1650,
        words: [{ at: 0, ms: 940 }],
      },
    ];
    const livePath = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    expect(readVtt(readFileSync(livePath, "utf8")).cues).toMatchObject(expected);

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    if (!saved.savedPath) throw new Error("The Transcript has no saved file.");
    expect(readVtt(readFileSync(saved.savedPath, "utf8")).cues).toMatchObject(expected);
    expect((await shownSpeakers(core, saved.documentId, saved.savedPath)).speakers).toEqual([
      "Speaker 1",
      "Speaker 2",
    ]);
  });

  test("the service's unfinished words show for both sides before any line is finished, and the finished line takes their place", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");

    record(1.5 * SECOND);
    const speaking = await until(
      core,
      meeting.id,
      (transcript) => transcript.partials.length === 2,
    );
    expect(speaking.lines).toBe(0);
    expect(speaking.documentId).toBeNull();
    expect(speaking.partials.map((partial) => partial.speaker).sort()).toEqual(["Me", "Them"]);
    for (const { text } of speaking.partials) {
      expect(FAKE_CLOUD_LINES.some((line) => line.startsWith(text) && line !== text)).toBe(true);
    }

    record(3 * SECOND);
    const finished = await until(core, meeting.id, (transcript) =>
      speaking.partials.every(
        (partial) => !transcript.partials.some((each) => each.startMs === partial.startMs),
      ),
    );
    expect(finished.lines).toBeGreaterThanOrEqual(2);
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    for (const partial of speaking.partials) {
      const line = cues.find((cue) => cue.startMs === partial.startMs);
      expect(line?.text.startsWith(partial.text)).toBe(true);
      expect(FAKE_CLOUD_LINES).toContain(line?.text);
    }
  });

  // protects=on the cloud path too, a line the User said before the others made a sound becomes Me once the computer's sound is heard, not the room's "Speaker 1" the service's voice gave it (#2305); fails_when=the first line keeps a number; no_claim=the local engine, which tests/core/transcripts.test.ts covers.
  test("the User speaks before the others make a sound: the service's first lines read Me once the call is heard", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(4 * SECOND, ["microphone"]);
    await until(core, meeting.id, (transcript) => transcript.lines >= 1);
    record(6 * SECOND);
    const live = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await vi.waitFor(() =>
      expect(readVtt(readFileSync(live, "utf8")).cues.some((cue) => cue.speaker !== "Me")).toBe(
        true,
      ),
    );
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { from, speakers } = await shownSpeakers(core, saved.documentId, saved.savedPath);
    // Only the microphone was heard for the first four seconds: the first line is the User's.
    expect(from).toBe(0);
    expect(speakers[0]).toBe("Me");
    expect(speakers.some((speaker) => speaker !== "Me")).toBe(true);
  });

  // protects=the same across a quit: the service numbered the User's first line as a room's voice before the others made a sound, IncarnaMind closed, and once the resumed Meeting hears the call, that line read back from the file becomes Me too (#2305); fails_when=the saved first line keeps "Speaker 1"; no_claim=a macOS that never allows the computer's sound.
  test("the User's first lines read Me after a quit, once the resumed Meeting hears the call", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir);
    await chooseSoniox(first.core);
    const meeting = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: meeting.id });
    await until(first.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    first.record(4 * SECOND, ["microphone"]);
    await until(first.core, meeting.id, (transcript) => transcript.lines >= 1);
    first.core.close();

    const second = await transcribingCore(dataDir);
    await chooseSoniox(second.core);
    await second.core.resumeMeeting(meeting.id);
    await until(second.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    second.record(4 * SECOND, ["microphone"]);
    second.record(8 * SECOND);
    const live = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await vi.waitFor(() =>
      expect(readVtt(readFileSync(live, "utf8")).cues.some((cue) => cue.speaker !== "Me")).toBe(
        true,
      ),
    );
    await second.core.stopMeeting(meeting.id);
    const saved = await until(
      second.core,
      meeting.id,
      (transcript) => transcript.state === "saved",
    );
    const { from, speakers } = await shownSpeakers(second.core, saved.documentId, saved.savedPath);
    expect(from).toBe(0);
    expect(speakers[0]).toBe("Me");
    expect(speakers.some((speaker) => speaker !== "Me")).toBe(true);
    second.core.close();
  });

  // protects=a Transcript saved by an older version, with no callHeard mark and only numbered voices, loads as a call that was heard, so the resumed Meeting keeps the other side's labels instead of making every saved line Me, and only the microphone's new lines are Me (#2305); fails_when=the old numbered lines become Me when the resumed Meeting hears the computer's sound; no_claim=a Transcript saved before the voices map, which has no :system: key to tell it by.
  test("a legacy Transcript with only numbered voices keeps them when the resumed Meeting hears the call", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir);
    await chooseSoniox(first.core);
    const meeting = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: meeting.id });
    await until(first.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    first.record(9 * SECOND);
    await until(first.core, meeting.id, (transcript) => transcript.lines >= 4);
    const live = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await vi.waitFor(() =>
      expect(readVtt(readFileSync(live, "utf8")).cues.some((cue) => cue.speaker !== "Me")).toBe(
        true,
      ),
    );
    first.core.close();

    // The files an older version left: no callHeard mark, and cues whose voices are numbered only.
    const jsonPath = join(dataDir, "Transcripts", `${meeting.id}.json`);
    const saved = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
    delete saved.callHeard;
    // The older version had transcribed all it recorded: the resumed stop catches nothing up.
    saved.doneMs = 9 * SECOND;
    saved.pending = [];
    writeFileSync(jsonPath, JSON.stringify(saved));
    const vttPath = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    const legacy = readVtt(readFileSync(vttPath, "utf8"));
    writeFileSync(
      vttPath,
      writeVtt({
        cues: legacy.cues.map((cue) => ({ ...cue, speaker: "Speaker 2" })),
        gaps: legacy.gaps,
      }),
    );
    expect(saved).not.toHaveProperty("callHeard");
    expect(Object.keys((saved.voices ?? {}) as Record<string, number>)).toContainEqual(
      expect.stringContaining(":system:"),
    );

    const second = await transcribingCore(dataDir);
    await chooseSoniox(second.core);
    await second.core.resumeMeeting(meeting.id);
    await until(second.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    second.record(8 * SECOND);
    await until(
      second.core,
      meeting.id,
      (transcript) => transcript.lines >= legacy.cues.length + 2,
    );
    await second.core.stopMeeting(meeting.id);
    const stopped = await until(
      second.core,
      meeting.id,
      (transcript) => transcript.state === "saved",
    );
    const { speakers } = await shownSpeakers(second.core, stopped.documentId, stopped.savedPath);
    // The saved lines keep the labels the older version gave them; the microphone's new lines are
    // the only Me, and the other side's are still its own voices.
    expect(speakers.slice(0, legacy.cues.length)).toEqual(legacy.cues.map(() => "Speaker 2"));
    const resumed = speakers.slice(legacy.cues.length);
    expect(resumed).toContain("Me");
    expect(resumed.some((speaker) => speaker !== "Me")).toBe(true);
    expect(
      resumed.every((speaker) => speaker === "Me" || /^(Them|Speaker \d+)$/.test(speaker ?? "")),
    ).toBe(true);
    second.core.close();
  });

  // protects=DESIGN.md › Speakers on the cloud path: one voice on the other side stays "Them", in the saved file and after the speaker pass, which runs on a cloud Transcript too; fails_when=one voice is numbered, or the pass leaves a cloud Transcript alone; no_claim=the pass's own labels, which tests/core/speakerPass.test.ts covers.
  test('with one voice on the other side, its lines say "Them", before the speaker pass and after it', async () => {
    const dataDir = await createTempDataFolder();
    const pass = fakeSeparator();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { cloud: { voices: 1 } },
      speakerSeparator: pass.separator,
    });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(9 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    await core.stopMeeting(meeting.id);
    const saved = await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "saved" && !transcript.separating,
    );
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    expect(pass.requests).toHaveLength(1);
    expect(new Set((await toldCues(core, meeting.id)).map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Them"]),
    );
    core.close();
  });

  // protects=DESIGN.md › Speakers on the cloud path: the voices a service numbers as they speak are rough, so after the call the speaker pass gives the other side's lines their final voices from the computer's sound, in the Transcript's who's who over its file's labels, the file itself untouched, the User's lines "Me" throughout, and a call the User said nothing in, whose lines say neither "Me" nor "Them", is told apart the same way; fails_when=a line keeps the service's voice after the pass, a "Me" line changes, the file is rewritten, or the pass reads the microphone's audio of a call; no_claim=the pass's own rule, which tests/core/speakerPass.test.ts covers, and which labels are right on real audio, which eval/speakers measures.
  test.each([
    { who: "both sides speak", sources: ["microphone", "system"] as const },
    { who: "the User says nothing", sources: ["system"] as const },
  ])(
    "after a call where $who, the speaker pass gives the final voices over the ones the service numbered",
    async ({ sources }) => {
      const dataDir = await createTempDataFolder();
      const pass = fakeSeparator();
      const { core, record } = await transcribingCore(dataDir, {
        engine: { cloud: { voices: 2 } },
        speakerSeparator: pass.separator,
      });
      await chooseSoniox(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
      record(25 * SECOND, [...sources]);
      await until(core, meeting.id, (transcript) => transcript.lines >= 8);
      await core.stopMeeting(meeting.id);
      const saved = await until(
        core,
        meeting.id,
        (transcript) => transcript.state === "saved" && !transcript.separating,
      );
      const file = readFileSync(saved.savedPath as string, "utf8");
      const before = readVtt(file).cues;
      const theirsBefore = before.filter((cue) => cue.speaker !== "Me");
      // The service's voices take turns line by line, so both speak in the first ten seconds.
      expect(
        new Set(theirsBefore.filter((cue) => cue.endMs <= 10 * SECOND).map((cue) => cue.speaker)),
      ).toEqual(new Set(["Speaker 1", "Speaker 2"]));

      expect(pass.requests).toHaveLength(1);
      expect(pass.requests[0]?.parts.length).toBeGreaterThan(0);
      expect(pass.requests[0]?.parts.every((part) => /[\\/]system-\d+\.wav$/.test(part.path))).toBe(
        true,
      );
      const cues = await toldCues(core, meeting.id);
      expect(readFileSync(saved.savedPath as string, "utf8")).toBe(file);
      expect(cues.filter((cue) => cue.speaker === "Me").map((cue) => cue.startMs)).toEqual(
        before.filter((cue) => cue.speaker === "Me").map((cue) => cue.startMs),
      );
      // The fake pass hears voice 0 in the first ten seconds and voice 1 in the next.
      const theirs = cues.filter((cue) => cue.speaker !== "Me");
      expect(
        new Set(theirs.filter((cue) => cue.endMs <= 10 * SECOND).map((cue) => cue.speaker)),
      ).toEqual(new Set(["Speaker 1"]));
      expect(
        new Set(
          theirs
            .filter((cue) => cue.startMs >= 10 * SECOND && cue.endMs <= 20 * SECOND)
            .map((cue) => cue.speaker),
        ),
      ).toEqual(new Set(["Speaker 2"]));
      core.close();
    },
  );

  // protects=in a room the speaker pass labels a cloud Transcript too, as after a call: it separates the room's track (the microphone), its voices replace the ones the service numbered, and the saved file is unchanged (#138); fails_when=the pass leaves a room's cloud Transcript alone, separates another track, or rewrites the file; no_claim=how well the pass tells voices apart, which eval/speakers measures.
  test("after a meeting in a room, the speaker pass gives the final voices over the ones the service numbered", async () => {
    const dataDir = await createTempDataFolder();
    const pass = fakeSeparator();
    const { core, record } = await transcribingCore(dataDir, {
      capture: { system: "denied" },
      engine: { cloud: { voices: 2 } },
      speakerSeparator: pass.separator,
    });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(25 * SECOND, ["microphone"]);
    await until(core, meeting.id, (transcript) => transcript.lines >= 8);
    await core.stopMeeting(meeting.id);
    const saved = await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "saved" && !transcript.separating,
    );
    const file = readFileSync(saved.savedPath as string, "utf8");
    // The service's voices take turns line by line, so both speak in the first ten seconds.
    expect(
      new Set(
        readVtt(file)
          .cues.filter((cue) => cue.endMs <= 10 * SECOND)
          .map((cue) => cue.speaker),
      ),
    ).toEqual(new Set(["Speaker 1", "Speaker 2"]));

    expect(pass.requests).toHaveLength(1);
    expect(pass.requests[0]?.parts.length).toBeGreaterThan(0);
    expect(
      pass.requests[0]?.parts.every((part) => /[\\/]microphone-\d+\.wav$/.test(part.path)),
    ).toBe(true);
    const cues = await toldCues(core, meeting.id);
    expect(readFileSync(saved.savedPath as string, "utf8")).toBe(file);
    expect(cues.some((cue) => cue.speaker === "Me")).toBe(false);
    // The fake pass hears voice 0 in the first ten seconds and voice 1 in the next.
    expect(
      new Set(cues.filter((cue) => cue.endMs <= 10 * SECOND).map((cue) => cue.speaker)),
    ).toEqual(new Set(["Speaker 1"]));
    expect(
      new Set(
        cues
          .filter((cue) => cue.startMs >= 10 * SECOND && cue.endMs <= 20 * SECOND)
          .map((cue) => cue.speaker),
      ),
    ).toEqual(new Set(["Speaker 2"]));
    core.close();
  });

  test("in a room, with no computer sound, the voices it told apart are numbered, never the User, and a Citation names them", async () => {
    const dataDir = await createTempDataFolder();
    const quote = FAKE_CLOUD_LINES[0] as string;
    const { core, record } = await transcribingCore(dataDir, {
      capture: { system: "denied" },
      model: citingModel({
        query: "budget",
        records: (passages: ShownPassage[]) => [
          { marker: 1, passage: passages[0]?.id, quote: `[0:00] ${quote}` },
        ],
        answer: "The budget holds [^1].",
      }),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(9 * SECOND, ["microphone"]);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 3);
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Speaker 1", "Speaker 2"]));

    await vi.waitFor(
      async () => {
        const found = await core.searchPassages("one point two million", { mode: "keyword" });
        expect(found.map((passage) => passage.documentId)).toContain(live.documentId);
      },
      { timeout: 20_000, interval: 50 },
    );
    const mind = await core.createMind({ title: "Budget" });
    const client = await connectToMind(core, mind.id);
    const { answerId } = await askAndFinish(core, client, mind.id, "Does the budget hold?");
    expect(onlyCitation(client, answerId)).toMatchObject({
      documentId: live.documentId,
      location: { kind: "time", speaker: cues.find((cue) => cue.text === quote)?.speaker },
      check: "found",
    });
    expect(onlyCitation(client, answerId).location).not.toMatchObject({ speaker: "Me" });
  });

  test("Soniox keeps transcribing live while it processes audio without finalizing its words", async () => {
    let processedMs = 0;
    const text = "Let’s review the budget.";
    const cloud: CloudConnect = (_url, _key, events) => {
      const say = (isFinal: boolean) =>
        events.message(
          JSON.stringify({
            tokens: [{ text, start_ms: 100, end_ms: processedMs, is_final: isFinal }],
            final_audio_proc_ms: isFinal ? processedMs : 0,
            total_audio_proc_ms: processedMs,
            ...(isFinal && { finished: true }),
          }),
        );
      queueMicrotask(() => events.open());
      return {
        send(data) {
          if (data === "") say(true);
          else if (typeof data !== "string") {
            processedMs += data.byteLength / 32;
            say(false);
          }
        },
        close() {},
      };
    };
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      cloud,
      capture: { microphone: "denied" },
    });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });

    for (let elapsed = 4 * SECOND; elapsed <= 44 * SECOND; elapsed += 4 * SECOND) {
      record(4 * SECOND, ["system"]);
      const live = await until(
        core,
        meeting.id,
        (transcript) =>
          transcript.state === "behind" ||
          (processedMs >= elapsed - SECOND && transcript.partials.length > 0),
      );
      expect(live).toMatchObject({ state: "live", cloud: "soniox", lines: 0 });
    }

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    if (!saved.savedPath) throw new Error("The Transcript was not saved.");
    const { cues, gaps } = readVtt(readFileSync(saved.savedPath, "utf8"));
    expect(gaps).toEqual([{ fromMs: 0, toMs: 44 * SECOND, reason: "muted" }]);
    expect(cues.map((cue) => cue.text)).toEqual([text]);
  });

  test.each([
    ["The first draft.", "The final draft."],
    ["先讨论初稿。", "最后定稿了。"],
  ])("a brief disconnect keeps %s once and resumes at its original time", async (first, second) => {
    const { cloud, sockets } = scriptedSoniox();
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      cloud,
      capture: { microphone: "denied" },
    });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (t) => t.cloud === "soniox");
    await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
    record(3000, ["system"]);
    await vi.waitFor(() => expect(sockets[0]?.audio.length).toBeGreaterThan(0));
    const original = sockets[0];
    if (!original) throw new Error("No system stream");
    original.say(first, 100, 1293);
    await until(core, meeting.id, (t) => t.lines === 1);
    const tail = Buffer.concat(original.audio).subarray(1293 * 32);
    expect(tail.length).toBeGreaterThan(0);
    original.close();
    record(1000, ["system"]);
    await vi.waitFor(() => expect(sockets[1]?.audio.length).toBeGreaterThan(0), { timeout: 6000 });
    const next = sockets[1];
    if (!next) throw new Error("No replacement system stream");
    const sent = Buffer.concat(next.audio);
    expect(sent.length).toBeGreaterThan(tail.length);
    expect(sent.subarray(0, tail.length).equals(tail)).toBe(true);
    next.say(second, 207, 1207);
    const live = await until(core, meeting.id, (t) => t.lines === 2);
    expect(live).toMatchObject({ cloud: "soniox", fellBack: null });
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (t) => t.state === "saved");
    if (!saved.savedPath) throw new Error("Transcript missing");
    const { cues } = readVtt(readFileSync(saved.savedPath, "utf8"));
    expect(cues.map((c) => [c.text, c.startMs, c.endMs])).toEqual([
      [first, 100, 1293],
      [second, 1500, 2500],
    ]);
    expect(Buffer.concat(next.audio).length).toBe((4000 - 1293) * 32);
    expect(cues.map((cue) => cue.speaker)).toEqual(["Them", "Them"]);
    expect(sockets).toHaveLength(2);
  });

  test.each([
    ["We agreed.", "The date", " moves to Friday."],
    ["我们同意了。", "我觉得学生", "学过这一行。"],
  ])(
    "a live disconnect inside a sentence keeps %s and replays the open sentence once",
    async (first, prefix, rest) => {
      const { cloud, sockets } = scriptedSoniox();
      const { core, record } = await transcribingCore(await createTempDataFolder(), {
        cloud,
        capture: { microphone: "denied" },
      });
      await chooseSoniox(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (t) => t.cloud === "soniox");
      await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
      record(4000, ["system"]);
      await vi.waitFor(() => expect(sockets[0]?.audio.length).toBeGreaterThan(0));
      const original = sockets[0];
      if (!original) throw new Error("Missing system stream");
      original.say(first, 100, 900);
      original.hear({
        tokens: [
          { text: prefix, start_ms: 1100, end_ms: 1800, is_final: true },
          { text: rest, start_ms: 1900, end_ms: 3100, is_final: false },
        ],
        final_audio_proc_ms: 2500,
        total_audio_proc_ms: 3300,
      });
      await until(core, meeting.id, (t) => t.partials.some((line) => line.text === prefix + rest));
      original.close();
      await vi.waitFor(() => expect(sockets[1]?.audio.length).toBeGreaterThan(0), {
        timeout: 6000,
      });
      const next = sockets[1];
      if (!next) throw new Error("Missing replacement stream");
      expect(Buffer.concat(next.audio)).toEqual(Buffer.concat(original.audio).subarray(1100 * 32));
      next.say(prefix + rest, 0, 2000);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (t) => t.state === "saved");
      if (!saved.savedPath) throw new Error("Transcript missing");
      expect(
        readVtt(readFileSync(saved.savedPath, "utf8")).cues.map((c) => [
          c.text,
          c.startMs,
          c.endMs,
        ]),
      ).toEqual([
        [first, 100, 900],
        [prefix + rest, 1100, 3100],
      ]);
    },
  );

  test("a disconnect beyond the replay window recovers the whole unfinished turn locally", async () => {
    const { cloud, sockets } = scriptedSoniox();
    const { core, record } = await transcribingCore(await createTempDataFolder(), { cloud });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (t) => t.cloud === "soniox");
    await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
    for (let step = 0; step < 8; step++) {
      record(5000, ["system"]);
      await vi.waitFor(() =>
        expect(Buffer.concat(sockets[0]?.audio ?? []).length).toBeGreaterThan(
          ((step + 1) * 5000 - 1000) * 32,
        ),
      );
      const socket = sockets[0];
      if (!socket) throw new Error("No system stream");
      socket.progress(Buffer.concat(socket.audio).length / 32);
    }
    sockets[0]?.close();
    await until(core, meeting.id, (t) => t.fellBack?.reason === "dropped");
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (t) => t.state === "saved");
    if (!saved.savedPath) throw new Error("Transcript missing");
    const { cues } = readVtt(readFileSync(saved.savedPath, "utf8"));
    expect(cues[0]?.startMs).toBeLessThan(1000);
    expect(cues.at(-1)?.endMs).toBeGreaterThan(39000);
    expect(sockets).toHaveLength(1);
  });

  test("after a second loss the healthy source recovers only past its own last words", async () => {
    const { cloud, sockets } = scriptedSoniox();
    const { core, record } = await transcribingCore(await createTempDataFolder(), { cloud });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (t) => t.cloud === "soniox");
    record(6000);
    await vi.waitFor(() => expect(sockets.filter((s) => s.audio.length > 0)).toHaveLength(2));
    const [healthy, lost] = sockets;
    if (!healthy || !lost) throw new Error("Missing one side of the call");
    healthy.say("Here is the original date.", 200, 2900);
    lost.say("I heard the plan.", 200, 1000);
    await until(core, meeting.id, (t) => t.lines === 2);
    lost.close();
    healthy.say("Please review the new deadline.", 3100, 5200);
    await until(core, meeting.id, (t) => t.lines === 3);
    await vi.waitFor(() => expect(sockets[2]?.audio.length).toBeGreaterThan(0), { timeout: 6000 });
    sockets[2]?.close();
    await until(core, meeting.id, (t) => t.fellBack?.reason === "dropped");
    record(4000);
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (t) => t.state === "saved");
    if (!saved.savedPath) throw new Error("Transcript missing");
    const { cues } = readVtt(readFileSync(saved.savedPath, "utf8"));
    const confirmed = cues.find((c) => c.text === "Please review the new deadline.");
    expect(confirmed?.endMs).toBe(5200);
    expect(
      cues.filter((c) => c.speaker === confirmed?.speaker && c.startMs < 5200).map((c) => c.text),
    ).toEqual(["Here is the original date.", "Please review the new deadline."]);
    expect(sockets).toHaveLength(3);
  });

  test("the connection dropping hands the live audio to this computer: the gap is marked, the bar says when, and Stop fills it in", async () => {
    const dataDir = await createTempDataFolder();
    const initial = createFakeCloud({ dropAfterMs: 5 * SECOND });
    let offline = false;
    const cloud: CloudConnect = (url, key, events, auth) => {
      if (offline) {
        queueMicrotask(() => events.closed(1006));
        return { send() {}, close() {} };
      }
      return initial(
        url,
        key,
        {
          ...events,
          closed(code, reason) {
            if (code === 1006) offline = true;
            events.closed(code, reason);
          },
        },
        auth,
      );
    };
    const { core, record } = await transcribingCore(dataDir, { cloud });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");

    record(4 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    record(3 * SECOND);
    const fellBack = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
    expect(fellBack).toMatchObject({
      cloud: null,
      fellBack: { route: "soniox", reason: "dropped" },
    });
    expect(fellBack.fellBack?.atMs).toBeGreaterThanOrEqual(4 * SECOND);

    // Recording goes on, and this computer gives the lines from here.
    record(6 * SECOND);
    await until(
      core,
      meeting.id,
      (transcript, each) =>
        each.status === "recording" && transcript.state === "live" && transcript.lines >= 4,
    );
    const working = readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8");
    expect(working).toMatch(/^NOTE gap .* cloud$/m);
    const health = (await core.listMeetings())[0]?.health.events;
    expect(health).toContainEqual(
      expect.objectContaining({ kind: "switched", from: "cloud", to: "local", reason: "failed" }),
    );

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(final.gaps).toEqual([]);
    const texts = final.cues.map((cue) => cue.text);
    expect(texts.some((text) => FAKE_CLOUD_LINES.includes(text))).toBe(true);
    expect(texts.some((text) => FAKE_LINES.includes(text))).toBe(true);
  });

  test("Soniox disconnecting during Stop recovers the unfinished audio in the saved Transcript", async () => {
    const dataDir = await createTempDataFolder();
    const connect = createFakeCloud();
    const cloud: CloudConnect = (url, key, events, auth) => {
      const socket = connect(url, key, events, auth);
      return {
        ...socket,
        send(data) {
          if (data === "") events.closed(1006);
          else socket.send(data);
        },
      };
    };
    const { core, record } = await transcribingCore(dataDir, { cloud });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(7 * SECOND);
    await until(
      core,
      meeting.id,
      (transcript) => transcript.lines >= 2 && transcript.partials.length > 0,
    );

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    if (!saved.savedPath) throw new Error("The Meeting's Transcript was not saved.");
    const final = readVtt(readFileSync(saved.savedPath, "utf8"));
    const texts = final.cues.map((cue) => cue.text);
    const cloudTexts = texts.filter((text) => FAKE_CLOUD_LINES.includes(text));
    expect(final.gaps).toEqual([]);
    expect(cloudTexts.length).toBeGreaterThan(0);
    expect(new Set(cloudTexts).size).toBe(cloudTexts.length);
    expect(texts.some((text) => FAKE_LINES.includes(text) || FAKE_THEIR_LINES.includes(text))).toBe(
      true,
    );
  });

  test("Stop only replays the unconfirmed audio of the Soniox track that disconnected", async () => {
    const dataDir = await createTempDataFolder();
    const durationMs = 3 * SECOND;
    const confirmedMs = 700;
    const systemText = "Please review";
    const tail = "the revised budget";
    const microphoneText = "我已记下。";
    let connections = 0;
    const cloud: CloudConnect = (_url, _key, events) => {
      const microphone = connections++ === 0;
      let heard = false;
      const say = (message: object) => events.message(JSON.stringify(message));
      queueMicrotask(() => events.open());
      return {
        send(data) {
          if (data === "") {
            if (microphone) say({ finished: true });
            else events.closed(1006);
          } else if (typeof data !== "string" && !heard) {
            heard = true;
            say({
              tokens: [
                {
                  text: microphone ? microphoneText : systemText,
                  start_ms: 0,
                  end_ms: confirmedMs,
                  is_final: true,
                },
              ],
              final_audio_proc_ms: confirmedMs,
            });
          }
        },
        close() {},
      };
    };
    const { core, record } = await transcribingCore(dataDir, {
      cloud,
      engineFactory: async () => ({
        ...createFakeSpeechEngine({ maxSpeechMs: durationMs }),
        recognizer: {
          async decode(samples, stream) {
            if (!stream.endsWith(":system")) return microphoneText;
            return samples.length <= (durationMs - confirmedMs) * 16
              ? tail
              : `${systemText} ${tail}`;
          },
        },
      }),
    });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(durationMs);
    await until(core, meeting.id, (transcript) => transcript.partials.length === 2);

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    if (!saved.savedPath) throw new Error("The Transcript was not saved.");
    const { cues, gaps } = readVtt(readFileSync(saved.savedPath, "utf8"));
    expect(gaps).toEqual([]);
    expect(cues.filter((cue) => cue.speaker === "Me").map((cue) => cue.text)).toEqual([
      microphoneText,
    ]);
    const theirs = cues.filter((cue) => cue.speaker === "Them");
    expect(theirs.map((cue) => cue.text)).toEqual([systemText, tail]);
    expect(theirs[1]?.startMs).toBe(theirs[0]?.endMs);
  });

  test("the monthly cap hands the live audio to this computer with a notice; recording never stops", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await chooseSoniox(core);
    // Soniox's $0.12 an hour: about 30 seconds of the two streams' audio fit.
    await core.updateSettings({ user: { monthlyCap: { currency: "USD", amount: 0.001 } } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");

    record(20 * SECOND);
    const capped = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
    expect(capped).toMatchObject({ cloud: null, fellBack: { route: "soniox", reason: "cap" } });
    record(4 * SECOND);
    const after = await until(
      core,
      meeting.id,
      (transcript, each) => each.status === "recording" && transcript.state === "live",
    );
    expect(after.fellBack?.reason).toBe("cap");
    const events = (await core.listMeetings())[0]?.health.events ?? [];
    expect(events).toContainEqual(expect.objectContaining({ kind: "switched", reason: "cap" }));
    const summary = await core.getCostSummary();
    expect(summary.spentTowardCap?.amount ?? 0).toBeLessThanOrEqual(0.001);
    expect(summary.spent[0]?.amount ?? 0).toBeGreaterThan(0);

    // The cloud's streams finished with what they were sent: no gap at the switch.
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    expect(readVtt(readFileSync(saved.savedPath as string, "utf8")).gaps).toEqual([]);

    // A Meeting started at the cap goes to this computer at once, saying why.
    const next = await core.createMeeting();
    await core.startMeeting({ meetingId: next.id });
    const local = await until(core, next.id, (transcript) => transcript.fellBack !== null);
    expect(local).toMatchObject({ cloud: null, fellBack: { reason: "cap", atMs: 0 } });
  });

  test("choosing the service is the consent to send it meeting audio, named for it; Local mode keeps it off", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    await expect(core.updateSettings({ device: { transcriptionRoute: "soniox" } })).rejects.toThrow(
      InvalidInputError,
    );
    expect((await core.getSettings()).device.transcriptionRoute).toBeNull();

    await chooseSoniox(core);
    const flows = await core.listDataFlows();
    expect(flows).toContainEqual(
      expect.objectContaining({
        flow: {
          id: "transcription",
          service: { id: "https://stt-rt.soniox.com", name: "Soniox" },
          sends: ["meeting-audio", "meeting-words"],
        },
        consent: "accepted",
        chosen: true,
      }),
    );

    await core.updateSettings({ device: { transcriptionRoute: "local" } });
    await core.setLocalOnly(true);
    await expect(core.updateSettings({ device: { transcriptionRoute: "soniox" } })).rejects.toThrow(
      InvalidInputError,
    );
  });

  test("a service's own key lives in the keychain, never in the data folder, and a key it refuses isn't kept", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    expect((await core.listTranscriptionServices()).services).toEqual([
      expect.objectContaining({ route: "openai", key: "provider", hasKey: false }),
      expect.objectContaining({ route: "soniox", key: "own", hasKey: false, liveSpeakers: true }),
      expect.objectContaining({ route: "qwen", key: "provider", hasKey: false }),
      expect.objectContaining({ route: "deepgram", key: "own", hasKey: false, liveSpeakers: true }),
      expect.objectContaining({
        route: "assemblyai",
        key: "own",
        hasKey: false,
        liveSpeakers: true,
      }),
      expect.objectContaining({ route: "gemini", key: "provider", hasKey: false }),
      expect.objectContaining({ route: "elevenlabs", key: "own", hasKey: false }),
      expect.objectContaining({
        route: "speechmatics",
        key: "own",
        hasKey: false,
        liveSpeakers: true,
      }),
      expect.objectContaining({ route: "gladia", key: "own", hasKey: false, keyChecked: false }),
      expect.objectContaining({ route: "xai", key: "provider", hasKey: false, liveSpeakers: true }),
    ]);

    await chooseSoniox(core);
    expect((await core.listTranscriptionServices()).services[1]).toMatchObject({ hasKey: true });
    const leaked = filesUnder(dataDir).filter((file) => file.text.includes(SONIOX_KEY));
    expect(leaked.map((file) => file.path)).toEqual([]);

    await core.removeTranscriptionKey("soniox");
    expect((await core.listTranscriptionServices()).services[1]).toMatchObject({ hasKey: false });
    expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
  });

  // protects=the services' revision (#2147): of two answers the higher revision is the newer, whichever was asked first; fails_when=a change doesn't raise it, a failed change does, or a list that a change overtook is stamped with a state older than it holds; no_claim=how the app orders the answers it gets, which e2e/modelSetup.spec.ts covers.
  describe("the services' revision", () => {
    test("every committed change raises it and a failed one leaves it", async () => {
      const dataDir = await createTempDataFolder();
      const { core } = await transcribingCore(dataDir);
      const first = await core.listTranscriptionServices();
      expect((await core.listTranscriptionServices()).revision).toBe(first.revision);

      await expect(core.setTranscriptionKey({ route: "soniox", apiKey: "" })).rejects.toThrow(
        InvalidInputError,
      );
      expect((await core.listTranscriptionServices()).revision).toBe(first.revision);

      const saved = await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
      expect(saved.revision).toBeGreaterThan(first.revision);
      expect(saved.services[1]).toMatchObject({ hasKey: true });
      expect((await core.listTranscriptionServices()).revision).toBe(saved.revision);

      const removed = await core.removeTranscriptionKey("soniox");
      expect(removed.revision).toBeGreaterThan(saved.revision);
      expect(removed.services[1]).toMatchObject({ hasKey: false });

      const provider = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "gpt-5.4-mini",
      });
      const withOpenAi = await core.listTranscriptionServices();
      expect(withOpenAi.revision).toBeGreaterThan(removed.revision);
      expect(withOpenAi.services[0]).toMatchObject({ hasKey: true });
      await core.deleteChatProvider(provider.id);
      const without = await core.listTranscriptionServices();
      expect(without.revision).toBeGreaterThan(withOpenAi.revision);
      expect(without.services[0]).toMatchObject({ hasKey: false });
    });

    test("a list that changes overtake while it is read keeps the revision it began at, below theirs", async () => {
      const dataDir = await createTempDataFolder();
      const memory = createMemoryKeychain();
      let hold: Promise<void> | null = null;
      const { core } = await transcribingCore(dataDir, {
        keychain: {
          ...memory,
          get: async (name) => {
            const value = await memory.get(name);
            const waiting = hold;
            hold = null;
            await waiting;
            return value;
          },
        },
      });
      await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
      const began = (await core.listTranscriptionServices()).revision;

      // The list reads the key, then waits; three changes are committed; the list ends.
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing = core.listTranscriptionServices();
      await core.removeTranscriptionKey("soniox");
      await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
      const last = await core.removeTranscriptionKey("soniox");
      release();
      const listed = await racing;

      expect(listed.revision).toBe(began);
      expect(last.revision).toBeGreaterThan(began);
      expect(last.services[1]).toMatchObject({ hasKey: false });
    });
  });

  // protects=Your providers says which provider row's key also transcribes; fails_when=the list names no provider, another one, or one for a service with its own key; no_claim=the row's words, which e2e/liveRoutes.spec.ts covers.
  test("OpenAI uses the key of the OpenAI provider in Models, and the list names that provider", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    const before = (await core.listTranscriptionServices()).services[0];
    expect(before).toMatchObject({ route: "openai", hasKey: false, providerId: null });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-5.4-mini",
    });
    await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
    const listed = (await core.listTranscriptionServices()).services;
    expect(listed[0]).toMatchObject({
      route: "openai",
      model: "gpt-live-transcribe",
      hasKey: true,
      providerId: provider.id,
      perHour: { currency: "USD", amount: 1.02 },
    });
    expect(listed[1]).toMatchObject({ route: "soniox", hasKey: true, providerId: null });
    await core.updateSettings({ device: { transcriptionRoute: "openai" } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "openai");
    record(6 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    expect(live.cloud).toBe("openai");
    expect((await transcriptOf(core, meeting.id)).fellBack).toBeNull();
  });

  describe("Qwen, with the key of the Qwen provider in Models", () => {
    test("a Meeting transcribed by Qwen: its lines come as sentences, with no speakers of its own", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir);
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(9 * SECOND);
      const live = await until(core, meeting.id, (transcript) => transcript.lines >= 4);
      expect(live).toMatchObject({ state: "live", cloud: "qwen", fellBack: null });
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(cues.every((cue) => FAKE_CLOUD_LINES.includes(cue.text))).toBe(true);
      // Qwen tells no speakers apart: the microphone is "Me" and the call "Them", until #140.
      expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    });

    test("it is offered with the region of the Qwen provider the key is from, and the price there; the consent is for that region's service", async () => {
      const dataDir = await createTempDataFolder();
      const { core } = await transcribingCore(dataDir);
      const qwen = async () =>
        (await core.listTranscriptionServices()).services.find((each) => each.route === "qwen");
      expect(await qwen()).toMatchObject({
        hasKey: false,
        region: null,
        model: "fun-asr-realtime",
      });

      await chooseQwen(core, "intl");
      expect(await qwen()).toMatchObject({
        hasKey: true,
        model: "fun-asr-realtime",
        region: { en: "International (Singapore)", zh: "国际（新加坡）" },
        perHour: { currency: "USD", amount: 0.324 },
        recipient: { en: "Alibaba Cloud", zh: "阿里云" },
        dataUse: {
          summary: { en: expect.stringContaining("isn’t used for model training") },
          url: { en: expect.stringMatching(/^https:\/\/docs\.agent\.bailian\.aliyun\.com\//) },
        },
      });
      expect(await core.listDataFlows()).toContainEqual(
        expect.objectContaining({
          flow: expect.objectContaining({
            id: "transcription",
            service: { id: "https://dashscope-intl.aliyuncs.com", name: "Qwen (Alibaba Cloud)" },
          }),
          consent: "accepted",
          chosen: true,
        }),
      );

      const beijing = await transcribingCore(await createTempDataFolder());
      await chooseQwen(beijing.core);
      expect(
        (await beijing.core.listTranscriptionServices()).services.find(
          (each) => each.route === "qwen",
        ),
      ).toMatchObject({
        region: { en: "China (Beijing)", zh: "中国内地（北京）" },
        perHour: { currency: "CNY", amount: 1.188 },
      });
      expect(await beijing.core.listDataFlows()).toContainEqual(
        expect.objectContaining({
          flow: expect.objectContaining({
            service: { id: "https://dashscope.aliyuncs.com", name: "Qwen (Alibaba Cloud)" },
          }),
          consent: "accepted",
        }),
      );
    });

    test("the key never leaves the keychain: it is in no file of the data folder", async () => {
      const dataDir = await createTempDataFolder();
      const { core } = await transcribingCore(dataDir);
      await chooseQwen(core);
      expect(filesUnder(dataDir).filter((file) => file.text.includes(QWEN_KEY))).toEqual([]);
    });

    test("the connection dropping hands the live audio to this computer: the gap is marked, the bar says when, and Stop fills it in", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: { cloud: { dropAfterMs: 5 * SECOND } },
      });
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(4 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.lines >= 2);
      record(3 * SECOND);
      const fellBack = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      expect(fellBack).toMatchObject({
        cloud: null,
        fellBack: { route: "qwen", reason: "dropped" },
      });

      record(6 * SECOND);
      await until(
        core,
        meeting.id,
        (transcript, each) =>
          each.status === "recording" && transcript.state === "live" && transcript.lines >= 4,
      );
      const working = readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8");
      expect(working).toMatch(/^NOTE gap .* cloud$/m);

      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      const texts = final.cues.map((cue) => cue.text);
      expect(texts.some((text) => FAKE_CLOUD_LINES.includes(text))).toBe(true);
      expect(texts.some((text) => FAKE_LINES.includes(text))).toBe(true);
    });

    test("a drop after a late first partial replays every unfinished second", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: {
          cloud: {
            latePartial: { atMs: SECOND, beginMs: SECOND, text: "Unfinished cloud words" },
            dropAfterMs: 10 * SECOND,
          },
        },
      });
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(11 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      expect(Math.min(...final.cues.map((cue) => cue.startMs))).toBeLessThanOrEqual(SECOND);
      expect(final.cues.some((cue) => FAKE_LINES.includes(cue.text))).toBe(true);
      expect(final.cues.some((cue) => cue.text === "Unfinished cloud words")).toBe(false);
    });

    test("a socket drop while finishing replays the unfinished sentence", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: {
          cloud: {
            latePartial: {
              atMs: SECOND,
              beginMs: SECOND,
              text: "Unfinished cloud words",
              dropOnFinish: true,
            },
          },
        },
      });
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      record(4 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.partials.length > 0);

      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      expect(Math.min(...final.cues.map((cue) => cue.startMs))).toBeLessThanOrEqual(SECOND);
      expect(final.cues.some((cue) => FAKE_LINES.includes(cue.text))).toBe(true);
    });

    // protects=a healthy Qwen connection, whose heartbeats show it keeps up, stays live through a silence longer than the lag allows, and speech after it is in the saved Transcript when the connection then drops; fails_when=the silence reads as falling behind and closes the socket, or the drop leaves the speech out; no_claim=how often the real service sends heartbeats, which needs a real key.
    test("a silence longer than the lag allows stays live on Qwen, and speech after it survives a dropped connection", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        capture: { system: "silent" },
        engine: { cloud: { dropAfterMs: 40 * SECOND } },
      });
      // The time between chunks, in which the service and the transcription process answer.
      const answered = async () => {
        for (let turn = 0; turn < 10; turn++) await new Promise((done) => setTimeout(done, 0));
      };
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      for (let second = 0; second < 36; second++) {
        record(SECOND, ["system"]);
        await answered();
      }
      expect(await transcriptOf(core, meeting.id)).toMatchObject({
        state: "live",
        cloud: "qwen",
        fellBack: null,
      });

      for (let second = 0; second < 6; second++) {
        record(SECOND);
        await answered();
      }
      await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      record(4 * SECOND);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      expect(
        final.cues.some((cue) => cue.startMs >= 36 * SECOND && FAKE_LINES.includes(cue.text)),
      ).toBe(true);
    });

    test("the monthly cap counts Qwen's price from the catalog and hands the live audio to this computer; recording never stops", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir);
      await chooseQwen(core);
      // ¥1.188 an hour: about 20 seconds of the two streams' audio fit.
      await core.updateSettings({ user: { monthlyCap: { currency: "USD", amount: 0.001 } } });
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(20 * SECOND);
      const capped = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      expect(capped).toMatchObject({ cloud: null, fellBack: { route: "qwen", reason: "cap" } });
      record(4 * SECOND);
      await until(
        core,
        meeting.id,
        (transcript, each) => each.status === "recording" && transcript.state === "live",
      );
      const summary = await core.getCostSummary();
      expect(summary.spentTowardCap?.amount ?? 0).toBeLessThanOrEqual(0.001);
      expect(summary.spent.some((each) => each.currency === "CNY" && each.amount > 0)).toBe(true);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      expect(readVtt(readFileSync(saved.savedPath as string, "utf8")).gaps).toEqual([]);
    });

    test("a key made in the other region is turned away: one problem in the bar, this computer takes over, and recording goes on", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: { cloud: { refuse: true } },
      });
      await chooseQwen(core, "intl");
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(3 * SECOND);
      const refused = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      expect(refused).toMatchObject({
        cloud: null,
        fellBack: { route: "qwen", reason: "refused" },
      });
      // Settings › AI's row for the key says so, until the key changes.
      const services = (await core.listTranscriptionServices()).services;
      expect(services.find((each) => each.route === "qwen")?.refused).toBe(true);
      expect(services.find((each) => each.route === "soniox")?.refused).toBe(false);
      record(6 * SECOND);
      await until(
        core,
        meeting.id,
        (transcript, each) =>
          each.status === "recording" && transcript.state === "live" && transcript.lines >= 2,
      );
      const health = (await core.listMeetings())[0]?.health.events;
      expect(health).toContainEqual(
        expect.objectContaining({ kind: "switched", from: "cloud", to: "local", reason: "failed" }),
      );
    });

    test("Local mode keeps the route off: it can't be chosen, and a Meeting goes to this computer, none of its audio sent", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir);
      await chooseQwen(core);
      await core.setLocalOnly(true);
      await core.updateSettings({ device: { transcriptionRoute: "local" } });
      await expect(core.updateSettings({ device: { transcriptionRoute: "qwen" } })).rejects.toThrow(
        InvalidInputError,
      );
      expect((await core.getSettings()).device.transcriptionRoute).toBe("local");

      // Chosen before Local mode was turned on, it still sends nothing.
      await core.setLocalOnly(false);
      await core.updateSettings({ device: { transcriptionRoute: "qwen" } });
      await core.setLocalOnly(true);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      record(5 * SECOND);
      const live = await until(core, meeting.id, (transcript) => transcript.lines >= 2);
      expect(live).toMatchObject({
        cloud: null,
        fellBack: { route: "qwen", reason: "local-mode", atMs: 0 },
      });
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(cues.some((cue) => FAKE_CLOUD_LINES.includes(cue.text))).toBe(false);
      expect(
        cues.every((cue) => FAKE_LINES.includes(cue.text) || FAKE_THEIR_LINES.includes(cue.text)),
      ).toBe(true);
    });
  });
});
