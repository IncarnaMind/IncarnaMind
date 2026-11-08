/**
 * Live text from VAD segments (#136): what runs beside the engine, in the
 * transcription process. Silero VAD finds where each stretch of speech starts
 * and ends; once the speaker pauses, the whole stretch is decoded, as its
 * final text. One decode runs at a time.
 *
 * While a stretch lasts, its words so far are partial text. An engine with a
 * streaming model reads them as they are said (#2662, ADR-0027): each stretch
 * not yet final keeps its live words until its final text replaces them.
 * Without one, or once it can't keep up, the speech so far is decoded again
 * every few seconds, final text first, and a partial waits only while
 * nothing else does.
 *
 * Engine-neutral: the detector and the recognizers are passed in, Qwen3-ASR,
 * the streaming model and Silero through sherpa-onnx today (./sherpa).
 */
import { gap } from "../../shared/i18n/join";
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../adapters";
import { cleanSpeech } from "./speechText";

/** Finds speech in one stream. Samples are in [-1, 1], at `MEETING_SAMPLE_RATE`. */
export interface VoiceDetector {
  accept(samples: Float32Array): void;
  /** Speech has started and hasn't ended yet. */
  speaking(): boolean;
  /** The next stretch of speech that has ended: where it starts in the stream, in samples, and its samples. */
  next(): { start: number; samples: Float32Array } | null;
  /** Ends the speech in progress, so `next` returns it. */
  flush(): void;
}

export interface Recognizer {
  /**
   * The words in one stretch of speech, said on the stream named. `words` are those the speech may
   * hold (the names in the call, #1031), for an engine that can be told them: a final reading is
   * told them, a partial one, soon replaced, is not.
   */
  decode(samples: Float32Array, stream: string, words: readonly string[]): Promise<string>;
}

/** A streaming model's reading of one stretch of speech, fed its audio as it comes. */
export interface LiveReading {
  /** Takes the next audio and gives the words heard so far. */
  hear(samples: Float32Array): string;
  /** No more audio comes: the words of the whole stretch. */
  end(): string;
}

/**
 * An engine, loaded: a detector for each stream, and one recognizer they share. `live`, when the
 * engine has a streaming model, starts a reading of a stretch, whose words are the stretch's
 * partial text until the recognizer gives its final text.
 */
export interface SpeechEngine {
  detector(): VoiceDetector;
  recognizer: Recognizer;
  live?(stream: string): LiveReading;
  close(): void;
}

export interface SpeechReport {
  segment(segment: SpeechSegment): void;
  progress(stream: string, doneMs: number): void;
  /** A stretch couldn't be decoded: it has no text, and the stream goes on. */
  failed(stream: string, message: string): void;
}

export interface SpeechHostOptions {
  /** Called when the host has nothing left to do: no stream open and nothing being decoded. */
  onIdle?(): void;
}

/** How often speech in progress is decoded again. */
export const PARTIAL_EVERY_MS = 2500;
/** Speech shorter than this has no partial text: its final text comes soon. */
const MIN_PARTIAL_MS = 1500;
/** What is kept before the moment speech is detected, for partials: the detector notices it a little late. */
const LEAD_IN_MS = 400;
/** The most audio kept for partials: the detector ends a stretch at 20 seconds. */
const KEPT_MS = 30_000;
/** What is decoded before where the detector says speech starts: it cuts a word's first sound otherwise. */
const PAD_MS = 250;
/**
 * Quiet audio is raised before speech is looked for, towards this peak, by
 * at most `MAX_GAIN` (30 dB): the detector misses a quiet voice, such as a
 * meeting app turned down. The level is the recent peak, halving each
 * `LEVEL_HALF_LIFE_MS`.
 */
const TARGET_PEAK = 0.5;
const MAX_GAIN = 30;
const LEVEL_HALF_LIFE_MS = 1500;

/**
 * A final reading is told its stream's words (#1031) only while decoding takes at most this share
 * of the audio's time, every stream's readings counted over the last minute of each: a told
 * reading is a second reading of the stretch, and with the microphone and the call's sound both
 * busy it would otherwise outrun real time on a slower computer.
 */
const TOLD_LOAD = 0.5;
const LOAD_WINDOW_MS = 60_000;
/** A stream counts towards the load once it has this much audio. */
const LOAD_FROM_MS = 10_000;
/**
 * The streaming model reads at most this share of the audio's time, every stream's reading
 * counted, or live words go back to decoding the speech again: it reads each chunk as it comes,
 * before the next, so a slower one would hold up the final text of every stream.
 */
