/**
 * A Meeting's Transcript (#136), made on this computer from its audio as it
 * is captured: the microphone, with the computer's echo taken out, and the
 * computer's sound, as two streams (./tracks) to the `Transcriber`, whose
 * lines arrive a few seconds behind. A line from the microphone is "Me" and
 * one from the computer's sound "Them" (#941); in a room with no computer
 * sound, "Speaker ?"; in a voice memo (#1568), no one is named. The Transcript
 * is a Document from its first line, kept in the data folder's "Transcripts"
 * and in the Library, indexed again as lines come; at Stop it is finished
 * there, with nothing asked about where files go (#763). Then, while the
 * audio is kept, the speaker pass (./speakerPass, #138) tells voices apart and
 * relabels it; a voice memo has no such pass.
 *
 * Its audio stays on disk, so nothing is lost when live text can't keep up:
 * - while the model downloads or starts, the audio waits, and what waited
 *   too long is transcribed after the Meeting stops;
 * - when live text falls too far behind, it stops, the meeting bar says
 *   "Recording…", and the rest is transcribed after the Meeting stops;
 * - when the engine's process crashes, it is started again and the stretch
 *   it lost is marked as a gap, which is filled in after the Meeting stops
 *   if its audio is still there.
 *
 * Where the User chose a cloud service (#141), the live audio goes to it
 * instead, each chunk through the cloud's send gate and counted against the
 * monthly cap first. A lost connection, or the service refusing its key,
 * hands the live audio to this computer: what the cloud hadn't given text for
 * is a gap, filled in after Stop. At the cap, the cloud's streams finish what
 * they were sent. When the gate closes (Local mode, consent revoked, another
 * route chosen, the key removed), its streams are dropped with nothing more
 * sent, and this computer transcribes that stretch after Stop. Recording never
 * stops, and the bar says why, except where the User chose.
 *
 * What is needed to pick up after a crash is in files beside the Transcript,
 * as the audio's parts are (ADR-0015): its lines and gaps in the WebVTT file,
 * and in "<meeting>.json" its Document, how far live text got and what is
 * left to transcribe.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isTheirs,
  numberedVoice,
  SPEAKER_ME,
  SPEAKER_THEM,
  SPEAKER_UNKNOWN,
} from "../../shared/speakers";
import type {
  CloudLoss,
  CloudStream,
  EngineSwitch,
  Logger,
  SpeechSegment,
  Transcriber,
} from "../adapters";
import type {
  AudioSource,
  CloudTranscriptionRoute,
  Document,
  MeetingTranscript,
  TranscriptionModelStatus,
  TranscriptProblem,
  TranscriptState,
} from "../api";
import { hashBytes } from "../documents/files";
import {
  type Cue,
  type GapReason,
  MIN_GAP_MS,
  readVtt,
  type TranscriptGap,
  writeVtt,
} from "../documents/formats/vtt";
import type { SnapshotFile } from "../documents/web";
import type { CloudAudioMeter, CloudTranscription } from "../transcription/cloud/routes";
import type { TranscriptionModel } from "../transcription/model";
import type { AudioPart } from "./audioFiles";
import { echoedBy, isEcho, repeats } from "./echoLines";
import type { CaptureHealthRecords } from "./health";
import { isCall, type SpeakerPass, sourceToSeparate } from "./speakerPass";
import { createTracks, type TrackedAudio, type Tracks } from "./tracks";

/** Live text this far behind the audio has fallen behind. */
export const BEHIND_MS = 30_000;
/** While the engine starts, at most this much audio waits for it; older audio is transcribed after Stop. */
const HELD_MS = 60_000;
/**
 * The Document is indexed again at most this often while lines come: every
 * 20 seconds at first, then less often as it grows, to two minutes, as each
 * indexing keeps a version until the next start (unless a Citation quotes it).
 */
const indexEvery = (lines: number) => Math.min(120_000, Math.max(20_000, lines * 100));
/** The engine started again this many times within `RESTARTS_WITHIN_MS` isn't started again until Stop. */
const MAX_RESTARTS = 3;
const RESTARTS_WITHIN_MS = 5 * 60_000;
/** Both streams move to another engine together: switches this close are one switch of the Meeting. */
const SWITCH_TOGETHER_MS = 10_000;
/** Audio read back from disk goes to the engine this much at a time. */
const CATCH_UP_CHUNK_MS = 20_000;
/** The speed probe counts once this much audio has been decoded live. */
const PROBE_MS = 30_000;
/** Partial text reaches the window at most this often. */
const PARTIAL_EVERY_MS = 500;
/** Cloud audio is counted against the cap this much ahead of what is sent, so the cap is never passed. */
const COUNTED_AHEAD_MS = 10_000;

const SAMPLE_RATE_MS = 16;
const WAV_HEADER_BYTES = 44;

interface Range {
  fromMs: number;
  toMs: number;
}

/** What is kept in "<meeting>.json". */
interface Saved {
  documentId: string | null;
  /** How far live text got, in the Meeting's time: everything before has its final text. */
  doneMs: number;
  /** Stretches to transcribe once the Meeting stops. */
  pending: Range[];
  savedPath: string | null;
  /** Stopped with nothing transcribed. */
  empty?: boolean;
  /** The number each speaker a cloud service told apart has, by stream and its own label. */
  voices?: Record<string, number>;
  /** The speaker pass (#138): it runs after the save, again after a quit cut it short. */
  speakers?: "due" | "done" | "failed";
  /**
   * The computer's sound has had sound in it: it is being recorded, so the microphone is the
   * User's alone. Until then a macOS that isn't allowing it can't be told from a quiet call.
   */
  callHeard?: boolean;
}

interface LiveStream {
  stream: string;
  baseMs: number;
  doneMs: number;
  /** A cloud stream's audio held in the core until its connection opens; absent once it has. */
  waiting?: Int16Array[];
}

interface Finishing {
  stream: string;
  reading: Reading;
  /** Settles once its last lines are in, or it is dropped. */
  done: Promise<void>;
  drop(): void;
}

interface Live {
  stream: string;
  engine: "local" | CloudTranscriptionRoute;
  /** `aheadMs`: audio counted against the cap and not sent yet. */
  cloud: { stream: CloudStream; meter: CloudAudioMeter; aheadMs: number } | null;
  /** Where to transcribe is being worked out: the audio waits meanwhile. */
  choosing: boolean;
  tracks: Tracks;
  /** The streams opened, each with its source's first audio: the computer's sound may come later, or never. */
  streams: Partial<Record<AudioSource, LiveStream>>;
  /** The microphone's streams opened since `stream` began: each pause ends one and the next audio starts another. */
  microphoneStreams: number;
  /** Microphone streams a pause ended, until their last lines are in: a closed gate drops them too. */
  finishing: Finishing[];
  started: boolean;
  /** Audio waiting for the engine to start. */
  held: TrackedAudio[];
  /** How far audio has gone to the engine, and how far its text is final on every stream, in the Meeting's time. */
  pushedMs: number;
  doneMs: number;
  /** Audio from here on isn't transcribed live: it is transcribed after Stop. Null while it is. */
  pendingFrom: number | null;
  /**
   * Where the audio that waited for the engine to start ends: until the engine
   * is done with it, only audio after it counts towards falling behind.
   */
  backlogEnd: number;
  callSound(): boolean;
}

