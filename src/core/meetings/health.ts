/**
 * How well each Meeting's capture went (#161), so a bad recording can be
 * explained: how fast this computer transcribed it live, audio lost and
 * audio saved after a crash, the transcription process started again and
 * the gap that left, live text falling behind, speech the engine couldn't
 * read, and switches between engines.
 *
 * Only numbers, times and kinds, never a word of the Transcript or any
 * audio, both in the record and in the log, where each event goes as it
 * happens. The record is a file per Meeting, as its audio and Transcript are
 * (ADR-0015): the data folder's meetings/<id>.health.json, beside its audio's
 * folder rather than in it, so it outlives the audio.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../adapters";
import type { CaptureEvent, CaptureHealth, CaptureHealthEvent } from "../api";
import { KEEPS_UP } from "../transcription/model";

/** The speed is written at most this often; events are written as they happen. */
const SPEED_SAVED_EVERY_MS = 30_000;
/** A loss starting this soon after the same kind of loss ends is the same loss. */
const TOUCHING_MS = 1000;

interface Stored {
  /** Speech transcribed live, and the time decoding it took, in ms. */
  speechMs: number;
  decodeMs: number;
  events: CaptureHealthEvent[];
}

interface Kept extends Stored {
  savedAt: number;
}

export interface CaptureHealthOptions {
  dataDir: string;
  now: () => string;
  log: Logger;
  changed(): void;
}

export type CaptureHealthRecords = ReturnType<typeof createCaptureHealth>;

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown";

const factorOf = (kept: Stored) =>
  kept.speechMs > 0 ? Math.round((kept.decodeMs / kept.speechMs) * 100) / 100 : null;

type Stretch = Extract<CaptureHealthEvent, { kind: "audioLost" | "notTranscribed" }>;

/** The loss, or the unread speech, that `event` carries on from: one part lost after another is one loss. */
function continued(events: CaptureHealthEvent[], event: CaptureEvent & { atMs: number }) {
  if (event.kind !== "audioLost" && event.kind !== "notTranscribed") return undefined;
  const same = (each: CaptureHealthEvent): each is Stretch =>
    each.kind === event.kind &&
    (each.kind !== "audioLost" ||
      event.kind !== "audioLost" ||
      (each.source === event.source && each.cause === event.cause));
  const before = events.findLast(same);
  if (!before) return undefined;
  const touches =
    event.atMs >= before.atMs && event.atMs <= before.atMs + before.durationMs + TOUCHING_MS;
  return touches ? before : undefined;
}

export function createCaptureHealth(options: CaptureHealthOptions) {
  const { log } = options;
  const kept = new Map<string, Kept>();
  const pathOf = (meetingId: string) =>
    join(options.dataDir, "meetings", `${meetingId}.health.json`);

  function load(meetingId: string): Kept {
    const known = kept.get(meetingId);
    if (known) return known;
    let stored: Stored = { speechMs: 0, decodeMs: 0, events: [] };
    try {
      if (existsSync(pathOf(meetingId))) {
        stored = { ...stored, ...(JSON.parse(readFileSync(pathOf(meetingId), "utf8")) as Stored) };
      }
    } catch (error) {
      log.error("capture.unreadable", { meetingId, code: codeOf(error) });
    }
    const loaded = { ...stored, savedAt: Date.now() };
    kept.set(meetingId, loaded);
    return loaded;
  }

  /** Writes the record whole or not at all. */
  function save(meetingId: string, record: Kept): void {
    record.savedAt = Date.now();
    const stored: Stored = {
      speechMs: record.speechMs,
      decodeMs: record.decodeMs,
      events: record.events,
    };
    try {
      const path = pathOf(meetingId);
      mkdirSync(join(options.dataDir, "meetings"), { recursive: true });
      const partial = `${path}.${randomUUID()}.part`;
      writeFileSync(partial, JSON.stringify(stored));
      renameSync(partial, path);
    } catch (error) {
      log.error("capture.saveFailed", { meetingId, code: codeOf(error) });
    }
  }

  return {
    of(meetingId: string): CaptureHealth {
      const record = load(meetingId);
      const factor = factorOf(record);
      return {
        realTimeFactor: factor,
        measuredMs: record.speechMs,
        keepsUp: factor === null ? null : factor <= KEEPS_UP,
        events: record.events.map((event) => ({ ...event })),
      };
    },

    /** Speech transcribed live, and how long decoding it took. */
    decoded(meetingId: string, speechMs: number, decodeMs: number): void {
      const record = load(meetingId);
      const first = record.speechMs === 0;
      record.speechMs += speechMs;
      record.decodeMs += decodeMs;
      if (first || Date.now() - record.savedAt >= SPEED_SAVED_EVERY_MS) save(meetingId, record);
    },

    /** Something happened to the capture, at `atMs` in the Meeting's time. */
    add(meetingId: string, event: CaptureEvent & { atMs: number }): void {
      const record = load(meetingId);
      const before = continued(record.events, event);
      if (before && "durationMs" in event) {
        before.durationMs = Math.max(
          before.durationMs,
          event.atMs + event.durationMs - before.atMs,
        );
      } else {
        record.events.push({ at: options.now(), ...event });
      }
      const { kind, ...fields } = event;
      const quiet = kind === "audioRecovered" || kind === "behind" || kind === "switched";
      log[quiet ? "info" : "warn"](`capture.${kind}`, { meetingId, ...fields });
      save(meetingId, record);
      options.changed();
    },

    /** A stretch of recording ended: the record is written, and summed up in the log. */
    ended(meetingId: string): void {
      const record = load(meetingId);
      save(meetingId, record);
      const sum = (kind: CaptureEvent["kind"]) =>
        record.events.reduce(
          (total, event) =>
            total + (event.kind === kind && "durationMs" in event ? event.durationMs : 0),
          0,
        );
      const count = (kind: CaptureEvent["kind"]) =>
        record.events.filter((event) => event.kind === kind).length;
      log.info("capture.health", {
        meetingId,
        realTimeFactor: factorOf(record),
        measuredMs: record.speechMs,
        audioLostMs: sum("audioLost"),
        restarts: count("restarted"),
        gapMs: record.events.reduce(
          (total, event) => total + (event.kind === "restarted" ? event.gapMs : 0),
          0,
        ),
        behind: count("behind"),
        notTranscribedMs: sum("notTranscribed"),
        switches: count("switched"),
      });
    },

    /** The Meeting is gone for good: its record goes with it. */
    forget(meetingId: string): void {
      kept.delete(meetingId);
      rmSync(pathOf(meetingId), { force: true });
    },
  };
}
