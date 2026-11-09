import { describe, expect, test, vi } from "vitest";
import type { SpeechSegment } from "../../src/core";
import { createSpeechHost } from "../../src/core/transcription/speech";
import { joinsUnspaced, turnsOf } from "../../src/shared/transcriptTurns";

/*
 * A long stretch of speech with no pause in it, through the engine on this computer (#1031): a
 * stand-in for sherpa-onnx with Qwen3-ASR's limits as sherpa-onnx applies them, and a voice
 * detector that, like Silero, ends a stretch only at half a second of quiet.
 */
const RATE = 16_000;
const WORD_SAMPLES = (240 * RATE) / 1000;
const GAP_SAMPLES = (60 * RATE) / 1000;
/** Each word is a burst of sound at its own level, with a short quiet after it. */
const levelOf = (index: number) => 0.5 + index / 1000;

let vocabulary: readonly string[] = [];
let separator = " ";
/** The audio each reading was given, in seconds. */
const readings: number[] = [];

/** The words whole in `samples`: a burst cut in two is heard as "?". */
function heardIn(samples: Float32Array): string[] {
  const words: string[] = [];
  let from = -1;
  for (let at = 0; at <= samples.length; at++) {
    const loud = at < samples.length && Math.abs(samples[at] as number) > 0.1;
    if (loud && from < 0) from = at;
    if (!loud && from >= 0) {
      const burst = samples.subarray(from, at);
      const level = burst.reduce((sum, each) => sum + Math.abs(each), 0) / burst.length;
      words.push(
        burst.length === WORD_SAMPLES ? (vocabulary[Math.round((level - 0.5) * 1000)] ?? "?") : "?",
      );
      from = -1;
    }
  }
  return words;
}

/**
 * Qwen3-ASR as sherpa-onnx runs it: a 15-token prompt, 13 tokens a second of audio, only the audio
 * that fits `maxTotalLen`; then the header "language English<asr_text>" (3 tokens) and a token a
 * word, until it has written `maxNewTokens` or the whole holds `maxTotalLen`.
 */
async function createAsync(config: {
  modelConfig: { qwen3Asr: { maxNewTokens?: number; maxTotalLen?: number } };
}) {
  const { maxNewTokens = 128, maxTotalLen = 512 } = config.modelConfig.qwen3Asr;
  return {
    createStream: () => {
      let samples: Float32Array = new Float32Array(0);
      return {
        acceptWaveform: (wave: { samples: Float32Array }) => {
          samples = wave.samples;
        },
        setOption: () => {},
        get samples() {
          return samples;
        },
        handle: {},
      };
    },
    decodeAsync: async (stream: { samples: Float32Array }) => {
      const { samples } = stream;
      readings.push(samples.length / RATE);
      const prompt = 15;
      const audio = Math.min(Math.ceil((samples.length / RATE) * 13), maxTotalLen - prompt);
      const heard = heardIn(samples.subarray(0, Math.floor((audio / 13) * RATE)));
      const room = Math.min(maxNewTokens, maxTotalLen + 1 - prompt - audio);
      const tokens = heard.slice(0, Math.max(0, room - 3));
      return { text: tokens.join(separator), tokens };
    },
  };
}

/** Silero VAD as sherpa-onnx runs it, but no window is ever quiet enough to end a stretch early. */
class Vad {
  private readonly heard: number[] = [];
  private readonly ended: { start: number; samples: Float32Array }[] = [];
  private start = -1;
  private quiet = 0;
  private readonly window: number;
  private readonly minSpeech: number;
  private readonly minSilence: number;
  constructor(config: {
    sileroVad: { windowSize: number; minSpeechDuration: number; minSilenceDuration: number };
  }) {
    this.window = config.sileroVad.windowSize;
    this.minSpeech = config.sileroVad.minSpeechDuration * RATE;
    this.minSilence = config.sileroVad.minSilenceDuration * RATE;
  }
  acceptWaveform(samples: Float32Array) {
    this.heard.push(...samples);
    const loud = samples.some((sample) => Math.abs(sample) > 0.1);
    this.quiet = loud ? 0 : this.quiet + samples.length;
    const tail = this.heard.length;
    if (loud && this.start < 0) {
      this.start = Math.max(0, tail - 2 * this.window - this.minSpeech);
    } else if (this.start >= 0 && this.quiet >= this.minSilence) {
      this.end(tail - this.minSilence);
    }
  }
  private end(at: number) {
    this.ended.push({
      start: this.start,
      samples: Float32Array.from(this.heard.slice(this.start, at)),
    });
    this.start = -1;
  }
  isDetected = () => this.start >= 0;
  isEmpty = () => this.ended.length === 0;
  front = () => this.ended[0];
  pop = () => this.ended.shift();
  flush = () => {
    if (this.start >= 0) this.end(this.heard.length);
  };
}