interface Reading {
  baseMs: number;
  source: AudioSource;
  speaker(): string | null;
  /** A cloud stream lost before its last lines came. */
  lost?: boolean;
}

interface Heard {
  startMs: number;
  text: string;
  id: number;
  speaker: string | null;
}

interface State extends Saved {
  meetingId: string;
  cues: Cue[];
  gaps: TranscriptGap[];
  state: TranscriptState;
  problem: TranscriptProblem | null;
  partials: Map<string, Heard>;
  live: Live | null;
  /** The live streams last ended, until their last lines are in. */
  ending: Promise<void> | null;
  /** Streams reading audio back from disk, and live streams ending. */
  catchUps: Map<string, Reading>;
  restarts: number[];
  /** The other side's lines from the one voice a cloud service heard so far, while it is "Them". */
  firstVoice: Set<Cue>;
  lastSwitch: (Pick<EngineSwitch, "from" | "to" | "reason"> & { atMs: number }) | null;
  fellBack: MeetingTranscript["fellBack"];
  probe: { audioMs: number; decodeMs: number; recorded: boolean };
  written: boolean;
  separating: boolean;
  lastIndexed: number;
  indexTimer: ReturnType<typeof setTimeout> | null;
  partialTimer: ReturnType<typeof setTimeout> | null;
  finishing: Promise<void> | null;
  /** A voice memo (#1568): its lines name no speaker, and no pass tells speakers apart. */
  memo: boolean;
}

export interface TranscriptDocuments {
  add(id: string, name: string, file: SnapshotFile): Document;
  /** Files the Document in the Mind's Folder. */
  file(documentId: string, folderId: string): void;
  check(path: string): Promise<void>;
  /** Reads the file again, and resolves once the Document's text is this file's. */
  checkNow(documentId: string | null, path: string): Promise<void>;
  /** The live Document, or null once deleted. */
  find(id: string): Document | null;
}

