import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type {
  ChatModelFactory,
  Core,
  CoreAdapters,
  Logger,
  Meeting,
  MeetingTranscript,
  SpeakerSeparator,
  Transcriber,
  TranscriptionModelFiles,
  VoiceTurn,
} from "../../src/core";
import { hashBytes } from "../../src/core/documents/files";
import { readVtt } from "../../src/core/documents/formats/vtt";
import type { Language } from "../../src/core/language";
import { createFakeCapture, type FakeCaptureOptions } from "../../src/core/meetings/fakeCapture";
import {
  type CloudServing,
  createChannelTranscriber,
  type ServingOptions,
  serveTranscriber,
  type TranscriberPort,
  type TranscriberRequest,
  type TranscriberResponse,
} from "../../src/core/transcription/channel";
import type { CloudConnect } from "../../src/core/transcription/cloud/socket";
import {
  createFakeSpeechEngine,
  type FakeTranscriberOptions,
  failingOver,
} from "../../src/core/transcription/fake";
import { createFakeCloud, createFakeCloudFetch } from "../../src/core/transcription/fakeCloud";
import type { SpeechEngine } from "../../src/core/transcription/speech";
import { speakerOf } from "../../src/shared/speakers";
import { createTempDataFolder, manualClock, startCore } from "./core";
import { scriptedModels } from "./models";

/** No files to download: the fake engine needs none. */
export const NO_TRANSCRIPTION_FILES = {
  model: { baseUrl: "http://127.0.0.1/", files: [] },
  vad: { baseUrl: "http://127.0.0.1/", files: [] },
} as const;

/** No files to download for the speaker models: the fake separator needs none. */
export const NO_SPEAKER_FILES = {
  segmentation: { baseUrl: "http://127.0.0.1/", files: [] },
  embedding: { baseUrl: "http://127.0.0.1/", files: [] },
} as const;

/**
 * A `SpeakerSeparator` that hears one voice per 10-second part of audio, by `voiceOf(the part's
 * place)`, answering once `holds` (if given) resolves; `fails` rejects as a failed pass does.
 */
export function fakeSeparator({
  voiceOf = (index: number) => index % 2,
  holds,
  fails,
}: {
  voiceOf?: (index: number) => number;
  holds?: Promise<void>;
  fails?: string;
} = {}) {
  const requests: Parameters<SpeakerSeparator["separate"]>[0][] = [];
  const separator: SpeakerSeparator = {
    async separate(request) {
      requests.push(request);
      await holds;
      if (fails) throw new Error(fails);
      return request.parts.map(
        (part, index): VoiceTurn => ({
          startMs: part.offsetMs,
          endMs: part.offsetMs + 10_000,
          voice: voiceOf(index),
        }),
      );
    },
  };
  return { separator, requests };
}

/**
 * A `Transcriber` whose engine (the fake one) runs in this process behind
 * the same channel as the desktop app's utility process, messages crossing a
 * turn of the event loop as they would between processes. `crash` kills the
 * running one, as an out-of-memory would. `engine` runs another engine, the
 * real one in the live tests. `options.failover` has it say it moved its
 * streams to the cloud and back. Streams opened with a cloud service go to the
 * pretend one, as `options.cloud` says.
 */