vi.mock("sherpa-onnx-node", () => ({
  default: {
    OfflineRecognizer: { createAsync },
    OnlineRecognizer: class {},
    Vad,
    OfflineSpeakerDiarization: class {},
    SpeakerEmbeddingExtractor: class {},
  },
}));
vi.mock("sherpa-onnx-node/addon.js", () => ({
  default: {
    getOfflineStreamResultAsJson: () => "",
    getOnlineStreamResultAsJson: () => "",
    offlineStreamSetOption: () => {},
  },
}));

const { createSherpaEngine } = await import("../../src/core/transcription/sherpa");

const model = {
  engine: "qwen3-asr",
  files: { convFrontend: "a", encoder: "b", decoder: "c", tokenizer: "d" },
  vad: "v",
  threads: 1,
};

/** A second of quiet, then `words` said one after another with no pause, then a second and a half of quiet. */
function speech(words: number): Float32Array {
  const samples = new Float32Array(RATE + words * (WORD_SAMPLES + GAP_SAMPLES) + 1.5 * RATE);
  for (let index = 0; index < words; index++) {
    const from = RATE + index * (WORD_SAMPLES + GAP_SAMPLES);
    samples.fill(levelOf(index), from, from + WORD_SAMPLES);
  }
  return samples;
}

/** The final lines of `samples` said into a Meeting's microphone, `pushMs` of audio at a time. */
async function transcribe(samples: Float32Array, pushMs: number): Promise<SpeechSegment[]> {
  const lines: SpeechSegment[] = [];
  const failures: string[] = [];
  const host = createSpeechHost(await createSherpaEngine(model), {
    segment: (segment) => {
      if (segment.final && segment.text) lines.push(segment);
    },
    progress: () => {},
    failed: (_stream, message) => failures.push(message),
  });
  const push = (pushMs * RATE) / 1000;
  for (let at = 0; at < samples.length; at += push) {
    host.push("meeting-1:microphone", samples.subarray(at, at + push));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await host.finish("meeting-1:microphone");
  expect(failures).toEqual([]);
  return lines;
}

const LANGUAGES = {
  en: { words: Array.from({ length: 200 }, (_, at) => `word${at + 1}`), separator: " " },
  "zh-CN": {
    words: Array.from({ length: 200 }, (_, at) => String.fromCodePoint(0x4e00 + at * 37)),
    separator: "",
  },
};

for (const [language, said] of Object.entries(LANGUAGES)) {
  describe(`A long stretch of speech with no pause, ${language} (#1031)`, () => {
    // protects=a minute of speech with no pause is all in the Transcript: every word once and in order, read in parts none of which reaches Qwen3-ASR's 128 written or 512 total tokens, cut between words, the lines touching end to end, and shown as one turn of one paragraph that reads the whole speech; fails_when=the stretch is read whole and cut off at a limit (as before #1031), a cut lands inside a word, a word is read twice or lost at a cut, or a cut that isn't a sentence end breaks the turn or the paragraph; no_claim=the real model's accuracy at a cut, which eval/meetings measures.
    test.each([
      ["as it is said", 100],
      ["read back after Stop, 20 s at a time", 20_000],
    ])("every word comes back once, %s", async (_how, pushMs) => {
      vocabulary = said.words;
      separator = said.separator;
      readings.length = 0;
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

      const lines = await transcribe(speech(200), pushMs);

      const text = lines.map((line) => line.text).join(separator);
      expect(text).toBe(said.words.join(separator));
      expect(lines.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...readings)).toBeLessThanOrEqual(12);
      expect(warned).not.toHaveBeenCalled();
      for (const [at, line] of lines.entries()) {
        if (at > 0) expect(line.startMs).toBe(lines[at - 1]?.endMs);
      }
      expect(lines[0]?.startMs).toBeLessThan(1000);
      // The last word ends at 60.94 s.
      expect(lines.at(-1)?.endMs).toBeGreaterThanOrEqual(60_940);

      const turns = turnsOf(
        lines.map((line) => ({ ...line, speaker: "Speaker ?" as string | null })),
      );
      expect(turns).toHaveLength(1);
      expect(turns[0]?.paragraphs).toHaveLength(1);
      const shown = (turns[0]?.paragraphs[0] ?? []).reduce(
        (all, line, at, paragraph) =>
          at === 0
            ? line.text
            : `${all}${joinsUnspaced(paragraph[at - 1]?.text ?? "", line.text) ? "" : " "}${line.text}`,
        "",
      );
      expect(shown).toBe(said.words.join(separator));
      warned.mockRestore();
    });

    test("silence gives no line and no reading", async () => {
      readings.length = 0;
      expect(await transcribe(new Float32Array(30 * RATE), 100)).toEqual([]);
      expect(readings).toEqual([]);
    });
  });
}