const LIVE_LOAD = 0.5;

const msOf = (samples: number) => (samples * 1000) / MEETING_SAMPLE_RATE;
const samplesOf = (ms: number) => Math.round((ms * MEETING_SAMPLE_RATE) / 1000);

/** 16-bit PCM as the engines read it. */
export function toFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] as number) / 32768;
  return out;
}

/** One stream's audio raised towards `TARGET_PEAK` by its recent level (see `MAX_GAIN`), chunk by chunk. */
export function createLeveler(): (samples: Float32Array) => Float32Array {
  let recent = 0;
  return (samples) => {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const decay = 0.5 ** (samples.length / samplesOf(LEVEL_HALF_LIFE_MS));
    recent = Math.max(peak, recent * decay);
    if (recent === 0) return samples;
    const gain = Math.min(MAX_GAIN, Math.max(1, TARGET_PEAK / recent));
    if (gain === 1) return samples;
    return samples.map((sample) => Math.max(-1, Math.min(1, sample * gain)));
  };
}

interface Job {
  stream: string;
  id: number;
  start: number;
  samples: Float32Array;
  final: boolean;
  words: readonly string[];
}

interface Stream {
  name: string;
  detector: VoiceDetector;
  /** Samples accepted so far. */
  received: number;
  /** The latest samples, for partials: `kept` starts at sample `keptFrom`. */
  kept: Float32Array[];
  keptFrom: number;
  keptLength: number;
  /** The speech in progress: its id, and where it was first heard. */
  speech: { id: number; start: number; lastPartial: number } | null;
  /** The streaming model's reading of the speech in progress, and its words so far. */
  reading: { live: LiveReading; text: string } | null;
  /** The live words of each stretch whose final text hasn't come, by id. */
  drafts: Map<number, { start: number; text: string }>;
  shown: string;
  level: (samples: Float32Array) => Float32Array;
  nextId: number;
  words: readonly string[];
  /**
   * Its readings' decoding time, each placed at the end of the audio it read, in ms: audio fed
   * faster than it is spoken, as from a file, counts at the time it covers.
   */
  work: { atMs: number; ms: number }[];
  liveWork: { atMs: number; ms: number }[];
  /** Final decodes queued or running, by where they start. */
  unfinished: Set<number>;
  finishing: { resolve(): void } | null;
  dropped: boolean;
}

