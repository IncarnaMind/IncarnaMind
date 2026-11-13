/**
 * Meetings (#135): the recording's state, and its audio on disk.
 *
 * A Meeting belongs to a Mind. It starts "ready" (the Mind shows the start
 * block), then records, pauses and stops. The audio comes from the host's
 * `AudioCapture` and goes to disk in 10-second parts per source as it comes
 * (./audioFiles), so a crash, sleep or device change loses at most the part
 * still filling.
 *
 * The Meeting's time is recording time: each stretch recorded (a period)
 * starts where the one before ended, so pauses and gaps take none of it. A
 * stretch that ended because the computer slept or IncarnaMind closed leaves a
 * gap, marked at that point with how long was missed. A Meeting found
 * recording at startup was cut off by a crash or a quit: its stretch ends
 * where its last saved part ends, and it waits, paused, for the User to resume.
 *
 * Its audio is kept for at most a day after the last stretch, then deleted;
 * the User can delete it sooner. Deleting its Mind never deletes it (#1253):
 * the Meeting goes to Recently deleted with the Mind, stopped if it recorded,
 * and comes back with it, until Recently deleted drops it or its day ends.
 * While audio is being captured, background work holds back
 * (`onCapturingChange`): live capture comes first.
 *
 * Where this copy can transcribe, the audio also goes to the Meeting's
 * Transcript as it comes (./transcript, #136). What goes wrong with the
 * capture is kept in its health record (./health, #161).
 *
 * The User can pause their microphone while the Meeting records, for when they
 * mute themselves in the call to talk to someone in the room: it is stopped at
 * its source, and nothing from it is kept, sent or transcribed until it is
 * resumed, while the computer's sound goes on. That is the Meeting's, not the
 * device's: every Meeting starts with its microphone on.
 *
 * A voice memo (#1568) is a Meeting of the User alone: it records the microphone only, from the
 * moment it is made, in a Mind with no title, so the title line of its note names the Mind.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { formatDay } from "../../shared/dates";
import { translate } from "../../shared/i18n";
import {
  type AudioCapture,
  type CaptureSession,
  type CaptureState,
  type Logger,
  MEETING_SAMPLE_RATE,
} from "../adapters";
import {
  type AudioLossCause,
  type AudioSource,
  MEETING_AUDIO_KEPT_MS,
  type Meeting,
  type MeetingAudioStretch,
  type MeetingFill,
  type MeetingGap,
  type MeetingHelp,
  type MeetingHelpTemplate,
  type MeetingKind,
  type MeetingLevel,
  type MeetingSourceState,
  type Mind,
} from "../api";
import { InvalidInputError, isRecord, NotFoundError, TranslatableError } from "../errors";
import type { Language } from "../language";
import { parseFolderChoice } from "../minds";
import type { Database } from "../storage";
import {
  listParts,
  MAX_RECORDING_MS,
  meetingFolder,
  msOf,
  PART_SAMPLES,
  readStretch,
  removeAudio,
  removeUnfinished,
  writePart,
  writeRecording,
} from "./audioFiles";
import type { CaptureHealthRecords } from "./health";
import type { Transcripts } from "./transcript";

/** The longest stretch of audio read at once for playing: the player asks for the next as it goes. */
const MAX_STRETCH_MS = 30_000;

/** Samples arriving this much later than the ones before them could have: a new run starts where they belong. */
const DISCONTINUITY_MS = 1000;

/** The computer's sound, all silence for this long, is said to be silent: macOS gives silence when it isn't allowed. */
const SILENT_SAMPLES = MEETING_SAMPLE_RATE * 60;
/** The microphone, all silence for this long, is said to be silent: a muted one, or the wrong one, gives none. */
const MICROPHONE_SILENT_SAMPLES = MEETING_SAMPLE_RATE * 15;

/** How often audio past its day is looked for. */
const SWEEP_INTERVAL_MS = 60_000;

const LEVEL_EVERY_MS = 100;

/** Loudness from 0 to 1 for samples: their RMS on a scale where quiet speech is about a third. */
function loudness(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, samples.length)) / 32768;
  return Math.min(1, Math.sqrt(rms * 8));
}

type EndedBy = "pause" | "stop" | "sleep" | "interrupted";

/** One stretch recorded. `durationMs` is null while it lasts. */
interface Period {
  start: string;
  offsetMs: number;
  durationMs: number | null;
  endedBy: EndedBy | null;
}

