/**
 * Transcripts as WebVTT (ADR-0011): a Meeting's Transcript is saved in this
 * format, and a .vtt file the User adds reads the same way. Each cue is one
 * line of a Unit's text; Units are blocks of cues in time order, and each
 * cue is anchored by its times ("t754000-761500"), so a Citation's Location
 * is the time its quote starts ("12:34"). Stretches nothing was transcribed
 * for are NOTE blocks ("NOTE gap 00:12:07.000 to 00:12:19.000 restarted"),
 * shown by the viewer but never indexed. Pure: the worker indexes with it
 * and the viewer draws with it.
 */
import { cueTarget, type TextUnit, UnitBuilder } from "../../../shared/units";
import { ExtractionError } from "./errors";

/** One line of a Transcript: what was said between two times, in ms from its start. */
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
  /**
   * Who said it: "Me", "Them" or "Speaker ?" on a live line (#941), a person's name once speakers
   * are told apart (#140); null for a line from a file that names no one.
   */
  speaker: string | null;
}

/**
 * Why a stretch of a Meeting has no text: transcription restarted after a
 * crash, the computer slept, IncarnaMind wasn't running, the audio was
 * deleted before it could catch up, no audio was recorded for it (the system's
 * permission prompt unanswered, a capture that stalled), the cloud service's
 * connection dropped (#141), or the User paused their microphone (the other
 * side's lines go on through it).
 */
export type GapReason =
  | "restarted"
  | "sleep"
  | "interrupted"
  | "lost"
  | "uncaptured"
  | "cloud"
  | "muted";

export const GAP_REASONS: readonly GapReason[] = [
  "restarted",
  "sleep",
  "interrupted",
  "lost",
  "uncaptured",
  "cloud",
  "muted",
];

/** A stretch without text shorter than this isn't listed: nobody can tell it was missing. */
export const MIN_GAP_MS = 1000;

export interface TranscriptGap {
  fromMs: number;
  toMs: number;
  reason: GapReason;
}

/** The gaps a Transcript lists: a point in time, and any stretch of a second or more. */
export const listedGaps = (gaps: readonly TranscriptGap[]): TranscriptGap[] =>
  gaps.filter((gap) => gap.toMs === gap.fromMs || gap.toMs - gap.fromMs >= MIN_GAP_MS);

export interface Transcript {
  cues: Cue[];
  gaps: TranscriptGap[];
}

/** About the most characters of cues in one Unit, as for a block of rows: a Passage holds one or two. */
export const CUE_BLOCK_CHARACTERS = 1600;
/** The most cues in one Unit. */
export const CUES_PER_BLOCK = 40;

