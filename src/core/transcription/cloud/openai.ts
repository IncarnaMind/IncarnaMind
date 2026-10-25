/**
 * OpenAI's live transcription (`gpt-live-transcribe`, #141) over the Realtime API's
 * transcription session. The model takes no server-side turn detection, so our own Silero VAD
 * finds each stretch of speech, as on this computer: only speech is sent (the service bills the
 * audio it is sent), each stretch is committed as one turn once the speaker pauses, and its text
 * comes back as it is said (deltas), then whole (completed).
 *
 * Turns are known to the service by `item_id`. Results for different turns can arrive out of
 * order, and a turn's first deltas come before its commit is acknowledged, so the k-th
 * `input_audio_buffer.committed` event names the k-th turn committed; until then, an id is
 * taken to be the oldest turn without one.
 */

import { createLeveler, toFloat, type VoiceDetector } from "../speech";
import { cleanSpeech } from "../speechText";
import {
  type CloudStreamHandle,
  type CloudStreamOptions,
  CONNECT_TIMEOUT_MS,
  FINISH_TIMEOUT_MS,
  msOf,
  samplesOf,
} from "./stream";

export const OPENAI_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

/** The Realtime API's PCM is 24 kHz. */
const SERVICE_RATE = 24_000;
/** What is sent from before the detector heard speech start: it notices a little late. */
const LEAD_IN_MS = 1200;
const KEPT_MS = 2000;
/** The service refuses a commit of less audio than this. */
const MIN_TURN_MS = 100;
const LANGUAGES = ["en", "zh"];
/** Errors that end the stream: the key refused, or the service won't take more for now. */
const REFUSALS = new Set(["invalid_api_key", "account_deactivated"]);
const STOPS = new Set([...REFUSALS, "insufficient_quota", "rate_limit_exceeded"]);

interface Turn {
  id: number;
  start: number;
  /** Where it ended, in samples, once committed. */
  end: number | null;
  item: string | null;
  committedAt: number | null;
  final: boolean;
}

/**
 * 16 kHz to 24 kHz, chunk after chunk: each output sample falls two thirds of an input sample
 * after the one before, on the straight line between its neighbours.
 */
export function createUpsampler(): (samples: Int16Array) => Int16Array {
  let carry: number[] = [];
  /** Where the next output falls, in thirds of an input sample from `carry[0]`. */
  let thirds = 0;
  return (samples) => {
    const all = carry.length > 0 ? [...carry, ...samples] : Array.from(samples);
    const out: number[] = [];
    for (let at = 0; at + 1 < all.length; at = Math.floor(thirds / 3)) {
      const from = all[at] as number;
      const to = all[at + 1] as number;
      out.push(Math.round(from + ((to - from) * (thirds % 3)) / 3));
      thirds += 2;
    }
    const used = Math.floor(thirds / 3);
    carry = all.slice(used);
    thirds -= used * 3;
    return Int16Array.from(out);
  };
}

const toPcm = (samples: Float32Array) =>
  Int16Array.from(samples, (sample) =>
    Math.max(-32768, Math.min(32767, Math.round(sample * 32768))),
  );

const base64 = (samples: Int16Array) =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");

type ServerEvent = {
  type?: unknown;
  item_id?: unknown;
  delta?: unknown;
  transcript?: unknown;
  error?: { code?: unknown } | null;
};

