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
 * the User can delete it sooner. While audio is being captured, background
 * work holds back (`onCapturingChange`): live capture comes first.
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
 */
import { randomUUID } from "node:crypto";
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
  type MeetingFill,
  type MeetingGap,
  type MeetingHelp,
  type MeetingHelpTemplate,
  type MeetingLevel,
  type MeetingSourceState,
  type Mind,
} from "../api";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { Language } from "../language";
import { parseFolderChoice } from "../minds";
import type { Database } from "../storage";
import {
  listParts,
  meetingFolder,
  msOf,
  PART_SAMPLES,
  removeAudio,
  removeUnfinished,
  writePart,
} from "./audioFiles";
import type { CaptureHealthRecords } from "./health";
import type { Transcripts } from "./transcript";

/** Samples arriving this much later than the ones before them could have: a new run starts where they belong. */
const DISCONTINUITY_MS = 1000;

/** The computer's sound, all silence for this long, is said to be silent: macOS gives silence when it isn't allowed. */
const SILENT_SAMPLES = MEETING_SAMPLE_RATE * 60;

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
  status: Meeting["status"];
  paused_by: Meeting["pausedBy"];
  system_audio: number;
  periods: string;
  started_at: string | null;
  stopped_at: string | null;
  audio_expires_at: string | null;
  audio_deleted_at: string | null;
  fill: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, mind_id, status, paused_by, system_audio, periods, started_at, stopped_at, audio_expires_at, audio_deleted_at, fill, created_at, updated_at";

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
  language(): Language;
  createMind(title: string, folderId: string | null): Mind;
  mindExists(mindId: string): boolean;
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

/** Why a part couldn't be saved, from the error's code. */
function lossCauseOf(code: string): AudioLossCause {
  if (code === "ENOSPC" || code === "EDQUOT") return "full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "denied";
  return "error";
}