export function inProcessTranscriber(
  options: FakeTranscriberOptions = {},
  engine: (model: TranscriptionModelFiles) => Promise<SpeechEngine> = async () =>
    createFakeSpeechEngine(options),
  /** The cloud's connections, to watch them: the pretend service as `options.cloud` says by default. */
  connect: CloudConnect = createFakeCloud(options.cloud),
  /** The idle unload (#2673): an engine that went idle ends this process, as the app's does. */
  serving: ServingOptions = {},
  /** The requests a service needs before its socket (Gladia's session), to watch them. */
  cloudFetch: CloudServing["fetch"] = createFakeCloudFetch(options.cloud),
) {
  let kill: (() => void) | null = null;
  let endIdle: (() => void) | null = null;
  let started = 0;
  const transcriber: Transcriber = createChannelTranscriber(() => {
    started++;
    let open = true;
    let deliver: (request: TranscriberRequest) => void = () => {};
    const responses: ((response: TranscriberResponse) => void)[] = [];
    const exits: ((code: number | null) => void)[] = [];
    const port: TranscriberPort = {
      onRequest: (listener) => {
        deliver = listener;
      },
      respond: (response) =>
        setImmediate(() => {
          if (open) for (const listener of responses) listener(response);
        }),
    };
    const idleExit = () => {
      open = false;
      for (const listener of exits) listener(0);
    };
    serveTranscriber(
      engine,
      options.failover ? failingOver(port, options.failover) : port,
      {
        connect,
        fetch: cloudFetch,
        detectors: async () => createFakeSpeechEngine(options).detector,
      },
      {
        idleMs: serving.idleMs,
        unloaded: () => {
          serving.unloaded?.();
          idleExit();
        },
      },
    );
    endIdle = idleExit;
    kill = () => {
      open = false;
      for (const listener of exits) listener(null);
    };
    return {
      send: (request) =>
        setImmediate(() => {
          if (open) deliver(request);
        }),
      onResponse: (listener) => responses.push(listener),
      onExit: (listener) => exits.push(listener),
      stop: () => {
        open = false;
      },
    };
  });
  return {
    transcriber,
    crash: () => kill?.(),
    /** Ends the running process idle, as its own five quiet minutes do, with the requests still in flight dropped (#2673). */
    unload: () => endIdle?.(),
    get started() {
      return started;
    },
  };
}

/**
 * A core that records Meetings with the fake capture (a tone from each
 * source) and transcribes them with the fake engine behind the channel the
 * desktop app uses: every two seconds of sound is a line, the microphone's
 * saying the next of `FAKE_LINES` and the computer sound's the next of
 * `FAKE_THEIR_LINES`. The clock moves with the audio the test records.
 */
