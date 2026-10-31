/**
 * sherpa-onnx-node ships no types: the part of its API the transcription
 * engine (./sherpa) and the speaker pass (./diarization) use, as its JSDoc in types.js describes it.
 */
declare module "sherpa-onnx-node" {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      qwen3Asr?: {
        convFrontend: string;
        encoder: string;
        decoder: string;
        tokenizer: string;
        hotwords?: string;
        maxNewTokens?: number;
      };
      tokens: string;
      numThreads: number;
      provider: "cpu";
      debug: number;
    };
  }

  export interface OfflineStream {
    acceptWaveform(waveform: Waveform): void;
    /** A decoding option for this stream alone: Qwen3-ASR reads "hotwords", comma-separated. */
    setOption(key: string, value: string): void;
    /** The native stream, which keeps its result once decoded. */
    handle: unknown;
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
  }

  export interface VadConfig {
    sileroVad: {
      model: string;
      threshold: number;
      minSpeechDuration: number;
      minSilenceDuration: number;
      maxSpeechDuration: number;
      windowSize: number;
    };
    sampleRate: number;
    numThreads: number;
    debug: number;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
    pop(): void;
    flush(): void;
  }

  export interface OfflineSpeakerDiarizationConfig {
    segmentation: {
      pyannote: { model: string; windowShiftRatio?: number };
      numThreads: number;
      debug: number;
    };
    embedding: { model: string; numThreads: number; debug: number };
    /** `numClusters` -1: as many as the threshold gives. */
    clustering: { numClusters: number; threshold: number };
    minDurationOn: number;
    minDurationOff: number;
  }

  /** `start` and `end` in seconds of the samples given; `speaker` from 0. */
  export interface SpeakerDiarizationSegment {
    start: number;
    end: number;
    speaker: number;
  }

  export interface OnlineStream {
    acceptWaveform(waveform: Waveform): void;
    inputFinished(): void;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads: number; debug: number });
    createStream(): OnlineStream;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }

  export class OfflineSpeakerDiarization {
    constructor(config: OfflineSpeakerDiarizationConfig);
    readonly sampleRate: number;
    /** Holds the thread until it is done. */
    process(samples: Float32Array): SpeakerDiarizationSegment[];
  }
}

/** The package's native addon, for what its JavaScript doesn't give: a result as the JSON the engine wrote. */
declare module "sherpa-onnx-node/addon.js" {
  const addon: { getOfflineStreamResultAsJson(handle: unknown): string };
  export default addon;
}