export interface TranscriptsOptions {
  dataDir: string;
  transcriber: Transcriber;
  model: TranscriptionModel;
  documents: TranscriptDocuments;
  /** "Transcript · {meeting}", in the language of the interface. */
  name(meetingId: string): string;
  /** The Folder of the Meeting's Mind, if it is in one. */
  folderOf(meetingId: string): string | null;
  /** The Meeting's audio parts on disk. */
  partsOf(meetingId: string): AudioPart[];
  /** Whether the Meeting's audio was deleted, by the User or after its day. */
  audioDeleted(meetingId: string): boolean;
  /** Keeps how long decoding took for the audio it decoded, by model. */
  recordSpeed(modelId: string, ratio: number): void;
  /** Each Meeting's capture health (#161): how fast live text came, restarts, falling behind, switches. */
  health: CaptureHealthRecords;
  /** Tells speakers apart after the call (#138). Absent: lines keep the labels of where they came from. */
  speakers?: SpeakerPass;
  /** Whether the Meeting is a voice memo (#1568), whose lines name no one. */
  memo?(meetingId: string): boolean;
  /** The files of Transcript Documents IncarnaMind kept that were deleted permanently (#763). */
  purgedPaths?(): readonly string[];
  decoded?(modelId: string, decodeMs: number, audioSeconds: number): void;
  /**
   * The Meeting's Transcript is finished (#142): saved, its Document in its place and its
   * speakers told apart (#138), or with no lines.
   */
  saved?(meetingId: string): void;
  /** The cloud service the User chose for meeting audio (#141). Absent: always this computer. */
  cloud?: Pick<CloudTranscription, "start" | "sending" | "refuse">;
  changed(): void;
  log: Logger;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const SOURCES: readonly AudioSource[] = ["microphone", "system"];

const streamName = (prefix: string, source: AudioSource, generation = 0) =>
  generation === 0 ? `${prefix}:${source}` : `${prefix}:${source}:${generation}`;

/** Who a line is said by, as it comes: in a voice memo, no one is named. */
const speakerOf = (source: AudioSource, callSound: boolean, memo: boolean): string | null =>
  memo ? null : source === "system" ? SPEAKER_THEM : callSound ? SPEAKER_ME : SPEAKER_UNKNOWN;

const msOf = (chunks: readonly Int16Array[]) =>
  chunks.reduce((sum, samples) => sum + samples.length / SAMPLE_RATE_MS, 0);

type Leaving = "dropped" | "refused" | "cap" | "user" | "local-mode";

/** The engine couldn't start, or stopped, while what was left was being transcribed. */
class EngineError extends Error {}

/** Adds a stretch to a list of stretches, merging those it touches. */
function addRange(ranges: Range[], range: Range): Range[] {
  if (range.toMs <= range.fromMs) return ranges;
  const all = [...ranges, range].sort((a, b) => a.fromMs - b.fromMs);
  const merged: Range[] = [];
  for (const each of all) {
    const last = merged.at(-1);
    if (last && each.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, each.toMs);
    else merged.push({ ...each });
  }
  return merged;
}

/** A part's samples, from our own WAV files. */
async function samplesOf(part: AudioPart): Promise<Int16Array> {
  const bytes = await readFile(part.path);
  const body = bytes.subarray(WAV_HEADER_BYTES);
  const copy = new Uint8Array(body.byteLength - (body.byteLength % 2));
  copy.set(body.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
}

export function createTranscripts(options: TranscriptsOptions) {
  const { transcriber, model, documents, health, log } = options;
  const folder = join(options.dataDir, "Transcripts");
  const states = new Map<string, State>();
  let streams = 0;
  let closed = false;

  const vttPath = (meetingId: string) => join(folder, `${meetingId}.vtt`);
  const jsonPath = (meetingId: string) => join(folder, `${meetingId}.json`);

  // ---- Files ----

  function load(meetingId: string): State {
    const known = states.get(meetingId);
    if (known) return known;
    let saved: Saved = { documentId: null, doneMs: 0, pending: [], savedPath: null };
    let cues: Cue[] = [];
    let gaps: TranscriptGap[] = [];
    try {
      if (existsSync(jsonPath(meetingId))) {
        saved = { ...saved, ...(JSON.parse(readFileSync(jsonPath(meetingId), "utf8")) as Saved) };
      }
      const vtt =
        saved.savedPath && existsSync(saved.savedPath) ? saved.savedPath : vttPath(meetingId);
      if (existsSync(vtt)) ({ cues, gaps } = readVtt(readFileSync(vtt, "utf8")));
    } catch (error) {
      log.error("transcript.unreadable", { meetingId, message: messageOf(error) });
    }
    const state: State = {
      ...saved,
      meetingId,
      cues,
      gaps,
      state: saved.savedPath
        ? "saved"
        : saved.empty
          ? "empty"
          : cues.length > 0
            ? "behind"
            : "waiting",
      problem: null,
      partials: new Map(),
      live: null,
      ending: null,
      catchUps: new Map(),
      restarts: [],
      firstVoice: new Set(),
      lastSwitch: null,
      fellBack: null,
      probe: { audioMs: 0, decodeMs: 0, recorded: false },
      written: cues.length > 0,
      separating: false,
      lastIndexed: 0,
      indexTimer: null,
      partialTimer: null,
      finishing: null,
      memo: options.memo?.(meetingId) ?? false,
    };
    states.set(meetingId, state);
    return state;
  }

  /** Writes a file whole or not at all. */
  function writeWhole(path: string, data: string): SnapshotFile {
    mkdirSync(folder, { recursive: true });
    const bytes = Buffer.from(data, "utf8");
    const partial = `${path}.${randomUUID()}.part`;
    writeFileSync(partial, bytes);
    renameSync(partial, path);
    return { path, contentHash: hashBytes(bytes), size: bytes.byteLength, mtimeMs: Date.now() };
  }

  function persist(state: State): void {
    const saved: Saved = {
      documentId: state.documentId,
      doneMs: state.doneMs,
      pending: state.pending,
      savedPath: state.savedPath,
      ...(state.state === "empty" && { empty: true }),
      ...(state.voices && { voices: state.voices }),
      ...(state.speakers && { speakers: state.speakers }),
      ...(state.callHeard && { callHeard: true }),
    };
    try {
      writeWhole(jsonPath(state.meetingId), JSON.stringify(saved));
    } catch (error) {
      log.error("transcript.saveFailed", { meetingId: state.meetingId, message: messageOf(error) });
    }
  }

  const transcriptOf = (state: State) => writeVtt({ cues: state.cues, gaps: state.gaps });

  /** Writes the lines to the data folder's file, makes the Document on the first, and indexes it again now and then. */
  function writeLines(state: State, { now = false } = {}): void {
    if (state.cues.length === 0 || state.savedPath) return;
    let file: SnapshotFile;
    try {
      file = writeWhole(vttPath(state.meetingId), transcriptOf(state));
    } catch (error) {
      log.error("transcript.writeFailed", {
        meetingId: state.meetingId,
        message: messageOf(error),
      });
      return;
    }
    state.written = true;
    persist(state);
    if (!state.documentId) {
      const id = randomUUID();
      try {
        documents.add(id, options.name(state.meetingId), file);
        const folderId = options.folderOf(state.meetingId);
        if (folderId) documents.file(id, folderId);
        state.documentId = id;
        state.lastIndexed = Date.now();
        persist(state);
      } catch (error) {
        log.error("transcript.documentFailed", {
          meetingId: state.meetingId,
          message: messageOf(error),
        });
      }
      return;
    }
    if (!documents.find(state.documentId)) return;
    const wait = state.lastIndexed + indexEvery(state.cues.length) - Date.now();
    if (now || wait <= 0) {
      if (state.indexTimer) clearTimeout(state.indexTimer);
      state.indexTimer = null;
      index(state);
    } else {
      state.indexTimer ??= setTimeout(() => {
        state.indexTimer = null;
        index(state);
      }, wait);
    }
  }

  function index(state: State): void {
    if (closed || state.savedPath) return;
    state.lastIndexed = Date.now();
    documents.check(vttPath(state.meetingId)).catch((error: unknown) => {
      log.error("transcript.indexFailed", {
        meetingId: state.meetingId,
        message: messageOf(error),
      });
    });
  }

  // ---- What the engine says ----

  function owner(stream: string): {
    state: State;
    baseMs: number;
    live: boolean;
    source: AudioSource;
    speaker: string | null;
    callSound: boolean;
    reading?: Reading;
  } | null {
    for (const state of states.values()) {
      const live = state.live;
      for (const source of SOURCES) {
        const own = live?.streams[source];
        if (live && own && stream === own.stream) {
          return {
            state,
            baseMs: own.baseMs,
            live: true,
            source,
            speaker: speakerOf(source, state.callHeard === true, state.memo),
            callSound: state.callHeard === true,
          };
        }
      }
      const reading = state.catchUps.get(stream);
      if (reading) {
        return {
          state,
          live: false,
          baseMs: reading.baseMs,
          source: reading.source,
          speaker: reading.speaker(),
          // Its microphone is "Me" exactly when the computer's sound was recorded with it.
          callSound: reading.source === "system" || reading.speaker() === SPEAKER_ME,
          reading,
        };
      }
    }
    return null;
  }

  /**
   * The computer's sound has had sound in it: the microphone's lines are the User's, those said
   * before the others first made a sound too (#2305).
   */
  function heardCall(state: State): void {
    if (state.callHeard || state.memo) return;
    state.callHeard = true;
    for (const cue of state.cues) if (cue.speaker === SPEAKER_UNKNOWN) cue.speaker = SPEAKER_ME;
    for (const heard of state.partials.values()) {
      if (heard.speaker === SPEAKER_UNKNOWN) heard.speaker = SPEAKER_ME;
    }
    persist(state);
    writeLines(state);
    options.changed();
  }

  // The words of DESIGN.md › Speakers, as the speaker pass (./speakerPass) writes them after
  // the call. In a call the microphone is the User's: its lines stay "Me", so echo removal still
  // applies. The other side is "Them" while one voice speaks; once a second does, the first's
  // lines become "Speaker 1". A room's voices are "Speaker 1, 2…". Labels are per stream: a new
  // session's "1" is a new person.
  function voiceOf(
    state: State,
    stream: string,
    source: AudioSource,
    callSound: boolean,
    label: string,
  ): string {
    if (source === "microphone" && callSound) return SPEAKER_ME;
    const voices = state.voices ?? {};
    state.voices = voices;
    const key = `${stream}:${label}`;
    const side = `:${source}:`;
    const before = Object.keys(voices).filter((each) => each.includes(side)).length;
    const number = voices[key] ?? before + 1;
    voices[key] = number;
    if (source !== "system") return numberedVoice(number);
    if (number === 1 && before <= 1) return SPEAKER_THEM;
    for (const cue of state.firstVoice) cue.speaker = numberedVoice(1);
    state.firstVoice.clear();
    return numberedVoice(number);
  }

  function addCue(state: State, cue: Cue): void {
    if (isEcho(cue, state.cues)) return;
    // Lines caught up from disk fill in before later ones: keep them in time order.
    let at = state.cues.length;
    while (at > 0 && (state.cues[at - 1] as Cue).startMs > cue.startMs) at--;
    state.cues.splice(at, 0, cue);
    // Theirs may come after the echo of it.
    for (const echo of echoedBy(cue, state.cues)) state.cues.splice(state.cues.indexOf(echo), 1);
  }

  // A stretch caught up after Stop can overlap what a cloud service or an engine before a restart
  // already gave text for, up to where it stopped: the same side's same words at the same time
  // are kept once. The other side's are left to echo removal.
  function alreadySaid(state: State, cue: Cue): boolean {
    const length = Math.max(1, cue.endMs - cue.startMs);
    return state.cues.some((each) => {
      const shared = Math.min(each.endMs, cue.endMs) - Math.max(each.startMs, cue.startMs);
      return (
        (each.speaker === SPEAKER_ME) === (cue.speaker === SPEAKER_ME) &&
        shared > length / 2 &&
        repeats(cue.text, [each.text])
      );
    });
  }

  function shownPartial(state: State): MeetingTranscript["partial"] {
    const all = [...state.partials.values()];
    const theirs = all.filter((each) => isTheirs(each.speaker)).map((each) => each.text);
    const newest = all
      .filter((each) => each.speaker !== SPEAKER_ME || !repeats(each.text, theirs))
      .sort((a, b) => b.startMs - a.startMs)[0];
    return newest ? { startMs: newest.startMs, text: newest.text, speaker: newest.speaker } : null;
  }

  function heardSegment(segment: SpeechSegment): void {
    if (closed) return;
    const found = owner(segment.stream);
    if (!found) return;
    const { state, baseMs, live } = found;
    const speaker =
      segment.speaker && found.speaker !== null
        ? voiceOf(state, segment.stream, found.source, found.callSound, segment.speaker)
        : found.speaker;
    const startMs = baseMs + segment.startMs;
    if (!segment.final) {
      if (!live || state.state !== "live") return;
      state.partials.set(segment.stream, { startMs, text: segment.text, id: segment.id, speaker });
      state.partialTimer ??= setTimeout(() => {
        state.partialTimer = null;
        options.changed();
      }, PARTIAL_EVERY_MS);
      return;
    }
    if (live && state.partials.get(segment.stream)?.id === segment.id) {
      state.partials.delete(segment.stream);
    }
    const cue = { startMs, endMs: baseMs + segment.endMs, text: segment.text, speaker };
    if (segment.text && (live || !alreadySaid(state, cue))) {
      addCue(state, cue);
      if (segment.speaker && speaker === SPEAKER_THEM) state.firstVoice.add(cue);
    }
    if (segment.failed) {
      health.add(state.meetingId, {
        kind: "notTranscribed",
        atMs: startMs,
        durationMs: segment.endMs - segment.startMs,
      });
    } else if (live && state.live?.engine === "local") {
      probe(state, segment);
    }
    writeLines(state);
    options.changed();
  }

  /** The speed probe: how long decoding takes for the audio it decodes, kept for the next Meeting's choice of model. */
  function probe(state: State, segment: SpeechSegment): void {
    options.decoded?.(
      model.definition.id,
      segment.decodeMs,
      (segment.endMs - segment.startMs) / 1000,
    );
    state.probe.audioMs += segment.endMs - segment.startMs;
    state.probe.decodeMs += segment.decodeMs;
    health.decoded(state.meetingId, segment.endMs - segment.startMs, segment.decodeMs);
    if (state.probe.recorded || state.probe.audioMs < PROBE_MS) return;
    state.probe.recorded = true;
    const ratio = state.probe.decodeMs / state.probe.audioMs;
    options.recordSpeed(model.definition.id, ratio);
    log.info("transcript.speed", {
      meetingId: state.meetingId,
      model: model.definition.id,
      ratio: Math.round(ratio * 100) / 100,
    });
  }

  function heardProgress(stream: string, doneMs: number): void {
    const found = owner(stream);
    if (!found?.live || !found.state.live) return;
    const { state } = found;
    const live = found.state.live;
    const own = live.streams[found.source];
    if (!own) return;
    own.doneMs = Math.max(own.doneMs, found.baseMs + doneMs);
    live.doneMs = Math.max(
      live.doneMs,
      Math.min(...Object.values(live.streams).map((each) => each.doneMs)),
    );
    if (live.pendingFrom === null) state.doneMs = live.doneMs;
  }

  /** The engine's process stopped: started again, the stretch it lost marked, unless it keeps stopping. */
  function engineStopped(reason: string): void {
    if (closed) return;
    log.warn("transcript.engineStopped", { reason });
    for (const state of states.values()) {
      const live = state.live;
      if (!live?.started) continue;
      const lost = { fromMs: live.doneMs, toMs: Math.max(live.doneMs, live.pushedMs) };
      if (live.pendingFrom === null && lost.toMs > lost.fromMs) {
        state.gaps.push({ ...lost, reason: "restarted" });
        state.pending = addRange(state.pending, lost);
      }
      state.partials.clear();
      const now = Date.now();
      state.restarts = [...state.restarts.filter((at) => now - at < RESTARTS_WITHIN_MS), now];
      live.started = false;
      live.stream = `${state.meetingId}:${++streams}`;
      live.streams = {};
      live.doneMs = live.pushedMs;
      if (state.restarts.length > MAX_RESTARTS) {
        live.pendingFrom ??= live.pushedMs;
        state.state = "behind";
        state.problem = { kind: "engine", message: reason };
        health.add(state.meetingId, { kind: "behind", atMs: lost.fromMs });
      } else {
        startEngine(state);
        health.add(state.meetingId, {
          kind: "restarted",
          atMs: lost.fromMs,
          gapMs: lost.toMs - lost.fromMs,
        });
      }
      writeLines(state, { now: true });
      persist(state);
    }
    options.changed();
  }

  /** The transcriber moved a stream to another engine (#141, #462): the Meeting's health says when, and why. */
  function heardSwitch(change: EngineSwitch): void {
    const found = owner(change.stream);
    if (!found) return;
    const { state } = found;
    const atMs = found.live && state.live ? state.live.pushedMs : found.baseMs;
    const { from, to, reason } = change;
    const last = state.lastSwitch;
    if (
      last?.from === from &&
      last.to === to &&
      last.reason === reason &&
      Math.abs(atMs - last.atMs) < SWITCH_TOGETHER_MS
    ) {
      return;
    }
    state.lastSwitch = { from, to, reason, atMs };
    health.add(state.meetingId, { kind: "switched", atMs, from, to, reason });
  }

  function heardLost(stream: string, loss: CloudLoss): void {
    if (closed) return;
    const found = owner(stream);
    if (!found) return;
    log.warn("transcript.cloudLost", { meetingId: found.state.meetingId, loss });
    if (found.reading) {
      found.reading.lost = true;
      return;
    }
    const live = found.state.live;
    if (live) leaveCloud(found.state, live, loss);
  }

  // Dropped, refused or the gate closed: the cloud's streams are dropped, nothing they queued is
  // sent, and the stretch this computer didn't hear is transcribed after Stop. At the cap, the
  // streams finish with what they were already sent.
  function leaveCloud(state: State, live: Live, reason: Leaving): void {
    if (live.engine === "local") return;
    const route = live.engine;
    const atMs = live.pushedMs;
    if (reason === "cap") {
      if (live.started) finishStreams(state, live, atMs);
    } else {
      dropStreams(live);
      const lost = { fromMs: live.doneMs, toMs: Math.max(live.doneMs, live.pushedMs) };
      if (live.started && live.pendingFrom === null && lost.toMs > lost.fromMs) {
        if (reason === "dropped" || reason === "refused") {
          state.gaps.push({ ...lost, reason: "cloud" });
        }
        state.pending = addRange(state.pending, lost);
      }
    }
    if (reason === "refused") options.cloud?.refuse(route);
    live.engine = "local";
    live.cloud = null;
    live.started = false;
    live.stream = `${state.meetingId}:${++streams}`;
    live.streams = {};
    live.doneMs = live.pushedMs;
    live.backlogEnd = live.pushedMs;
    state.partials.clear();
    if (reason !== "user") state.fellBack = { route, atMs, reason };
    health.add(state.meetingId, {
      kind: "switched",
      atMs,
      from: "cloud",
      to: "local",
      reason:
        reason === "dropped" || reason === "refused" ? "failed" : reason === "cap" ? "cap" : "user",
    });
    startEngine(state);
    writeLines(state, { now: true });
    persist(state);
    options.changed();
  }

  function gateClosed(live: Live): Leaving | null {
    if (live.engine === "local") return null;
    const now = options.cloud?.sending(live.engine) ?? "stopped";
    return now === "ok" ? null : now === "local-mode" ? "local-mode" : "user";
  }

  function heardOpened(stream: string): void {
    if (closed) return;
    const found = owner(stream);
    const live = found?.state.live;
    const own = found?.live && live ? live.streams[found.source] : undefined;
    if (!found || !live || !own?.waiting) return;
    const leaving = gateClosed(live);
    if (leaving) {
      leaveCloud(found.state, live, leaving);
      return;
    }
    if (!counted(live, msOf(own.waiting))) {
      leaveCloud(found.state, live, "cap");
      return;
    }
    const waiting = own.waiting;
    delete own.waiting;
    for (const samples of waiting) transcriber.push(stream, samples);
  }

  transcriber.listen({
    segment: heardSegment,
    progress: heardProgress,
    // Not the engine's message: one from a cloud service could quote what it was sent.
    failed: (stream) => log.warn("transcript.decodeFailed", { stream }),
    stopped: engineStopped,
    switched: heardSwitch,
    lost: heardLost,
    opened: heardOpened,
  });

  // ---- Live ----

  /** Starts the engine for the live stream, once the model is downloaded; the audio waits meanwhile. */
  function startEngine(state: State): void {
    const live = state.live;
    if (!live || live.started || live.choosing || live.pendingFrom !== null) return;
    if (live.engine !== "local") {
      startCloud(state, live);
      return;
    }
    if (model.status().state !== "ready") {
      state.state = "preparing";
      model.ensure();
      return;
    }
    if (state.state !== "behind") state.state = "preparing";
    void model.load().then((loaded) => {
      if (closed || state.live !== live) return;
      if (!loaded) {
        live.pendingFrom ??= live.held[0]?.atMs ?? live.pushedMs;
        live.held = [];
        state.state = "behind";
        const message = model.status().error?.message ?? "";
        log.warn("transcript.engineFailed", { meetingId: state.meetingId, message });
        state.problem = { kind: "engine", message };
        options.changed();
        return;
      }
      live.started = true;
      state.state = "live";
      state.problem = null;
      const held = live.held;
      live.held = [];
      for (const audio of held) pushTracks(state, live, audio);
      live.backlogEnd = live.pushedMs;
      options.changed();
    });
  }

  function startCloud(state: State, live: Live): void {
    live.started = true;
    state.state = "live";
    state.problem = null;
    const held = live.held;
    live.held = [];
    for (const audio of held) {
      if (!live.started) {
        live.held.push(audio);
        continue;
      }
      pushTracks(state, live, audio);
    }
    live.backlogEnd = live.pushedMs;
    options.changed();
  }

  // Counted as it is sent, not while held for a connection that may never open.
  function counted(live: Live, ms: number): boolean {
    const cloud = live.cloud;
    if (!cloud) return true;
    while (cloud.aheadMs < ms) {
      if (!cloud.meter.add(COUNTED_AHEAD_MS)) return false;
      cloud.aheadMs += COUNTED_AHEAD_MS;
    }
    cloud.aheadMs -= ms;
    return true;
  }

  function pushTracks(state: State, live: Live, audio: TrackedAudio): void {
    if (live.engine !== "local") {
      const sent = SOURCES.flatMap((source) => {
        const samples = audio[source];
        return samples && live.streams[source] && !live.streams[source].waiting ? [samples] : [];
      });
      const leaving = gateClosed(live) ?? (counted(live, msOf(sent)) ? null : "cap");
      if (leaving) {
        leaveCloud(state, live, leaving);
        if (live.started) pushTracks(state, live, audio);
        else live.held.push(audio);
        return;
      }
    }
    for (const source of SOURCES) {
      const samples = audio[source];
      if (!samples) {
        if (source === "microphone") endMicrophone(state, live, audio.atMs);
        continue;
      }
      let own = live.streams[source];
      if (!own) {
        own = {
          stream: streamName(
            live.stream,
            source,
            source === "microphone" ? live.microphoneStreams++ : 0,
          ),
          baseMs: audio.atMs,
          doneMs: audio.atMs,
          ...(live.cloud && { waiting: [] }),
        };
        live.streams[source] = own;
        if (live.cloud) transcriber.open(own.stream, live.cloud.stream);
      }
      if (own.waiting) own.waiting.push(samples);
      else transcriber.push(own.stream, samples);
    }
    live.pushedMs = audio.atMs + audio.lengthMs;
  }

  function endMicrophone(state: State, live: Live, atMs: number): void {
    const own = live.streams.microphone;
    if (!own) return;
    delete live.streams.microphone;
    if (own.waiting) {
      // A cloud stream that never opened has sent nothing: this computer transcribes its stretch.
      transcriber.drop(own.stream);
      state.pending = addRange(state.pending, { fromMs: own.baseMs, toMs: atMs });
      return;
    }
    const reading: Reading = {
      baseMs: own.baseMs,
      source: "microphone",
      speaker: () => speakerOf("microphone", state.callHeard === true, state.memo),
    };
    state.catchUps.set(own.stream, reading);
    let drop = () => {};
    const dropped = new Promise<void>((resolve) => {
      drop = resolve;
    });
    const done: Promise<void> = Promise.race([transcriber.finish(own.stream), dropped])
      .then(
        () => {
          if (reading.lost)
            state.pending = addRange(state.pending, { fromMs: own.baseMs, toMs: atMs });
        },
        (error: unknown) => {
          log.warn("transcript.endFailed", {
            meetingId: state.meetingId,
            message: messageOf(error),
          });
          state.pending = addRange(state.pending, { fromMs: own.baseMs, toMs: atMs });
        },
      )
      .finally(() => {
        state.catchUps.delete(own.stream);
        live.finishing = live.finishing.filter((each) => each.done !== done);
        if (closed) return;
        writeLines(state);
        options.changed();
      });
    live.finishing.push({ stream: own.stream, reading, done, drop });
  }

  function dropStreams(live: Live): void {
    for (const own of Object.values(live.streams)) transcriber.drop(own.stream);
    for (const each of live.finishing) {
      transcriber.drop(each.stream);
      // Its stretch is transcribed from the audio after Stop, as any stream lost is.
      each.reading.lost = true;
      each.drop();
    }
  }

  function send(state: State, live: Live, audio: TrackedAudio): void {
    if (!live.started || live.pendingFrom !== null) return;
    pushTracks(state, live, audio);
    if (!live.started) return;
    if (live.pushedMs - Math.max(live.doneMs, live.backlogEnd) > BEHIND_MS) fallBehind(state, live);
  }

  /** Live text stops; the rest is transcribed after Stop. */
  function fallBehind(state: State, live: Live): void {
    dropStreams(live);
    live.stream = `${state.meetingId}:${++streams}`;
    live.streams = {};
    live.started = false;
    live.pendingFrom = live.doneMs;
    state.state = "behind";
    state.partials.clear();
    health.add(state.meetingId, { kind: "behind", atMs: live.doneMs });
    persist(state);
    options.changed();
  }

  function choose(state: State, live: Live, cloud: NonNullable<TranscriptsOptions["cloud"]>): void {
    cloud.start().then(
      (start) => {
        if (closed || state.live !== live) return;
        live.choosing = false;
        if (start && "refused" in start) {
          const reason = start.refused === "key" ? "refused" : start.refused;
          state.fellBack = { route: start.route, atMs: live.pushedMs, reason };
          health.add(state.meetingId, {
            kind: "switched",
            atMs: live.pushedMs,
            from: "cloud",
            to: "local",
            reason: reason === "refused" ? "failed" : reason === "cap" ? "cap" : "user",
          });
        } else if (start) {
          live.engine = start.route;
          live.cloud = { stream: start.stream, meter: start.meter, aheadMs: 0 };
          log.info("transcript.cloud", { meetingId: state.meetingId, route: start.route });
        }
        startEngine(state);
        options.changed();
      },
      (error: unknown) => {
        if (closed || state.live !== live) return;
        live.choosing = false;
        log.warn("transcript.cloudUnavailable", {
          meetingId: state.meetingId,
          message: messageOf(error),
        });
        startEngine(state);
        options.changed();
      },
    );
  }

  function feed(state: State, audio: TrackedAudio | null): void {
    const live = state.live;
    if (!audio || !live || live.pendingFrom !== null) return;
    if (live.started) {
      send(state, live, audio);
      return;
    }
    live.held.push(audio);
    // Audio that waited too long is transcribed after Stop: live text starts from what is left.
    const newest = audio.atMs + audio.lengthMs;
    while ((live.held[0]?.atMs ?? newest) < newest - HELD_MS) {
      const old = live.held.shift() as TrackedAudio;
      const end = old.atMs + old.lengthMs;
      state.pending = addRange(state.pending, { fromMs: old.atMs, toMs: end });
      live.doneMs = end;
      live.pushedMs = end;
    }
  }

  model.onReady(() => {
    for (const state of states.values()) {
      if (state.live && !state.live.started) startEngine(state);
      if (state.state === "finishing" && !state.finishing) state.finishing = finish(state);
    }
    options.changed();
  });

  // ---- Finishing ----

  /** Transcribes a stretch from the audio on disk, each source on its own; the part with no audio left is a gap. */
  async function catchUp(state: State, range: Range): Promise<void> {
    const parts = options
      .partsOf(state.meetingId)
      .filter(
        (part) => part.offsetMs < range.toMs && part.offsetMs + part.durationMs > range.fromMs,
      );
    let covered: Range[] = [];
    for (const part of parts) {
      covered = addRange(covered, { fromMs: part.offsetMs, toMs: part.offsetMs + part.durationMs });
    }
    const pauses = state.gaps.filter((gap) => gap.reason === "muted");
    for (const pause of pauses) covered = addRange(covered, pause);
    const reason = options.audioDeleted(state.meetingId) ? "lost" : "uncaptured";
    let at = range.fromMs;
    for (const each of [...covered, { fromMs: range.toMs, toMs: range.toMs }]) {
      const toMs = Math.min(each.fromMs, range.toMs);
      if (toMs - at >= MIN_GAP_MS) state.gaps.push({ fromMs: at, toMs, reason });
      at = Math.max(at, each.toMs);
    }
    if (parts.length === 0) return;
    const prefix = `${state.meetingId}:catch-up:${++streams}`;
    const opened: string[] = [];
    let microphoneStreams = 0;
    let microphoneOpen = false;
    try {
      const tracks = createTracks(range.fromMs);
      const end = Math.min(
        range.toMs,
        Math.max(...parts.map((part) => part.offsetMs + part.durationMs)),
      );
      // No chunk crosses the edge of a stretch the microphone was paused: it sends nothing for one.
      const edges = pauses.flatMap((pause) => [pause.fromMs, pause.toMs]);
      for (let from = range.fromMs, to = from; from < end; from = to) {
        to = Math.min(end, from + CATCH_UP_CHUNK_MS, ...edges.filter((edge) => edge > from));
        const paused = pauses.some((pause) => pause.fromMs <= from && pause.toMs >= to);
        for (const part of parts) {
          const partEnd = part.offsetMs + part.durationMs;
          if (part.offsetMs >= to || partEnd <= from) continue;
          const samples = await samplesOf(part);
          const first = Math.max(0, Math.round((from - part.offsetMs) * SAMPLE_RATE_MS));
          const last = Math.min(samples.length, Math.round((to - part.offsetMs) * SAMPLE_RATE_MS));
          if (last > first) {
            tracks.put(
              part.source,
              samples.subarray(first, last),
              part.offsetMs + first / SAMPLE_RATE_MS,
            );
          }
        }
        const audio = tracks.flush();
        if (audio?.system?.some((sample) => sample !== 0)) heardCall(state);
        for (const source of SOURCES) {
          const track = audio?.[source];
          if (!audio || !track) continue;
          if (source === "microphone" && paused) {
            if (microphoneOpen) microphoneStreams++;
            microphoneOpen = false;
            continue;
          }
          if (source === "microphone") microphoneOpen = true;
          const stream = streamName(
            prefix,
            source,
            source === "microphone" ? microphoneStreams : 0,
          );
          if (!state.catchUps.has(stream)) {
            state.catchUps.set(stream, {
              baseMs: audio.atMs,
              source,
              speaker: () => speakerOf(source, state.callHeard === true, state.memo),
            });
            opened.push(stream);
          }
          transcriber.push(stream, track);
        }
      }
      await Promise.all(opened.map((stream) => transcriber.finish(stream))).catch(
        (error: unknown) => {
          throw new EngineError(messageOf(error));
        },
      );
    } finally {
      for (const stream of opened) state.catchUps.delete(stream);
    }
  }

  /** Whether a gap's stretch has been transcribed since: its lines fill it. */
  const filled = (gap: TranscriptGap, done: readonly Range[]) =>
    (gap.reason === "restarted" || gap.reason === "cloud") &&
    done.some((range) => range.fromMs <= gap.fromMs && range.toMs >= gap.toMs);

  /**
   * After Stop: the live stream's last lines, then what was left to
   * transcribe, then the WebVTT file saved to the Output location, where the
   * Document follows it.
   */
  async function finish(state: State): Promise<void> {
    try {
      if (state.pending.length > 0) {
        if (model.status().state !== "ready") {
          model.ensure();
          state.finishing = null;
          options.changed();
          return; // goes on when the model is ready (`onReady`)
        }
        if (!(await model.load())) throw new EngineError(model.status().error?.message ?? "");
        const done: Range[] = [];
        for (const range of [...state.pending]) {
          await catchUp(state, range);
          done.push(range);
          state.pending = state.pending.filter((each) => each !== range);
          state.gaps = state.gaps.filter((gap) => !filled(gap, done));
          writeLines(state);
          persist(state);
          options.changed();
        }
      }
      await save(state);
    } catch (error) {
      state.state = "failed";
      state.problem = {
        kind: error instanceof EngineError ? "engine" : "save",
        message: messageOf(error),
      };
      log.warn("transcript.finishFailed", {
        meetingId: state.meetingId,
        message: messageOf(error),
      });
    } finally {
      state.finishing = null;
      if (!closed) {
        persist(state);
        options.changed();
      }
    }
    if (state.speakers === "due") separate(state);
  }

  async function save(state: State): Promise<void> {
    if (state.cues.length === 0) {
      state.state = "empty";
      options.saved?.(state.meetingId);
      return;
    }
    const file = writeWhole(vttPath(state.meetingId), transcriptOf(state));
    state.savedPath = file.path;
    state.state = "saved";
    state.problem = null;
    log.info("transcript.saved", { meetingId: state.meetingId, lines: state.cues.length });
    if (options.speakers && !state.memo) state.speakers = "due";
    await documents.checkNow(state.documentId, file.path);
    if (state.speakers !== "due") options.saved?.(state.meetingId);
  }

  // Voices a cloud service told apart as they spoke stand: the pass leaves that side.
  const toldApart = (state: State) => {
    const side = `:${sourceToSeparate(isCall(state.cues))}:`;
    return Object.keys(state.voices ?? {}).some((key) => key.includes(side));
  };

  // A quit during the pass leaves it due, for the next start. Whatever else ends it, the notes
  // go ahead with the labels the Transcript has, so a failed pass never holds them up.
  function separate(state: State): void {
    const pass = options.speakers;
    if (!pass || state.separating || closed) return;
    if (!state.savedPath || options.audioDeleted(state.meetingId) || toldApart(state)) {
      settle(state, "done");
      return;
    }
    state.separating = true;
    options.changed();
    const saved = transcriptOf(state);
    const current = () => !closed && states.get(state.meetingId) === state;
    pass
      .run(state.meetingId, [...state.cues])
      .then(
        (cues) => {
          if (current() && cues?.some((cue, at) => cue.speaker !== state.cues[at]?.speaker)) {
            relabel(state, cues, saved);
          }
          return "done" as const;
        },
        (error: unknown) => {
          log.error("speakers.failed", { meetingId: state.meetingId, message: messageOf(error) });
          return "failed" as const;
        },
      )
      .then((outcome) => {
        state.separating = false;
        if (current()) settle(state, outcome);
      })
      .catch((error: unknown) => {
        log.error("speakers.settleFailed", {
          meetingId: state.meetingId,
          message: messageOf(error),
        });
      });
  }

  function settle(state: State, outcome: "done" | "failed"): void {
    state.speakers = outcome;
    persist(state);
    options.changed();
    options.saved?.(state.meetingId);
  }

  function modelProblem(state: State, status: TranscriptionModelStatus): TranscriptProblem | null {
    if (status.state !== "failed") return null;
    if (state.state !== "preparing" && state.state !== "finishing") return null;
    return {
      kind: status.error?.kind === "load" ? "engine" : "download",
      message: status.error?.message ?? "",
    };
  }

  const speakersProblem = (state: State): TranscriptProblem | null =>
    state.speakers === "failed" ? { kind: "speakers", message: "" } : null;

  function relabel(state: State, cues: Cue[], saved: string): void {
    const path = state.savedPath;
    if (!path) return;
    try {
      // Written over only while it still holds the lines that were saved.
      if (readFileSync(path, "utf8") !== saved) {
        log.warn("speakers.fileChanged", { meetingId: state.meetingId });
        return;
      }
      state.cues = cues;
      writeWhole(path, transcriptOf(state));
    } catch (error) {
      log.error("speakers.writeFailed", { meetingId: state.meetingId, message: messageOf(error) });
      return;
    }
    documents.check(path).catch((error: unknown) => {
      log.error("transcript.indexFailed", {
        meetingId: state.meetingId,
        message: messageOf(error),
      });
    });
  }

  function finishStreams(state: State, live: Live, endMs: number): void {
    const fromMs = live.doneMs;
    // A cloud stream that never opened has sent nothing: this computer transcribes its stretch.
    let unopened = false;
    for (const source of SOURCES) {
      const own = live.streams[source];
      if (!own?.waiting) continue;
      transcriber.drop(own.stream);
      delete live.streams[source];
      unopened = true;
    }
    if (unopened) state.pending = addRange(state.pending, { fromMs, toMs: endMs });
    const ending = SOURCES.flatMap((source) => {
      const own = live.streams[source];
      return own
        ? [
            {
              stream: own.stream,
              reading: {
                baseMs: own.baseMs,
                source,
                speaker: () => speakerOf(source, state.callHeard === true, state.memo),
              } as Reading,
            },
          ]
        : [];
    });
    for (const { stream, reading } of ending) state.catchUps.set(stream, reading);
    const before = state.ending;
    const done: Promise<void> = Promise.all([
      before,
      ...ending.map(({ stream }) => transcriber.finish(stream)),
      ...live.finishing.map((each) => each.done),
    ])
      .then(
        () => {
          if (ending.some(({ reading }) => reading.lost)) {
            state.pending = addRange(state.pending, { fromMs, toMs: endMs });
          } else state.doneMs = Math.max(state.doneMs, endMs);
        },
        (error: unknown) => {
          log.warn("transcript.endFailed", {
            meetingId: state.meetingId,
            message: messageOf(error),
          });
          state.pending = addRange(state.pending, { fromMs, toMs: endMs });
        },
      )
      .finally(() => {
        for (const { stream } of ending) state.catchUps.delete(stream);
        if (state.ending === done) state.ending = null;
        if (closed) return;
        writeLines(state, { now: true });
        persist(state);
      });
    state.ending = done;
  }

  function endLive(state: State, endMs: number): void {
    const live = state.live;
    if (!live) return;
    feed(state, live.tracks.flush());
    const leaving = gateClosed(live);
    if (leaving) leaveCloud(state, live, leaving);
    state.live = null;
    state.partials.clear();
    if (live.started && live.pendingFrom === null) {
      finishStreams(state, live, endMs);
    } else {
      state.pending = addRange(state.pending, {
        fromMs: live.pendingFrom ?? live.doneMs,
        toMs: endMs,
      });
    }
    persist(state);
    options.changed();
  }

  return {
    /**
     * Indexes a recording Meeting's Transcript again now, for a Question asked during the call
     * (#144): what was said up to now can be found and cited. Resolves once its file is checked
     * (a changed one is then processed). Nothing for a Meeting with no lines or one saved.
     */
    async refresh(meetingId: string): Promise<void> {
      const state = states.get(meetingId);
      if (closed || !state?.documentId || state.savedPath || state.cues.length === 0) return;
      if (state.indexTimer) clearTimeout(state.indexTimer);
      state.indexTimer = null;
      state.lastIndexed = Date.now();
      await documents.check(vttPath(meetingId));
    },

    /**
     * The newest line said, by `speaker` when given (a live line's "Me" or "Them", which is
     * anyone told apart too), for the heading over help during the call; null before there is one.
     */
    newestLine(
      meetingId: string,
      speaker?: string,
    ): { text: string; speaker: string | null } | null {
      const cues = states.get(meetingId)?.cues ?? [];
      const said = (each: Cue) =>
        speaker === undefined ||
        each.speaker === speaker ||
        (speaker === SPEAKER_THEM && isTheirs(each.speaker));
      const cue = cues.findLast(said);
      return cue ? { text: cue.text, speaker: cue.speaker } : null;
    },

    /** Removes the files of Transcripts deleted permanently: the App's own, never a .vtt the User added. */
    dropPurged(): void {
      for (const path of options.purgedPaths?.() ?? []) {
        try {
          rmSync(path, { force: true });
          rmSync(path.replace(/\.vtt$/, ".json"), { force: true });
        } catch (error) {
          // Left for the next start: a failed cleanup must not stop the core from opening.
          log.warn("transcript.purgeFailed", { path, message: messageOf(error) });
        }
      }
    },

    /** The Meeting's Transcript, as the window shows it. `audioKept`: its audio is still on this computer. */
    of(meetingId: string, audioKept: boolean): MeetingTranscript {
      const state = load(meetingId);
      const status = model.status();
      return {
        documentId: state.documentId,
        state: state.state,
        lines: state.cues.length,
        partial: shownPartial(state),
        model:
          (state.state === "preparing" ||
            state.state === "finishing" ||
            state.problem?.kind === "download") &&
          status.state !== "ready"
            ? status
            : null,
        cloud:
          state.live && state.live.engine !== "local" && state.live.started
            ? state.live.engine
            : null,
        fellBack: state.fellBack,
        savedPath: state.savedPath,
        separating: state.speakers === "due",
        problem:
          state.problem ??
          modelProblem(state, status) ??
          (audioKept ? speakersProblem(state) : null),
      };
    },

    /**
     * Where meeting audio may go changed (Local mode, consent, the chosen route, a key): every
     * live cloud stream whose gate is now closed is dropped at once, not at its next chunk.
     */
    recheckCloud(): void {
      for (const state of states.values()) {
        const live = state.live;
        const leaving = live && gateClosed(live);
        if (live && leaving) leaveCloud(state, live, leaving);
      }
    },

    /**
     * Audio starts being captured, at `offsetMs` in the Meeting's time. `callSound` says,
     * whenever asked, whether the computer's sound is being recorded.
     */
    begin(meetingId: string, offsetMs: number, callSound: () => boolean): void {
      const state = load(meetingId);
      if (state.savedPath) return;
      const live: Live = {
        stream: `${meetingId}:${++streams}`,
        engine: "local",
        cloud: null,
        choosing: options.cloud !== undefined,
        tracks: createTracks(offsetMs),
        streams: {},
        microphoneStreams: 0,
        finishing: [],
        started: false,
        held: [],
        pushedMs: offsetMs,
        doneMs: offsetMs,
        pendingFrom: null,
        backlogEnd: offsetMs,
        callSound,
      };
      state.live = live;
      state.fellBack = null;
      state.problem = state.problem?.kind === "engine" ? state.problem : null;
      state.state = "preparing";
      options.speakers?.prepare();
      if (options.cloud) choose(state, live, options.cloud);
      else startEngine(state);
      options.changed();
    },

    /** Samples from a source, starting at `atMs` in the Meeting's time. */
    hear(meetingId: string, source: AudioSource, samples: Int16Array, atMs: number): void {
      const state = states.get(meetingId);
      if (!state?.live) return;
      feed(state, state.live.tracks.add(source, samples, atMs));
      if (state.live?.callSound()) heardCall(state);
    },

    /**
     * The User paused their microphone at `atMs` in the Meeting's time: what it heard up to there
     * is let out and its stream finished, so its lines are final. Nothing is sent for it, not even
     * silence, until `microphoneResumed`.
     */
    microphonePaused(meetingId: string, atMs: number): void {
      const state = states.get(meetingId);
      const live = state?.live;
      if (!state || !live) return;
      feed(state, live.tracks.pauseMicrophone(atMs));
      feed(state, { atMs: live.tracks.atMs, lengthMs: 0, microphone: null, system: null });
    },

    /** The User's microphone is on again from `atMs` in the Meeting's time: its next audio starts a stream. */
    microphoneResumed(meetingId: string, atMs: number): void {
      const state = states.get(meetingId);
      if (state?.live) feed(state, state.live.tracks.resumeMicrophone(atMs));
    },

    markMicrophonePause(meetingId: string, fromMs: number, toMs: number): void {
      if (toMs <= fromMs) return;
      const state = load(meetingId);
      if (state.savedPath) return;
      state.gaps.push({ fromMs, toMs, reason: "muted" });
      writeLines(state, { now: true });
      options.changed();
    },

    /** Audio stopped being captured, at `endMs` in the Meeting's time: paused, asleep or stopped. */
    end(meetingId: string, endMs: number): void {
      const state = states.get(meetingId);
      if (state) endLive(state, endMs);
    },

    /** The Meeting stopped: what is left is transcribed, and the file saved. */
    stop(meetingId: string): void {
      const state = load(meetingId);
      if (state.savedPath || state.finishing) return;
      if (state.cues.length === 0 && state.pending.length === 0 && !state.ending) {
        state.state = "empty";
        persist(state);
        options.changed();
        return;
      }
      state.state = "finishing";
      state.finishing = (state.ending ?? Promise.resolve()).then(() => finish(state));
      options.changed();
    },

    /**
     * IncarnaMind closed while the Meeting recorded: what was recorded after
     * live text got is transcribed once it stops.
     */
    recovered(meetingId: string, recordedMs: number): void {
      const state = load(meetingId);
      if (state.savedPath) return;
      const fromMs = Math.max(state.doneMs, state.cues.at(-1)?.endMs ?? 0);
      state.pending = addRange(state.pending, { fromMs, toMs: recordedMs });
      if (state.cues.length > 0 || state.pending.length > 0) state.state = "behind";
      persist(state);
    },

    /** A stopped Meeting whose Transcript wasn't finished, when IncarnaMind started: it is finished now. */
    resume(meetingId: string): void {
      const state = load(meetingId);
      if (state.speakers === "due") separate(state);
      if (state.savedPath || state.state === "empty") return;
      if (state.cues.length === 0 && state.pending.length === 0) return;
      state.state = "finishing";
      state.finishing = finish(state);
    },

    retry(meetingId: string): void {
      const state = load(meetingId);
      if (state.speakers === "failed") {
        state.speakers = "due";
        persist(state);
        separate(state);
        return;
      }
      const status = model.status();
      if (status.state === "failed") model.retry();
      state.problem = null;
      state.restarts = [];
      const live = state.live;
      if (live && !live.started) {
        if (live.pendingFrom !== null) {
          state.pending = addRange(state.pending, {
            fromMs: live.pendingFrom,
            toMs: live.tracks.atMs,
          });
          live.stream = `${meetingId}:${++streams}`;
          live.streams = {};
          live.pushedMs = live.tracks.atMs;
          live.doneMs = live.tracks.atMs;
          live.pendingFrom = null;
        }
        startEngine(state);
      } else if ((state.state === "failed" || state.state === "finishing") && !state.finishing) {
        state.state = "finishing";
        state.finishing = finish(state);
      }
      options.changed();
    },

    /** The Meeting's Mind was deleted: its Transcript's working files go; its Document stays. */
    forget(meetingId: string): void {
      const state = states.get(meetingId);
      if (state?.live) {
        dropStreams(state.live);
        state.live = null;
      }
      if (state?.indexTimer) clearTimeout(state.indexTimer);
      states.delete(meetingId);
      rmSync(jsonPath(meetingId), { force: true });
    },

    close(): void {
      closed = true;
      for (const state of states.values()) {
        if (state.indexTimer) clearTimeout(state.indexTimer);
        if (state.partialTimer) clearTimeout(state.partialTimer);
        if (state.live) persist(state);
      }
      model.close();
    },
  };
}

export type Transcripts = ReturnType<typeof createTranscripts>;

/** Why a stretch has no text, as the reasons of the gaps a Transcript marks. */
export type { GapReason };