export async function transcribingCore(
  dataDir: string,
  {
    engine = {},
    model,
    createChatModel,
    ollamaModels,
    loads,
    log,
    capture: captureOptions,
    audioCapture,
    keychain,
    speakerSeparator,
    speakerModelSource = NO_SPEAKER_FILES,
    transcriptionModelSource = NO_TRANSCRIPTION_FILES,
    cloud,
    cloudFetch,
    systemLanguages,
    answerPaths,
    notesBeforeSpeakers,
    helpFormJudged,
    helpMarksQuoteOnly,
    callHelpForm,
    callsUnmarked,
    examples,
    serving,
    engineFactory,
    systemCalendar,
    linkedFolders,
    paceTimers,
  }: {
    engine?: FakeTranscriberOptions;
    /** The cloud's connections, to watch them; the pretend service as `engine.cloud` says by default. */
    cloud?: CloudConnect;
    /** Gladia's session requests, to watch them; the pretend service's by default. */
    cloudFetch?: CloudServing["fetch"];
    /** The idle unload (#2673): a short wait, and what an idle engine's process ending looks like. */
    serving?: ServingOptions;
    /** Another engine than the fake one, e.g. one whose loading the test holds. */
    engineFactory?: (model: TranscriptionModelFiles) => Promise<SpeechEngine>;
    /** The computer's languages, "en-US" by default. */
    systemLanguages?: readonly string[];
    /** What the fake capture does, e.g. the computer's sound denied. */
    capture?: FakeCaptureOptions;
    /** A capture instead of the fake one, for a start that fails after it heard audio. */
    audioCapture?: CoreAdapters["audioCapture"];
    model?: Parameters<typeof scriptedModels>[0];
    /** Real chat models instead of a scripted one, for a live test. */
    createChatModel?: ChatModelFactory;
    ollamaModels?: CoreAdapters["ollamaModels"];
    /** The engine starts once this resolves, as a model loading slowly does. */
    loads?: Promise<void>;
    log?: Logger;
    keychain?: CoreAdapters["keychain"];
    /** Tells speakers apart after the call (#138); absent, the labels stay where lines came from. */
    speakerSeparator?: SpeakerSeparator;
    /** Where the speaker models come from: none to download by default. */
    speakerModelSource?: CoreAdapters["speakerModelSource"];
    /** Where the speech models come from: none to download by default, and no streaming model. */
    transcriptionModelSource?: CoreAdapters["transcriptionModelSource"];
    /** Which models take the faster Answer paths, instead of the lists beside the catalog. */
    answerPaths?: CoreAdapters["answerPaths"];
    /** Whether a call's notes start before its speakers are told apart, instead of the default. */
    notesBeforeSpeakers?: CoreAdapters["notesBeforeSpeakers"];
    helpFormJudged?: CoreAdapters["helpFormJudged"];
    helpMarksQuoteOnly?: CoreAdapters["helpMarksQuoteOnly"];
    callHelpForm?: CoreAdapters["callHelpForm"];
    callsUnmarked?: CoreAdapters["callsUnmarked"];
    /** The shipped examples' folder, for a core that makes them. */
    examples?: string;
    /** The Mac's calendars, for a Meeting started from a calendar event (#190). */
    systemCalendar?: CoreAdapters["systemCalendar"];
    /** A watcher the test reports changes through, instead of the file system's. */
    linkedFolders?: CoreAdapters["linkedFolders"];
    /** The core's waits on a clock the test moves, e.g. between a Transcript's reads. */
    paceTimers?: CoreAdapters["paceTimers"];
  } = {},
) {
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime(), ...captureOptions });
  const engineHost = inProcessTranscriber(
    engine,
    engineFactory ??
      (async () => {
        await loads;
        return createFakeSpeechEngine(engine);
      }),
    cloud ?? createFakeCloud(engine.cloud),
    serving,
    cloudFetch,
  );
  const models = model ? scriptedModels(model) : undefined;
  const core = startCore(dataDir, {
    audioCapture: audioCapture ?? capture,
    transcriber: engineHost.transcriber,
    transcriptionModelSource,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    now: clock.now,
    ...(models && { createChatModel: models.createChatModel }),
    ...(createChatModel && { createChatModel }),
    ...(ollamaModels && { ollamaModels }),
    ...(log && { log }),
    ...(keychain && { keychain }),
    ...(speakerSeparator && { speakerSeparator, speakerModelSource }),
    ...(systemLanguages && { systemLanguages: () => systemLanguages }),
    ...(answerPaths && { answerPaths }),
    ...(notesBeforeSpeakers && { notesBeforeSpeakers }),
    ...(helpFormJudged && { helpFormJudged }),
    ...(helpMarksQuoteOnly && { helpMarksQuoteOnly }),
    ...(callHelpForm && { callHelpForm }),
    ...(callsUnmarked && { callsUnmarked }),
    ...(examples && { paths: { dataDir, examples } }),
    ...(systemCalendar && { systemCalendar }),
    ...(linkedFolders && { linkedFolders }),
    ...(paceTimers && { paceTimers }),
  });
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  const record = (ms: number, sources: ("microphone" | "system")[] = ["microphone", "system"]) => {
    for (let at = 0; at < ms; at += 500) {
      const step = Math.min(500, ms - at);
      clock.advance(step);
      for (const source of sources) capture.push(source, step);
    }
  };
  return { core, capture, clock, record, engineHost };
}

export async function transcriptOf(core: Core, meetingId: string): Promise<MeetingTranscript> {
  const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
  if (!meeting?.transcript) throw new Error(`Meeting ${meetingId} has no transcript.`);
  return meeting.transcript;
}

/** Waits, with real time, until the Meeting's Transcript is as `ready` wants it. */
export async function until(
  core: Core,
  meetingId: string,
  ready: (transcript: MeetingTranscript, meeting: Meeting) => boolean,
): Promise<MeetingTranscript> {
  return vi.waitFor(
    async () => {
      const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
      if (!meeting?.transcript || !ready(meeting.transcript, meeting)) {
        throw new Error(`Not yet: ${JSON.stringify(meeting?.transcript)}`);
      }
      return meeting.transcript;
    },
    { timeout: 20_000, interval: 20 },
  );
}

/**
 * A Meeting recording for 9 seconds in a new Note, its first four lines transcribed. With
 * `createChatModel`, its models are there for a provider the test saves.
 */