export function createOpenAiStream(
  options: CloudStreamOptions & { detector: VoiceDetector },
): CloudStreamHandle {
  const { stream, report, detector } = options;
  const level = createLeveler();
  let received = 0;
  /** The latest audio, for the lead-in: `kept` starts at sample `keptFrom`. */
  let kept = new Int16Array(0);
  let keptFrom = 0;
  let open: (Turn & { upsample: (samples: Int16Array) => Int16Array }) | null = null;
  /** Audio before this has gone to the service, in a turn, or was silence. */
  let sent = 0;
  const turns: Turn[] = [];
  const committedOrder: Turn[] = [];
  let acknowledged = 0;
  const texts = new Map<string, string>();
  /** Completed text that came before its turn was known. */
  const early = new Map<string, string>();
  let nextId = 1;
  let ready = false;
  const waiting: string[] = [];
  let ended = false;
  let refused = false;
  let finishing: { resolve(): void } | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (message: object) => {
    const text = JSON.stringify(message);
    if (ready) socket.send(text);
    else waiting.push(text);
  };

  const socket = options.connect(OPENAI_TRANSCRIPTION_URL, options.apiKey, {
    open() {
      if (ended) return;
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: SERVICE_RATE },
                transcription: { model: options.model, languages: LANGUAGES },
                turn_detection: null,
              },
            },
          },
        }),
      );
    },
    message: heard,
    closed() {
      if (ended) return;
      end();
      report.lost(refused ? "refused" : "dropped");
    },
  });
  const connectTimer = setTimeout(() => {
    if (ready || ended) return;
    socket.close();
  }, CONNECT_TIMEOUT_MS);

  function end(): void {
    ended = true;
    // What waited for the connection is never sent once the stream has ended.
    waiting.length = 0;
    clearTimeout(connectTimer);
    if (finishTimer) clearTimeout(finishTimer);
    finishing?.resolve();
    finishing = null;
  }

  /** Everything before the oldest turn without its final text, or the turn being said, is done. */
  function doneMs(): number {
    let done = received;
    for (const turn of turns) if (!turn.final) done = Math.min(done, turn.start);
    if (open) done = Math.min(done, open.start);
    return msOf(done);
  }

  function textOf(turn: Turn): string {
    return turn.item ? (texts.get(turn.item) ?? "") : "";
  }

  function settle(): void {
    report.progress(doneMs());
    if (finishing && !open && turns.every((turn) => turn.final)) {
      end();
      socket.close();
    }
  }

  function finalize(turn: Turn, transcript: string): void {
    if (turn.final) return;
    turn.final = true;
    report.segment({
      stream,
      id: turn.id,
      startMs: msOf(turn.start),
      endMs: msOf(turn.end ?? received),
      text: cleanSpeech(transcript),
      final: true,
      decodeMs: turn.committedAt === null ? 0 : Date.now() - turn.committedAt,
    });
    turns.splice(turns.indexOf(turn), 1);
  }

  function turnOf(item: string): Turn | undefined {
    const named = committedOrder.find((turn) => turn.item === item);
    if (named) return named;
    const all = open ? [...turns, open] : turns;
    const known = all.find((turn) => turn.item === item);
    if (known) return known;
    const free = all.find((turn) => turn.item === null);
    if (free) free.item = item;
    return free;
  }

  function heard(text: string): void {
    if (ended) return;
    let event: ServerEvent;
    try {
      event = JSON.parse(text) as ServerEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "session.updated": {
        if (ready) return;
        ready = true;
        clearTimeout(connectTimer);
        for (const message of waiting.splice(0)) socket.send(message);
        report.opened();
        return;
      }
      case "input_audio_buffer.committed": {
        if (typeof event.item_id !== "string") return;
        const turn = committedOrder[acknowledged++];
        if (!turn) return;
        // An id taken for this turn before belonged to another: they swap.
        const holder = [...turns, ...(open ? [open] : [])].find(
          (each) => each !== turn && each.item === event.item_id,
        );
        if (holder) holder.item = turn.item;
        turn.item = event.item_id;
        const done = early.get(event.item_id);
        if (done !== undefined) {
          early.delete(event.item_id);
          finalize(turn, done);
          settle();
        }
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        if (typeof event.item_id !== "string" || typeof event.delta !== "string") return;
        texts.set(event.item_id, (texts.get(event.item_id) ?? "") + event.delta);
        const turn = turnOf(event.item_id);
        if (!turn || turn.final) return;
        const words = cleanSpeech(textOf(turn));
        if (!words) return;
        report.segment({
          stream,
          id: turn.id,
          startMs: msOf(turn.start),
          endMs: msOf(turn.end ?? received),
          text: words,
          final: false,
          decodeMs: 0,
        });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (typeof event.item_id !== "string") return;
        const transcript = typeof event.transcript === "string" ? event.transcript : "";
        const turn = committedOrder.find((each) => each.item === event.item_id);
        if (!turn) {
          early.set(event.item_id, transcript);
          return;
        }
        finalize(turn, transcript);
        settle();
        return;
      }
      case "error": {
        const code = event.error?.code;
        if (typeof code !== "string" || !STOPS.has(code)) return;
        // The service may keep the socket open after it, transcribing nothing.
        refused = REFUSALS.has(code);
        end();
        socket.close();
        report.lost(refused ? "refused" : "dropped");
        return;
      }
    }
  }

  function keep(samples: Int16Array): void {
    const all = new Int16Array(kept.length + samples.length);
    all.set(kept);
    all.set(samples, kept.length);
    const most = samplesOf(KEPT_MS);
    const drop = Math.max(0, all.length - most);
    kept = all.slice(drop);
    keptFrom += drop;
  }

  function since(from: number): Int16Array {
    return kept.subarray(Math.max(0, from - keptFrom));
  }

  function append(): void {
    if (!open) return;
    const samples = since(Math.max(sent, open.start));
    sent = received;
    const out = open.upsample(samples);
    if (out.length > 0) send({ type: "input_audio_buffer.append", audio: base64(out) });
  }

  function begin(start: number): void {
    open = {
      id: nextId++,
      // Never audio a turn before had: a turn cut short at the detector's longest goes straight on.
      start: Math.max(start, sent, keptFrom),
      end: null,
      item: null,
      committedAt: null,
      final: false,
      upsample: createUpsampler(),
    };
    append();
  }

  function commit(end: number): void {
    const turn = open;
    if (!turn) return;
    open = null;
    const { upsample: _upsample, ...rest } = turn;
    const committed: Turn = { ...rest, end, committedAt: Date.now() };
    if (msOf(sent - turn.start) < MIN_TURN_MS) {
      send({ type: "input_audio_buffer.clear" });
      return;
    }
    send({ type: "input_audio_buffer.commit" });
    turns.push(committed);
    committedOrder.push(committed);
  }

  function look(): void {
    for (let found = detector.next(); found; found = detector.next()) {
      if (!open) begin(found.start - samplesOf(LEAD_IN_MS));
      commit(Math.min(received, found.start + found.samples.length));
    }
    if (!open && detector.speaking()) begin(received - samplesOf(LEAD_IN_MS));
  }

  return {
    push(samples) {
      if (ended || finishing || samples.length === 0) return;
      // The service is sent what the detector hears: a quiet voice raised, as on this computer.
      const leveled = level(toFloat(samples));
      keep(toPcm(leveled));
      received += samples.length;
      append();
      detector.accept(leveled);
      look();
      settle();
    },

    finish() {
      if (ended) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishing = { resolve };
        detector.flush();
        look();
        commit(received);
        finishTimer = setTimeout(() => {
          for (const turn of [...turns]) finalize(turn, textOf(turn));
          report.progress(msOf(received));
          end();
          socket.close();
        }, FINISH_TIMEOUT_MS);
        settle();
      });
    },

    drop() {
      if (ended) return;
      end();
      socket.close();
    },
  };
}