interface MeetingRow {
  id: string;
  mind_id: string;
  kind: MeetingKind;
  status: Meeting["status"];
  paused_by: Meeting["pausedBy"];
  system_audio: number;
  periods: string;
  started_at: string | null;
  stopped_at: string | null;
  audio_expires_at: string | null;
  audio_kept_at: string | null;
  audio_deleted_at: string | null;
  fill: string | null;
  transcript_document_id: string | null;
  purged_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, mind_id, kind, status, paused_by, system_audio, periods, started_at, stopped_at, audio_expires_at, audio_kept_at, audio_deleted_at, fill, transcript_document_id, purged_at, created_at, updated_at";

/** A Meeting's fill as stored: as the API has it, and the ids of the Blocks it added, for Undo. */
export interface StoredFill extends MeetingFill {
  blocks: string[];
}

function storedFillOf(row: Pick<MeetingRow, "fill">): StoredFill | null {
  if (row.fill === null) return null;
  try {
    return JSON.parse(row.fill) as StoredFill;
  } catch {
    return null;
  }
}

/** One source's samples since its run began: what is saved, and what waits to fill a part. */
interface Run {
  /** Where the run starts, in the Meeting's time. */
  startMs: number;
  /** Samples in it so far, saved or waiting. */
  samples: number;
  saved: number;
  waiting: Int16Array[];
  waitingSamples: number;
}

/** The Meeting whose audio is being captured now. */
interface Live {
  meetingId: string;
  folder: string;
  period: Period;
  session: CaptureSession | null;
  sources: Record<AudioSource, MeetingSourceState>;
  runs: Map<AudioSource, Run>;
  /** Where each source's saved audio ends, so a new run never overlaps it. */
  ends: Map<AudioSource, number>;
  /** All-silent samples in a row from the computer's sound. */
  silent: number;
  /** All-silent samples in a row from the microphone. */
  micSilent: number;
  /** Some sound has come from the computer's sound: without it, a macOS that isn't allowing it can't be told from a quiet call. */
  systemSignal: boolean;
  saveError: string | null;
  /** The loudest each source has been since the level was last told, and when that was. */
  levels: Record<AudioSource, number>;
  levelAt: number;
}

export interface MeetingsOptions {
  db: Database;
  dataDir: string;
  now: () => string;
  capture: AudioCapture | undefined;
  noticeAccepted(): boolean;
  /** The "What is recorded" choice in Settings. */
  systemAudioByDefault(): boolean;
  /** "Keep a meeting's audio" in Settings (#687): a Meeting that starts then keeps its audio. */
  keepAudioByDefault(): boolean;
  language(): Language;
  createMind(title: string, folderId: string | null): Mind;
  mindExists(mindId: string): boolean;
  /** Removes a Mind a memo made, when recording can't start: nothing is left behind (#1568). */
  removeMind(mindId: string): void;
  changed(meetings: Meeting[]): void;
  /** Whether audio is being captured, each time that changes. */
  onCapturingChange(capturing: boolean): void;
  /** How loud each source is, about ten times a second while audio is captured. */
  level?(level: MeetingLevel): void;
  /** Transcribes Meetings (#136); absent where this copy can't. */
  transcripts?: Transcripts;
  health: CaptureHealthRecords;
  log: Logger;
}

export type Meetings = ReturnType<typeof createMeetings>;

/** A Meeting brought back with its Mind, and when the two were deleted. */
export interface RestoredMeeting {
  meetingId: string;
  deletedAt: string;
}

/** Why a part couldn't be saved, from the error's code. */
function lossCauseOf(code: string): AudioLossCause {
  if (code === "ENOSPC" || code === "EDQUOT") return "full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "denied";
  return "error";
}

export const isMemo = (db: Database, meetingId: string): boolean =>
  db.get<Pick<MeetingRow, "kind">>("SELECT kind FROM meetings WHERE id = ?", [meetingId])?.kind ===
  "memo";

/** A Meeting's note, kind and times, in Recently deleted too: what its Transcript is named from. */
export function meetingRecord(
  db: Database,
  meetingId: string,
): {
  mindId: string;
  kind: MeetingKind;
  startedAt: string | null;
  createdAt: string;
  deletedAt: string | null;
} | null {
  const row = db.get<
    Pick<MeetingRow, "mind_id" | "kind" | "started_at" | "created_at"> & {
      deleted_at: string | null;
    }
  >("SELECT mind_id, kind, started_at, created_at, deleted_at FROM meetings WHERE id = ?", [
    meetingId,
  ]);
  return row
    ? {
        mindId: row.mind_id,
        kind: row.kind,
        startedAt: row.started_at,
        createdAt: row.created_at,
        deletedAt: row.deleted_at,
      }
    : null;
}

/**
 * The call a Transcript Document records (#3005): its Meeting's Note and when the call started.
 * Null for any other Document, a voice memo's Transcript and a Transcript the User added among them.
 */
export function callOfTranscript(
  db: Database,
  documentId: string,
): { mindId: string; startedAt: string } | null {
  const row = db.get<Pick<MeetingRow, "mind_id" | "started_at">>(
    "SELECT mind_id, started_at FROM meetings WHERE transcript_document_id = ? AND kind = 'meeting' AND started_at IS NOT NULL",
    [documentId],
  );
  return row?.started_at ? { mindId: row.mind_id, startedAt: row.started_at } : null;
}

/**
 * The Transcripts of every call but the one recording or paused in Note `mindId`: what a help
 * button's press never reads (#3005).
 */
export function otherCallTranscripts(db: Database, mindId: string): string[] {
  return db
    .all<Pick<MeetingRow, "transcript_document_id">>(
      "SELECT transcript_document_id FROM meetings WHERE kind = 'meeting' AND transcript_document_id IS NOT NULL AND NOT (mind_id = ? AND status IN ('recording', 'paused'))",
      [mindId],
    )
    .flatMap((row) => (row.transcript_document_id ? [row.transcript_document_id] : []));
}

/**
 * Records which Document is the Meeting's Transcript, in the transaction that makes it, and that
 * it belongs to the Meeting's Note (#2528).
 */
export function linkTranscript(db: Database, meetingId: string, documentId: string): void {
  db.run("UPDATE meetings SET transcript_document_id = ? WHERE id = ?", [documentId, meetingId]);
  db.run(
    "UPDATE documents SET meeting_mind_id = (SELECT mind_id FROM meetings WHERE id = ?) WHERE id = ?",
    [meetingId, documentId],
  );
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown";

export function createMeetings(options: MeetingsOptions) {
  const { db, now, capture, transcripts, health, log } = options;
  const clock = () => Date.parse(now());
  const folderOf = (meetingId: string) => meetingFolder(options.dataDir, meetingId);
  let live: Live | null = null;
  /** Whether each Meeting has audio on disk, looked up once. */
  const kept = new Map<string, boolean>();
  /** Save recording… writing a Meeting's audio now (#687): set when its audio goes, so it stops. */
  const writing = new Map<string, { stop: boolean }>();
  /** For the call's help, kept in memory: it matters only while the Meeting is live. */
  const help = new Map<string, MeetingHelp>();
  const templates = new Map<string, MeetingHelpTemplate>();
  const microphonePausedAt = new Map<string, number>();
  const microphoneResumedAt = new Map<string, number>();

  const rowOf = (meetingId: unknown): MeetingRow => {
    if (typeof meetingId !== "string" || meetingId === "") {
      throw new InvalidInputError("A Meeting id must be a non-empty string.");
    }
    const row = db.get<MeetingRow>(
      `SELECT ${COLUMNS} FROM meetings WHERE id = ? AND deleted_at IS NULL`,
      [meetingId],
    );
    if (!row) throw new NotFoundError({ key: "error.meeting.notFound" });
    return row;
  };

  const periodsOf = (row: MeetingRow): Period[] => JSON.parse(row.periods) as Period[];

  const isLiveRow = (row: MeetingRow) => row.status === "recording" || row.status === "paused";

  const hasAudio = (meetingId: string): boolean => {
    let value = kept.get(meetingId);
    if (value === undefined) {
      value = listParts(folderOf(meetingId)).length > 0;
      kept.set(meetingId, value);
    }
    return value;
  };

  /** Where the stretch ends in wall-clock time, in ms. */
  const endOf = (period: Period) => Date.parse(period.start) + (period.durationMs ?? 0);

  function fillOf(row: MeetingRow): MeetingFill | null {
    const stored = storedFillOf(row);
    if (!stored) return null;
    const { blocks, ...fill } = stored;
    return { ...fill, addedBlockIds: [...(blocks ?? [])] };
  }

  function toMeeting(row: MeetingRow): Meeting {
    const periods = periodsOf(row);
    const last = periods.at(-1);
    const open = last && last.durationMs === null ? last : null;
    const gaps: MeetingGap[] = [];
    for (let i = 1; i < periods.length; i++) {
      const before = periods[i - 1] as Period;
      const after = periods[i] as Period;
      if (before.endedBy !== "sleep" && before.endedBy !== "interrupted") continue;
      gaps.push({
        atMs: after.offsetMs,
        missedMs: Math.max(0, Date.parse(after.start) - endOf(before)),
        reason: before.endedBy,
      });
    }
    const current = live?.meetingId === row.id ? live : null;
    return {
      id: row.id,
      mindId: row.mind_id,
      kind: row.kind,
      status: row.status,
      pausedBy: row.paused_by,
      systemAudio: row.system_audio === 1,
      sources: current ? { ...current.sources } : { microphone: "off", system: "off" },
      recordedMs: open ? open.offsetMs : last ? last.offsetMs + (last.durationMs ?? 0) : 0,
      recordingSince: open ? open.start : null,
      gaps,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      audio: {
        kept: hasAudio(row.id),
        expiresAt: row.audio_expires_at,
        deletedAt: row.audio_deleted_at,
        keptUntilDeleted: row.audio_kept_at !== null,
      },
      saveError: current?.saveError ?? null,
      transcript:
        transcripts && row.status !== "ready" ? transcripts.of(row.id, hasAudio(row.id)) : null,
      health: health.of(row.id),
      microphonePausedAtMs: microphonePausedAt.get(row.id) ?? null,
      help: help.get(row.id) ?? null,
      helpTemplate: templates.get(row.id) ?? null,
      fill: fillOf(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const list = (): Meeting[] =>
    db
      .all<MeetingRow>(
        `SELECT ${COLUMNS} FROM meetings WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC`,
      )
      .map(toMeeting);

  const changed = () => options.changed(list());

  function save(
    meetingId: string,
    change: Partial<Omit<MeetingRow, "id" | "mind_id" | "created_at" | "updated_at">>,
  ): void {
    const entries = Object.entries(change);
    const at = now();
    db.run(
      `UPDATE meetings SET ${entries.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      [...entries.map(([, value]) => value as string | number | null), at, meetingId],
    );
  }

  const timeOf = (current: Live, wallMs: number) =>
    current.period.offsetMs + (wallMs - Date.parse(current.period.start));
  const meetingTime = (current: Live) => timeOf(current, clock());

  // ---- Audio to disk ----

  /** Takes the first `count` samples waiting in a run. */
  function take(run: Run, count: number): Int16Array {
    const out = new Int16Array(count);
    let filled = 0;
    while (filled < count) {
      const first = run.waiting[0] as Int16Array;
      const needed = count - filled;
      if (first.length <= needed) {
        out.set(first, filled);
        filled += first.length;
        run.waiting.shift();
      } else {
        out.set(first.subarray(0, needed), filled);
        run.waiting[0] = first.subarray(needed);
        filled += needed;
      }
    }
    run.waitingSamples -= count;
    return out;
  }

  function savePart(current: Live, source: AudioSource, run: Run, samples: Int16Array): void {
    const offsetMs = run.startMs + msOf(run.saved);
    run.saved += samples.length;
    current.ends.set(source, offsetMs + msOf(samples.length));
    const first = !hasAudio(current.meetingId);
    try {
      writePart(current.folder, source, offsetMs, samples);
    } catch (error) {
      // The part is lost; the Meeting says so until a part is saved again.
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      log.error("meeting.saveFailed", { meetingId: current.meetingId, source, code });
      health.add(current.meetingId, {
        kind: "audioLost",
        source,
        cause: lossCauseOf(code),
        atMs: offsetMs,
        durationMs: msOf(samples.length),
      });
      if (current.saveError === null) {
        current.saveError = error instanceof Error ? error.message : String(error);
        changed();
      }
      return;
    }
    kept.set(current.meetingId, true);
    if (first || current.saveError !== null) {
      current.saveError = null;
      changed();
    }
  }

  /** Saves what a run has waiting, however short, and ends it. */
  function endRun(current: Live, source: AudioSource): void {
    const run = current.runs.get(source);
    if (!run) return;
    current.runs.delete(source);
    if (run.waitingSamples > 0) savePart(current, source, run, take(run, run.waitingSamples));
  }

  function hear(
    current: Live,
    source: AudioSource,
    heard: Int16Array,
    capturedAt: number | undefined,
  ): void {
    if (live !== current || heard.length === 0) return;
    // Frames already on their way when the microphone was paused are dropped here.
    if (source === "microphone" && microphonePausedAt.has(current.meetingId)) return;
    const at = meetingTime(current);
    // What the capture held at a pause can arrive after the resume (it flushes as it closes the
    // microphone): only what was captured since the last resume counts, whenever it arrives. A
    // stamp later than the arrival is a clock that is off, so the arrival counts instead.
    const samples =
      source === "microphone"
        ? capturedSinceResumed(
            current,
            heard,
            capturedAt === undefined ? at : Math.min(at, timeOf(current, capturedAt)),
          )
        : heard;
    if (samples.length === 0) return;
    let run = current.runs.get(source);
    let stalledFrom: number | null = null;
    // Samples that come much later than the run could have produced them (a device changed,
    // the capture stalled) start a new run where they belong, so the parts keep the right times.
    if (run && at - (run.startMs + msOf(run.samples + samples.length)) > DISCONTINUITY_MS) {
      stalledFrom = run.startMs + msOf(run.samples);
      endRun(current, source);
      run = undefined;
    }
    if (!run) {
      const ends = current.ends.get(source) ?? current.period.offsetMs;
      run = {
        startMs: Math.max(ends, current.period.offsetMs, at - msOf(samples.length)),
        samples: 0,
        saved: 0,
        waiting: [],
        waitingSamples: 0,
      };
      current.runs.set(source, run);
      if (stalledFrom !== null && run.startMs > stalledFrom) {
        health.add(current.meetingId, {
          kind: "audioLost",
          source,
          cause: "stalled",
          atMs: stalledFrom,
          durationMs: run.startMs - stalledFrom,
        });
        transcripts?.captureStalled(current.meetingId, stalledFrom, run.startMs);
      }
    }
    const quiet = samples.every((sample) => sample === 0);
    if (source === "system") {
      current.silent = quiet ? current.silent + samples.length : 0;
      if (!quiet) current.systemSignal = true;
    } else {
      current.micSilent = quiet ? current.micSilent + samples.length : 0;
    }
    transcripts?.hear(current.meetingId, source, samples, run.startMs + msOf(run.samples));
    tellLevel(current, source, samples);
    run.waiting.push(samples);
    run.waitingSamples += samples.length;
    run.samples += samples.length;
    while (run.waitingSamples >= PART_SAMPLES) {
      savePart(current, source, run, take(run, PART_SAMPLES));
    }
    setSource(
      current,
      source,
      (source === "system" && current.silent >= SILENT_SAMPLES) ||
        (source === "microphone" && current.micSilent >= MICROPHONE_SILENT_SAMPLES)
        ? "silent"
        : "recording",
    );
  }

  function capturedSinceResumed(current: Live, samples: Int16Array, endMs: number): Int16Array {
    const from = microphoneResumedAt.get(current.meetingId);
    if (from === undefined) return samples;
    const before = Math.ceil(((from - endMs) * MEETING_SAMPLE_RATE) / 1000) + samples.length;
    return before <= 0 ? samples : samples.subarray(Math.min(before, samples.length));
  }

  function tellLevel(current: Live, source: AudioSource, samples: Int16Array): void {
    if (!options.level) return;
    current.levels[source] = Math.max(current.levels[source], loudness(samples));
    const at = clock();
    if (at - current.levelAt < LEVEL_EVERY_MS) return;
    current.levelAt = at;
    options.level({ meetingId: current.meetingId, ...current.levels });
    current.levels = { microphone: 0, system: 0 };
  }

  function setSource(current: Live, source: AudioSource, state: MeetingSourceState): void {
    if (current.sources[source] === state) return;
    current.sources[source] = state;
    log.info("meeting.source", { meetingId: current.meetingId, source, state });
    changed();
  }

  function heardState(current: Live, source: AudioSource, state: CaptureState): void {
    if (live !== current) return;
    // "Recording" again is a new track (the default microphone changed): its samples start a run
    // where they arrive, however short the gap, to stay in step with the computer's sound (#846).
    endRun(current, source);
    if (state === "recording" && current.sources[source] === "silent") return;
    // The microphone's permission prompt holds up the capture of both sources, so its wait is the
    // Meeting's, and nothing is captured until it is answered.
    if (source === "microphone") {
      if (state === "waiting") {
        transcripts?.waitingForPermission(current.meetingId, meetingTime(current));
      } else if (current.sources.microphone === "waiting") {
        transcripts?.permissionAnswered(current.meetingId, meetingTime(current));
      }
    }
    setSource(current, source, state);
  }

  /** Starts capturing a Meeting's audio, in a stretch that begins now. */
  function begin(row: MeetingRow, period: Period): void {
    if (!capture) throw new InvalidInputError("This copy of IncarnaMind can't record audio.");
    const systemAudio = row.system_audio === 1;
    const current: Live = {
      meetingId: row.id,
      folder: folderOf(row.id),
      period,
      session: null,
      sources: {
        microphone: "starting",
        system: !systemAudio ? "off" : capture.systemAudio ? "starting" : "unavailable",
      },
      runs: new Map(),
      ends: new Map(),
      silent: 0,
      micSilent: 0,
      systemSignal: false,
      saveError: null,
      levels: { microphone: 0, system: 0 },
      levelAt: 0,
    };
    for (const part of listParts(current.folder)) {
      const end = part.offsetMs + part.durationMs;
      if (end > (current.ends.get(part.source) ?? 0)) current.ends.set(part.source, end);
    }
    live = current;
    options.onCapturingChange(true);
    transcripts?.begin(row.id, period.offsetMs, () => current.systemSignal);
    const silenced = microphonePausedAt.has(row.id);
    if (silenced) transcripts?.microphonePaused(row.id, period.offsetMs);
    current.session = capture.start(
      { systemAudio: systemAudio && capture.systemAudio },
      {
        audio: (source, samples, capturedAt) => hear(current, source, samples, capturedAt),
        state: (source, state) => heardState(current, source, state),
      },
    );
    if (silenced) current.session.setMicrophone(false);
  }

  /**
   * Stops capturing: what is waiting is saved now, and the stretch ends where
   * its audio does, or now if that is later. Returns the stretch's length.
   */
  function end(current: Live): number {
    live = null;
    endRun(current, "microphone");
    endRun(current, "system");
    current.session?.stop().catch((error: unknown) => {
      log.warn("meeting.captureStopFailed", {
        meetingId: current.meetingId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    options.onCapturingChange(false);
    const audioEnd = Math.max(0, ...current.ends.values());
    const length = Math.max(
      clock() - Date.parse(current.period.start),
      audioEnd - current.period.offsetMs,
    );
    transcripts?.end(current.meetingId, current.period.offsetMs + length);
    health.ended(current.meetingId);
    return length;
  }

  /** Ends the Meeting's open stretch, if it has one, and returns its stretches. */
  function closePeriod(row: MeetingRow, endedBy: EndedBy): Period[] {
    const periods = periodsOf(row);
    const open = periods.at(-1);
    if (!open || open.durationMs !== null) return periods;
    open.durationMs =
      live?.meetingId === row.id ? end(live) : Math.max(0, clock() - Date.parse(open.start));
    open.endedBy = endedBy;
    return periods;
  }

  /**
   * When the Meeting's audio goes: a day after its last stretch, if it has any, unless the User
   * keeps it (#687).
   */
  const expiryOf = (row: Pick<MeetingRow, "id" | "audio_kept_at">, periods: Period[]) => {
    const last = periods.at(-1);
    return last && row.audio_kept_at === null && hasAudio(row.id)
      ? new Date(endOf(last) + MEETING_AUDIO_KEPT_MS).toISOString()
      : null;
  };

  /**
   * When the audio goes once a stretch ends: a deletion due and not yet done (a Delete now that
   * failed, a day ended just now) stays due, so the next sweep, or Resume, does it (#687).
   */
  const dueOr = (row: Pick<MeetingRow, "audio_expires_at">, otherwise: string | null) =>
    row.audio_expires_at !== null && row.audio_expires_at <= now()
      ? row.audio_expires_at
      : otherwise;

  const recordedOf = (periods: Period[]) => {
    const last = periods.at(-1);
    return last ? last.offsetMs + (last.durationMs ?? 0) : 0;
  };

  function endMicrophonePause(meetingId: string, atMs: number): void {
    const from = microphonePausedAt.get(meetingId);
    if (from === undefined) return;
    microphonePausedAt.delete(meetingId);
    transcripts?.markMicrophonePause(meetingId, from, atMs);
  }

  function assertNoneCapturing(meetingId: string | null): void {
    if (live && live.meetingId !== meetingId) {
      throw new InvalidInputError({ key: "error.meeting.otherRecording" });
    }
  }

  /** What recording needs: a copy that records, the notice read, and nothing else capturing. */
  function assertCanStart(meetingId: string | null): void {
    if (!capture) throw new InvalidInputError("This copy of IncarnaMind can't record audio.");
    if (!options.noticeAccepted()) {
      throw new InvalidInputError({ key: "error.meeting.noticeUnread" });
    }
    assertNoneCapturing(meetingId);
  }

  // ---- Retention ----

  function deleteAudio(
    meetingId: string,
    reason: "user" | "expired" | "discarded" | "purged",
  ): void {
    if (live?.meetingId === meetingId) {
      live.runs.clear();
    }
    const write = writing.get(meetingId);
    if (write) write.stop = true;
    removeAudio(folderOf(meetingId));
    kept.set(meetingId, false);
    log.info("meeting.audioDeleted", { meetingId, reason });
  }

  /** A recording that couldn't start: what it captured goes, and its Transcript and health, before its row. */
  function discardStart(row: MeetingRow): void {
    if (live?.meetingId === row.id) end(live);
    microphonePausedAt.delete(row.id);
    microphoneResumedAt.delete(row.id);
    transcripts?.forget(row.id);
    health.forget(row.id);
    deleteAudio(row.id, "discarded");
  }

  /** Deletes audio a day past its Meeting's last stretch, in Recently deleted too. */
  function sweep(): void {
    const at = now();
    const due = db.all<{ id: string }>(
      `SELECT id FROM meetings
       WHERE audio_expires_at IS NOT NULL AND audio_expires_at <= ?
         AND status IN ('paused', 'stopped')`,
      [at],
    );
    if (due.length === 0) return;
    for (const { id } of due) {
      try {
        deleteAudio(id, "expired");
      } catch (error) {
        // Tried again at the next sweep: a file that can't be removed now never stops the rest.
        log.error("meeting.expireFailed", { meetingId: id, code: codeOf(error) });
        continue;
      }
      save(id, { audio_deleted_at: at, audio_expires_at: null });
    }
    changed();
  }

  /**
   * Deletes the audio, the Transcript's working state and the health record of Meetings whose
   * Mind was deleted permanently, each once (`purged_at`). One whose files can't be removed now
   * stays for the next start, which tries again; never throws. Returns those Meetings' Minds.
   */
  function dropPurged(): string[] {
    const purged = db.all<Pick<MeetingRow, "id" | "mind_id" | "audio_deleted_at">>(
      `SELECT id, mind_id, audio_deleted_at FROM meetings WHERE purged_at IS NULL
         AND mind_id IN (SELECT id FROM minds WHERE purged_at IS NOT NULL)`,
    );
    const failed: string[] = [];
    for (const { id, mind_id, audio_deleted_at } of purged) {
      try {
        transcripts?.forget(id);
        health.forget(id);
        if (audio_deleted_at === null) deleteAudio(id, "purged");
      } catch (error) {
        log.error("meeting.purgeFailed", { meetingId: id, code: codeOf(error) });
        failed.push(mind_id);
        continue;
      }
      const at = now();
      save(id, {
        purged_at: at,
        ...(audio_deleted_at === null && { audio_deleted_at: at, audio_expires_at: null }),
      });
    }
    return failed;
  }

  /**
   * The Transcript Documents of these Meetings, those that have one: as recorded, else as its
   * working file says, for one made before the record was kept.
   */
  const transcriptsOf = (rows: readonly Pick<MeetingRow, "id" | "transcript_document_id">[]) =>
    rows.flatMap((row) => row.transcript_document_id ?? transcripts?.documentOf(row.id) ?? []);

  // ---- After a crash or a quit ----

  /**
   * A Meeting still recording was cut off: its stretch ends where its saved
   * audio does, and it waits, paused, for the User. Parts half written go.
   */
  function recover(): void {
    const cut = db.all<MeetingRow>(
      `SELECT ${COLUMNS} FROM meetings WHERE deleted_at IS NULL AND status = 'recording'`,
    );
    for (const row of cut) {
      const folder = folderOf(row.id);
      const unfinished = removeUnfinished(folder);
      const parts = listParts(folder);
      const periods = periodsOf(row);
      const last = periods.at(-1);
      if (last && last.durationMs === null) {
        const audioEnd = Math.max(
          last.offsetMs,
          ...parts.map((part) => part.offsetMs + part.durationMs),
        );
        last.durationMs = audioEnd - last.offsetMs;
      }
      // Asleep when IncarnaMind closed, or cut off: either way it didn't record until now.
      if (last) {
        last.endedBy = "interrupted";
        transcripts?.recovered(row.id, last.offsetMs + (last.durationMs ?? 0));
        const saved = parts.filter((part) => part.offsetMs >= last.offsetMs).length;
        if (saved > 0) {
          health.add(row.id, {
            kind: "audioRecovered",
            parts: saved,
            atMs: last.offsetMs + (last.durationMs ?? 0),
            durationMs: last.durationMs ?? 0,
          });
        }
      }
      for (const part of unfinished) {
        health.add(row.id, {
          kind: "audioLost",
          source: part.source,
          cause: "closed",
          atMs: part.offsetMs,
          durationMs: part.durationMs,
        });
      }
      save(row.id, {
        status: "paused",
        paused_by: "interrupted",
        periods: JSON.stringify(periods),
        audio_expires_at: dueOr(row, expiryOf(row, periods)),
      });
      log.warn("meeting.recovered", {
        meetingId: row.id,
        parts: parts.length,
        unfinished: unfinished.length,
      });
    }
  }

  recover();
  // A Transcript a quit cut off while it was being finished is finished now, in Recently deleted
  // too, so it is whole if it comes back.
  for (const { id } of db.all<{ id: string }>(
    `SELECT id FROM meetings WHERE status = 'stopped'
       AND mind_id NOT IN (SELECT id FROM minds WHERE purged_at IS NOT NULL)`,
  )) {
    transcripts?.resume(id);
  }
  dropPurged();
  sweep();
  const sweeping = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      log.error("meeting.sweepFailed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, SWEEP_INTERVAL_MS);
  sweeping.unref?.();

  const meetingTitle = () => {
    const language = options.language();
    return translate(language, "meetings.mindTitle", { date: formatDay(clock(), language) });
  };

  const parseInput = (input: unknown): Record<string, unknown> => {
    if (input === undefined) return {};
    if (!isRecord(input)) throw new InvalidInputError("Expected an object.");
    return input;
  };

  /** A Meeting ready to record, in the empty Mind given or a new one; a memo's has no title. */
  function insert(
    input: unknown,
    kind: MeetingKind,
  ): { row: MeetingRow; createdMindId: string | null } {
    if (!capture) throw new InvalidInputError("This copy of IncarnaMind can't record audio.");
    const { mindId, folderId } = parseInput(input);
    if (mindId !== undefined && (typeof mindId !== "string" || !options.mindExists(mindId))) {
      throw new NotFoundError({ key: "error.mind.notFound" });
    }
    if (
      typeof mindId === "string" &&
      db.get("SELECT 1 FROM meetings WHERE mind_id = ? AND deleted_at IS NULL", [mindId])
    ) {
      throw new InvalidInputError("That Note has a Meeting already.");
    }
    const id = randomUUID();
    const at = now();
    const systemAudio = kind === "meeting" && options.systemAudioByDefault();
    let createdMindId: string | null = null;
    db.transaction(() => {
      let mind: string;
      if (typeof mindId === "string") {
        mind = mindId;
      } else {
        const created = options.createMind(
          kind === "memo" ? "" : meetingTitle(),
          parseFolderChoice(folderId),
        );
        mind = created.id;
        createdMindId = created.id;
      }
      db.run(
        `INSERT INTO meetings (id, mind_id, kind, status, system_audio, created_at, updated_at)
         VALUES (?, ?, ?, 'ready', ?, ?, ?)`,
        [id, mind, kind, systemAudio ? 1 : 0, at, at],
      );
    });
    return { row: rowOf(id), createdMindId };
  }

  function record(row: MeetingRow, system: boolean): Meeting {
    const at = now();
    const period: Period = { start: at, offsetMs: 0, durationMs: null, endedBy: null };
    save(row.id, {
      status: "recording",
      system_audio: system ? 1 : 0,
      periods: JSON.stringify([period]),
      started_at: at,
      // As the setting is when it starts: what the recording notice said holds for it.
      ...(options.keepAudioByDefault() && { audio_kept_at: at }),
    });
    begin(rowOf(row.id), period);
    log.info("meeting.started", { meetingId: row.id, kind: row.kind, systemAudio: system });
    changed();
    return toMeeting(rowOf(row.id));
  }

  return {
    list,

    create(input: unknown): Meeting {
      const { row } = insert(input, "meeting");
      changed();
      return toMeeting(row);
    },

    recordMemo(input: unknown): Meeting {
      assertCanStart(null);
      const { row, createdMindId } = insert(input, "memo");
      try {
        return record(row, false);
      } catch (error) {
        try {
          discardStart(row);
        } catch (cleanup) {
          log.warn("meeting.memoStartCleanupFailed", {
            meetingId: row.id,
            message: cleanup instanceof Error ? cleanup.message : String(cleanup),
          });
        }
        try {
          const at = now();
          db.run("UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ?", [
            at,
            at,
            row.id,
          ]);
          changed();
        } catch (cleanup) {
          log.warn("meeting.memoStartTombstoneFailed", {
            meetingId: row.id,
            message: cleanup instanceof Error ? cleanup.message : String(cleanup),
          });
        }
        if (createdMindId !== null) {
          try {
            options.removeMind(createdMindId);
          } catch (cleanup) {
            log.warn("meeting.memoCleanupFailed", {
              meetingId: row.id,
              mindId: createdMindId,
              message: cleanup instanceof Error ? cleanup.message : String(cleanup),
            });
          }
        }
        throw error;
      }
    },

    discard(meetingId: unknown): void {
      const row = rowOf(meetingId);
      if (row.status !== "ready") {
        throw new InvalidInputError({ key: "error.meeting.cantDiscard" });
      }
      const at = now();
      db.run("UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, row.id]);
      changed();
    },

    start(input: unknown): Meeting {
      const { meetingId, systemAudio } = parseInput(input);
      const row = rowOf(meetingId);
      if (row.status !== "ready")
        throw new InvalidInputError({ key: "error.meeting.alreadyStarted" });
      if (systemAudio !== undefined && typeof systemAudio !== "boolean") {
        throw new InvalidInputError("systemAudio must be true or false.");
      }
      assertCanStart(row.id);
      return record(row, row.kind === "meeting" && (systemAudio ?? row.system_audio === 1));
    },

    pause(meetingId: unknown): Meeting {
      const row = rowOf(meetingId);
      if (row.status !== "recording")
        throw new InvalidInputError({ key: "error.meeting.notRecording" });
      const periods = closePeriod(row, "pause");
      save(row.id, {
        status: "paused",
        paused_by: "user",
        periods: JSON.stringify(periods),
        audio_expires_at: dueOr(row, expiryOf(row, periods)),
      });
      log.info("meeting.paused", { meetingId: row.id });
      changed();
      return toMeeting(rowOf(row.id));
    },

    resume(meetingId: unknown): Meeting {
      const row = rowOf(meetingId);
      if (row.status !== "paused") throw new InvalidInputError({ key: "error.meeting.notPaused" });
      assertNoneCapturing(row.id);
      // A deletion already due goes first, so what is recorded next never falls under its date
      // (#687); one that still fails keeps the Meeting paused, and says why.
      if (dueOr(row, null) !== null) {
        try {
          deleteAudio(row.id, "expired");
        } catch (error) {
          log.error("meeting.resumeDeleteFailed", { meetingId: row.id, code: codeOf(error) });
          throw new TranslatableError(
            { key: "error.meeting.resumeAudioNotDeleted" },
            { cause: error },
          );
        }
        save(row.id, { audio_deleted_at: now(), audio_expires_at: null });
      }
      const periods = periodsOf(row);
      const period: Period = {
        start: now(),
        offsetMs: recordedOf(periods),
        durationMs: null,
        endedBy: null,
      };
      save(row.id, {
        status: "recording",
        paused_by: null,
        periods: JSON.stringify([...periods, period]),
        audio_expires_at: null,
      });
      begin(rowOf(row.id), period);
      log.info("meeting.resumed", { meetingId: row.id });
      changed();
      return toMeeting(rowOf(row.id));
    },

    stop(meetingId: unknown): Meeting {
      const row = rowOf(meetingId);
      if (row.status !== "recording" && row.status !== "paused") {
        throw new InvalidInputError({ key: "error.meeting.notBeingRecorded" });
      }
      const periods = closePeriod(row, "stop");
      endMicrophonePause(row.id, recordedOf(periods));
      save(row.id, {
        status: "stopped",
        paused_by: null,
        periods: JSON.stringify(periods),
        stopped_at: now(),
        audio_expires_at: dueOr(row, expiryOf(row, periods)),
      });
      transcripts?.stop(row.id);
      help.delete(row.id);
      templates.delete(row.id);
      log.info("meeting.stopped", { meetingId: row.id });
      changed();
      return toMeeting(rowOf(row.id));
    },

    /** The Meeting's fill as stored (#142), with the Blocks it added. */
    storedFill(meetingId: string): StoredFill | null {
      return storedFillOf(rowOf(meetingId));
    },

    /** Records the Meeting's fill (#142) and reports the change. */
    setFill(meetingId: string, fill: StoredFill): Meeting {
      save(meetingId, { fill: JSON.stringify(fill) });
      changed();
      return toMeeting(rowOf(meetingId));
    },

    /** The stopped Meetings whose fill was under way or waiting (#142): what a quit left. */
    unfinishedFills(): { meetingId: string; mindId: string; fill: StoredFill }[] {
      return db
        .all<MeetingRow>(
          `SELECT ${COLUMNS} FROM meetings
           WHERE deleted_at IS NULL AND status = 'stopped'
             AND json_extract(fill, '$.state') IN ('waiting', 'filling')`,
        )
        .flatMap((row) => {
          const fill = storedFillOf(row);
          return fill ? [{ meetingId: row.id, mindId: row.mind_id, fill }] : [];
        });
    },

    retryTranscript(meetingId: unknown): Meeting {
      const row = rowOf(meetingId);
      if (!transcripts) throw new InvalidInputError("This copy of IncarnaMind can't transcribe.");
      transcripts.retry(row.id);
      return toMeeting(rowOf(row.id));
    },

    /**
     * A stretch of a stopped Meeting's audio for playing it from a word (#138): see
     * `readStretch`. NotFoundError once its audio is deleted or its files are gone.
     */
    readAudio(input: unknown): MeetingAudioStretch {
      const { meetingId, fromMs, toMs } = isRecord(input) ? input : {};
      if (typeof fromMs !== "number" || typeof toMs !== "number" || !(toMs > fromMs)) {
        throw new InvalidInputError({ key: "error.meeting.audioStretch" });
      }
      const row = rowOf(meetingId);
      const from = Math.max(0, fromMs);
      const to = Math.min(toMs, from + MAX_STRETCH_MS);
      const samples =
        row.audio_deleted_at === null && row.status === "stopped"
          ? readStretch(folderOf(row.id), from, to)
          : null;
      if (!samples) throw new NotFoundError({ key: "error.meeting.audioGone" });
      return { fromMs: from, toMs: to, sampleRate: MEETING_SAMPLE_RATE, samples };
    },

    /**
     * Keeps a Meeting's audio until the User deletes it, or with `kept` false, as its Undo does,
     * lets it go a day from now: never at once, however long it was kept (#687).
     */
    keepAudio(input: unknown): Meeting {
      const { meetingId, kept: keep } = isRecord(input) ? input : {};
      if (typeof keep !== "boolean") {
        throw new InvalidInputError({ key: "error.meeting.keepAudioChoice" });
      }
      const row = rowOf(meetingId);
      if (keep && !hasAudio(row.id)) {
        throw new InvalidInputError({ key: "error.meeting.noAudioToKeep" });
      }
      const at = now();
      save(row.id, {
        audio_kept_at: keep ? (row.audio_kept_at ?? at) : null,
        audio_expires_at:
          !keep && (row.status === "paused" || row.status === "stopped") && hasAudio(row.id)
            ? new Date(Date.parse(at) + MEETING_AUDIO_KEPT_MS).toISOString()
            : null,
      });
      log.info("meeting.audioKept", { meetingId: row.id, kept: keep });
      changed();
      return toMeeting(rowOf(row.id));
    },

    /**
     * Writes the Meeting's audio as one WAV file at `path`, a place the User chose (#687). Not
     * while it records. NotFoundError when it has no audio, or its audio goes while it is
     * written, which then leaves nothing at `path`.
     */
    async writeRecording(meetingId: unknown, path: unknown): Promise<void> {
      if (typeof path !== "string" || !isAbsolute(path)) {
        throw new InvalidInputError({ key: "error.meeting.recordingPath" });
      }
      const row = rowOf(meetingId);
      if (row.status === "recording") {
        throw new InvalidInputError({ key: "error.meeting.saveWhileRecording" });
      }
      if (writing.has(row.id)) {
        throw new InvalidInputError({ key: "error.meeting.savingRecording" });
      }
      if (!hasAudio(row.id)) throw new NotFoundError({ key: "error.meeting.audioGone" });
      const durationMs = recordedOf(periodsOf(row));
      if (durationMs > MAX_RECORDING_MS) {
        throw new InvalidInputError({ key: "error.meeting.recordingTooLong" });
      }
      const write = { stop: false };
      writing.set(row.id, write);
      try {
        const written = await writeRecording(folderOf(row.id), durationMs, path, () => write.stop);
        if (!written) throw new NotFoundError({ key: "error.meeting.audioGone" });
        log.info("meeting.recordingSaved", { meetingId: row.id });
      } finally {
        writing.delete(row.id);
      }
    },

    /**
     * Delete now. Asked for first, as the audio's day ending now: a removal that fails part-way is
     * tried again by the sweep and at the next start, kept or not, and its error is thrown.
     */
    deleteAudio(meetingId: unknown): Meeting {
      const row = rowOf(meetingId);
      save(row.id, { audio_kept_at: null, audio_expires_at: now() });
      try {
        deleteAudio(row.id, "user");
      } catch (error) {
        log.error("meeting.deleteAudioFailed", { meetingId: row.id, code: codeOf(error) });
        changed();
        throw new TranslatableError({ key: "error.meeting.audioNotDeleted" }, { cause: error });
      }
      save(row.id, { audio_deleted_at: now(), audio_expires_at: null });
      changed();
      return toMeeting(rowOf(row.id));
    },

    async openSettings(source: unknown): Promise<void> {
      if (source !== "microphone" && source !== "system") {
        throw new InvalidInputError('The source must be "microphone" or "system".');
      }
      if (!capture) throw new InvalidInputError("This copy of IncarnaMind can't record audio.");
      await capture.openSettings(source);
    },

    /**
     * The Mind went to Recently deleted at `at`, in this transaction: its Meetings go with it, at
     * its time, as they are, their audio kept until Recently deleted drops it or its day ends
     * (#1253). One recording is stopped first (`stop`). Returns their ids, and their Transcript
     * Documents, which go with them.
     */
    deletedWith(mindId: string, at: string): { meetingIds: string[]; transcripts: string[] } {
      const rows = db.all<MeetingRow>(
        `SELECT ${COLUMNS} FROM meetings WHERE mind_id = ? AND deleted_at IS NULL`,
        [mindId],
      );
      if (rows.length === 0) return { meetingIds: [], transcripts: [] };
      if (rows.some(isLiveRow)) {
        throw new Error("A Meeting being recorded is stopped before its Mind is deleted.");
      }
      const ids = rows.map((row) => row.id);
      db.run(
        "UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE mind_id = ? AND deleted_at IS NULL",
        [at, at, mindId],
      );
      for (const meetingId of ids) log.info("meeting.deleted", { meetingId });
      changed();
      return { meetingIds: ids, transcripts: transcriptsOf(rows) };
    },

    /** The Transcript Documents of the Mind's Meetings deleted with it at `deletedAt`. */
    transcriptsDeletedWith(mindId: string, deletedAt: string): string[] {
      return transcriptsOf(
        db.all<Pick<MeetingRow, "id" | "transcript_document_id">>(
          "SELECT id, transcript_document_id FROM meetings WHERE mind_id = ? AND deleted_at = ?",
          [mindId, deletedAt],
        ),
      );
    },

    /** Whether a Meeting deleted with the Mind at `deletedAt` still keeps its audio. */
    recordingDeletedWith(mindId: string, deletedAt: string): boolean {
      return db
        .all<{ id: string }>(
          `SELECT id FROM meetings
           WHERE mind_id = ? AND deleted_at = ? AND audio_deleted_at IS NULL`,
          [mindId, deletedAt],
        )
        .some((row) => hasAudio(row.id));
    },

    /**
     * Brings back the Mind's Meetings deleted with it at `deletedAt`, in the restore's
     * transaction, then `restored`. One an earlier version left recording when it deleted the
     * Mind stays deleted: its audio and its Transcript's state went then.
     */
    restoreWith(mindId: string, deletedAt: string): RestoredMeeting[] {
      const where = "mind_id = ? AND deleted_at = ? AND status IN ('ready', 'stopped')";
      const ids = db
        .all<{ id: string }>(`SELECT id FROM meetings WHERE ${where}`, [mindId, deletedAt])
        .map((row) => row.id);
      if (ids.length > 0) {
        db.run(`UPDATE meetings SET deleted_at = NULL, updated_at = ? WHERE ${where}`, [
          now(),
          mindId,
          deletedAt,
        ]);
      }
      return ids.map((meetingId) => ({ meetingId, deletedAt }));
    },

    /**
     * Meetings `restoreWith` brought back: audio whose day ended meanwhile goes now, and their
     * Transcripts are read again. Says which Minds' Meetings came back without their audio: lost,
     * no longer on this computer though its day hadn't ended, or expired, its day having ended
     * while the Mind waited in Recently deleted.
     */
    restored(meetings: readonly RestoredMeeting[]): {
      lost: string[];
      expired: { mindId: string; meetingId: string; memo: boolean }[];
    } {
      if (meetings.length === 0) return { lost: [], expired: [] };
      for (const { meetingId } of meetings) kept.delete(meetingId);
      sweep();
      const at = now();
      const lost: string[] = [];
      const expired: { mindId: string; meetingId: string; memo: boolean }[] = [];
      for (const { meetingId, deletedAt } of meetings) {
        const row = rowOf(meetingId);
        log.info("meeting.restored", { meetingId });
        transcripts?.restored(meetingId);
        if (row.audio_deleted_at !== null) {
          if (row.audio_deleted_at > deletedAt) {
            expired.push({ mindId: row.mind_id, meetingId, memo: row.kind === "memo" });
          }
          continue;
        }
        if (row.audio_expires_at === null || hasAudio(meetingId)) continue;
        // An earlier version deleted it with the Mind, or something outside IncarnaMind did.
        log.warn("meeting.audioNotRestored", { meetingId });
        save(meetingId, { audio_deleted_at: at, audio_expires_at: null });
        lost.push(row.mind_id);
      }
      changed();
      return { lost, expired };
    },

    /** Deletes what Meetings of Minds deleted permanently kept; see `dropPurged`. */
    dropPurged,

    /** The Meeting's Transcript Document, if it has one, in Recently deleted too. */
    transcriptOf(meetingId: string): string | null {
      const row = db.get<Pick<MeetingRow, "id" | "transcript_document_id">>(
        "SELECT id, transcript_document_id FROM meetings WHERE id = ?",
        [meetingId],
      );
      return (row && transcriptsOf([row])[0]) ?? null;
    },

    /** Whether the Meeting waits in Recently deleted with its Mind. */
    isDeleted: (meetingId: string): boolean =>
      db.get("SELECT 1 FROM meetings WHERE id = ? AND deleted_at IS NOT NULL", [meetingId]) !==
      undefined,

    /** The computer is going to sleep: what is waiting is saved, and capture stops until it wakes. */
    sleeping(): void {
      if (!live) return;
      const row = rowOf(live.meetingId);
      save(row.id, { periods: JSON.stringify(closePeriod(row, "sleep")) });
      log.info("meeting.asleep", { meetingId: row.id });
      changed();
    },

    /** The computer woke: a Meeting it put to sleep records again, the sleep marked as a gap. */
    awake(): void {
      if (live) return;
      const row = db.get<MeetingRow>(
        `SELECT ${COLUMNS} FROM meetings WHERE deleted_at IS NULL AND status = 'recording'`,
      );
      if (!row) return;
      const periods = periodsOf(row);
      const period: Period = {
        start: now(),
        offsetMs: recordedOf(periods),
        durationMs: null,
        endedBy: null,
      };
      save(row.id, { periods: JSON.stringify([...periods, period]) });
      begin(rowOf(row.id), period);
      log.info("meeting.awake", { meetingId: row.id });
      changed();
    },

    helped(meetingId: string, given: MeetingHelp): void {
      if (!isLiveRow(rowOf(meetingId))) return;
      help.set(meetingId, given);
      changed();
    },

    setMicrophonePaused(input: unknown): Meeting {
      const { meetingId, paused } = parseInput(input);
      const row = rowOf(meetingId);
      if (!isLiveRow(row)) throw new InvalidInputError({ key: "error.meeting.notBeingRecorded" });
      if (typeof paused !== "boolean")
        throw new InvalidInputError({ key: "error.meeting.microphone" });
      if (paused === microphonePausedAt.has(row.id)) return toMeeting(row);
      const capturing = live?.meetingId === row.id ? live : null;
      const atMs = capturing ? meetingTime(capturing) : recordedOf(periodsOf(row));
      if (paused) {
        microphonePausedAt.set(row.id, atMs);
        if (capturing) {
          endRun(capturing, "microphone");
          capturing.session?.setMicrophone(false);
          transcripts?.microphonePaused(row.id, atMs);
        }
        log.info("meeting.microphonePaused", { meetingId: row.id });
      } else {
        microphoneResumedAt.set(row.id, atMs);
        endMicrophonePause(row.id, atMs);
        if (capturing) {
          transcripts?.microphoneResumed(row.id, atMs);
          capturing.session?.setMicrophone(true);
        }
        log.info("meeting.microphoneResumed", { meetingId: row.id });
      }
      changed();
      return toMeeting(row);
    },

    setTemplate(meetingId: unknown, template: MeetingHelpTemplate | null): Meeting {
      const row = rowOf(meetingId);
      if (!isLiveRow(row)) throw new InvalidInputError({ key: "error.meeting.notBeingRecorded" });
      if (template) templates.set(row.id, template);
      else templates.delete(row.id);
      changed();
      return toMeeting(row);
    },

    liveOf(mindId: string): Meeting | null {
      const row = db.get<MeetingRow>(
        `SELECT ${COLUMNS} FROM meetings WHERE mind_id = ? AND deleted_at IS NULL AND status IN ('recording', 'paused')`,
        [mindId],
      );
      return row ? toMeeting(row) : null;
    },

    get: (meetingId: unknown): Meeting => toMeeting(rowOf(meetingId)),

    sweep,

    /**
     * IncarnaMind is closing: what is waiting is saved. A Meeting recording
     * stays so in the database, so the next start finds it cut off.
     */
    close(): void {
      clearInterval(sweeping);
      if (live) {
        endMicrophonePause(live.meetingId, meetingTime(live));
        end(live);
      }
      // A call paused with its microphone is cut off as it is: the stretch is marked up to there.
      for (const meetingId of [...microphonePausedAt.keys()]) {
        endMicrophonePause(meetingId, recordedOf(periodsOf(rowOf(meetingId))));
      }
    },
  };
}
