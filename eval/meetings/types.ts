/**
 * The formats of the meeting audio set (eval/meetings/README.md): what a case is, what its
 * reference says, and what a transcriber hands back to be scored.
 */

export type Language = "en" | "zh" | "mixed";
/** `conversation` is two people talking, recorded as one track. */
export type Setting = "online" | "room" | "conversation";
export type Track = "mic" | "system" | "room" | "conversation";
export type SourceKind =
  | "ami-online"
  | "ami-room"
  | "alimeeting-online"
  | "alimeeting-room"
  | "ascend";

export interface Segment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  speaker: string;
  text: string;
  track: Track;
}

/** reference.json: who said what, when, in time order. */
export interface Reference {
  format: 1;
  segments: Segment[];
}

/** One recording, as cases.json pins it. */
export interface CaseDefinition {
  id: string;
  language: Language;
  setting: Setting;
  source: SourceKind;
  /** The meeting or session in the source. */
  recording: string;
  /** Online only: the speaker whose track is the microphone. */
  me?: string;
  /** Audio seconds on each track. */
  durationSeconds: number;
  speakers: number;
  /** SHA-256 of each file a case is made of. */
  files: Record<string, string>;
}

/** What a transcriber hands back for one case, as `<case id>.json` in a results folder. */
export interface Hypothesis {
  case: string;
  transcriber: string;
  /** Wall-clock seconds the transcriber took on the whole case, for the real-time factor. */
  processingSeconds?: number;
  /** A segment with no speaker says nothing about who spoke: the case gets no diarisation score. */
  segments: { start: number; end: number; text: string; speaker?: string }[];
}

export interface CaseFolder {
  definition: CaseDefinition;
  folder: string;
  tracks: Partial<Record<Track, string>>;
  reference: Reference;
}
