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

import type { CloudLoss } from "../../adapters";
import { createLeveler, toFloat, type VoiceDetector } from "../speech";
import { cleanSpeech } from "../speechText";
import { base64Pcm, createLiveStream, type LiveLink } from "./live";
import { type CloudStreamHandle, type CloudStreamOptions, msOf, samplesOf } from "./stream";

export const OPENAI_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

/** The Realtime API's PCM is 24 kHz. */
const SERVICE_RATE = 24_000;
/** What is sent from before the detector heard speech start: it notices a little late. */
const LEAD_IN_MS = 1200;
const KEPT_MS = 2000;
/** The service refuses a commit of less audio than this. */
const MIN_TURN_MS = 100;
const LANGUAGES = ["en", "zh"];
/** Errors that end the stream: the key refused, no credit left, or no more for now. */
const STOPS: Readonly<Record<string, CloudLoss>> = {
  invalid_api_key: "refused",
  account_deactivated: "refused",
  insufficient_quota: "credit",
  rate_limit_exceeded: "dropped",
};

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

  function settle(link: LiveLink): void {
    report.progress(doneMs());
    if (link.finishing && !open && turns.every((turn) => turn.final)) link.complete();
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

  function heard(event: ServerEvent, link: LiveLink): void {
    switch (event.type) {
      case "session.updated":
        link.ready();
        return;
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
          settle(link);
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
        settle(link);
        return;
      }
      case "error": {
        const code = event.error?.code;
        const loss = typeof code === "string" ? STOPS[code] : undefined;
        // The service may keep the socket open after it, transcribing nothing.
        if (loss) link.lose(loss);
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

  function append(link: LiveLink): void {
    if (!open) return;
    const samples = since(Math.max(sent, open.start));
    sent = received;
    const out = open.upsample(samples);
    if (out.length > 0) {
      link.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Pcm(out) }));
    }
  }

  function begin(start: number, link: LiveLink): void {
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
    append(link);
  }

  function commit(end: number, link: LiveLink): void {
    const turn = open;
    if (!turn) return;
    open = null;
    const { upsample: _upsample, ...rest } = turn;
    const committed: Turn = { ...rest, end, committedAt: Date.now() };
    if (msOf(sent - turn.start) < MIN_TURN_MS) {
      link.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      return;
    }
    link.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    turns.push(committed);
    committedOrder.push(committed);
  }

  function look(link: LiveLink): void {
    for (let found = detector.next(); found; found = detector.next()) {
      if (!open) begin(found.start - samplesOf(LEAD_IN_MS), link);
      commit(Math.min(received, found.start + found.samples.length), link);
    }
    if (!open && detector.speaking()) begin(received - samplesOf(LEAD_IN_MS), link);
  }

  return createLiveStream(options, {
    url: OPENAI_TRANSCRIPTION_URL,
    opened(link) {
      link.setup(
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
    heard: (message, link) => heard(message as ServerEvent, link),
    audio(samples, link) {
      // The service is sent what the detector hears: a quiet voice raised, as on this computer.
      const leveled = level(toFloat(samples));
      keep(toPcm(leveled));
      received += samples.length;
      append(link);
      detector.accept(leveled);
      look(link);
      settle(link);
    },
    finish(link) {
      detector.flush();
      look(link);
      commit(received, link);
      settle(link);
    },
    late(link) {
      for (const turn of [...turns]) finalize(turn, textOf(turn));
      report.progress(msOf(received));
      link.complete();
    },
    // The key is refused only in words of the service's own (`error`).
    closed(_code, _reason, link) {
      link.lose("dropped");
    },
  });
}
