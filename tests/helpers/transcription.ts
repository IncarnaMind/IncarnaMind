import { join } from "node:path";
import { vi } from "vitest";
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
import { createFakeCapture, type FakeCaptureOptions } from "../../src/core/meetings/fakeCapture";
import {
  createChannelTranscriber,
  serveTranscriber,
  type TranscriberPort,
  type TranscriberRequest,
  type TranscriberResponse,
} from "../../src/core/transcription/channel";
import {
  createFakeSpeechEngine,
  type FakeTranscriberOptions,
  failingOver,
} from "../../src/core/transcription/fake";
import { createFakeCloud } from "../../src/core/transcription/fakeCloud";
import type { SpeechEngine } from "../../src/core/transcription/speech";
import { manualClock, startCore } from "./core";
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
) {
  let kill: (() => void) | null = null;
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
    serveTranscriber(engine, options.failover ? failingOver(port, options.failover) : port, {
      connect: createFakeCloud(options.cloud),
      detectors: async () => createFakeSpeechEngine(options).detector,
    });
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
    loads,
    log,
    capture: captureOptions,
    keychain,
    speakerSeparator,
    speakerModelSource = NO_SPEAKER_FILES,
  }: {
    engine?: FakeTranscriberOptions;
    /** What the fake capture does, e.g. the computer's sound denied. */
    capture?: FakeCaptureOptions;
    model?: Parameters<typeof scriptedModels>[0];
    /** Real chat models instead of a scripted one, for a live test. */
    createChatModel?: ChatModelFactory;
    /** The engine starts once this resolves, as a model loading slowly does. */
    loads?: Promise<void>;
    log?: Logger;
    keychain?: CoreAdapters["keychain"];
    /** Tells speakers apart after the call (#138); absent, the labels stay where lines came from. */
    speakerSeparator?: SpeakerSeparator;
    /** Where the speaker models come from: none to download by default. */
    speakerModelSource?: CoreAdapters["speakerModelSource"];
  } = {},
) {
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime(), ...captureOptions });
  const engineHost = inProcessTranscriber(engine, async () => {
    await loads;
    return createFakeSpeechEngine(engine);
  });
  const models = model ? scriptedModels(model) : undefined;
  const core = startCore(dataDir, {
    audioCapture: capture,
    transcriber: engineHost.transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    now: clock.now,
    ...(models && { createChatModel: models.createChatModel }),
    ...(createChatModel && { createChatModel }),
    ...(log && { log }),
    ...(keychain && { keychain }),
    ...(speakerSeparator && { speakerSeparator, speakerModelSource }),
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