export async function recordedMeeting(
  language: Language,
  engine: FakeTranscriberOptions = {},
  createChatModel?: ChatModelFactory,
) {
  const dataDir = await createTempDataFolder();
  const recording = await transcribingCore(dataDir, {
    engine,
    ...(createChatModel && { createChatModel }),
  });
  await recording.core.updateSettings({ user: { language } });
  const meeting = await recording.core.createMeeting();
  await recording.core.startMeeting({ meetingId: meeting.id });
  recording.record(9_000);
  await until(recording.core, meeting.id, (transcript) => transcript.lines >= 4);
  return { ...recording, dataDir, meeting };
}

/** Waits until the Transcript Document holds its file as it is now, read and ready. */
export async function transcriptRead(
  core: Core,
  dataDir: string,
  meetingId: string,
  documentId: string,
) {
  const file = join(dataDir, "Transcripts", `${meetingId}.vtt`);
  return vi.waitFor(
    async () => {
      const document = (await core.listDocuments()).find((each) => each.id === documentId);
      expect(document).toMatchObject({
        status: "ready",
        contentHash: hashBytes(readFileSync(file)),
      });
      return document as NonNullable<typeof document>;
    },
    { timeout: 20_000, interval: 20 },
  );
}

/** The longest a recording call's Transcript goes between reads (src/core/meetings/transcript.ts). */
const LONGEST_SPACING_MS = 120_000;

/**
 * Waits until a recording call's Transcript Document holds its file as it is now. Only the call
 * itself reads it then, at its own spacing (#3055): the core's held clock, `pace`, is moved on
 * until it has. Use it only while nothing else waits on that clock, such as a check's time limit.
 */
export async function liveTranscriptRead(
  core: Core,
  dataDir: string,
  meetingId: string,
  documentId: string,
  pace: { advance(ms: number): void },
) {
  const file = join(dataDir, "Transcripts", `${meetingId}.vtt`);
  return vi.waitFor(
    async () => {
      pace.advance(LONGEST_SPACING_MS);
      const document = (await core.listDocuments()).find((each) => each.id === documentId);
      expect(document).toMatchObject({
        status: "ready",
        contentHash: hashBytes(readFileSync(file)),
      });
      return document as NonNullable<typeof document>;
    },
    { timeout: 20_000, interval: 20 },
  );
}

/** Stops the Meeting and waits for all Stop does: the Transcript saved and read, the notes tried. */
export async function stoppedMeeting(core: Core, dataDir: string, meetingId: string) {
  const meetingOf = async () =>
    (await core.listMeetings()).find((each) => each.id === meetingId) as Meeting;
  await core.stopMeeting(meetingId);
  const { documentId } = await until(core, meetingId, (transcript) => transcript.state === "saved");
  const document = await transcriptRead(core, dataDir, meetingId, documentId as string);
  await vi.waitFor(async () => expect((await meetingOf()).fill?.state).toBe("off"));
  return { meeting: await meetingOf(), document };
}

/** The saved Transcript's lines, once the speaker pass (#138) has settled. */
export async function savedCues(core: Core, meetingId: string) {
  const saved = await until(
    core,
    meetingId,
    (transcript) => transcript.state === "saved" && !transcript.separating,
  );
  return readVtt(readFileSync(saved.savedPath as string, "utf8")).cues;
}

/**
 * The saved Transcript's lines once its speakers are told apart, each by who spoke it now: its
 * who's who over its file's own labels, as every Citation and view of it reads them (#2839).
 */
export async function toldCues(core: Core, meetingId: string) {
  const cues = await savedCues(core, meetingId);
  const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
  const speakers =
    (await core.listDocuments()).find((each) => each.id === meeting?.transcript?.documentId)
      ?.speakers ?? null;
  return cues.map((cue) =>
    cue.speaker ? { ...cue, speaker: speakerOf(speakers, cue.startMs, cue.speaker) } : cue,
  );
}

/** A call of 25 seconds from `sources`, recorded and stopped: a line every two seconds a source. */
export async function recordedCall(
  dataDir: string,
  options: Parameters<typeof transcribingCore>[1] = {},
  sources: ("microphone" | "system")[] = ["microphone", "system"],
) {
  const { core, record } = await transcribingCore(dataDir, options);
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: sources.includes("system") });
  record(25_000, sources);
  await until(core, meeting.id, (transcript) => transcript.lines >= 8);
  await core.stopMeeting(meeting.id);
  return { core, meeting };
}
