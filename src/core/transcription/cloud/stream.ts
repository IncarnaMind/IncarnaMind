/**
 * One stream's audio going to a cloud transcription service (#141), as the transcription
 * process serves it beside the engine on this computer (../channel): the services' adapters
 * (./openai, ./soniox) turn what each sends back into the same segments and progress.
 */
import { type CloudLoss, MEETING_SAMPLE_RATE, type SpeechSegment } from "../../adapters";
import type { CloudConnect } from "./socket";

export interface CloudStreamReport {
  segment(segment: SpeechSegment): void;
  /**
   * All the stream's audio before `doneMs` has its final text; the service has answered for the
   * audio sent before `heardMs` (`doneMs` when absent), so it keeps up while nothing is final yet.
   */
  progress(doneMs: number, heardMs?: number): void;
  /** It ended before it was finished; nothing more is reported. */
  lost(loss: CloudLoss): void;
  /** The core holds the audio until now, so a send gate that closes meanwhile sends nothing. */
  opened(): void;
}

export interface CloudStreamHandle {
  /** Audio, `MEETING_SAMPLE_RATE` mono, signed 16-bit, in order. */
  push(samples: Int16Array): void;
  /** No more audio comes: resolves once its last text has been reported, or it is lost. */
  finish(): Promise<void>;
  drop(): void;
}

export interface CloudStreamOptions {
  stream: string;
  model: string;
  apiKey: string;
  connect: CloudConnect;
  report: CloudStreamReport;
}

/** A service that hasn't let the stream start after this long is out of reach. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** After the last audio, the last text is waited for this long at most: what came by then is final. */
export const FINISH_TIMEOUT_MS = 20_000;

export const msOf = (samples: number) => (samples * 1000) / MEETING_SAMPLE_RATE;
export const samplesOf = (ms: number) => Math.round((ms * MEETING_SAMPLE_RATE) / 1000);