export function createMeetings(options: MeetingsOptions) {
  const { db, now, capture, transcripts, health, log } = options;
  const clock = () => Date.parse(now());
  const folderOf = (meetingId: string) => meetingFolder(options.dataDir, meetingId);
  let live: Live | null = null;
  /** Whether each Meeting has audio on disk, looked up once. */
  const kept = new Map<string, boolean>();
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
    const { blocks: _blocks, ...fill } = stored;
    return fill;
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
      }
    }
    transcripts?.hear(current.meetingId, source, samples, run.startMs + msOf(run.samples));
    tellLevel(current, source, samples);
    run.waiting.push(samples);
    run.waitingSamples += samples.length;
    run.samples += samples.length;
    while (run.waitingSamples >= PART_SAMPLES) {
      savePart(current, source, run, take(run, PART_SAMPLES));
    }
    if (source === "system") {
      const quiet = samples.every((sample) => sample === 0);
      current.silent = quiet ? current.silent + samples.length : 0;
      if (!quiet) current.systemSignal = true;
    }
    setSource(
      current,
      source,
      source === "system" && current.silent >= SILENT_SAMPLES ? "silent" : "recording",
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

  /** When the Meeting's audio goes: a day after its last stretch, if it has any. */
  const expiryOf = (meetingId: string, periods: Period[]) => {
    const last = periods.at(-1);
    return last && hasAudio(meetingId)
      ? new Date(endOf(last) + MEETING_AUDIO_KEPT_MS).toISOString()
      : null;
  };

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

  function assertNoneCapturing(meetingId: string): void {
    if (live && live.meetingId !== meetingId) {
      throw new InvalidInputError({ key: "error.meeting.otherRecording" });
    }
  }

  // ---- Retention ----

  function deleteAudio(meetingId: string, reason: "user" | "expired" | "discarded"): void {
    if (live?.meetingId === meetingId) {
      live.runs.clear();
    }
    removeAudio(folderOf(meetingId));
    kept.set(meetingId, false);
    log.info("meeting.audioDeleted", { meetingId, reason });
  }

  /** Deletes audio a day past its Meeting's last stretch. */
  function sweep(): void {
    const at = now();
    const due = db.all<{ id: string }>(
      `SELECT id FROM meetings
       WHERE deleted_at IS NULL AND audio_expires_at IS NOT NULL AND audio_expires_at <= ?
         AND status IN ('paused', 'stopped')`,
      [at],
    );
    if (due.length === 0) return;
    for (const { id } of due) {
      deleteAudio(id, "expired");
      save(id, { audio_deleted_at: at, audio_expires_at: null });
    }
    changed();
  }

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
        audio_expires_at: expiryOf(row.id, periods),
      });
      log.warn("meeting.recovered", {
        meetingId: row.id,
        parts: parts.length,
        unfinished: unfinished.length,
      });
    }
  }

  recover();
  // A Transcript a quit cut off while it was being finished is finished now.
  for (const { id } of db.all<{ id: string }>(
    "SELECT id FROM meetings WHERE deleted_at IS NULL AND status = 'stopped'",
  )) {
    transcripts?.resume(id);
  }
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

  return {
    list,

    create(input: unknown): Meeting {
      if (!capture) throw new InvalidInputError("This copy of IncarnaMind can't record audio.");
      const { mindId, folderId } = parseInput(input);
      if (mindId !== undefined && (typeof mindId !== "string" || !options.mindExists(mindId))) {
        throw new NotFoundError({ key: "error.mind.notFound" });
      }
      if (
        typeof mindId === "string" &&
        db.get("SELECT 1 FROM meetings WHERE mind_id = ? AND deleted_at IS NULL", [mindId])
      ) {
        throw new InvalidInputError("That Mind has a Meeting already.");
      }
      const id = randomUUID();
      const at = now();
      db.transaction(() => {
        const mind =
          typeof mindId === "string"
            ? mindId
            : options.createMind(meetingTitle(), parseFolderChoice(folderId)).id;
        db.run(
          `INSERT INTO meetings (id, mind_id, status, system_audio, created_at, updated_at)
           VALUES (?, ?, 'ready', ?, ?, ?)`,
          [id, mind, options.systemAudioByDefault() ? 1 : 0, at, at],
        );
      });
      changed();
      return toMeeting(rowOf(id));
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
      if (!capture) throw new InvalidInputError("This copy of IncarnaMind can't record audio.");
      if (!options.noticeAccepted()) {
        throw new InvalidInputError({ key: "error.meeting.noticeUnread" });
      }
      assertNoneCapturing(row.id);
      const at = now();
      const period: Period = { start: at, offsetMs: 0, durationMs: null, endedBy: null };
      const system = systemAudio ?? row.system_audio === 1;
      save(row.id, {
        status: "recording",
        system_audio: system ? 1 : 0,
        periods: JSON.stringify([period]),
        started_at: at,
      });
      begin(rowOf(row.id), period);
      log.info("meeting.started", { meetingId: row.id, systemAudio: system });
      changed();
      return toMeeting(rowOf(row.id));
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
        audio_expires_at: expiryOf(row.id, periods),
      });
      log.info("meeting.paused", { meetingId: row.id });
      changed();
      return toMeeting(rowOf(row.id));
    },

    resume(meetingId: unknown): Meeting {
      const row = rowOf(meetingId);
      if (row.status !== "paused") throw new InvalidInputError({ key: "error.meeting.notPaused" });
      assertNoneCapturing(row.id);
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
        audio_expires_at: expiryOf(row.id, periods),
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

    deleteAudio(meetingId: unknown): Meeting {
      const row = rowOf(meetingId);
      deleteAudio(row.id, "user");
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

    /** The Mind was deleted: its Meeting stops, and its audio goes with it. */
    mindDeleted(mindId: string): void {
      const rows = db.all<MeetingRow>(
        `SELECT ${COLUMNS} FROM meetings WHERE mind_id = ? AND deleted_at IS NULL`,
        [mindId],
      );
      if (rows.length === 0) return;
      const at = now();
      for (const row of rows) {
        if (live?.meetingId === row.id) end(live);
        microphonePausedAt.delete(row.id);
        microphoneResumedAt.delete(row.id);
        transcripts?.forget(row.id);
        health.forget(row.id);
        deleteAudio(row.id, "discarded");
        db.run("UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, row.id]);
      }
      changed();
    },

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