const TIMING =
  /^((?:\d{1,}:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+((?:\d{1,}:)?\d{2}:\d{2}\.\d{3})(?:[ \t].*)?$/;
const GAP = /^NOTE gap ((?:\d+:)?\d{2}:\d{2}\.\d{3}) to ((?:\d+:)?\d{2}:\d{2}\.\d{3}) ([a-z]+)$/;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  lrm: "‎",
  rlm: "‏",
};

/** "01:02:03.450" or "02:03.450" → ms. */
function timestampMs(text: string): number {
  const parts = text.split(":");
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

/** ms → "01:02:03.450", as WebVTT writes a time. */
export function timestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(total % 1000, 3)}`;
}

/** A cue's payload as plain text, and its speaker if it opens with a voice span. */
function payloadOf(lines: readonly string[]): { text: string; speaker: string | null } {
  const raw = lines.join("\n");
  const voice = /^<v(?:\.[^ \t>]*)?[ \t]+([^>]+)>/.exec(raw);
  const decode = (value: string) =>
    value.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, name: string) => ENTITIES[name] ?? "");
  const text = decode(raw.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return { text, speaker: voice?.[1] ? decode(voice[1]).trim() || null : null };
}

/** Reads a WebVTT file. Throws `ExtractionError` when it isn't one. */
export function readVtt(source: string): Transcript {
  const lines = source.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? "")) {
    throw new ExtractionError("unreadable", "The file isn't WebVTT: it doesn't start with WEBVTT.");
  }
  const cues: Cue[] = [];
  const gaps: TranscriptGap[] = [];
  let block: string[] = [];
  const finish = () => {
    const [first, ...rest] = block;
    block = [];
    if (first === undefined) return;
    if (/^NOTE(?:[ \t]|$)/.test(first)) {
      const gap = GAP.exec(first);
      const reason = gap?.[3] as GapReason | undefined;
      if (gap && reason && GAP_REASONS.includes(reason)) {
        gaps.push({
          fromMs: timestampMs(gap[1] as string),
          toMs: timestampMs(gap[2] as string),
          reason,
        });
      }
      return;
    }
    if (/^(?:STYLE|REGION)(?:[ \t]|$)/.test(first)) return;
    // A cue: an optional identifier line, then its timing line, then its text.
    const all = [first, ...rest];
    const timingAt = TIMING.test(first) ? 0 : 1;
    const match = TIMING.exec(all[timingAt] ?? "");
    if (!match) return;
    const { text, speaker } = payloadOf(all.slice(timingAt + 1));
    if (!text) return;
    const startMs = timestampMs(match[1] as string);
    cues.push({
      startMs,
      endMs: Math.max(startMs, timestampMs(match[2] as string)),
      text,
      speaker,
    });
  };
  for (const line of lines.slice(1)) {
    if (line.trim() === "") finish();
    else block.push(line);
  }
  finish();
  cues.sort((a, b) => a.startMs - b.startMs);
  gaps.sort((a, b) => a.fromMs - b.fromMs);
  return { cues, gaps };
}

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "--&gt;");

/** Writes a Transcript as WebVTT: its cues and gaps in time order. */
export function writeVtt(transcript: Transcript): string {
  const blocks: { at: number; text: string }[] = [];
  for (const gap of transcript.gaps) {
    blocks.push({
      at: gap.fromMs,
      text: `NOTE gap ${timestamp(gap.fromMs)} to ${timestamp(gap.toMs)} ${gap.reason}`,
    });
  }
  transcript.cues.forEach((cue) => {
    const speaker = cue.speaker
      ? `<v ${cue.speaker.replace(/&/g, "&amp;").replace(/[<>\n]/g, " ")}>`
      : "";
    blocks.push({
      at: cue.startMs,
      text: `${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${speaker}${escapeText(cue.text)}`,
    });
  });
  blocks.sort((a, b) => a.at - b.at);
  return `WEBVTT\n\n${blocks.map((block) => block.text).join("\n\n")}\n`;
}

/**
 * A Transcript's Units: blocks of up to `CUES_PER_BLOCK` cues and about
 * `CUE_BLOCK_CHARACTERS` characters, a cue a line, each anchored by its times,
 * and who said each, where the file says (`UnitLabel.speakers`).
 */
export function transcriptUnits(transcript: Transcript): TextUnit[] {
  const units: TextUnit[] = [];
  let builder = new UnitBuilder();
  let first: Cue | null = null;
  let last: Cue | null = null;
  let count = 0;
  let speakers: (string | null)[] = [];
  const flush = () => {
    if (!first || !last || builder.empty) return;
    units.push({
      page: units.length + 1,
      kind: "cues",
      label: {
        from: first.startMs,
        to: last.endMs,
        ...(speakers.some((speaker) => speaker !== null) && { speakers }),
      },
      text: builder.text,
      anchors: builder.anchors,
    });
    builder = new UnitBuilder();
    first = null;
    count = 0;
    speakers = [];
  };
  for (const cue of transcript.cues) {
    if (
      count > 0 &&
      (count >= CUES_PER_BLOCK || builder.text.length + cue.text.length + 1 > CUE_BLOCK_CHARACTERS)
    ) {
      flush();
    }
    first ??= cue;
    last = cue;
    builder.add(cue.text, cueTarget(cue.startMs, cue.endMs));
    speakers.push(cue.speaker);
    count++;
  }
  flush();
  return units;
}