export function createSpeechHost(
  engine: SpeechEngine,
  report: SpeechReport,
  options: SpeechHostOptions = {},
) {
  const streams = new Map<string, Stream>();
  const finals: Job[] = [];
  /** The latest partial asked for, by stream: an older one is no use. */
  const partials = new Map<string, Job>();
  let decoding = false;
  let closed = false;
  /**
   * Live words come from the streaming model, until it fails or can't keep up; tried again once
   * no stream is open, so each Meeting starts with them.
   */
  let reads = engine.live !== undefined;

  /** Nothing is open and nothing is decoded: the engine has no work until a stream comes again. */
  function idle(): boolean {
    return streams.size === 0 && !decoding && finals.length === 0 && partials.size === 0;
  }

  function becameIdle(): void {
    if (idle()) options.onIdle?.();
  }

  /** The kept samples from `from` to `to` (exclusive), in the stream's samples. */
  function slice(stream: Stream, from: number, to = stream.received): Float32Array {
    const start = Math.max(from, stream.keptFrom);
    const out = new Float32Array(Math.max(0, to - start));
    let at = stream.keptFrom;
    let filled = 0;
    for (const chunk of stream.kept) {
      const end = at + chunk.length;
      if (end > start && at < to) {
        const part = chunk.subarray(Math.max(0, start - at), Math.min(chunk.length, to - at));
        out.set(part, filled);
        filled += part.length;
      }
      at = end;
    }
    return out;
  }

  function keep(stream: Stream, samples: Float32Array): void {
    stream.kept.push(samples);
    stream.keptLength += samples.length;
    const most = samplesOf(KEPT_MS);
    while (stream.keptLength - (stream.kept[0]?.length ?? 0) > most) {
      const first = stream.kept.shift() as Float32Array;
      stream.keptLength -= first.length;
      stream.keptFrom += first.length;
    }
  }

  /** Everything before this has its final text: the start of the oldest speech not yet decoded. */
  function doneOf(stream: Stream): number {
    let done = stream.received;
    for (const start of stream.unfinished) done = Math.min(done, start);
    if (stream.speech) done = Math.min(done, stream.speech.start);
    return msOf(done);
  }

  function settle(stream: Stream): void {
    if (stream.dropped) return;
    report.progress(stream.name, doneOf(stream));
    if (stream.finishing && stream.unfinished.size === 0 && !stream.speech) {
      const { resolve } = stream.finishing;
      stream.finishing = null;
      streams.delete(stream.name);
      resolve();
    }
    becameIdle();
  }

  /** Decoding time over audio time, every stream's over the last minute of its audio: `liveWork`, the streaming model's. */
  function load(of: "work" | "liveWork" = "work"): number {
    let sum = 0;
    for (const stream of streams.values()) {
      const heardMs = msOf(stream.received);
      stream[of] = stream[of].filter((each) => each.atMs > heardMs - LOAD_WINDOW_MS);
      if (heardMs < LOAD_FROM_MS) continue;
      const busy = stream[of].reduce((total, each) => total + each.ms, 0);
      sum += busy / Math.min(heardMs, LOAD_WINDOW_MS);
    }
    return sum;
  }

  /** Live words go back to decoding the speech again, for every stream: those already heard stay until their final text. */
  function stopReading(why: string): void {
    reads = false;
    // The process has no logger of its own: its output goes to the app's log.
    console.warn(`Live words go back to reading the speech again: ${why}`);
    for (const stream of streams.values()) stream.reading = null;
  }

  /** The words of the stream's speech that have no final text yet, as one partial, when they changed. */
  function showLive(stream: Stream, decodeMs: number): void {
    const said = [...stream.drafts];
    if (stream.speech && stream.reading) {
      said.push([stream.speech.id, { start: stream.speech.start, text: stream.reading.text }]);
    }
    const heard = said.filter(([, each]) => each.text);
    const text = heard.reduce(
      (all, [, each]) => all + gap("zh-CN", all, each.text) + each.text,
      "",
    );
    if (text === stream.shown) return;
    stream.shown = text;
    const [first] = heard;
    if (!first) return;
    const [id, { start }] = first;
    report.segment({
      stream: stream.name,
      id,
      startMs: msOf(start),
      endMs: msOf(stream.received),
      text,
      final: false,
      decodeMs,
    });
  }

  /** Feeds the streaming model the speech's next audio: how long it took, in ms. */
  function hear(stream: Stream, samples: Float32Array): number {
    const { reading } = stream;
    if (!reading || samples.length === 0) return 0;
    const started = Date.now();
    try {
      reading.text = cleanSpeech(reading.live.hear(samples));
    } catch (error) {
      stopReading(
        `the streaming model failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
    const ms = Date.now() - started;
    stream.liveWork.push({ atMs: msOf(stream.received), ms });
    if (load("liveWork") > LIVE_LOAD) stopReading("the streaming model can't keep up");
    return ms;
  }

  /** The streaming model's reading of the speech that ended: its words stay until the stretch's final text. */
  function endReading(stream: Stream, id: number, start: number): void {
    const { reading } = stream;
    stream.reading = null;
    if (!reading) return;
    let text = reading.text;
    try {
      text = cleanSpeech(reading.live.end());
    } catch (error) {
      stopReading(
        `the streaming model failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (text) stream.drafts.set(id, { start, text });
  }

  async function pump(): Promise<void> {
    if (decoding || closed) return;
    const job = finals.shift() ?? partials.values().next().value;
    if (!job) return;
    if (!job.final) partials.delete(job.stream);
    decoding = true;
    const started = Date.now();
    const words = job.final && load() <= TOLD_LOAD ? job.words : [];
    let text = "";
    let failed = false;
    try {
      text = cleanSpeech(await engine.recognizer.decode(job.samples, job.stream, words));
    } catch (error) {
      // A stretch the engine can't read loses its text, not the rest of the stream.
      failed = true;
      report.failed(job.stream, error instanceof Error ? error.message : String(error));
    }
    decoding = false;
    const stream = streams.get(job.stream);
    stream?.work.push({ atMs: msOf(job.start + job.samples.length), ms: Date.now() - started });
    if (stream && !stream.dropped && !closed) {
      const current = job.final || stream.speech?.id === job.id;
      if (current && (text || job.final)) {
        report.segment({
          stream: job.stream,
          id: job.id,
          startMs: msOf(job.start),
          endMs: msOf(job.start + job.samples.length),
          text,
          final: job.final,
          decodeMs: Date.now() - started,
          ...(failed && { failed: true }),
        });
      }
      if (job.final) {
        stream.unfinished.delete(job.start);
        // The final text drops the partial that has its id, words of later speech included:
        // those still unfinished are reported again.
        stream.drafts.delete(job.id);
        stream.shown = "";
        showLive(stream, 0);
        settle(stream);
      }
    }
    void pump();
    becameIdle();
  }

  /**
   * Queues the stretches of speech that have ended, and reads the one going on: `heard`, the
   * audio just taken, goes to the streaming model, or a partial is queued.
   */
  function look(stream: Stream, heard?: Float32Array): void {
    let readMs = 0;
    for (let found = stream.detector.next(); found; found = stream.detector.next()) {
      const id = stream.speech?.id ?? stream.nextId++;
      const start = Math.max(stream.keptFrom, found.start - samplesOf(PAD_MS));
      endReading(stream, id, start);
      stream.speech = null;
      const before = slice(stream, start, found.start);
      const samples = new Float32Array(before.length + found.samples.length);
      samples.set(before);
      samples.set(found.samples, before.length);
      stream.unfinished.add(start);
      finals.push({ stream: stream.name, id, start, samples, final: true, words: stream.words });
    }
    if (stream.detector.speaking()) {
      if (!stream.speech) {
        stream.speech = {
          id: stream.nextId++,
          start: Math.max(0, stream.received - samplesOf(LEAD_IN_MS)),
          lastPartial: stream.received,
        };
        if (reads && engine.live) {
          stream.reading = { live: engine.live(stream.name), text: "" };
          readMs = hear(stream, slice(stream, stream.speech.start));
        }
      } else if (heard) {
        readMs = hear(stream, heard);
      }
      const { speech } = stream;
      if (
        !stream.reading &&
        msOf(stream.received - speech.lastPartial) >= PARTIAL_EVERY_MS &&
        msOf(stream.received - speech.start) >= MIN_PARTIAL_MS
      ) {
        speech.lastPartial = stream.received;
        partials.set(stream.name, {
          stream: stream.name,
          id: speech.id,
          start: speech.start,
          samples: slice(stream, speech.start),
          final: false,
          words: [],
        });
      }
    } else {
      stream.speech = null;
      stream.reading = null;
    }
    showLive(stream, readMs);
    void pump();
  }

  function streamOf(name: string): Stream {
    let stream = streams.get(name);
    if (!stream) {
      if (streams.size === 0) reads = engine.live !== undefined;
      stream = {
        name,
        detector: engine.detector(),
        received: 0,
        kept: [],
        keptFrom: 0,
        keptLength: 0,
        speech: null,
        reading: null,
        drafts: new Map(),
        shown: "",
        level: createLeveler(),
        nextId: 1,
        words: [],
        work: [],
        liveWork: [],
        unfinished: new Set(),
        finishing: null,
        dropped: false,
      };
      streams.set(name, stream);
    }
    return stream;
  }

  return {
    /** The words the stream's speech may hold, from its next stretch on (see `Recognizer.decode`). */
    words(name: string, words: readonly string[]): void {
      if (closed) return;
      streamOf(name).words = words;
    },

    idle,

    push(name: string, samples: Float32Array): void {
      if (closed || samples.length === 0) return;
      const stream = streamOf(name);
      if (stream.finishing) return;
      const leveled = stream.level(samples);
      stream.detector.accept(leveled);
      keep(stream, leveled);
      stream.received += leveled.length;
      look(stream, leveled);
      settle(stream);
    },

    finish(name: string): Promise<void> {
      const stream = streamOf(name);
      if (stream.finishing) return Promise.resolve();
      return new Promise<void>((resolve) => {
        stream.finishing = { resolve };
        stream.detector.flush();
        look(stream);
        stream.speech = null;
        stream.reading = null;
        partials.delete(name);
        settle(stream);
      });
    },

    drop(name: string): void {
      const stream = streams.get(name);
      if (!stream) return;
      stream.dropped = true;
      streams.delete(name);
      partials.delete(name);
      for (let i = finals.length - 1; i >= 0; i--) {
        if (finals[i]?.stream === name) finals.splice(i, 1);
      }
      stream.finishing?.resolve();
      becameIdle();
    },

    close(): void {
      closed = true;
      for (const stream of streams.values()) stream.finishing?.resolve();
      streams.clear();
      finals.length = 0;
      partials.clear();
      engine.close();
    },
  };
}

export type SpeechHost = ReturnType<typeof createSpeechHost>;
